import { createDirectFirstTransport } from './direct-first-transport.js';
import { createDwebClient } from './dweb-client.js';
import { createRoomVoice, isRoomVoiceSignal } from './voice.js';

const scopedTopic = (scope, topic) => `charon/${scope || 'lobby'}/${topic}`;
const PEER_FAILURE_EVENTS = new Set(['room_dial_failed', 'room_accept_failed']);
const TURN_CREDENTIALS_PATH = '/api/turn-credentials';
const isBrowserRelayUrl = (url) => typeof url === 'string' && url.startsWith('turn')
  && !/^turns?:[^/?#]+:53(?:[/?#]|$)/i.test(url);

function cancelledJoinError() {
  const error = new Error('co-op join cancelled');
  error.code = 'JOIN_CANCELLED';
  return error;
}

export class PeerConnectionError extends Error {
  constructor({ relayAvailable = false } = {}) {
    super(relayAvailable
      ? 'Another player reached matchmaking, but WebRTC timed out even with relay fallback. Check whether the VPN or firewall allows WebRTC, then try again.'
      : 'Another player reached matchmaking, but the WebRTC data channel timed out. Direct connectivity was blocked by a VPN, NAT, or firewall, and relay credentials were unavailable.');
    this.name = 'PeerConnectionError';
    this.code = 'PEER_CONNECTION_FAILED';
  }
}

export class SignalingConnectionError extends Error {
  constructor({ cause } = {}) {
    super('Could not reach the co-op matchmaking service. Check the connection and try again.', { cause });
    this.name = 'SignalingConnectionError';
    this.code = 'SIGNALING_UNAVAILABLE';
  }
}

export class RelayCredentialsError extends Error {
  constructor({ cause } = {}) {
    super('WebRTC relay credentials are temporarily unavailable.', { cause });
    this.name = 'RelayCredentialsError';
    this.code = 'TURN_UNAVAILABLE';
  }
}

// The vendored room transport reports both initiator and responder ICE
// failures through its audit seam. Converting those low-level events here
// keeps networking internals out of the launcher while giving people an
// honest, actionable error instead of a false singleton lobby.
export function peerConnectionFailure(event, options) {
  return PEER_FAILURE_EVENTS.has(event) ? new PeerConnectionError(options) : null;
}

export async function fetchRelayIceServers({ fetcher = fetch, signal } = {}) {
  let response;
  try {
    response = await fetcher(TURN_CREDENTIALS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal,
    });
  } catch (cause) {
    throw new RelayCredentialsError({ cause });
  }
  if (!response.ok) throw new RelayCredentialsError();
  const payload = await response.json().catch(() => null);
  const iceServers = payload?.iceServers;
  const relayServers = Array.isArray(iceServers) ? iceServers.flatMap((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    const relayUrls = [...new Set(urls.filter(isBrowserRelayUrl))];
    if (!relayUrls.length || typeof server?.username !== 'string' || typeof server?.credential !== 'string') return [];
    return [{ ...server, urls: Array.isArray(server.urls) ? relayUrls : relayUrls[0] }];
  }) : [];
  if (!relayServers.length) throw new RelayCredentialsError();
  return relayServers;
}

async function browserCapacity(room) {
  const samples = await Promise.all(room.peers().map(async (peer) => {
    try {
      const stats = await peer.channel?.pc?.getStats?.();
      let selected = null;
      stats?.forEach((row) => {
        if (row.type === 'candidate-pair' && (row.selected || (row.nominated && row.state === 'succeeded'))) selected = row;
      });
      return selected ? {
        outMbps: Number(selected.availableOutgoingBitrate || 0) / 1e6,
        rttMs: Number(selected.currentRoundTripTime || 0) * 1_000,
      } : null;
    } catch { return null; }
  }));
  const valid = samples.filter(Boolean);
  const connection = navigator.connection;
  const cores = Math.max(1, Math.min(16, Number(navigator.hardwareConcurrency) || 2));
  const memory = Math.max(1, Math.min(16, Number(navigator.deviceMemory) || 4));
  const measured = valid.map((sample) => sample.outMbps).filter((value) => value > 0);
  const outMbps = measured.length ? Math.min(...measured) : Math.max(0, Math.min(50, Number(connection?.downlink) || 5));
  const rttValues = valid.map((sample) => sample.rttMs).filter((value) => value > 0);
  const rttMs = rttValues.length ? rttValues.reduce((sum, value) => sum + value, 0) / rttValues.length : 80;
  const score = Math.max(0, Math.min(1_000, Math.round(
    cores * 12 + memory * 7 + Math.min(100, outMbps) * 5 - Math.min(200, rttMs) * 0.35
      - (connection?.saveData ? 120 : 0),
  )));
  // Signed peerd envelopes use an integer-only canonical numeric form.
  return { score, outMbps: Math.round(outMbps), rttMs: Math.round(rttMs) };
}

