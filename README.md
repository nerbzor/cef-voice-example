# CEF Voice Example

```bash
git clone https://github.com/nerbzor/cef-voice-example.git
cd cef-voice-example
```

A minimal end-to-end example of a CEF vault agent that records audio, transcribes it, runs an LLM, and stores the result — all wired through Cere's vault infrastructure.

---

## What runs where

```
┌─────────────────────────────────────┐   ┌────────────────────────────────────────┐
│  Your browser (this repo)           │   │  CEF agent sandbox (this repo)         │
│                                     │   │                                        │
│  - Records mic audio (WebM chunks)  │   │  - Receives events from vault          │
│  - Uploads audio to file storage ①  │   │  - Submits audio URL to transcription ②│
│  - Publishes events to Cere vault   │   │  - Polls until transcript is ready     │
│  - Polls cubby for results          │   │  - Calls LLM for summary ③             │
│  - Renders summary + topics         │   │  - Writes result to cubby              │
└─────────────────────────────────────┘   └────────────────────────────────────────┘

① File storage   — this example uses AssemblyAI's upload endpoint as temporary storage.
                   You can replace this with Cere DDC (Cere's own distributed storage).

② Transcription  — this example uses AssemblyAI's transcription API (external, paid).
                   You can replace this with any transcription service or self-hosted model.

③ LLM            — this example uses Gemini 2.5 Flash via Google's API (external, paid).
                   You can replace this with any model — self-hosted or otherwise.

Cere components  — vault, cubby, agent sandbox, ROB, marketplace. These are the parts
                   you own and control. Everything marked ①②③ is pluggable.
```

---

## What's in this repo

```
index.html                        — web client
src/main.ts                       — wallet connect, mic recording, AssemblyAI upload,
                                    vault event publishing, cubby polling, result render
agent/
  cef.config.ts                   — agent definition: id, cubby alias, settings, fetch allowlist
  src/phrase-handler.ts           — handles audio_chunk and audio.complete vault events
  src/lib/transcribe.ts           — AssemblyAI transcription: submit job, poll until done
  src/prompts/system-prompt-v1.ts — prompt sent to the LLM
  migrations/voice_agent/         — cubby schema (SQLite tables: nodes, edges, transcript_chunks)
  prepare-manifest.mjs            — strips internal build fields before ROB upload
```

---

## Cere platform concepts

**Vault** — your personal encrypted data store on Cere's network. Events you publish go here. Your agent reads from here.

**Cubby** — a SQLite-backed graph DB inside a vault. The agent writes results here; the browser reads them.

**CEF agent** — code that runs in Cere's sandboxed agent runtime. It reacts to vault events. It cannot make arbitrary HTTP calls — only to domains explicitly listed in `cef.config.ts` under `fetch.allow`.

**ROB** — Cere's agent registry (https://rob.compute.dev.ddcdragon.com). Where you create agent services and upload manifests. Must use the same Cere wallet that will own the agent.

