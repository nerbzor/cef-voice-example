# CEF Voice Example

A minimal end-to-end example of a CEF vault agent that:

1. Records mic audio in the browser (5-second chunks)
2. Uploads each chunk to AssemblyAI for transcription
3. On stop, sends the full transcript to Gemini for summarisation
4. Writes the result to a cubby (CEF's SQLite graph DB)
5. Displays the summary, topics, and action items in the browser

---

## What's in this repo

```
index.html              — web client UI
src/main.ts             — wallet connect, mic recording, vault events, cubby polling
agent/
  cef.config.ts         — agent definition (id, cubby, settings, fetch allowlist)
  src/phrase-handler.ts — engagement: handles audio_chunk + audio.complete events
  src/lib/transcribe.ts — AssemblyAI polling logic
  migrations/voice_agent/ — cubby schema (nodes + transcript_chunks tables)
  prepare-manifest.mjs  — strips internal fields from raw manifest before ROB upload
```

---

## What you need before starting

### 1. Cere wallet

All publishing, vault access, and agent ownership goes through a single Cere wallet.

| Network | Wallet UI | Tokens |
|---|---|---|
| Devnet | https://wallet.dev.cere.io | Request from faucet or team |

This wallet is used in ROB, the marketplace, and the browser client. No JSON signer file needed.

### 2. API keys

| What | Where |
|---|---|
| AssemblyAI | https://assemblyai.com → sign up → API Keys |
| Gemini | https://aistudio.google.com → Get API key |

### 3. Agent service pubkey — from ROB

ROB is the Cere agent registry. **Create your agent service here, not in the marketplace playground** — playground-created services don't get a runtime subscription and events are silently dropped.

**ROB:** https://rob.compute.dev.ddcdragon.com

1. Sign in with your Cere wallet
2. Create a new agent service
3. Copy the `agentServicePubkey`

Your `agentId` is: `<agentServicePubkey>:voice-agent`

---

## Setup — step by step

### Step 1 — Create your agent service in ROB

Go to **ROB**: https://rob.compute.dev.ddcdragon.com and sign in with your Cere wallet.

Create a new agent service. ROB gives you an `agentServicePubkey` — copy it. This is a public key, not a secret.

> Do this in ROB, not the marketplace playground. Playground services don't get a runtime subscription.

### Step 2 — Fill in .env

```bash
cp .env.example .env
```

Edit `.env` with your values:

```
VITE_WALLET_ENV=dev
VITE_WALLET_APP_ID=cef-conv-recorder
VITE_AGENT_SERVICE_PUBKEY=<your pubkey from ROB>
VITE_AGENT_ID=<pubkey>:voice-agent
VITE_CUBBY_ALIAS=voice_agent
VITE_SCOPE_NAME=default
VITE_ASSEMBLY_AI_KEY=<your AssemblyAI key>
VITE_GEMINI_API_KEY=<your Gemini key>
```

### Step 3 — Build the agent and generate your manifest

The sample code in `agent/` is your agent. Build it — it reads your `.env` and produces a manifest specific to your agent service.

```bash
cd agent
npm install
npm run build
npm run prepare-manifest
cd ..
```

This produces `manifest-publish.json` at the repo root. This file is unique to your agent service — do not share it.

### Step 4 — Upload to ROB and publish

1. In ROB, open your agent service
2. Upload `manifest-publish.json`
3. Click **Publish**

Each time you change the agent code and republish, bump `version` in `agent/cef.config.ts` first — ROB rejects duplicate versions with 409.

### Step 5 — Connect the agent in the marketplace and set API keys

**Marketplace:** https://agent-marketplace.compute.dev.ddcdragon.com

1. Sign in with your **Cere wallet** (same one used in ROB)
2. Search for your agent by name or pubkey
3. Open agent settings → enter your **AssemblyAI API Key** and **Gemini API Key**
4. Click **Connect** to activate the agent

> If a previous version was already connected: disconnect it first, then connect the new one. Publishing does not automatically swap the running version.

### Step 6 — Run the web client

```bash
npm install
npm run dev
```

Open http://localhost:5173 and connect your wallet.

**Critical:** use the **exact same Cere wallet** here that you used to connect the agent in the marketplace (Step 5). The vault belongs to that wallet — if you connect a different wallet in the browser, it won't have a vault and won't see any results.

---

## How it works

### Audio path (browser → agent → cubby)

```
Browser
  └─ MediaRecorder (stop/start every 5s → valid standalone WebM blobs)
  └─ POST https://api.assemblyai.com/v2/upload  (binary upload, client-side)
  └─ vault.events.publish → audio_chunk { conversationId, segmentIndex, audio_url }

Agent (phrase-handler)
  └─ onAudioChunk
       POST /v2/transcript { audio_url }   → job_id
       GET  /v2/transcript/:id             → poll until completed
       INSERT INTO transcript_chunks
  └─ onAudioComplete  (sent after 25s delay)
       SELECT all chunks → join text
       POST Gemini 2.5 Flash → { summary, topics, action_items }
       UPDATE nodes SET attribute = ?

Browser
  └─ polls cubby every 3s until status === 'complete'
  └─ renders results
```

### Why upload to AssemblyAI in the browser?

The CEF agent sandbox cannot send binary HTTP bodies via `ctx.fetch` — it returns HTTP 422. The upload happens client-side; only the resulting `audio_url` is sent to the agent.

### Why stop/start instead of MediaRecorder timeslice?

`mediaRecorder.start(5000)` produces fragmented WebM chunks — intermediate blobs don't include the EBML container header and cannot be decoded independently. `stop()` + `start()` produces a complete, valid file each time.

---

## Agent output format

When `status === "complete"`, the cubby node looks like:

```json
{
  "conversationId": "conv-...",
  "status": "complete",
  "ai_analyzed": true,
  "summary": "Two or three sentence summary of what was said.",
  "topics": ["topic one", "topic two"],
  "action_items": ["Any explicit next steps mentioned."]
}
```

---

## Confirmed failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `[ac] no audio_url — skipping` | Event payload missing `audio_url` | Check client is sending `audio_url` not `audio` |
| AssemblyAI: "File does not appear to contain audio" | Timeslice MediaRecorder blobs (fragmented WebM) | Use stop/start cycle — this repo already does |
| `[acp] no transcript chunks` | `audio.complete` arrived before chunks written | Client waits 25s — don't reduce this |
| `[object Object]` error in ROB | DB query throwing before any log (e.g. tight polling loop) | Fixed in current version with 2s sleep |
| Gemini JSON parse fails | `responseMimeType` not set | Already set in this repo |
| Marketplace returns 409 on publish | Version not incremented | Bump `version` in `agent/cef.config.ts` and rebuild |
| Events silently dropped | Agent service created in marketplace playground | Recreate in ROB |
| Old code still running after publish | Skipped disconnect/reconnect | Disconnect old deployment, connect new one |
| Cubby query returns 404 | Using `vault.cubbies.query()` SDK method | Use raw HTTP path (already done in this repo) |
| JWK 503 on wallet connect | `walletAppId` not registered | Use `cef-conv-recorder` (already set in `.env.example`) |