class SessionBase {
  constructor({ roomId, name, did, transport }) {
    this.roomId = roomId;
    this.name = name;
    this.did = did;
    this.transport = transport;
    this.scope = '';
    this.members = new Map();
    this.listeners = new Map();
    this.topicOff = new Map();
    this.allowedVoicePeers = new Set();
    this.supportsCapacity = false;
    this.supportsVoice = false;
  }

  emit(event, value) {
    // A LISTENER THAT THROWS MUST NOT TAKE THE SESSION WITH IT. `report()` in
    // the voice stack is the LAST statement of makePeer, so an exception
    // raised by a UI listener propagated back through it: makePeer never
    // returned its record, makeOffer never sent an offer, and voice silently
    // failed to connect in BOTH directions. One bad HUD line should cost a
    // HUD line, not the call.
    for (const callback of this.listeners.get(event) ?? []) {
      try { callback(value); } catch (error) { console.error('[saturn-devouring] session listener failed', event, error); }
    }
  }

  on(event, callback) {
    const group = this.listeners.get(event) ?? new Set();
    group.add(callback);
    this.listeners.set(event, group);
    return () => group.delete(callback);
  }

  setScope(scope) {
    this.scope = String(scope || '');
  }

  roster() {
    return [{ did: this.did, name: this.name, self: true }, ...this.members.values()];
  }

  setVoicePeers(peers) {
    const next = new Set((peers ?? []).filter((did) => typeof did === 'string' && did !== this.did));
    if (next.size === this.allowedVoicePeers.size && [...next].every((did) => this.allowedVoicePeers.has(did))) return false;
    this.allowedVoicePeers = next;
    return true;
  }
}

export class BridgeSession extends SessionBase {
  constructor(args) {
    super({ ...args, transport: 'peerd' });
    this.client = args.client;
    this.unsubscribers = [];
    this.operations = new Set(args.operations ?? []);
    this.supportsCapacity = this.operations.has('capacity');
    this.supportsVoice = [
      'voice-start', 'voice-peers', 'voice-mute', 'voice-status', 'voice-unlock', 'voice-stop',
    ].every((op) => this.operations.has(op));
  }

  async subscribe(topic, callback) {
    const wire = scopedTopic(this.scope, topic);
    if (!this.topicOff.has(wire)) {
      await this.client.call('subscribe', { topic: wire });
      const off = this.client.on('message', (message) => {
        if (message?.topic === wire) this.emit(`topic:${wire}`, message);
      });
      this.topicOff.set(wire, off);
    }
    return this.on(`topic:${wire}`, callback);
  }

  publish(topic, data, { retain = false } = {}) {
    return this.client.call('publish', { topic: scopedTopic(this.scope, topic), data, retain });
  }

  retain(topic) {
    return this.client.call('retain', { topic: scopedTopic(this.scope, topic) });
  }

  history(topic) {
    return this.client.call('history', { topic: scopedTopic(this.scope, topic) });
  }

  sendDirect(to, data) {
    return this.client.call('dm-send', { to, data });
  }

  capacity() {
    return this.supportsCapacity
      ? this.client.call('capacity')
      : Promise.resolve({ score: 0, outMbps: 0, rttMs: 0 });
  }

  setVoicePeers(peers) {
    if (!super.setVoicePeers(peers)) return;
    if (this.supportsVoice) {
      this.client.call('voice-peers', { peers: [...this.allowedVoicePeers] }).catch(() => {});
    }
  }

