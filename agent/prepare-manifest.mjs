import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(__dirname, 'dist/voice-agent/manifest.json'), 'utf8'));

const { source, issuedAt, nonce, ...clean } = raw;
// agentId and agentServicePubkey are already set from cef.config.ts at build time
// This script just strips the fields ROB rejects

const out = resolve(__dirname, '../manifest-publish.json');
writeFileSync(out, JSON.stringify(clean, null, 2));
console.log(`✓ manifest-publish.json written (version ${clean.version})`);
console.log(`  Upload this file to ROB → publish → disconnect old → connect new`);
