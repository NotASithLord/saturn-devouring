// Build the deployed SITE: the same tree the Worker serves today, but with the
// game's module graph bundled and minified instead of shipped as ~60 raw ES
// modules.
//
// WHY THIS EXISTS. wrangler.jsonc used to point at "." — the repo as-is — so
// every comment and blank line in the source went over the wire, and the browser
// paid a request per module. Measured on the game path: 2,078 KB gzipped raw vs
// 1,758 KB bundled+minified, so ~320 KB and a few dozen round-trips.
//
// Stripping the comments out of the SOURCE would have bought 177 KB of that and
// cost the reasoning that keeps this codebase debuggable. Minification is the
// superset: it takes the comments AND mangles identifiers AND drops dead code,
// and the source stays readable.
//
// WHAT THIS MUST NOT BREAK — the game is already hand-split into three load
// stages, and they are load-bearing:
//   1. launcher.js          — the menu, wanted immediately
//   2. import('./main.js')  — the whole engine, warmed after the menu paints;
//                            common renderer setup runs, then seed-dependent
//                            world/sim evaluation pauses until play
//   3. import('./peerd-browser.js') (83 KB) — only if you join a mesh game
// A plain `esbuild --bundle` flattens all three into one file, so the menu
// would block on the entire engine plus a multiplayer client most sessions
// never touch. `splitting: true` keeps each dynamic import its own chunk, which
// preserves the staging. Verify that by counting the emitted chunks, not by
// trusting the flag.
//
// Everything that is NOT the game (sim/, fused/, vat/, the test pages) is
// mirrored verbatim: those are dev surfaces, they load their own modules, and
// bundling them buys nothing worth the risk of breaking them.

import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'site');

// Kept in step with .assetsignore — anything here is tooling, not the site.
const SKIP = new Set([
  '.git', '.claude', '.wrangler', 'node_modules', 'dist', 'docs', 'scripts',
  'dwapp', '.assetsignore', 'wrangler.jsonc', 'wrangler.legacy.jsonc',
  'package.json', 'package-lock.json', 'README.md', '.gitignore',
  'worker.js', 'legacy-worker.js', 'worker-check.mjs',
]);

async function mirror(from, to) {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (SKIP.has(name)) continue;
    const src = join(from, name), dst = join(to, name);
    const s = await stat(src);
    if (s.isDirectory()) await mirror(src, dst);
    else await cp(src, dst);
  }
}

// The entry tags carry cache-busting queries (`./launcher.js?v=3`, and
// launcher.js itself does `import('./main.js?v=1')`). esbuild resolves the
// literal path and would fail on the query, so strip it at resolve time and let
// the content hash in the emitted chunk names do the cache-busting instead.
const stripQuery = {
  name: 'strip-version-query',
  setup(b) {
    b.onResolve({ filter: /\?v=\d+$/ }, (args) => ({
      path: join(args.resolveDir, args.path.replace(/\?v=\d+$/, '')),
    }));
  },
};

await rm(OUT, { recursive: true, force: true });
await mirror(ROOT, OUT);

const result = await build({
  entryPoints: [join(ROOT, 'game', 'launcher.js')],
  outdir: join(OUT, 'game'),
  bundle: true,
  splitting: true,       // keeps the three load stages as separate chunks
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  metafile: true,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  plugins: [stripQuery],
  // assets stay real files at their existing relative paths — the bundle lands
  // in game/ exactly where launcher.js was, so every './assets/...' still hits
  loader: { '.css': 'empty' },
});

const chunks = Object.keys(result.metafile.outputs);
if (chunks.length < 3) {
  throw new Error(`expected the dynamic imports to split into separate chunks, got ${chunks.length}: `
    + `${chunks.join(', ')} — the launcher would block on the whole engine`);
}

// point the page at the built entry (same name, no ?v= — the chunk hashes bust)
const page = join(OUT, 'game', 'index.html');
const html = await readFile(page, 'utf8');
await writeFile(page, html.replace(/\.\/launcher\.js\?v=\d+/, './launcher.js'));

let total = 0;
for (const [f, o] of Object.entries(result.metafile.outputs)) total += o.bytes;
console.log(`bundled the game into ${chunks.length} chunks, ${(total / 1024).toFixed(0)} KB total:`);
for (const [f, o] of Object.entries(result.metafile.outputs)) {
  console.log(`  ${(o.bytes / 1024).toFixed(0).padStart(6)} KB  ${f.replace(OUT + '/', '')}`);
}
console.log(`site built at dist/site/ — wrangler.jsonc serves it.`);
