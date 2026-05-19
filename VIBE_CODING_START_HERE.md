# Vibe Coding on Cere CEF — Start Here (Vault Edition)

Everything you need to ship an agent on Cere CEF using the vault-centric architecture.
The old ROB-agent-service guide is at `VIBE_CODING_START_HERE.legacy.md` — most of it is obsolete.

---

## Mental model (vault-centric)

```
Connector pushes an event via VaultSDK
  → scope.publish({ type, target, context, payload })
    → Vault routes to the engagement matching the target agent ID
      → @OnEvent(type) method runs in the vault runtime
        → ctx.cubby("alias").exec(sql, params)  — write
        → ctx.cubby("alias").query(sql, params) — read
        → ctx.publish(type, payload)            — chain to next event (separate invocation)
```

**No streams. No workspaces. No deployments. No CEF_AUTH_TOKEN needed in the connector.**
The vault routes entirely by `target` = `{agentServicePubKey}:{agentId}`.

---

## Environments

| | Devnet | Testnet (stage) |
|---|---|---|
| ROB / Marketplace UI | `rob.compute.dev.ddcdragon.com` | `rob.compute.test.ddcdragon.com` |
| Vault API | `vault-api.compute.dev.ddcdragon.com` | `vault-api.compute.test.ddcdragon.com` |
| GAR URL | `gar.compute.dev.ddcdragon.com` | `gar.compute.test.ddcdragon.com` |
| Auth token audience | `wallet.dev.cere.io` | `wallet.stage.cere.io` |

Get a token: log into ROB → DevTools → Network (filter `veri`) → click `verify` request → Response tab → copy the `eyJ...` JWT. Token is 7-day. Environment-specific — devnet token will fail on testnet.

---

## Project structure

```
cef-integration/
├── vault/
│   ├── src/
│   │   └── graph-ingest-handler.ts   # canonical handler — @Engagement + @OnEvent
│   ├── dist/
│   │   └── sot-wiki-graph/
│   │       ├── manifest-upload.json  # signed manifest — upload to marketplace
│   │       └── bundle.js             # compiled bundle (included in manifest)
│   └── .env                          # vault build env (VAULT_API, WALLET_PATH, etc.)
├── connector/
│   ├── stream.js                     # VaultSDK wrapper — pushes events to vault
│   ├── notion.js                     # Notion sync loop (calls stream.js)
│   └── notion-helper.js              # Notion API helpers, canonical event shape
├── cef.config.yaml                   # legacy config — still used for cubby migrations ref
│                                     # NOT used for stream/deployment routing anymore
└── docs/
    ├── VIBE_CODING_START_HERE.md     # this file
    └── VIBE_CODING_START_HERE.legacy.md  # old ROB agent-service guide
```

---

## Step 1 — Write a handler

Handlers live in `vault/src/`. They use `@cef-ai/agent-sdk` decorators.

```typescript
// vault/src/my-handler.ts
import { Engagement, OnEvent } from '@cef-ai/agent-sdk';

@Engagement({ id: 'my-agent' })   // ← must match agentId in cef.config.ts (without pubkey prefix)
export class MyHandler {

  @OnEvent('MY_EVENT_TYPE')
  async onMyEvent(event: any, ctx: any) {
    const payload = event.payload;  // no double-wrap in vault SDK (unlike old testnet)

    // Write
    const db = ctx.cubby('ws_2220');
    await db.exec('INSERT INTO nodes (id, type, attribute) VALUES (?, ?, ?)',
      [id, 'artifact', JSON.stringify(data)]);

    // Read
    const result = await db.query('SELECT * FROM nodes WHERE id = ?', [id]);
    const rows = result.rows ?? [];  // guard: query returns null not [] on empty

    // Chain to next event (separate invocation — writes above are committed first)
    await ctx.publish('NEXT_EVENT_TYPE', { someId: id });
  }

  @OnEvent('NEXT_EVENT_TYPE')
  async onNextEvent(event: any, ctx: any) {
    // This runs in a fresh invocation — can read rows written by onMyEvent
  }
}
```

### Handler rules

| Rule | Why |
|---|---|
| All event types under ONE `@Engagement` class | Vault routes by engagement id — separate classes/ids = separate agents |
| `event.payload` directly (no double-unwrap) | Vault SDK doesn't double-wrap unlike old testnet `params?.payload ?? params` |
| `ctx.cubby("alias")` not `ctx.cubbies.alias` | New vault SDK API. Old: `ctx.cubbies.ws_2220.query('default', ...)`. New: `ctx.cubby("ws_2220").query(sql, params)` |
| No `instanceId` arg | Old API required `'default'` as first arg. New API: just `db.exec(sql, params)` |
| `result.rows ?? []` on every query | Vault returns `null` not `[]` on empty result — reading `.length` on null throws |
| `ctx.publish()` for chaining | Fire-and-forget into a new invocation. The only way to read your own writes in the same logical flow. |
| Writes NOT visible to reads in the same invocation | `.exec()` and `.query()` hit separate endpoints. Commit happens between invocations. Design your flow accordingly. |

