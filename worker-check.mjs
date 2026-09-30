import assert from 'node:assert/strict';
import worker, { turnCredentials } from './worker.js';
import legacyWorker from './legacy-worker.js';

const origin = 'https://saturn-devouring.example';
const legacyOrigin = 'https://charon.example';
const request = () => new Request(`${origin}/api/turn-credentials`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: '{}',
});
const iceServers = [
  { urls: ['stun:stun.cloudflare.com:53', 'stun:stun.cloudflare.com:3478'] },
  {
    urls: [
      'turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: 'short-lived-user',
    credential: 'short-lived-secret',
  },
];
const browserIceServers = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'short-lived-user',
    credential: 'short-lived-secret',
  },
];
let upstreamRequest;
const response = await turnCredentials(request(), {
  TURN_KEY_ID: 'turn-key-id',
  TURN_KEY_TOKEN: 'turn-key-token',
}, {
  createIdentifier: () => 'test-client',
  fetcher: async (url, options) => {
    upstreamRequest = { url, options };
    return Response.json({ iceServers }, { status: 201 });
  },
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.deepEqual(await response.json(), { iceServers: browserIceServers });
assert.match(upstreamRequest.url, /turn-key-id\/credentials\/generate-ice-servers$/);
assert.equal(upstreamRequest.options.headers.authorization, 'Bearer turn-key-token');
assert.deepEqual(JSON.parse(upstreamRequest.options.body), { ttl: 21_600, customIdentifier: 'saturn-devouring-test-client' });

const denied = await turnCredentials(new Request(`${origin}/api/turn-credentials`, {
  method: 'POST',
  headers: { origin: 'https://attacker.example' },
}), { TURN_KEY_ID: 'id', TURN_KEY_TOKEN: 'token' });
assert.equal(denied.status, 403);
assert.equal((await denied.json()).error.code, 'ORIGIN_DENIED');

const unavailable = await turnCredentials(request(), {
  TURN_KEY_ID: 'id',
  TURN_KEY_TOKEN: 'token',
}, { fetcher: async () => new Response('', { status: 502 }) });
assert.equal(unavailable.status, 503);
assert.equal((await unavailable.json()).error.code, 'TURN_UNAVAILABLE');

const asset = new Response('asset');
const served = await worker.fetch(new Request(`${origin}/game/`), { ASSETS: { fetch: async () => asset } });
assert.equal(served, asset);

let boundRequest;
const bound = await worker.fetch(request(), { LEGACY_API: { fetch: async (incoming) => {
  boundRequest = incoming;
  return Response.json({ iceServers: browserIceServers });
} } });
assert.equal(bound.status, 200);
assert.equal(boundRequest.url, request().url, 'the new origin stays same-origin through the service binding');

const oldGame = await legacyWorker.fetch(new Request(`${legacyOrigin}/game/?seed=test`, {
  headers: { accept: 'text/html' },
}), { ASSETS: { fetch: async () => asset } });
assert.equal(oldGame.status, 308);
assert.equal(oldGame.headers.get('location'),
  'https://saturn-devouring.arieldeschapell.workers.dev/game/?seed=test');
const oldAsset = await legacyWorker.fetch(new Request(`${legacyOrigin}/game/launcher.js`), {
  ASSETS: { fetch: async () => asset },
});
assert.equal(oldAsset, asset, 'already-open old pages must still load their assets');
const oldApi = await legacyWorker.fetch(new Request(`${legacyOrigin}/api/turn-credentials`, {
  method: 'POST', headers: { origin: legacyOrigin }, body: '{}',
}), {});
assert.equal(oldApi.status, 503, 'the legacy API stays on the old origin');

console.log('TURN credential worker ✓');
