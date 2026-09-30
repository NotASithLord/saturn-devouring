#!/usr/bin/env node
// Bundles the browser-facing subset of peerd's audited room primitives for
// Saturn Devouring's standalone web build. The peerd dwapp never loads this path at
// runtime because its trusted parent bridge owns the network.

import { build } from 'esbuild';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PEERD = resolve(process.env.PEERD_SOURCE || join(ROOT, '..', 'peerd'));
const EXTENSION = join(PEERD, 'extension');
const OUT = join(ROOT, 'multiplayer', 'peerd-browser.js');

await access(join(EXTENSION, 'peerd-distributed', 'index.js'));
await mkdir(dirname(OUT), { recursive: true });

await build({
  stdin: {
    contents: [
      "export { generateIdentity } from './peerd-distributed/identity/keypair.js';",
      "export { createBufferedChannel } from './peerd-distributed/transport/channel.js';",
      "export { DEFAULT_ICE_SERVERS } from './peerd-distributed/transport/peer.js';",
      "export { joinRoom } from './peerd-distributed/transport/rooms.js';",
      "export { createGossip } from './peerd-distributed/gossip/topic.js';",
      "export { createTopicSync, createMemoryTopicStore } from './peerd-distributed/gossip/sync.js';",
      "export { createPresence } from './peerd-distributed/gossip/presence.js';",
      "export { createDirect } from './peerd-distributed/messaging/direct.js';",
    ].join('\n'),
    resolveDir: EXTENSION,
    sourcefile: 'saturn-devouring-peerd-browser-entry.js',
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  charset: 'utf8',
  outfile: OUT,
  legalComments: 'inline',
  plugins: [{
    name: 'peerd-extension-absolute-paths',
    setup(bundle) {
      bundle.onResolve({ filter: /^\/shared\// }, (args) => ({ path: join(EXTENSION, args.path.slice(1)) }));
    },
  }],
});

// why normalize: esbuild annotates modules with their source path. The peerd
// checkout may be a sibling locally or a release-stage directory in CI; keeping
// one logical prefix prevents identical vendor bytes from producing path-only
// diffs.
const bundled = await readFile(OUT, 'utf8');
await writeFile(OUT, bundled.replace(/^\/\/ .*?\/extension\//gm, '// peerd/extension/'));

// Execute the browser-format module in Node as a no-DOM smoke test. This
// catches UMD/ESM wrapper mistakes that compile successfully but initialize an
// empty codec namespace when the retained-topic transport is imported.
const smoke = await import(`${pathToFileURL(OUT).href}?smoke=${Date.now()}`);
for (const name of [
  'generateIdentity', 'joinRoom', 'createGossip', 'createTopicSync',
  'createMemoryTopicStore', 'createPresence', 'createDirect',
]) {
  if (typeof smoke[name] !== 'function') throw new Error(`vendored browser primitive missing: ${name}`);
}
if (!Array.isArray(smoke.DEFAULT_ICE_SERVERS) || smoke.DEFAULT_ICE_SERVERS.length < 2) {
  throw new Error('vendored browser direct ICE configuration missing');
}

console.log(`bundled peerd browser primitives → ${OUT}`);