### Cubby alias convention

Code accesses cubbies by alias (`ws_2220`). The alias is stable across agent service migrations — don't hardcode cubby IDs anywhere. The vault SDK resolves the alias to the correct cubby for the current agent service.

---

## Step 2 — Build the manifest

```bash
cd vault/
node node_modules/@cef-ai/cli/dist/cli.js build   # or: pnpm exec cef build
```

Output lands in `vault/dist/{agentId}/`:
- `bundle.js` — compiled bundle
- `manifest.json` — raw manifest
- `manifest-upload.json` — signed, ready to upload

The `agentId` in `manifest-upload.json` will be `{agentServicePubKey}:{id}` where `id` is from your `cef.config.ts`.

**After building:** open `manifest-upload.json` and note the `agentId` field. This is what `CEF_VAULT_AGENT_ID` in `.env` must be set to.

---

## Step 3 — Upload and reconnect

1. Go to `rob.compute.test.ddcdragon.com` (or devnet equivalent)
2. Navigate to your agent service → **Playground** or **Marketplace**
3. Upload `vault/dist/{agentId}/manifest-upload.json`
4. After upload, go to **Agent Marketplace** → find your agent → click **Reconnect**

**Reconnect is required.** Without it the vault agent isn't subscribed and events arrive but no jobs trigger. You must reconnect after every new manifest upload.

---

## Step 4 — Configure and run the connector

The connector (`connector/stream.js`) uses `@cef-ai/vault-sdk` to push events.

### Required env vars (`cef-integration/.env`)

```bash
# Vault SDK
CEF_VAULT_URL=https://vault-api.compute.test.ddcdragon.com
CEF_VAULT_AGENT_ID=d4d8138fad0954dac8276350f303619021ea4ee38005efee09417e73320b4627:sot-wiki-graph
CEF_VAULT_SCOPE=default

# Wallet (Substrate/ed25519 keystore JSON)
CEF_WALLET_PATH=./wallet.json
CEF_WALLET_PASSPHRASE=claude

# Notion + Gemini (for connector scripts)
NOTION_API_KEY=...
GEMINI_API_KEY=...
```

`CEF_AUTH_TOKEN` is **not needed** by the connector anymore (VaultSDK authenticates with the wallet directly).

### Connector pattern (`connector/stream.js`)

```javascript
const { VaultSDK, CereWallet } = await import('@cef-ai/vault-sdk');

const wallet = await CereWallet.fromKeystore(WALLET_JSON, WALLET_PASS);
const sdk    = new VaultSDK({ endpoint: VAULT_URL, garEndpoint: GAR_URL, wallet });
const vault  = await sdk.vault.current();
const scope  = vault.scope(SCOPE);

await scope.publish({
  type:    'ARTIFACT_INGEST',      // event type — must match @OnEvent in handler
  target:  AGENT_ID,               // {pubKey}:{agentId} from manifest
  context: `artifact-${ref}`,      // groups related events (use a stable ID like pageId)
  payload: canonicalEvent,         // your data
});
```

`@cef-ai/vault-sdk` is public on npm. Install: `npm install @cef-ai/vault-sdk`.

---

## Step 5 — Deploy to VPS

The syncer runs in Docker. Key things to know:

### Volume shadows image files

The syncer has `volumes: - sync_state:/app/connector`. This means:
- `docker compose build syncer` rebuilds the image with new files in `connector/` ✅
- But the volume mounts OVER `/app/connector/` at runtime — new image files are hidden ❌

**To update connector files on a running syncer:**
```bash
docker cp ./connector/stream.js server-syncer-1:/app/connector/stream.js
```

Or force-recreate the container (the volume persists, but since the volume was initialised from the image, its contents survive):
```bash
docker compose up -d --force-recreate syncer
```

### Env vars require force-recreate

`docker compose restart` keeps the old env. To pick up `.env` changes:
```bash
docker compose up -d --force-recreate syncer
```

Verify the env is live:
```bash
docker exec server-syncer-1 env | grep CEF_VAULT
```

### Installing packages on VPS without private registry access

`@cef-ai/vault-sdk` is public but some of its peer packages (`@cef-ai/deploy-cli`) aren't. Running `npm install @cef-ai/vault-sdk` on VPS triggers a full dependency tree install that fails on private packages.

**Workaround — copy from local:**
```bash
# On local machine:
cd cef-integration/node_modules/@cef-ai
tar czf /tmp/vault-sdk.tgz vault-sdk
cd ../../../node_modules/@noble
tar czf /tmp/noble-ed25519.tgz ed25519   # vault-sdk dep not already on VPS

# SCP to VPS:
scp /tmp/vault-sdk.tgz /tmp/noble-ed25519.tgz root@64.225.27.134:/tmp/

# Extract on VPS:
cd /opt/projectsot/cef-integration/node_modules/@cef-ai && tar xzf /tmp/vault-sdk.tgz
cd /opt/projectsot/cef-integration/node_modules/@noble && tar xzf /tmp/noble-ed25519.tgz
```

### Syncer cursor reset

