import { EmbedWallet } from '@cere/embed-wallet';
import { Vault, CereWalletSigner, type VaultRecord, VaultRequestError } from '@cef-ai/client-sdk';

// ─── Config from .env ─────────────────────────────────────────────────────────
const CONFIG = {
  walletEnv: (import.meta.env.VITE_WALLET_ENV ?? 'dev') as 'dev' | 'stage' | 'prod',
  agentId: import.meta.env.VITE_AGENT_ID as string,
  agentServicePubkey: import.meta.env.VITE_AGENT_SERVICE_PUBKEY as string,
  cubbyAlias: import.meta.env.VITE_CUBBY_ALIAS as string,
  scopeName: import.meta.env.VITE_SCOPE_NAME ?? 'default',
  assemblyAiKey: import.meta.env.VITE_ASSEMBLY_AI_KEY as string,
  walletAppId: import.meta.env.VITE_WALLET_APP_ID ?? 'cef-conv-recorder',
  audioCompleteDelayMs: 25_000,
};

// Vault URL is derived from the wallet environment — no separate config needed.
const VAULT_URLS = {
  dev:   'https://vault-api.compute.dev.ddcdragon.com',
  stage: 'https://vault-api.compute.stage.ddcdragon.com',
  prod:  'https://vault-api.compute.ddcdragon.com',
};
const vaultUrl = VAULT_URLS[CONFIG.walletEnv];
// ─────────────────────────────────────────────────────────────────────────────

const PERMISSIONS = {
  ed25519_signRaw: {
    title: 'Sign API request',
    description: 'Allow this app to publish events to your vault.',
  },
} as const;

// State
let vault: Vault | null = null;
let vaultRecord: VaultRecord | null = null;
let mediaRecorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
let chunkTimer: ReturnType<typeof setInterval> | null = null;
let conversationId: string | null = null;
let segmentIndex = 0;
const pendingChunks: Promise<void>[] = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const authStatus = document.getElementById('auth-status') as HTMLParagraphElement;
const recordSection = document.getElementById('record-section') as HTMLElement;
const recordBtn = document.getElementById('record-btn') as HTMLButtonElement;
const recordStatus = document.getElementById('record-status') as HTMLParagraphElement;
const chunkCount = document.getElementById('chunk-count') as HTMLParagraphElement;
const resultsSection = document.getElementById('results-section') as HTMLElement;
const summaryEl = document.getElementById('summary') as HTMLParagraphElement;
const topicsEl = document.getElementById('topics') as HTMLDivElement;
const actionItemsEl = document.getElementById('action-items') as HTMLDivElement;

// ─── Wallet + vault init ──────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  authStatus.textContent = 'Connecting wallet…';

  try {
    const embedWallet = new EmbedWallet({ appId: CONFIG.walletAppId, env: CONFIG.walletEnv });
    await embedWallet.init({ popupMode: 'modal', connectOptions: { permissions: PERMISSIONS } });
    await embedWallet.connect();

    const granted = await embedWallet.getPermissions().catch(() => []);
    const hasPermission = granted.some((p) => p.parentCapability === 'ed25519_signRaw');
    if (!hasPermission) await embedWallet.requestPermissions(PERMISSIONS);

    const signer = new CereWalletSigner(embedWallet);
    await signer.isReady();

    // The Vault SDK signs JSON text. CereWalletSigner.sign() takes a string,
    // but the SDK calls signRawBytes(Uint8Array) — decode back to UTF-8 first.
    const walletWithRawBytes = Object.assign(signer, {
      signRawBytes: async (bytes: Uint8Array) => signer.sign(new TextDecoder().decode(bytes)),
    });

    vault = new Vault({ url: vaultUrl, wallet: walletWithRawBytes as any });

    // Get existing vault — assumes user already claimed one via the marketplace.
    // If not claimed yet, vault.claim({ name, delegation_token }) is needed.
    let record: VaultRecord | null = null;
    try {
      record = await vault.current();
    } catch (e) {
      if (e instanceof VaultRequestError && e.status === 404) {
        authStatus.textContent = 'No vault found. Claim one in the marketplace first.';
        connectBtn.disabled = false;
        return;
      }
      throw e;
    }

    // Ensure scope exists (idempotent)
    try {
      await vault.scopes.create(record.vaultId, { name: CONFIG.scopeName });
    } catch (e) {
      if (!(e instanceof VaultRequestError && (e.status === 409 || e.status === 400))) throw e;
    }

    vaultRecord = record;
    authStatus.textContent = `Connected — vault ${record.vaultId}`;
    recordSection.hidden = false;
  } catch (e) {
    authStatus.textContent = `Error: ${(e as Error).message}`;
    connectBtn.disabled = false;
  }
});