  startVoice(options = {}) {
    if (!this.supportsVoice) return Promise.reject(new Error('voice is unavailable in this Peerd bridge'));
    return this.client.call('voice-start', {
      muted: !!options.startMuted,
      peers: [...this.allowedVoicePeers],
    }, 30_000);
  }

  setVoiceMuted(muted) {
    if (!this.supportsVoice) return Promise.reject(new Error('voice is unavailable in this Peerd bridge'));
    return this.client.call('voice-mute', { muted: !!muted });
  }

  voiceStatus() {
    if (!this.supportsVoice) return Promise.resolve({ active: false, muted: false, unavailable: true });
    return this.client.call('voice-status');
  }

  resumeVoicePlayback() {
    if (!this.supportsVoice) return Promise.reject(new Error('voice is unavailable in this Peerd bridge'));
    return this.client.call('voice-unlock');
  }

  stopVoice() {
    if (!this.supportsVoice) return Promise.resolve({ active: false, muted: false, unavailable: true });
    return this.client.call('voice-stop');
  }

  async refreshPresence() {
    const present = await this.client.call('presence');
    this.members.clear();
    for (const peer of present ?? []) {
      if (!peer?.did || peer.did === this.did) continue;
      this.members.set(peer.did, { did: peer.did, name: peer.meta?.name || '' });
    }
    this.emit('roster', this.roster());
    return this.roster();
  }

  async close() {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const off of this.topicOff.values()) off();
    this.topicOff.clear();
    try { await this.client.call('leave'); } catch { /* parent may already be gone */ }
    this.client.dispose();
  }
}

async function bridgeSession({ roomId, name, signal }) {
  const client = createDwebClient();
  const onAbort = () => client.dispose();
  if (signal?.aborted) { client.dispose(); throw cancelledJoinError(); }
  signal?.addEventListener('abort', onAbort, { once: true });
  let hello;
  try { hello = await client.hello(); }
  catch (error) {
    client.dispose();
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw cancelledJoinError();
    error.code = 'BRIDGE_UNAVAILABLE';
    throw error;
  }
  if (!hello?.available) {
    client.dispose();
    signal?.removeEventListener('abort', onAbort);
    const error = new Error('peerd bridge unavailable');
    error.code = 'BRIDGE_UNAVAILABLE';
    throw error;
  }
  let joined;
  // A host may leave this pending on explicit user consent. The bridge owns
  // cancellation/rollback; the frame must not invent a short consent timer.
  try { joined = await client.call('join', { roomId, name }, 0); }
  catch (error) {
    client.dispose();
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw cancelledJoinError();
    throw error;
  }
  // Bridge v0 advertises no optional media/RTC-stat surface. Future hosts may
  // add an explicit operations list without making old hosts receive unknown
  // RPCs that fail after a lobby has otherwise joined successfully.
  const operations = Array.isArray(hello.operations) ? hello.operations.filter((op) => typeof op === 'string') : [];
  const session = new BridgeSession({ roomId, name, did: joined.did, client, operations });
  const updateMember = ({ did, meta } = {}) => {
    if (!did || did === session.did) return;
    session.members.set(did, { did, name: meta?.name || session.members.get(did)?.name || '' });
    session.emit('roster', session.roster());
  };
  const dropMember = ({ did } = {}) => {
    if (did && session.members.delete(did)) {
      session.emit('peer-leave', did);
      session.emit('roster', session.roster());
    }
  };
  session.unsubscribers.push(
    client.on('presence-join', updateMember),
    client.on('presence-leave', dropMember),
    client.on('peer-gone', dropMember),
    client.on('direct', (message) => session.emit('direct', message)),
  );
  try {
    await client.call('announce', { meta: { name } });
    await session.refreshPresence();
  } catch (error) {
    await session.close().catch(() => {});
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw cancelledJoinError();
    throw error;
  }
  signal?.removeEventListener('abort', onAbort);
  return session;
}

class BrowserSession extends SessionBase {
  constructor(args) {
    super({ ...args, transport: 'web' });
    this.room = args.room;
    this.gossip = args.gossip;
    this.sync = args.sync;
    this.presence = args.presence;
    this.direct = args.direct;
    this.identity = args.identity;
    this.unsubscribers = args.unsubscribers;
    this.supportsCapacity = true;
    this.supportsVoice = true;
    this.requestedVoicePeers = new Set();
    this.voice = createRoomVoice({
      selfDid: this.did,
      scope: this.roomId,
      iceServers: args.iceServers,
      getRelayIceServers: args.getRelayIceServers,
      sendSignal: (to, signal) => this.direct.send(to, signal),
      onState: (status) => this.emit('voice', status),
    });
  }