The syncer stores `lastRunAt` in `/var/lib/docker/volumes/server_sync_state/_data/.sync-state.json`. To force-resync recent pages:

```bash
echo '{"lastRunAt": "2026-05-18T00:00:00.000Z"}' > /var/lib/docker/volumes/server_sync_state/_data/.sync-state.json
docker exec server-syncer-1 node connector/notion.js
```

---

## Step 6 — Verify end-to-end

1. **Events tab** in ROB → should show `ARTIFACT_INGEST` events arriving under your scope
2. **Jobs tab** in ROB → should show new jobs for your engagement (if not: reconnect in marketplace)
3. **Cubby** in ROB → query `SELECT COUNT(*) FROM nodes` to confirm writes landed

### Debugging: events arrive but no jobs trigger

1. Check `target` in the published event matches the manifest `agentId` exactly (`{pubKey}:{agentId}`, not `{pubKey}:{engagementId}`)
2. Go to Agent Marketplace → Reconnect (agent not subscribed)
3. Check vault agent version in ROB matches the uploaded manifest version

### Debugging: 400 errors from connector

The old `@cef-ai/client-sdk` stream-based connector will get 400s when pushed to streams that don't belong to the current agent service. If you see 400s: confirm `connector/stream.js` is the new VaultSDK version, not the legacy one.

---

## Hard-won lessons

### 1. `target` = `{pubKey}:{agentId}`, not `{pubKey}:{engagementId}`

The manifest has both:
```json
{ "agentId": "d4d8138f...:sot-wiki-graph",  // ← use this for CEF_VAULT_AGENT_ID
  "engagements": [{ "id": "graph-ingest-handler" }]  // ← NOT this
}
```
Using the engagement id as target → events arrive in vault Events tab but zero jobs trigger.

### 2. Reconnect after every manifest upload

Uploading a manifest to the playground/marketplace does NOT automatically subscribe the agent to incoming events. You must hit **Reconnect** in the Agent Marketplace UI after each upload. Symptom: events land, 0 jobs.

### 3. ctx.publish() is the only way to read your own writes

Within a single invocation: `.exec()` writes to the cubby but `.query()` in the same invocation won't see them (different endpoints, no shared transaction). To chain ingest → eval:

```typescript
// ✅ correct — eval runs in a fresh invocation after ingest commits
await ctx.publish('EVAL_REQUESTED', { artifactId, version });

// ❌ wrong — evalPage() queries cubby but the artifact isn't committed yet
const result = await evalPage(ctx, { artifactId, version });
```

### 4. All event types must be on one @Engagement class

If you split handlers across two classes with different `@Engagement({ id })` values, you effectively have two separate agents. All five event types (`ARTIFACT_INGEST`, `EVAL_REQUESTED`, `ADD_CONTEXT_EDGE`, `TRANSCRIPT_PUSH`, `NIGHTLY_EMBED`) must be `@OnEvent` methods on the same class. Separate engagement entries in an old-style manifest → events for the other entries silently dropped.

### 5. Agent must be created in ROB, not playground

Playground-created agent services don't get a runtime subscription. Create the agent service in **ROB → Agent Services** (not playground), then upload the manifest to the marketplace/playground from there.

### 6. CEF_AUTH_TOKEN is still needed — but not by the connector

`CEF_AUTH_TOKEN` is used by:
- The cef CLI (`cef deploy`) for deploying manifests, cubbies
- cef-proxy for sending events via the old client-sdk path

It is NOT used by `VaultSDK` / connector. VaultSDK authenticates with the wallet directly.

Token is 7-day. Get fresh from ROB DevTools → Network → `verify` → Response. Update both `deploy/.env` and `cef-integration/.env` on VPS, then `docker compose up -d --force-recreate cef-proxy` + restart syncer.

### 7. `cef.config.yaml` is legacy infrastructure

In the vault model, `cef.config.yaml` is no longer used for stream/deployment routing. Keep it for cubby migration reference but don't spend time trying to deploy streams/workspaces from it. The vault routes by target, not by stream selectors.

### 8. Vault SDK result shape

```typescript
// cubby query returns:
{ rows: [...] | null }   // null on empty, not []
// Always guard:
const rows = result.rows ?? [];
```

---

## Reference: VPS services map

| Container | Stack | Role |
|---|---|---|
| `server-syncer-1` | `cef-integration/server/` | Notion → vault syncer (runs every 10min) |
| `deploy-cef-proxy-1` | `deploy/` | `/cef-sync-page`, `/cef-retrieve` etc |
| `deploy-deno-1` | `deploy/` | Main API server |
| `deploy-caddy-1` | `deploy/` | Reverse proxy (handles CORS) |
| `deploy-postgres-1` | `deploy/` | Postgres (RAG pipeline) |

Syncer source: `cef-integration/server/` compose. All others: `deploy/` compose.

After updating `.env` for syncer: `cd cef-integration/server && docker compose up -d --force-recreate syncer`
After updating `.env` for cef-proxy: `cd deploy && docker compose up -d --force-recreate cef-proxy`