**Marketplace** — where you activate and configure your agent (https://agent-marketplace.compute.dev.ddcdragon.com). API keys (AssemblyAI, Gemini) are set here — they're injected into `ctx.settings` at runtime, never baked into the bundle.

---

## What you need

| What | Where | Notes |
|---|---|---|
| Cere wallet | https://wallet.dev.cere.io (devnet) | Fund with devnet tokens. One wallet used everywhere. |
| AssemblyAI key | https://assemblyai.com → API Keys | Used by the browser for upload + by the agent for transcription |
| Gemini key | https://aistudio.google.com → Get API key | Configured in marketplace settings, not in `.env` |

---

## Setup

### 1. Create your agent service in ROB

Go to **https://rob.compute.dev.ddcdragon.com** and sign in with your Cere wallet.

Create a new agent service. Copy the `agentServicePubkey` — this is a public identifier, not a secret.

> **Must be ROB, not the marketplace playground.** Playground-created services don't get a runtime subscription — events are silently dropped and nothing runs.

### 2. Fill in .env

```bash
cp .env.example .env
```

```
VITE_WALLET_ENV=dev
VITE_WALLET_APP_ID=cef-conv-recorder
VITE_AGENT_SERVICE_PUBKEY=<agentServicePubkey from ROB>
VITE_AGENT_ID=<agentServicePubkey>:voice-agent
VITE_CUBBY_ALIAS=voice_agent
VITE_SCOPE_NAME=default
VITE_ASSEMBLY_AI_KEY=<your AssemblyAI key>
```

The Gemini key does **not** go here — it goes in the marketplace agent settings in Step 5.

### 3. Build the agent and generate a manifest

```bash
cd agent
npm install
npm run build        # compiles agent/src/ → agent/dist/
npm run prepare-manifest  # strips internal build fields → manifest-publish.json at repo root
cd ..
```

The build output is generic — it does not contain your pubkey. ROB associates the manifest with your specific agent service when you upload it.

> Every time you change agent code and republish: bump `version` in `agent/cef.config.ts` first. ROB rejects duplicate versions with 409.

### 4. Upload to ROB and publish

1. In ROB, open your agent service
2. Upload `manifest-publish.json`
3. Click **Publish**

### 5. Configure and activate the agent in the marketplace

Go to **https://agent-marketplace.compute.dev.ddcdragon.com** and sign in with your **same Cere wallet**.

1. Search for your agent by name or pubkey
2. Open agent settings → enter:
   - **AssemblyAI API Key**
   - **Gemini API Key**
3. Click **Connect**

> If a previous version is already connected: disconnect it first, then connect the new one. Publishing does not automatically swap the running version.

### 6. Run the web client

```bash
npm install
npm run dev
```

Open http://localhost:5173.

**Use the same Cere wallet you connected in Step 5.** The vault and cubby belong to that wallet. A different wallet will have no vault and will see no results.

---

## How data flows

```
1. Browser starts recording
   └─ MediaRecorder, stop/start every 5s → valid standalone WebM blobs

2. Per chunk (client-side):
   └─ POST https://api.assemblyai.com/v2/upload (binary)
        AssemblyAI stores the file, returns { upload_url }
   └─ vault.events.publish → audio_chunk { conversationId, segmentIndex, audio_url }

   To use Cere DDC instead: upload the blob to a DDC bucket, pass the DDC URL as audio_url.
   The agent only cares about a URL it can fetch — it doesn't know or care where the file lives.

3. Agent — onAudioChunk (runs in CEF sandbox, one per event):
   └─ POST https://api.assemblyai.com/v2/transcript { audio_url }  → job_id
   └─ GET  /v2/transcript/:id  (polls every ~2s until status === "completed")
   └─ INSERT INTO transcript_chunks

4. Browser stops recording → waits 25s → sends audio.complete
   (25s allows in-flight transcription jobs to finish before the agent queries the DB)

5. Agent — onAudioComplete:
   └─ SELECT all transcript_chunks for this conversationId → join into full text
   └─ POST https://generativelanguage.googleapis.com (Gemini 2.5 Flash, Google's cloud)
        Returns { summary, topics, action_items }
   └─ UPDATE nodes SET attribute = ? WHERE id = 'conversation:<id>'

   To use a different model: replace the analyzeWithGemini() call in phrase-handler.ts
   and update fetch.allow in cef.config.ts.

6. Browser polls cubby every 3s:
   └─ POST /api/v1/vaults/.../cubbies/voice_agent/query
        { sql: "SELECT attribute FROM nodes WHERE id = ?", params: ["conversation:<id>"] }
   └─ When status === "complete": render summary, topics, action items
```

---

## Swapping out the external dependencies

| Component | Default | Cere alternative | What to change |
|---|---|---|---|
| Audio file storage | AssemblyAI upload endpoint | Cere DDC bucket | `uploadAndPublishChunk()` in `src/main.ts` |
| Transcription | AssemblyAI transcription API | Any STT service or self-hosted model | `agent/src/lib/transcribe.ts` + `fetch.allow` |
| LLM | Gemini 2.5 Flash (Google's cloud) | Self-hosted or any other API | `analyzeWithGemini()` in `agent/src/phrase-handler.ts` + `fetch.allow` |

---

## Confirmed failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `[ac] no audio_url — skipping` | Event payload missing `audio_url` field | Check client sends `audio_url`, not `audio` |
| AssemblyAI: "File does not appear to contain audio" | MediaRecorder timeslice blobs (fragmented WebM, no EBML header) | Use stop/start cycle — this repo already does |
| `[acp] no transcript chunks` | `audio.complete` sent before transcription jobs finished | Client waits 25s — don't reduce this |
| `[object Object]` error with 0 log lines | DB query threw a plain object before any logging | Fixed in this repo — polling loop has 2s sleep |
| Gemini JSON parse error | `responseMimeType: "application/json"` not set in generationConfig | Already set in this repo |
| 409 on publish | Version not bumped | Increment `version` in `agent/cef.config.ts` before every build |
| Events silently dropped, agent never runs | Agent service created in marketplace playground | Recreate in ROB |
| Old code still running after publish | Skipped disconnect/reconnect in marketplace | Disconnect old deployment, connect new one |
| Cubby query returns 404 | Using SDK `vault.cubbies.query()` method | Use raw HTTP path — already done in this repo |
| JWK 503 on wallet connect | `walletAppId` not registered with Cere | Use `cef-conv-recorder` — already set in `.env.example` |
| No results, browser stuck polling | Wrong wallet used in browser | Must be the same wallet used to connect agent in marketplace |