  async subscribe(topic, callback) {
    const wire = scopedTopic(this.scope, topic);
    const off = this.gossip.subscribe(wire, callback);
    this.topicOff.set(`${wire}:${this.topicOff.size}`, off);
    return off;
  }

  async publish(topic, data, { retain = false } = {}) {
    const wire = scopedTopic(this.scope, topic);
    const envelope = retain ? await this.sync.publish(wire, data) : await this.gossip.publish(wire, data);
    return { id: envelope.id, ts: envelope.ts };
  }

  retain(topic) {
    this.sync.retain(scopedTopic(this.scope, topic));
    return Promise.resolve({ ok: true });
  }

  history(topic) {
    const wire = scopedTopic(this.scope, topic);
    return Promise.resolve(this.sync.history(wire).map((env) => ({
      topic: wire,
      from: env.from,
      data: env.body.data,
      ts: env.ts,
      id: env.id,
    })));
  }

  sendDirect(to, data) {
    return this.direct.send(to, data);
  }

  capacity() {
    return browserCapacity(this.room);
  }

  setVoicePeers(peers) {
    this.requestedVoicePeers = new Set(peers ?? []);
    const supported = [...this.requestedVoicePeers]
      .filter((did) => this.members.get(did)?.mediaVoice === 1);
    if (!super.setVoicePeers(supported)) return;
    this.voice.setPeers([...this.allowedVoicePeers]);
  }

  startVoice(options = {}) {
    return this.voice.start({ muted: !!options.startMuted });
  }

  setVoiceMuted(muted) {
    return Promise.resolve(this.voice.setMuted(muted));
  }

  voiceStatus() {
    return Promise.resolve(this.voice.status());
  }

  resumeVoicePlayback() {
    return this.voice.resumePlayback();
  }

  stopVoice() {
    return Promise.resolve(this.voice.stop());
  }

  async refreshPresence() {
    this.members.clear();
    const announced = new Map(this.presence.list().map((peer) => [peer.did, peer]));
    // The authenticated room mesh is the liveness source of truth. Presence
    // metadata can arrive one message later than the WebRTC HELLO, so merging
    // both prevents an existing peer from being invisible to a fresh joiner.
    for (const peer of this.room.peers()) {
      if (!peer?.did || peer.did === this.did) continue;
      const known = announced.get(peer.did) ?? peer;
      this.members.set(peer.did, {
        did: peer.did,
        name: known.meta?.name || this.members.get(peer.did)?.name || '',
        mediaVoice: known.meta?.mediaVoice,
      });
    }
    this.emit('roster', this.roster());
    return this.roster();
  }

  async close() {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const off of this.topicOff.values()) off();
    this.topicOff.clear();
    this.presence.close();
    this.voice.stop();
    this.direct.close();
    this.sync.close();
    this.gossip.close();
    this.room.leave();
  }
}