// ─── Recording ────────────────────────────────────────────────────────────────
recordBtn.addEventListener('click', async () => {
  if (mediaRecorder?.state === 'recording') {
    await stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  if (!vault || !vaultRecord) return;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micStream = stream;
  conversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  segmentIndex = 0;
  pendingChunks.length = 0;
  resultsSection.hidden = true;

  await publishEvent('conversation_start', { conversationId });

  // stop()+start() cycle instead of timeslice — timeslice produces fragmented WebM
  // blobs that lack the EBML header, which AssemblyAI rejects as "not audio".
  // Each stop() finalizes the container into a valid standalone file.
  function makeRecorder() {
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    mr.ondataavailable = (e) => {
      if (e.data.size < 500) return;
      const idx = segmentIndex++;
      pendingChunks.push(uploadAndPublishChunk(e.data, idx));
      chunkCount.textContent = `Chunks sent: ${segmentIndex}`;
    };
    return mr;
  }

  mediaRecorder = makeRecorder();
  mediaRecorder.start();

  chunkTimer = setInterval(() => {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
    mediaRecorder.stop();
    mediaRecorder = makeRecorder();
    mediaRecorder.start();
  }, 5000);

  recordBtn.textContent = 'Stop Recording';
  recordBtn.classList.add('recording');
  recordStatus.textContent = 'Recording…';
}

async function stopRecording() {
  if (!mediaRecorder || !vault || !vaultRecord || !conversationId) return;

  recordBtn.disabled = true;
  recordStatus.textContent = 'Stopping…';
  if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
  mediaRecorder.stop();
  micStream?.getTracks().forEach((t) => t.stop());

  // Wait for any in-flight uploads to finish
  await Promise.all(pendingChunks);

  const total = segmentIndex;
  recordStatus.textContent = `Waiting for transcription (${CONFIG.audioCompleteDelayMs / 1000}s)…`;

  // AssemblyAI transcription runs in parallel on the agent, ~15-20s per chunk.
  // Sending audio.complete too early means the agent polls an empty DB and skips Gemini.
  await new Promise((r) => setTimeout(r, CONFIG.audioCompleteDelayMs));

  await publishEvent('audio.complete', { conversationId, totalSegments: total });
  await publishEvent('conversation_end', { conversationId });

  recordBtn.textContent = 'Start Recording';
  recordBtn.classList.remove('recording');
  recordBtn.disabled = false;
  recordStatus.textContent = 'Polling for results…';

  pollResults(conversationId);
}

// ─── AssemblyAI upload ────────────────────────────────────────────────────────
async function uploadAndPublishChunk(blob: Blob, idx: number): Promise<void> {
  const res = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { Authorization: CONFIG.assemblyAiKey, 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  const data = await res.json() as { upload_url?: string };
  if (!res.ok || !data.upload_url) throw new Error(`AssemblyAI upload failed: ${res.status}`);
  await publishEvent('audio_chunk', { conversationId, segmentIndex: idx, audio_url: data.upload_url });
}

// ─── Vault event publish ──────────────────────────────────────────────────────
async function publishEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  if (!vault || !vaultRecord) return;
  await vault.events.publish(vaultRecord.vaultId, CONFIG.scopeName, [{
    type,
    role: 'user',
    scope: CONFIG.scopeName,
    context: conversationId ?? 'default',
    target: CONFIG.agentId,
    payload,
    timestamp: new Date().toISOString(),
  }]);
}

// ─── Poll cubby for results ───────────────────────────────────────────────────
async function pollResults(convId: string, attempt = 0): Promise<void> {
  if (!vault || !vaultRecord) return;
  if (attempt > 60) {
    recordStatus.textContent = 'Timed out waiting for results.';
    return;
  }

  try {
    const path = `/api/v1/vaults/${vaultRecord.vaultId}/scopes/${CONFIG.scopeName}/agents/${CONFIG.agentId}/cubbies/${CONFIG.cubbyAlias}/query`;
    // vault.cubbies.query() returns 404 on devnet — use the raw HTTP path via the vault's internal client.
    const json = await (vault as any).http.request('POST', path, {
      body: { sql: 'SELECT attribute FROM nodes WHERE id = ? LIMIT 1', params: [`conversation:${convId}`] },
    }) as { columns: string[]; rows: unknown[][] };

    if (json.rows.length > 0) {
      const raw = json.rows[0][0];
      const attr = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>;
      if (attr.status === 'complete') {
        renderResults(attr);
        return;
      }
    }
  } catch { /* keep polling */ }

  setTimeout(() => pollResults(convId, attempt + 1), 3000);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderResults(attr: Record<string, unknown>) {
  recordStatus.textContent = 'Analysis complete.';
  resultsSection.hidden = false;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  summaryEl.textContent = (attr.summary as string) ?? '';

  const topics = (attr.topics as string[]) ?? [];
  topicsEl.innerHTML = topics.length
    ? `<h3>Topics</h3><div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.4rem">`
      + topics.map((t) => `<span class="tag">${t}</span>`).join('')
      + `</div>`
    : '';

  const items = (attr.action_items as string[]) ?? [];
  actionItemsEl.innerHTML = items.length
    ? `<h3>Action items</h3><ul style="padding-left:1.25rem;margin-top:0.4rem;display:flex;flex-direction:column;gap:0.4rem">`
      + items.map((i) => `<li style="font-size:0.875rem;color:#374151;line-height:1.5">${i}</li>`).join('')
      + `</ul>`
    : '';
}
