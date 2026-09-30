import { createIceFallback } from './ice-fallback.js';

// Saturn Devouring's standalone page uses the same audited native-media primitive as the
// peerd App parent. The dwapp path still keeps SDP, ICE, and MediaStreams on the
// trusted side of the bridge.
const MEDIA_MARKER = 1;
const MAX_PEERS = 15;
const MAX_SESSION = 64;
const MAX_SDP = 16_384;
const MAX_CANDIDATE = 4_096;
const MAX_PENDING_ICE = 64;
const MAX_SIGNALS_PER_WINDOW = 160;
const MAX_OFFERS_PER_WINDOW = 6;
const SIGNAL_WINDOW_MS = 10_000;
const MAX_SIGNAL_BYTES_PER_WINDOW = 256 * 1_024;
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
];

const mediaSessionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export function isRoomVoiceSignal(data) {
  if (data?.__peerdMedia !== MEDIA_MARKER || typeof data.kind !== 'string'
    || typeof data.scope !== 'string' || data.scope.length < 1 || data.scope.length > 64
    || typeof data.session !== 'string' || data.session.length < 12 || data.session.length > MAX_SESSION) return false;
  if (data.replyTo !== undefined && (typeof data.replyTo !== 'string'
    || data.replyTo.length < 12 || data.replyTo.length > MAX_SESSION)) return false;
  if (data.kind === 'ready') return typeof data.ack === 'boolean';
  if (data.kind === 'hangup') return data.replyTo === undefined;
  if (data.kind === 'offer' || data.kind === 'answer') {
    return typeof data.sdp === 'string' && data.sdp.length > 0 && data.sdp.length <= MAX_SDP
      && typeof data.replyTo === 'string';
  }
  if (data.kind !== 'ice' || typeof data.replyTo !== 'string') return false;
  return typeof data.candidate === 'string' && data.candidate.length <= MAX_CANDIDATE
    && (data.sdpMid === null || (typeof data.sdpMid === 'string' && data.sdpMid.length <= 64))
    && (data.sdpMLineIndex === null || (Number.isSafeInteger(data.sdpMLineIndex)
      && data.sdpMLineIndex >= 0 && data.sdpMLineIndex <= 64));
}

const isAudioOnlySdp = (sdp) => {
  const media = sdp.split(/\r?\n/).filter((line) => line.startsWith('m='));
  return media.length === 1 && media[0].startsWith('m=audio ');
};

const preferOpus = (transceiver) => {
  if (!transceiver.setCodecPreferences) return;
  const capabilities = globalThis.RTCRtpReceiver?.getCapabilities?.('audio')?.codecs ?? [];
  const opus = capabilities.filter((codec) => codec.mimeType?.toLowerCase() === 'audio/opus');
  if (!opus.length) return;
  try { transceiver.setCodecPreferences(opus); } catch { /* codec preference is optional */ }
};