async function browserSession({ roomId, name, identity: suppliedIdentity, signal }) {
  if (!globalThis.RTCPeerConnection || !globalThis.WebSocket || !globalThis.crypto?.subtle) {
    const error = new Error('This browser does not provide the WebRTC and WebCrypto features co-op requires.');
    error.code = 'BROWSER_UNSUPPORTED';
    throw error;
  }
  const {
    DEFAULT_ICE_SERVERS, createBufferedChannel, generateIdentity, joinRoom, createGossip, createPresence, createDirect,
    createTopicSync, createMemoryTopicStore,
  } = await import('./peerd-browser.js?v=3');
  const identity = suppliedIdentity ?? await generateIdentity();
  let room;
  let gossip;
  let sync;
  let presence;
  let direct;
  let session;
  let transportFailure = null;
  let relayIceServers;
  const unsubscribers = [];
  try {
    const iceServers = DEFAULT_ICE_SERVERS;
    const getRelayIceServers = async (options) => {
      const servers = await fetchRelayIceServers(options);
      relayIceServers = servers;
      return servers;
    };
    const transport = createDirectFirstTransport({
      iceServers, getRelayIceServers, createBufferedChannel,
    });
    try {
      room = await joinRoom({
        roomId,
        identity,
        kind: 'website',
        iceServers, transport,
        audit(event) {
          const failure = peerConnectionFailure(event, { relayAvailable: !!relayIceServers });
          if (!failure) return;
          transportFailure = failure;
          session?.emit('transport-status', { state: 'failed', error: failure });
        },
      });
    } catch (error) {
      if (signal?.aborted) throw cancelledJoinError();
      if (error instanceof PeerConnectionError) throw error;
      throw new SignalingConnectionError({ cause: error });
    }
    if (signal?.aborted) throw cancelledJoinError();
    // A rendezvous member answered, but every ICE path failed. Treating that
    // as an empty room is what made both players create believable singleton
    // lobbies. Fail the join while the incumbent gets the matching status
    // event from its responder path.
    if (transportFailure && room.peers().length === 0) throw transportFailure;
    gossip = createGossip({ mesh: room.mesh });
    sync = createTopicSync({ mesh: room.mesh, gossip, store: createMemoryTopicStore() });
    presence = createPresence({ gossip, selfDid: identity.did, meta: () => ({ name, mediaVoice: 1 }) });
    direct = createDirect({ mesh: room.mesh });
    session = new BrowserSession({
      roomId, name, did: identity.did, identity, room, gossip, sync, presence, direct,
      iceServers, getRelayIceServers, unsubscribers,
    });
  unsubscribers.push(
    room.onPeer(({ did } = {}) => {
      if (!did || did === session.did) return;
      transportFailure = null;
      session.emit('transport-status', { state: 'connected' });
      if (!session.members.has(did)) {
        session.members.set(did, { did, name: '' });
        session.emit('roster', session.roster());
      }
      // A newcomer could not have heard the beacon sent before its data
      // channel existed. Reannounce as soon as the authenticated link opens.
      Promise.resolve(presence.announce()).catch(() => {});
      session.setVoicePeers([...session.requestedVoicePeers]);
    }),
    presence.onJoin(({ did, meta }) => {
      session.members.set(did, { did, name: meta?.name || '', mediaVoice: meta?.mediaVoice });
      session.emit('roster', session.roster());
      session.setVoicePeers([...session.requestedVoicePeers]);
    }),
    presence.onLeave(({ did }) => {
      session.members.delete(did);
      session.allowedVoicePeers.delete(did);
      session.voice.forget(did);
      session.emit('peer-leave', did);
      session.emit('roster', session.roster());
    }),
    room.onPeerGone(({ did }) => {
      // Presence emits synchronously when it knew the peer. A link synthesized
      // before its first beacon still needs the same immediate leave path.
      presence.forget(did);
      if (did && session.members.delete(did)) {
        session.allowedVoicePeers.delete(did);
        session.voice.forget(did);
        session.emit('peer-leave', did);
        session.emit('roster', session.roster());
      }
    }),
    direct.onMessage(({ from, data }) => {
      if (isRoomVoiceSignal(data)) {
        if (session.allowedVoicePeers.has(from) && session.voice.status().active) {
          session.voice.ingestSignal(from, data).catch(() => {});
        }
        return;
      }
      session.emit('direct', { from, data });
    }),
  );
  presence.start();
  await presence.announce();
  await session.refreshPresence();
  return session;
  } catch (error) {
    for (const off of unsubscribers.splice(0)) off();
    try { presence?.close(); } catch { /* partial setup */ }
    try { direct?.close(); } catch { /* partial setup */ }
    try { sync?.close(); } catch { /* partial setup */ }
    try { gossip?.close(); } catch { /* partial setup */ }
    try { room?.leave(); } catch { /* partial setup */ }
    throw error;
  }
}

export async function joinMultiplayerRoom(options) {
  try {
    return await bridgeSession(options);
  } catch (bridgeError) {
    if (bridgeError?.code !== 'BRIDGE_UNAVAILABLE') throw bridgeError;
    try {
      return await browserSession(options);
    } catch (browserError) {
      browserError.bridgeError = bridgeError;
      throw browserError;
    }
  }
}
