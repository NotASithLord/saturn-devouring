import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LIVE_PROTOCOL_URL = 'https://charon.arieldeschapell.workers.dev/multiplayer/protocol.js';

function protocolVersion(source, label) {
  const match = source.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!match) throw new Error(`could not read the protocol version from ${label}`);
  return Number(match[1]);
}

const sourceVersion = protocolVersion(
  await readFile(join(ROOT, 'multiplayer', 'protocol.js'), 'utf8'),
  'multiplayer/protocol.js',
);
const builtVersion = protocolVersion(
  await readFile(join(ROOT, 'dist', 'site', 'multiplayer', 'protocol.js'), 'utf8'),
  'dist/site/multiplayer/protocol.js',
);
if (builtVersion !== sourceVersion) {
  throw new Error(`site build carries protocol v${builtVersion}, but source carries v${sourceVersion}`);
}

const response = await fetch(LIVE_PROTOCOL_URL, {
  cache: 'no-store',
  headers: { 'cache-control': 'no-cache' },
});
if (!response.ok) throw new Error(`could not verify the live protocol (${response.status})`);
const liveVersion = protocolVersion(await response.text(), LIVE_PROTOCOL_URL);
if (liveVersion > sourceVersion) {
  throw new Error(`refusing to roll the live co-op protocol back from v${liveVersion} to v${sourceVersion}`);
}

console.log(`deployment protocol check passed: live v${liveVersion} -> build v${builtVersion}`);