export function createRoomVoice({
  selfDid,
  scope,
  sendSignal,
  onState = () => {},
  iceServers = DEFAULT_ICE_SERVERS,
  getRelayIceServers,
  RTCPeerConnection: PeerConnection = globalThis.RTCPeerConnection,
  mediaDevices = globalThis.navigator?.mediaDevices,
  createAudio = () => document.createElement('audio'),
}) {
  let stream = null;
  let muted = false;
  let playbackBlocked = false;
  let localSession = '';
  let generation = 0;
  let startInFlight = null;
  let allowedPeers = new Set();
  const remoteSessions = new Map();
  const connections = new Map();
  const signalQueues = new Map();
  const outboundQueues = new Map();
  const earlyIce = new Map();
  const peerFlow = new Map();
  const disconnectTimers = new Map();
  const state = () => ({ active: !!stream, muted, peers: connections.size, codec: 'opus', playbackBlocked });
  const report = () => onState(state());

  const send = (peer, signal) => {
    const queued = (outboundQueues.get(peer) ?? Promise.resolve())
      .catch(() => {})
      .then(() => sendSignal(peer, signal))
      .catch(() => {});
    outboundQueues.set(peer, queued);
    queued.finally(() => {
      if (outboundQueues.get(peer) === queued) outboundQueues.delete(peer);
    });
    return queued;
  };

  const closePeer = (peer, notify = false) => {
    const record = connections.get(peer);
    if (!record) return;
    connections.delete(peer);
    record.fallback?.stop();
    clearTimeout(record.connectTimer);
    const timer = disconnectTimers.get(peer);
    if (timer) clearTimeout(timer);
    disconnectTimers.delete(peer);
    record.pc.onicecandidate = null;
    record.pc.ontrack = null;
    record.pc.onconnectionstatechange = null;
    try { record.pc.close(); } catch { /* already closed */ }
    try { record.audio.pause(); } catch { /* detached element */ }
    record.audio.srcObject = null;
    record.audio.remove?.();
    if (notify && localSession) send(peer, {
      __peerdMedia: MEDIA_MARKER, scope, kind: 'hangup', session: localSession,
    });
    report();
  };

  const sendReady = (peer, ack) => {
    if (!stream || !localSession || !allowedPeers.has(peer)) return;
    send(peer, { __peerdMedia: MEDIA_MARKER, scope, kind: 'ready', session: localSession, ack });
  };

  const allowAllocation = (peer) => {
    const now = performance.now();
    let flow = peerFlow.get(peer);
    if (!flow || now - flow.started >= SIGNAL_WINDOW_MS) {
      flow = { started: now, signals: 0, sdps: 0, bytes: 0, allocations: 0 };
      peerFlow.set(peer, flow);
    }
    if (flow.allocations >= MAX_OFFERS_PER_WINDOW) return false;
    flow.allocations += 1;
    return true;
  };

  const makePeer = (peer, remoteSession) => {
    if (!PeerConnection) throw new Error('WebRTC voice is unavailable');
    if (!allowAllocation(peer)) return null;
    closePeer(peer);
    const pc = new PeerConnection({ iceServers });
    const audio = createAudio();
    audio.autoplay = true;
    audio.setAttribute?.('playsinline', '');
    const local = stream;
    const track = local?.getAudioTracks?.()[0];
    if (!local || !track) throw new Error('microphone track unavailable');
    try {
      const transceiver = pc.addTransceiver(track, { direction: 'sendrecv', streams: [local] });
      preferOpus(transceiver);
      if ('contentHint' in track) track.contentHint = 'speech';
      const parameters = transceiver.sender?.getParameters?.();
      if (parameters) {
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 48e3;
        Promise.resolve(transceiver.sender.setParameters(parameters)).catch(() => {});
      }
    } catch (error) {
      try { pc.close(); } catch { /* partial setup */ }
      audio.remove?.();
      throw error;
    }
    const record = { pc, audio, remoteSession, pendingIce: [] };
    connections.set(peer, record);
    record.fallback = createIceFallback({ pc, getRelayIceServers,
      restart: async () => {
        if (selfDid >= peer || connections.get(peer) !== record) return;
        const offer = await pc.createOffer({ iceRestart: true });
        if (connections.get(peer) !== record) return;
        await pc.setLocalDescription(offer);
        if (connections.get(peer) !== record) return;
        await send(peer, {
          __peerdMedia: MEDIA_MARKER, scope, kind: 'offer', session: localSession,
          replyTo: remoteSession, sdp: pc.localDescription.sdp, relayFallback: true,
        });
      },
    });
    record.connectTimer = setTimeout(() => {
      if (connections.get(peer) === record && pc.connectionState !== 'connected') closePeer(peer);
    }, 15_000);
    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate || connections.get(peer) !== record) return;
      send(peer, {
        __peerdMedia: MEDIA_MARKER,
        scope,
        kind: 'ice',
        session: localSession,
        replyTo: record.remoteSession,
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    };
    pc.ontrack = (event) => {
      if (connections.get(peer) !== record) return;
      const [remote] = event.streams;
      audio.srcObject = remote ?? new MediaStream([event.track]);
      Promise.resolve(audio.play?.()).then(() => {
        if (playbackBlocked) { playbackBlocked = false; report(); }
      }).catch(() => {
        if (!playbackBlocked) { playbackBlocked = true; report(); }
      });
    };
    pc.onconnectionstatechange = () => {
      if (connections.get(peer) !== record) return;
      if (pc.connectionState === 'connected') {
        record.wasConnected = true;
        record.fallback.stop();
        clearTimeout(record.connectTimer);
        const timer = disconnectTimers.get(peer);
        if (timer) clearTimeout(timer);
        disconnectTimers.delete(peer);
        report();
      } else if (pc.connectionState === 'disconnected' && !disconnectTimers.has(peer)) {
        disconnectTimers.set(peer, setTimeout(() => {
          disconnectTimers.delete(peer);
          if (connections.get(peer) === record && pc.connectionState === 'disconnected') {
            closePeer(peer);
            sendReady(peer, false);
          }
        }, 3_000));
      } else if (pc.connectionState === 'failed') {
        if (record.wasConnected) { closePeer(peer); sendReady(peer, false); return; }
        if (selfDid < peer) void record.fallback.tryFallback();
        // The answering peer waits for the caller's ICE restart.
      }
    };
    report();
    return record;
  };

  const makeOffer = async (peer, remoteSession) => {
    if (!stream || selfDid >= peer || !allowedPeers.has(peer)) return;
    const existing = connections.get(peer);
    if (existing && existing.remoteSession === remoteSession && existing.pc.signalingState !== 'closed') return;
    const record = makePeer(peer, remoteSession);
    if (!record) return;
    const offer = await record.pc.createOffer();
    if (connections.get(peer) !== record) return;
    await record.pc.setLocalDescription(offer);
    if (connections.get(peer) !== record || !record.pc.localDescription?.sdp) return;
    await send(peer, {
      __peerdMedia: MEDIA_MARKER, scope, kind: 'offer', session: localSession,
      replyTo: remoteSession, sdp: record.pc.localDescription.sdp,
    });
    record.fallback.start();
  };

  const flushIce = async (record) => {
    for (const candidate of record.pendingIce.splice(0)) {
      await record.pc.addIceCandidate(candidate).catch(() => {});
    }
  };

  const handleSignal = async (from, data) => {
    if (!isRoomVoiceSignal(data) || data.scope !== scope || !stream
      || !allowedPeers.has(from) || from === selfDid) return true;
    if (data.kind === 'ready') {
      const previous = remoteSessions.get(from);
      remoteSessions.set(from, data.session);
      if (previous && previous !== data.session) closePeer(from);
      if (!data.ack) sendReady(from, true);
      await makeOffer(from, data.session);
      return true;
    }
    if (data.kind === 'hangup') {
      if (remoteSessions.get(from) === data.session) {
        remoteSessions.delete(from);
        closePeer(from);
      }
      return true;
    }
    if (data.replyTo !== undefined && data.replyTo !== localSession) return true;
    if (data.kind === 'offer') {
      if (selfDid <= from || !isAudioOnlySdp(data.sdp)) return true;
      const previous = remoteSessions.get(from);
      if (previous && previous !== data.session) closePeer(from);
      remoteSessions.set(from, data.session);
      let record = connections.get(from);
      if (data.relayFallback === true) {
        // A fallback offer must follow a real direct attempt in this session.
        if (!record || record.remoteSession !== data.session || record.fallbackOfferSeen) return true;
        record.fallbackOfferSeen = true;
        try { await record.fallback.enable(); } catch { /* direct paths remain available */ }
        if (connections.get(from) !== record) return true;
      } else record = makePeer(from, data.session);
      if (!record) return true;
      const early = earlyIce.get(from);
      if (early?.session === data.session) record.pendingIce.push(...early.candidates);
      earlyIce.delete(from);
      await record.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await flushIce(record);
      const answer = await record.pc.createAnswer();
      if (connections.get(from) !== record) return true;
      await record.pc.setLocalDescription(answer);
      if (record.pc.localDescription?.sdp) await send(from, {
        __peerdMedia: MEDIA_MARKER, scope, kind: 'answer', session: localSession,
        replyTo: data.session, sdp: record.pc.localDescription.sdp,
      });
      return true;
    }
    const record = connections.get(from);
    if ((!record || record.remoteSession !== data.session) && data.kind === 'ice') {
      let early = earlyIce.get(from);
      if (!early || early.session !== data.session) {
        early = { session: data.session, candidates: [] };
        earlyIce.set(from, early);
      }
      if (early.candidates.length < MAX_PENDING_ICE) early.candidates.push({
        candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex,
      });
      return true;
    }
    if (!record || record.remoteSession !== data.session) return true;
    if (data.kind === 'answer') {
      if (selfDid >= from || record.pc.signalingState !== 'have-local-offer' || !isAudioOnlySdp(data.sdp)) return true;
      await record.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      await flushIce(record);
      return true;
    }
    const candidate = { candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex };
    if (!record.pc.remoteDescription) {
      if (record.pendingIce.length < MAX_PENDING_ICE) record.pendingIce.push(candidate);
    } else await record.pc.addIceCandidate(candidate).catch(() => {});
    return true;
  };

  const ingestSignal = (from, data) => {
    if (!isRoomVoiceSignal(data)) return Promise.resolve(false);
    const now = performance.now();
    let flow = peerFlow.get(from);
    if (!flow || now - flow.started >= SIGNAL_WINDOW_MS) {
      flow = { started: now, signals: 0, sdps: 0, bytes: 0, allocations: 0 };
      peerFlow.set(from, flow);
    }
    flow.signals += 1;
    if (data.kind === 'offer' || data.kind === 'answer') flow.sdps += 1;
    flow.bytes += data.sdp?.length ?? data.candidate?.length ?? 64;
    if (flow.signals > MAX_SIGNALS_PER_WINDOW || flow.sdps > MAX_OFFERS_PER_WINDOW
      || flow.bytes > MAX_SIGNAL_BYTES_PER_WINDOW) return Promise.resolve(true);
    const signalGeneration = generation;
    const queued = (signalQueues.get(from) ?? Promise.resolve())
      .catch(() => {})
      .then(() => (signalGeneration === generation ? handleSignal(from, data) : true));
    signalQueues.set(from, queued);
    queued.finally(() => {
      if (signalQueues.get(from) === queued) signalQueues.delete(from);
    });
    return queued;
  };

  const setPeers = (peers) => {
    const next = new Set(peers.filter((peer) => typeof peer === 'string' && peer && peer !== selfDid).slice(0, MAX_PEERS));
    for (const peer of allowedPeers) {
      if (!next.has(peer)) { closePeer(peer, true); remoteSessions.delete(peer); }
    }
    const added = [...next].filter((peer) => !allowedPeers.has(peer));
    allowedPeers = next;
    for (const peer of added) sendReady(peer, false);
    return { peers: allowedPeers.size };
  };

  const setMuted = (value) => {
    muted = !!value;
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted;
    report();
    return state();
  };

  const start = async ({ muted: startMuted = false, startMuted: legacyMuted } = {}) => {
    if (legacyMuted !== undefined) startMuted = legacyMuted;
    if (stream) return setMuted(startMuted);
    if (startInFlight) { await startInFlight; return setMuted(startMuted); }
    if (!PeerConnection || !mediaDevices?.getUserMedia) throw new Error('WebRTC microphone capture is unavailable');
    const token = ++generation;
    startInFlight = (async () => {
      const captured = await mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (token !== generation) {
        for (const track of captured.getTracks()) track.stop();
        throw new Error('microphone start was cancelled');
      }
      stream = captured;
      muted = !!startMuted;
      localSession = mediaSessionId();
      for (const track of stream.getAudioTracks()) {
        track.enabled = !muted;
        track.addEventListener?.('ended', () => {
          if (stream !== captured) return;
          for (const peer of [...connections.keys()]) closePeer(peer);
          stream = null;
          localSession = '';
          report();
        }, { once: true });
      }
      for (const peer of allowedPeers) sendReady(peer, false);
      report();
      return state();
    })();
    try { return await startInFlight; } finally { startInFlight = null; }
  };

  const stop = () => {
    generation += 1;
    for (const peer of allowedPeers) {
      if (localSession) send(peer, { __peerdMedia: MEDIA_MARKER, scope, kind: 'hangup', session: localSession });
    }
    for (const peer of [...connections.keys()]) closePeer(peer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    localSession = '';
    playbackBlocked = false;
    remoteSessions.clear();
    signalQueues.clear();
    outboundQueues.clear();
    earlyIce.clear();
    peerFlow.clear();
    for (const timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();
    report();
    return state();
  };

  const forget = (peer) => {
    closePeer(peer);
    allowedPeers.delete(peer);
    remoteSessions.delete(peer);
    signalQueues.delete(peer);
    outboundQueues.delete(peer);
    earlyIce.delete(peer);
    peerFlow.delete(peer);
  };

  const resumePlayback = async () => {
    playbackBlocked = false;
    for (const record of connections.values()) {
      if (!record.audio.srcObject) continue;
      try { await record.audio.play?.(); } catch { playbackBlocked = true; }
    }
    report();
    return state();
  };

  return Object.freeze({ start, stop, setMuted, setPeers, ingestSignal, resumePlayback, forget, status: state });
}
