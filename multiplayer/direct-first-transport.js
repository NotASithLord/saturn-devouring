import { createIceFallback } from './ice-fallback.js';

// Adapt peerd's channel contract while retaining signaling during the initial
// ICE restart. The room still owns its 15-second total connection deadline.
export function createDirectFirstTransport({ iceServers, getRelayIceServers,
  createBufferedChannel, RTCPeerConnection = globalThis.RTCPeerConnection,
  directTimeoutMs,
}) {
  const begin = ({ initiator, offer, signaling, signal }) => {
    if (!signaling?.send || !signaling?.onRemote) throw new Error('signaling is required');
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceTransportPolicy: 'all', iceServers });
    let opened = false;
    let closed = false;
    let off = () => {};
    let channel;
    let disconnectTimer;
    let descriptionSent = false;
    let localCandidates = [];
    const remoteCandidates = [];
    let resolve;
    let reject;
    const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
    // accept() returns the promise before joinRoom installs its await handler.
    void ready.catch(() => {});
    const cleanup = () => {
      fallback.stop();
      off();
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(disconnectTimer);
    };
    const close = (error = new Error('WebRTC connection closed')) => {
      if (closed) return;
      closed = true;
      cleanup();
      pc.close();
      channel?.signalClose();
      if (!opened) reject(error);
    };
    const onAbort = () => { if (!opened) close(new Error('WebRTC connection cancelled')); };
    const sendDescription = async (description, relayFallback = false) => {
      descriptionSent = false;
      localCandidates = [];
      await pc.setLocalDescription(description);
      if (closed) return;
      signaling.send({ type: description.type, sdp: pc.localDescription.sdp, relayFallback });
      descriptionSent = true;
      for (const ice of localCandidates.splice(0)) signaling.send({ ice });
    };
    const fallback = createIceFallback({ pc, getRelayIceServers,
      timeoutMs: directTimeoutMs,
      isConnected: () => opened || ['connected', 'completed'].includes(pc.iceConnectionState),
      restart: async () => {
        // Only the original offerer restarts, so the peers cannot glare.
        if (!initiator || closed || opened) return;
        await sendDescription(await pc.createOffer({ iceRestart: true }), true);
      },
      // A credential outage must not interrupt a direct attempt still running.
      onError: () => {},
    });
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || closed) return;
      const ice = candidate.toJSON ? candidate.toJSON() : candidate;
      if (descriptionSent) signaling.send({ ice });
      else localCandidates.push(ice);
    };
    const wire = (dc) => {
      dc.binaryType = 'arraybuffer';
      channel = createBufferedChannel({
        send: (message) => { if (dc.readyState === 'open') dc.send(JSON.stringify(message)); },
        close: () => { dc.close(); close(); },
      });
      channel.pc = pc;
      dc.onmessage = ({ data }) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
        if (bytes > 1_000_000) return;
        let message;
        try { message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
        catch { return; }
        channel.deliver(message);
      };
      dc.onclose = () => close();
      dc.onopen = () => {
        if (closed || opened) return;
        opened = true;
        cleanup();
        resolve(channel);
      };
      if (dc.readyState === 'open') dc.onopen();
    };
    if (initiator) wire(pc.createDataChannel('peerd', { ordered: true }));
    else pc.ondatachannel = ({ channel: dc }) => wire(dc);
    const stateChanged = () => {
      if (closed) return;
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        fallback.connected();
        clearTimeout(disconnectTimer);
        disconnectTimer = undefined;
      } else if (!opened && state === 'failed') {
        if (initiator) void fallback.tryFallback();
        // The responder waits for the offerer's restart, within room timeout.
      } else if (opened && (state === 'failed' || state === 'closed')) close();
      else if (opened && state === 'disconnected' && !disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          if (!['connected', 'completed'].includes(pc.iceConnectionState)) close();
        }, 5_000);
      }
    };
    pc.addEventListener('iceconnectionstatechange', stateChanged);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed') close();
      else if (pc.connectionState === 'failed') {
        if (opened) close();
        else if (initiator) void fallback.tryFallback();
      }
    });
    const setRemote = async (description) => {
      await pc.setRemoteDescription(description);
      for (const ice of remoteCandidates.splice(0)) await pc.addIceCandidate(ice).catch(() => {});
    };
    let queue = Promise.resolve();
    let fallbackOfferSeen = false;
    const receive = async (message) => {
      if (!message || closed || opened) return;
      if (message.type === 'offer' && !initiator) {
        if (message.relayFallback === true) {
          if (fallbackOfferSeen || !pc.remoteDescription) return;
          fallbackOfferSeen = true;
          try { await fallback.enable(); } catch { /* keep direct paths available */ }
        }
        await setRemote({ type: 'offer', sdp: message.sdp });
        await sendDescription(await pc.createAnswer());
      } else if (message.type === 'answer' && initiator) {
        await setRemote({ type: 'answer', sdp: message.sdp });
      } else if (message.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.ice).catch(() => {});
        else if (remoteCandidates.length < 64) remoteCandidates.push(message.ice);
      }
    };
    // Install before creating SDP so synchronous trickle/signaling is buffered.
    off = signaling.onRemote((message) => { queue = queue.then(() => receive(message)).catch(close); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const start = async () => {
      if (closed) return;
      if (initiator) {
        await sendDescription(await pc.createOffer());
        fallback.start();
      } else await receive(offer);
    };
    queue = queue.then(start).catch(close);
    return ready;
  };
  return {
    name: 'webrtc',
    canReach: () => 0.6,
    connect: (_peer, options) => begin({ ...options, initiator: true }),
    accept: async (options) => ({ channel: begin({ ...options, initiator: false }) }),
  };
}
