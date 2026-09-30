#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PEERD = resolve(process.env.PEERD_SOURCE || join(ROOT, '..', 'peerd'));
const scratch = await mkdtemp(join(tmpdir(), 'saturn-devouring-peerd-compat-'));
const testFile = join(scratch, 'saturn-devouring-artifact.test.ts');
const exportModule = join(PEERD, 'extension', 'peerd-engine', 'export.js');
const artifact = join(ROOT, 'dwapp', 'saturn-devouring.peerd');
const source = `
import { test, expect } from 'bun:test';
import { inspectEnvelope, openEnvelope } from ${JSON.stringify(exportModule)};

test('Saturn Devouring release envelope opens through Peerd import primitives', async () => {
  const envelope = JSON.parse(await Bun.file(${JSON.stringify(artifact)}).text());
  const inspected = await inspectEnvelope(envelope);
  expect(inspected.ok).toBe(true);
  if (!inspected.ok) throw new Error(inspected.error);
  expect(inspected.summary.kind).toBe('app');
  expect(inspected.summary.fileCount).toBe(58);
  const opened = await openEnvelope(envelope);
  expect(opened.entry).toBe('index.html');
  expect(Object.keys(opened.files)).toHaveLength(58);
  expect(opened.fileKinds['index.html']).toBe('text');
  expect(opened.fileKinds['assets/sounds/boom.wav']).toBe('binary');
  const appManifest = JSON.parse(new TextDecoder().decode(opened.files['peerd.json']));
  expect(appManifest.agent).toMatchObject({ kind: 'bound-app', profile: 'developer', surface: 'code' });
  expect(appManifest.agent.runtime).toEqual(['observe', 'act']);
  expect(appManifest.capabilities).toEqual(['dweb']);
}, 30_000);
`;

try {
  await writeFile(testFile, source);
  const run = spawnSync('bun', ['test', testFile, '--preload', join(PEERD, 'tests', 'setup.ts')], {
    cwd: PEERD,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
