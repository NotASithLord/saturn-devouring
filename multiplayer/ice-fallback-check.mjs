import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createIceFallback } from './ice-fallback.js';
import { createDirectFirstTransport } from './direct-first-transport.js';
import { createBufferedChannel } from './peerd-browser.js';
const direct = [{ urls: 'stun:example.test:3478' }];
const relay = [{ urls: 'turn:example.test:3478', username: 'test', credential: 'test' }];
const isRelay = (pc) => pc.config.iceServers.some(s => s.urls.startsWith('turn:'));
class PC extends EventTarget {
  static all = [];
  static directWorks = true;
  constructor(config) {
    super(); this.config = config; PC.all.push(this);
    this.signalingState = 'stable'; this.iceConnectionState = 'new'; this.connectionState = 'new';
  }
  getConfiguration() { return this.config; }
  setConfiguration(config) { this.config = config; }
  createDataChannel() {
    return this.dc = { readyState: 'connecting', send() {}, close() { this.readyState = 'closed'; } };
  }
  async createOffer(options) { this.restart = !!options?.iceRestart; return { type: 'offer', sdp: this.restart ? 'restart' : 'direct' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(desc) { this.localDescription = desc; this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    if (desc.type === 'offer' && !this.dc) { this.createDataChannel(); this.ondatachannel?.({ channel: this.dc }); }
    if (desc.type === 'answer') {
      this.signalingState = 'stable';
      if (PC.directWorks || PC.all.every(isRelay)) queueMicrotask(() => PC.all.forEach(pc => pc.open()));
    }
  }
  async addIceCandidate() {}
  open() {
    if (this.signalingState === 'closed') return;
    this.iceConnectionState = this.connectionState = 'connected';
    this.dispatchEvent(new Event('iceconnectionstatechange'));
    this.dc.readyState = 'open'; this.dc.onopen?.();
  }
  close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
}
async function pair(directWorks) {
  PC.all = []; PC.directWorks = directWorks;
  let calls = 0;
  const transport = createDirectFirstTransport({ iceServers: direct, createBufferedChannel,
    RTCPeerConnection: PC, directTimeoutMs: 20,
    getRelayIceServers: async () => { calls++; return relay; },
  });
  const ac = new AbortController();
  let caller, responder, accepted;
  const pending = [];
  const outgoing = { onRemote: h => { caller = h; return () => { caller = null; }; },
    send: message => queueMicrotask(() => {
      if (responder) responder(message);
      else if (message.type === 'offer') {
        accepted = transport.accept({ offer: message, signaling: incoming, signal: ac.signal });
      } else pending.push(message);
    }),
  };
  const incoming = { onRemote: h => { responder = h; for (const m of pending.splice(0)) h(m); return () => { responder = null; }; },
    send: message => queueMicrotask(() => caller?.(message)),
  };
  const channel = await transport.connect({}, { signaling: outgoing, signal: ac.signal });
  const remote = await (await accepted).channel;
  await sleep(30);
  assert.equal(calls, directWorks ? 0 : 2);
  assert.equal(PC.all.length, 2, 'ICE restart reuses both peer connections');
  assert(PC.all.every(pc => isRelay(pc) === !directWorks));
  assert(!channel.isClosed() && !remote.isClosed());
  ac.abort(); // room aborts its setup controller after admission
  assert(!channel.isClosed(), 'setup abort must preserve an admitted channel');
  channel.close(); remote.close();
}
await pair(true);
await pair(false);

// A late credential response must not switch a now-connected direct peer.
const pc = new PC({ iceServers: direct });
let release;
let restarts = 0;
const f = createIceFallback({ pc, getRelayIceServers: () => new Promise(r => { release = r; }), restart: () => { restarts++; } });
const pending = f.tryFallback();
pc.iceConnectionState = 'connected'; release(relay); await pending;
assert.equal(restarts, 0); assert.equal(isRelay(pc), false); f.stop();

// Cancellation removes timers and does not mint credentials.
let calls = 0;
const cancelled = createIceFallback({ pc: new PC({ iceServers: direct }), timeoutMs: 5,
  getRelayIceServers: async () => { calls++; return relay; }, restart() {},
});
cancelled.start(); cancelled.stop(); await sleep(10); assert.equal(calls, 0);

// Explicit ICE failure uses the same single retry, with no parallel requests.
const failed = new PC({ iceServers: direct });
failed.iceConnectionState = 'failed';
const retry = createIceFallback({ pc: failed,
  getRelayIceServers: async () => { calls++; return relay; }, restart: () => { restarts++; },
});
await Promise.all([retry.tryFallback(), retry.tryFallback()]);
assert.equal(calls, 1); assert.equal(restarts, 1); retry.stop();
console.log('direct-first ICE: direct success, two-sided relay restart, late success, cancellation, single retry ✓');
