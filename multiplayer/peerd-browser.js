var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// peerd/extension/peerd-distributed/codec/base58.js
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var BASE = 58;
var LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();
var base58encode = (bytes) => {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const input = Array.from(bytes);
  const out = [];
  let start = zeros;
  while (start < input.length) {
    let remainder = 0;
    for (let i = start; i < input.length; i++) {
      const acc = (remainder << 8) + input[i];
      input[i] = Math.floor(acc / BASE);
      remainder = acc % BASE;
    }
    out.push(remainder);
    while (start < input.length && input[start] === 0) start++;
  }
  let str = "1".repeat(zeros);
  for (let i = out.length - 1; i >= 0; i--) str += ALPHABET[out[i]];
  return str;
};
var base58decode = (str) => {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const digits = [];
  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const val = code < 128 ? LOOKUP[code] : -1;
    if (val < 0) throw new Error(`base58decode: invalid character '${str[i]}'`);
    let carry = val;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * BASE;
      digits[j] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 255);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) {
    out[zeros + digits.length - 1 - i] = digits[i];
  }
  return out;
};

// peerd/extension/peerd-distributed/identity/did.js
var ED25519_PUB_PREFIX = Uint8Array.from([237, 1]);
var DID_PREFIX = "did:key:z";
var DID_KEY_LENGTH = 56;
var encodeDidKey = (pubkey32) => {
  if (!(pubkey32 instanceof Uint8Array) || pubkey32.length !== 32) {
    throw new Error("encodeDidKey: expected a 32-byte Ed25519 public key");
  }
  const tagged = new Uint8Array(2 + 32);
  tagged.set(ED25519_PUB_PREFIX, 0);
  tagged.set(pubkey32, 2);
  return DID_PREFIX + base58encode(tagged);
};
var decodeDidKey = (did) => {
  if (typeof did !== "string" || did.length !== DID_KEY_LENGTH || !did.startsWith(DID_PREFIX)) {
    throw new Error("decodeDidKey: not a did:key:z… string");
  }
  const tagged = base58decode(did.slice(DID_PREFIX.length));
  if (tagged.length !== 34 || tagged[0] !== 237 || tagged[1] !== 1) {
    throw new Error("decodeDidKey: unsupported key type (peerd is Ed25519-only)");
  }
  return tagged.slice(2);
};

// peerd/extension/shared/bundle/bytes.js
var utf8 = (s) => new TextEncoder().encode(s);
var toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var toBase64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
var fromBase64 = (s) => {
  base64ByteLength(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
var base64ByteLength = (s) => {
  if (typeof s !== "string") throw new Error("base64 must be a string");
  const length = s.length;
  if ((length & 3) !== 0) throw new Error("invalid base64");
  let padding = 0;
  if (length && s.charCodeAt(length - 1) === 61) padding += 1;
  if (length > 1 && s.charCodeAt(length - 2) === 61) padding += 1;
  const dataLength = length - padding;
  let lastValue = 0;
  for (let index = 0; index < dataLength; index++) {
    const code = s.charCodeAt(index);
    let value = -1;
    if (code >= 65 && code <= 90) value = code - 65;
    else if (code >= 97 && code <= 122) value = code - 71;
    else if (code >= 48 && code <= 57) value = code + 4;
    else if (code === 43) value = 62;
    else if (code === 47) value = 63;
    if (value < 0) throw new Error("invalid base64");
    lastValue = value;
  }
  for (let index = dataLength; index < length; index++) {
    if (s.charCodeAt(index) !== 61) throw new Error("invalid base64");
  }
  if (padding === 2 && (lastValue & 15) !== 0 || padding === 1 && (lastValue & 3) !== 0) {
    throw new Error("invalid base64");
  }
  return s.length / 4 * 3 - padding;
};
var concat = (...arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

// peerd/extension/peerd-distributed/identity/keypair.js
var generateIdentity = async () => {
  const kp = (
    /** @type {CryptoKeyPair} */
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const did = encodeDidKey(pubRaw);
  const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    kp.privateKey,
    /** @type {BufferSource} */
    bytes
  ));
  return { did, publicKey: pubRaw, sign };
};
var PKCS8_ED25519_PREFIX = Uint8Array.from([
  48,
  46,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  112,
  4,
  34,
  4,
  32
]);
var MATERIAL_PROOF = new TextEncoder().encode("peerd/identity-material-proof/v1");
var importVerifyKey = (pubkey32) => crypto.subtle.importKey(
  "raw",
  /** @type {BufferSource} */
  pubkey32,
  { name: "Ed25519" },
  true,
  ["verify"]
);
var verifySignature = async (did, signature, bytes) => {
  const key = await importVerifyKey(decodeDidKey(did));
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    /** @type {BufferSource} */
    signature,
    /** @type {BufferSource} */
    bytes
  );
};

// peerd/extension/peerd-distributed/transport/channel.js
var createBufferedChannel = ({ send, close } = (
  /** @type {{ send: (msg: any) => void }} */
  {}
)) => {
  let handler = null;
  let closed = false;
  const backlog = [];
  const closeCbs = /* @__PURE__ */ new Set();
  const chan = {
    /** @param {any} msg */
    send: (msg) => {
      if (!closed) send(msg);
    },
    // Called by the transport when a message arrives.
    /** @param {any} msg */
    deliver(msg) {
      if (closed) return;
      if (handler) handler(msg);
      else backlog.push(msg);
    },
    // Install (or clear, with null) the handler. Flushes the backlog.
    /** @param {((msg: any) => void) | null} fn */
    setHandler(fn) {
      handler = fn;
      if (fn) while (backlog.length) fn(backlog.shift());
    },
    isClosed: () => closed,
    // Fires once, immediately if already closed. Returns unsubscribe.
    /** @param {() => void} cb */
    onClose(cb) {
      if (closed) {
        cb();
        return () => {
        };
      }
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },
    // Transport-side: the pipe is gone (remote close, failure, or local
    // close() below). Idempotent.
    signalClose() {
      if (closed) return;
      closed = true;
      for (const cb of [...closeCbs]) cb();
      closeCbs.clear();
    },
    // Local hang-up: tear down the underlying transport too.
    close() {
      if (closed) return;
      try {
        close?.();
      } catch {
      }
      chan.signalClose();
    }
  };
  return chan;
};

// peerd/extension/peerd-distributed/transport/ice.js
var DirectPathUnavailableError = class extends Error {
  /** @param {{ local?: CandidateSummary, remote?: CandidateSummary }} [ends] */
  constructor({ local, remote } = {}) {
    const fmt = (s) => s ? `host6:${s.host6} host6ll:${s.host6ll} host4:${s.host4} srflx:${s.srflx} mdns:${s.mdns} relay:${s.relay}` : "unknown";
    const llOnly = local && remote && local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const tail = llOnly ? "and only LINK-LOCAL IPv6 (fe80::, does not route across networks)." : "with no global IPv6 path.";
    super(
      `no direct path between peers — local[${fmt(local)}] remote[${fmt(remote)}]. peerd ships no TURN relay (NORTH-STAR D-5): no routable path — symmetric-NAT IPv4 ${tail} This failure is surfaced, not silently relayed.`
    );
    this.name = "DirectPathUnavailableError";
    this.local = local;
    this.remote = remote;
  }
};
var summarizeCandidates = (sdp = "") => {
  const sum = { host4: 0, host6: 0, host6ll: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 };
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = line.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/);
    if (!m) continue;
    const [, addr, typ] = m;
    if (typ === "host") {
      if (addr.toLowerCase().endsWith(".local")) sum.mdns += 1;
      else if (addr.includes(":")) {
        if (/^fe80/i.test(addr)) sum.host6ll += 1;
        else sum.host6 += 1;
      } else sum.host4 += 1;
    } else if (typ in sum) {
      sum[
        /** @type {keyof CandidateSummary} */
        typ
      ] += 1;
    }
  }
  return sum;
};
var famOf = (addr) => addr && String(addr).includes(":") ? "ipv6" : "ipv4";
var connectionPath = async (pc) => {
  try {
    const stats = await pc.getStats();
    const byId = /* @__PURE__ */ new Map();
    stats.forEach((s) => byId.set(s.id, s));
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s.selected || s.nominated && s.state === "succeeded")) pair = s;
      });
    }
    if (!pair) return { path: "unknown" };
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const fam = famOf(local?.address ?? local?.ip ?? remote?.address ?? remote?.ip);
    const types = [local?.candidateType, remote?.candidateType];
    const kind = types.includes("relay") ? "relay" : types.some((t) => t === "srflx" || t === "prflx") ? "srflx" : "host";
    return {
      path: kind === "host" ? `direct-${fam}` : `direct-${fam}-${kind}`,
      family: fam,
      local: local?.candidateType ?? "unknown",
      remote: remote?.candidateType ?? "unknown"
    };
  } catch {
    return { path: "unknown" };
  }
};

// peerd/extension/peerd-distributed/log.js
var DWEB_LOG = true;
var on = () => DWEB_LOG && typeof window !== "undefined" && /** @type {Record<string, unknown>} */
globalThis.__DWEB_LOG__ !== false;
var BADGE = "background:#c4319b;color:#fff;font-weight:bold;border-radius:3px;padding:0 4px";
var TAG = "color:#c4319b;font-weight:bold";
var dlog = (tag, ...args) => {
  if (!on()) return;
  try {
    console.log(`%c DWEB %c ${tag} `, BADGE, TAG, ...args);
  } catch {
  }
};
var dwarn = (tag, ...args) => {
  if (!on()) return;
  try {
    console.warn(`%c DWEB %c ${tag} `, "background:#d04545;color:#fff;font-weight:bold;border-radius:3px;padding:0 4px", "color:#d04545;font-weight:bold", ...args);
  } catch {
  }
};

// peerd/extension/peerd-distributed/transport/peer.js
var DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "stun:stun.relay.metered.ca:80" }
  // :80 also slips past some 3478-blocking firewalls
];
var DISCONNECT_GRACE_MS = 5e3;
var MAX_DATA_CHANNEL_FRAME_BYTES = 1e6;
var decode = (data) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  if (bytes > MAX_DATA_CHANNEL_FRAME_BYTES) throw new Error("data-channel frame too large");
  return JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
};
var createPeer = ({
  initiator,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  config = { iceServers: DEFAULT_ICE_SERVERS },
  onCandidate = null
} = {}) => {
  if (!RTCPeerConnection) throw new Error("createPeer: WebRTC unavailable in this context");
  const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", iceTransportPolicy: "all", ...config });
  if (onCandidate) {
    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) onCandidate(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    });
  }
  const pendingRemote = [];
  const MAX_PENDING_REMOTE = 64;
  const setRemote = async (desc) => {
    await pc.setRemoteDescription(desc);
    while (pendingRemote.length) {
      try {
        await pc.addIceCandidate(
          /** @type {RTCIceCandidateInit} */
          pendingRemote.shift()
        );
      } catch (e) {
        dwarn("webrtc", `addIceCandidate (flush) failed: ${/** @type {{ message?: string }} */
        e?.message ?? e}`);
      }
    }
  };
  const addRemoteCandidate = async (candidate) => {
    if (!candidate) return;
    if (!pc.remoteDescription) {
      if (pendingRemote.length >= MAX_PENDING_REMOTE) {
        dwarn("webrtc", "dropping ICE candidate — pre-description buffer full");
        return;
      }
      pendingRemote.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      dwarn("webrtc", `addIceCandidate failed: ${/** @type {{ message?: string }} */
      e?.message ?? e}`);
    }
  };
  let resolveChannel;
  let rejectChannel;
  const channelReady = new Promise((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });
  const failDirect = () => {
    const local = summarizeCandidates(pc.localDescription?.sdp);
    const remote = summarizeCandidates(pc.remoteDescription?.sdp);
    const llOnly = local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const why = llOnly ? "the IPv6 host candidates are LINK-LOCAL only (fe80::, don't route across networks) and IPv4 is symmetric-NAT — no path." : "symmetric-NAT IPv4 with no global IPv6 — no path.";
    dlog("webrtc", `no direct path to this peer (expected without TURN — D-5: ${why}). local ${JSON.stringify(local)}, remote ${JSON.stringify(remote)}`);
    rejectChannel(new DirectPathUnavailableError({ local, remote }));
  };
  pc.addEventListener("iceconnectionstatechange", () => {
    dlog("webrtc", `ICE ${initiator ? "(initiator)" : "(responder)"} state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") failDirect();
  });
  const wire = (dc) => {
    dc.binaryType = "arraybuffer";
    const channel = (
      /** @type {ReturnType<typeof createBufferedChannel> & { pc?: RTCPeerConnection }} */
      createBufferedChannel({
        // why guard readyState: the RTCDataChannel can be 'connecting' (a
        // send racing ahead of onopen) or 'closing'/'closed' (the remote
        // vanished — a closed tab rarely sends a clean DC close — before
        // onclose / the connection-state handlers flip the buffered channel
        // shut). dc.send() in any non-'open' state throws InvalidStateError,
        // which surfaced as an uncaught rejection in the offscreen doc.
        // Drop the datagram instead: this is best-effort mesh traffic
        // (gossip / presence / DHT) that re-gossips and multi-hops, so a
        // frame lost to a dying peer is recoverable — the throw was not.
        send: (obj) => {
          if (dc.readyState === "open") dc.send(JSON.stringify(obj));
          else dlog("webrtc", `drop send — data channel is '${dc.readyState}', not open`);
        },
        close: () => {
          try {
            dc.close();
          } catch {
          }
          try {
            pc.close();
          } catch {
          }
        }
      })
    );
    channel.pc = pc;
    dc.onmessage = (e) => {
      let m;
      try {
        m = decode(e.data);
      } catch {
        dwarn("webrtc", "dropping unparseable data-channel frame");
        return;
      }
      channel.deliver(m);
    };
    dc.onopen = () => {
      dlog("webrtc", "🟢 data channel OPEN — peers connected directly");
      resolveChannel(channel);
    };
    dc.onclose = () => channel.signalClose();
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (pc.connectionState === "failed") failDirect();
        channel.signalClose();
      }
    });
    let discoTimer = null;
    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        clearTimeout(discoTimer ?? void 0);
        discoTimer = null;
      } else if (s === "disconnected" && !discoTimer) {
        discoTimer = setTimeout(() => {
          const live = pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
          if (!live) {
            dlog("webrtc", "peer link idle past the grace window — closing it");
            channel.signalClose();
          }
        }, DISCONNECT_GRACE_MS);
      } else if (s === "failed" || s === "closed") {
        clearTimeout(discoTimer ?? void 0);
        discoTimer = null;
        channel.signalClose();
      }
    });
    if (dc.readyState === "open") resolveChannel(channel);
    return channel;
  };
  if (initiator) wire(pc.createDataChannel("peerd", { ordered: true }));
  else pc.ondatachannel = (e) => wire(e.channel);
  return { pc, channelReady, setRemote, addRemoteCandidate };
};

// peerd/extension/peerd-distributed/transport/transports/webrtc.js
var requireSignaling = (signaling) => {
  if (typeof signaling?.send !== "function" || typeof signaling?.onRemote !== "function") {
    throw new Error("webrtc: a signaling channel is required ({ send, onRemote })");
  }
};
var orderedCandidates = (signaling) => {
  const pending = [];
  let descriptionSent = false;
  return {
    /** @param {any} candidate */
    send(candidate) {
      if (descriptionSent) signaling.send({ ice: candidate });
      else pending.push(candidate);
    },
    flush() {
      descriptionSent = true;
      for (const candidate of pending.splice(0)) signaling.send({ ice: candidate });
    }
  };
};
var abortClosesPc = (signal, p, isOpen) => {
  if (!signal) return;
  signal.addEventListener("abort", () => {
    if (isOpen()) return;
    try {
      p.pc.close();
    } catch {
    }
  }, { once: true });
};
var createWebrtcTransport = ({ RTCPeerConnection, iceServers = DEFAULT_ICE_SERVERS } = {}) => {
  const cfgFor = (sameMachine, override) => ({
    iceServers: override ?? (sameMachine ? [] : iceServers)
  });
  return {
    name: "webrtc",
    // Usable as a general fallback; preferred when the peer advertises it.
    /** @param {{ transports?: Array<{ kind: string }> }} peer */
    canReach(peer) {
      return peer?.transports?.some((t) => t.kind === "webrtc") ? 0.6 : 0.4;
    },
    // INITIATOR. Creates the offer, sends it immediately, then trickles
    // candidates; applies the remote answer + candidates as they arrive.
    // Resolves to the open Channel (or rejects with DirectPathUnavailableError).
    /**
     * @param {any} peer
     * @param {{ signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[], signal?: AbortSignal }} [opts]
     */
    async connect(peer, { signaling, sameMachine = false, iceServers: ice, signal } = {}) {
      requireSignaling(signaling);
      const sig = (
        /** @type {Signaling} */
        signaling
      );
      const candidates = orderedCandidates(sig);
      const p = createPeer({
        initiator: true,
        RTCPeerConnection,
        config: cfgFor(sameMachine, ice),
        onCandidate: candidates.send
      });
      const off = sig.onRemote(async (msg) => {
        if (!msg) return;
        if (msg.type === "answer") await p.setRemote({ type: "answer", sdp: msg.sdp });
        else if ("ice" in msg) await p.addRemoteCandidate(msg.ice);
      });
      let opened = false;
      p.channelReady.then(() => {
        opened = true;
        off();
      }, () => off());
      abortClosesPc(signal, p, () => opened);
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      sig.send({ type: "offer", sdp: (
        /** @type {RTCSessionDescription} */
        p.pc.localDescription.sdp
      ) });
      candidates.flush();
      return p.channelReady;
    },
    // RESPONDER. The offer already arrived (passed in); the answer +
    // candidates go back over `signaling`. Returns { channel } — a promise
    // that resolves when the data channel opens (NOT awaited here: it can't
    // open until the initiator applies our answer).
    /**
     * @param {{ offer?: { sdp?: string }, signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[], signal?: AbortSignal }} [opts]
     */
    async accept({ offer, signaling, sameMachine = false, iceServers: ice, signal } = {}) {
      requireSignaling(signaling);
      const sig = (
        /** @type {Signaling} */
        signaling
      );
      const candidates = orderedCandidates(sig);
      const p = createPeer({
        initiator: false,
        RTCPeerConnection,
        config: cfgFor(sameMachine, ice),
        onCandidate: candidates.send
      });
      const off = sig.onRemote(async (msg) => {
        if (msg && "ice" in msg) await p.addRemoteCandidate(msg.ice);
      });
      let opened = false;
      p.channelReady.then(() => {
        opened = true;
        off();
      }, () => off());
      abortClosesPc(signal, p, () => opened);
      await p.setRemote({ type: "offer", sdp: offer?.sdp });
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sig.send({ type: "answer", sdp: (
        /** @type {RTCSessionDescription} */
        p.pc.localDescription.sdp
      ) });
      candidates.flush();
      return { channel: p.channelReady };
    }
  };
};

// peerd/extension/peerd-distributed/transport/signaling-client.js
var DEFAULT_SIGNALING = ["wss://bootstrap.peerd.ai/rendezvous"];
var openRendezvous = ({
  url = DEFAULT_SIGNALING[0],
  room,
  kind,
  // 'website' = observe-only visitor (own cap pool); omitted/default = extension
  WebSocket: WS = globalThis.WebSocket,
  timeoutMs = 2e4
} = {}) => (
  /** @type {Promise<RendezvousSession>} */
  new Promise((resolve, reject) => {
    dlog("rendezvous", `connecting to ${url} — room "${room}"`);
    const kindQ = kind && kind !== "extension" ? `&kind=${encodeURIComponent(kind)}` : "";
    const ws = new WS(`${url}?key=${encodeURIComponent(
      /** @type {string} */
      room
    )}${kindQ}`);
    const wsSend = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    const listeners = { joined: /* @__PURE__ */ new Set(), left: /* @__PURE__ */ new Set(), signal: /* @__PURE__ */ new Set(), closed: /* @__PURE__ */ new Set() };
    const emit = (ev, arg) => {
      for (const cb of [...listeners[ev]]) cb(arg);
    };
    let opened = false;
    let closed = false;
    let keepalive;
    const timer = setTimeout(() => {
      if (!opened) {
        try {
          ws.close();
        } catch {
        }
        reject(new Error("signaling: timed out before join confirm"));
      }
    }, timeoutMs);
    const KEEPALIVE_MS = 25e3;
    const session = {
      self: null,
      members: [],
      sendSignal: (to, payload) => wsSend({ t: "signal", to, payload }),
      on: (ev, cb) => {
        listeners[ev].add(cb);
        return () => listeners[ev].delete(cb);
      },
      close: () => {
        closed = true;
        clearInterval(keepalive);
        try {
          ws.close();
        } catch {
        }
      }
    };
    ws.onerror = () => {
      dlog("rendezvous", `websocket error connecting to ${url} (transient? the caller escalates a real outage)`);
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`signaling: websocket error (${url})`));
      }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      clearInterval(keepalive);
      if (!opened) {
        dlog("rendezvous", "closed before join confirm (transient? the caller escalates a real outage)");
        reject(new Error("signaling: closed before join confirm"));
      } else if (!closed) {
        dlog("rendezvous", "node connection closed — reconnecting; mesh survives meanwhile");
        emit("closed", void 0);
      }
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
      } catch {
        return;
      }
      switch (m.t) {
        case "full":
          clearTimeout(timer);
          dwarn("rendezvous", `room "${room}" reported FULL. With real peers this means STALE/ghost connections piled up on the rendezvous node (reloads that never cleanly closed). Fix: try a fresh room code, or restart the node — the server now reaps dead connections on each join, so this should self-heal.`);
          return reject(new Error(`signaling: room "${room}" is full (likely stale connections — try a fresh room code)`));
        case "room":
          opened = true;
          clearTimeout(timer);
          keepalive = setInterval(() => wsSend({ t: "ping" }), KEEPALIVE_MS);
          session.self = m.self;
          session.members = m.members ?? [];
          dlog("rendezvous", `JOINED room "${room}" as ${m.self} — ${session.members.length} member(s) already here:`, session.members);
          return resolve(session);
        case "joined":
          dlog("rendezvous", `peer ${m.member} JOINED the room`);
          return emit("joined", m.member);
        case "left":
          dlog("rendezvous", `peer ${m.member} LEFT the room`);
          return emit("left", m.member);
        case "signal":
          dlog("rendezvous", `SIGNAL from ${m.from}`);
          return emit("signal", { from: m.from, payload: m.payload });
        default:
          return;
      }
    };
  })
);

// peerd/extension/shared/bundle/canonical.js
var canonicalize = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    const num = (
      /** @type {number} */
      v
    );
    if (!Number.isFinite(num)) throw new Error("canonicalize: non-finite number");
    if (!Number.isInteger(num)) {
      throw new Error("canonicalize: non-integer number in a signed payload");
    }
    return String(num);
  }
  if (t === "object") {
    const obj = (
      /** @type {Record<string, unknown>} */
      v
    );
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
};

// peerd/extension/peerd-distributed/transport/envelope.js
var DOMAIN = "peerd/envelope/v1";
var signingBytes = (env) => {
  const { sig, ...rest } = env;
  return concat(utf8(DOMAIN), Uint8Array.from([0]), utf8(canonicalize(rest)));
};
var buildEnvelope = ({ ch, typ, from, body, id, ts }) => ({
  v: 1,
  ch,
  typ,
  from,
  body,
  id,
  ts
});
var signEnvelope = async (env, identity) => {
  const sig = await identity.sign(signingBytes(env));
  return { ...env, sig: toBase64(sig) };
};
var envelopeBytes = (env) => {
  try {
    return utf8(canonicalize(env)).length;
  } catch {
    return Infinity;
  }
};
var verifyEnvelope = async (env) => {
  if (!env || typeof env !== "object") return false;
  const e = (
    /** @type {Envelope} */
    env
  );
  if (!e.sig || !e.from) return false;
  try {
    return await verifySignature(e.from, fromBase64(e.sig), signingBytes(e));
  } catch {
    return false;
  }
};

// peerd/extension/shared/bundle/chunk.js
var CHUNK_SIZE = 262144;
var sha256hex = async (bytes) => toHex(new Uint8Array(
  await crypto.subtle.digest(
    "SHA-256",
    /** @type {BufferSource} */
    bytes
  )
));

// peerd/extension/shared/bundle/manifest.js
var withoutSig = (manifest) => {
  const { sig, ...rest } = manifest;
  return rest;
};
var canonicalManifestBytes = (manifest) => utf8(canonicalize(withoutSig(manifest)));
var manifestHash = async (manifest) => sha256hex(canonicalManifestBytes(manifest));

// peerd/extension/shared/bundle/bundle.js
var DEFAULT_MAX_PACKED_BYTES = 64 * 1024 * 1024;
var DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
var MAX_NETWORK_BUNDLE_BYTES = 5e7;

// peerd/extension/vendor/pako/pako.esm.js
var pako = (function() {
  return (function r(s, o, l) {
    function h(e, t2) {
      if (!o[e]) {
        if (!s[e]) {
          var a = "function" == typeof __require && __require;
          if (!t2 && a) return a(e, true);
          if (d) return d(e, true);
          var i = new Error("Cannot find module '" + e + "'");
          throw i.code = "MODULE_NOT_FOUND", i;
        }
        var n = o[e] = { exports: {} };
        s[e][0].call(n.exports, function(t3) {
          return h(s[e][1][t3] || t3);
        }, n, n.exports, r, s, o, l);
      }
      return o[e].exports;
    }
    for (var d = "function" == typeof __require && __require, t = 0; t < l.length; t++) h(l[t]);
    return h;
  })({ 1: [function(t, e, a) {
    "use strict";
    var s = t("./zlib/deflate"), o = t("./utils/common"), l = t("./utils/strings"), n = t("./zlib/messages"), r = t("./zlib/zstream"), h = Object.prototype.toString, d = 0, f = -1, _ = 0, u = 8;
    function c(t2) {
      if (!(this instanceof c)) return new c(t2);
      this.options = o.assign({ level: f, method: u, chunkSize: 16384, windowBits: 15, memLevel: 8, strategy: _, to: "" }, t2 || {});
      var e2 = this.options;
      e2.raw && 0 < e2.windowBits ? e2.windowBits = -e2.windowBits : e2.gzip && 0 < e2.windowBits && e2.windowBits < 16 && (e2.windowBits += 16), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new r(), this.strm.avail_out = 0;
      var a2 = s.deflateInit2(this.strm, e2.level, e2.method, e2.windowBits, e2.memLevel, e2.strategy);
      if (a2 !== d) throw new Error(n[a2]);
      if (e2.header && s.deflateSetHeader(this.strm, e2.header), e2.dictionary) {
        var i2;
        if (i2 = "string" == typeof e2.dictionary ? l.string2buf(e2.dictionary) : "[object ArrayBuffer]" === h.call(e2.dictionary) ? new Uint8Array(e2.dictionary) : e2.dictionary, (a2 = s.deflateSetDictionary(this.strm, i2)) !== d) throw new Error(n[a2]);
        this._dict_set = true;
      }
    }
    function i(t2, e2) {
      var a2 = new c(e2);
      if (a2.push(t2, true), a2.err) throw a2.msg || n[a2.err];
      return a2.result;
    }
    c.prototype.push = function(t2, e2) {
      var a2, i2, n2 = this.strm, r2 = this.options.chunkSize;
      if (this.ended) return false;
      i2 = e2 === ~~e2 ? e2 : true === e2 ? 4 : 0, "string" == typeof t2 ? n2.input = l.string2buf(t2) : "[object ArrayBuffer]" === h.call(t2) ? n2.input = new Uint8Array(t2) : n2.input = t2, n2.next_in = 0, n2.avail_in = n2.input.length;
      do {
        if (0 === n2.avail_out && (n2.output = new o.Buf8(r2), n2.next_out = 0, n2.avail_out = r2), 1 !== (a2 = s.deflate(n2, i2)) && a2 !== d) return this.onEnd(a2), !(this.ended = true);
        0 !== n2.avail_out && (0 !== n2.avail_in || 4 !== i2 && 2 !== i2) || ("string" === this.options.to ? this.onData(l.buf2binstring(o.shrinkBuf(n2.output, n2.next_out))) : this.onData(o.shrinkBuf(n2.output, n2.next_out)));
      } while ((0 < n2.avail_in || 0 === n2.avail_out) && 1 !== a2);
      return 4 === i2 ? (a2 = s.deflateEnd(this.strm), this.onEnd(a2), this.ended = true, a2 === d) : 2 !== i2 || (this.onEnd(d), !(n2.avail_out = 0));
    }, c.prototype.onData = function(t2) {
      this.chunks.push(t2);
    }, c.prototype.onEnd = function(t2) {
      t2 === d && ("string" === this.options.to ? this.result = this.chunks.join("") : this.result = o.flattenChunks(this.chunks)), this.chunks = [], this.err = t2, this.msg = this.strm.msg;
    }, a.Deflate = c, a.deflate = i, a.deflateRaw = function(t2, e2) {
      return (e2 = e2 || {}).raw = true, i(t2, e2);
    }, a.gzip = function(t2, e2) {
      return (e2 = e2 || {}).gzip = true, i(t2, e2);
    };
  }, { "./utils/common": 3, "./utils/strings": 4, "./zlib/deflate": 8, "./zlib/messages": 13, "./zlib/zstream": 15 }], 2: [function(t, e, a) {
    "use strict";
    var f = t("./zlib/inflate"), _ = t("./utils/common"), u = t("./utils/strings"), c = t("./zlib/constants"), i = t("./zlib/messages"), n = t("./zlib/zstream"), r = t("./zlib/gzheader"), b = Object.prototype.toString;
    function s(t2) {
      if (!(this instanceof s)) return new s(t2);
      this.options = _.assign({ chunkSize: 16384, windowBits: 0, to: "" }, t2 || {});
      var e2 = this.options;
      e2.raw && 0 <= e2.windowBits && e2.windowBits < 16 && (e2.windowBits = -e2.windowBits, 0 === e2.windowBits && (e2.windowBits = -15)), !(0 <= e2.windowBits && e2.windowBits < 16) || t2 && t2.windowBits || (e2.windowBits += 32), 15 < e2.windowBits && e2.windowBits < 48 && 0 == (15 & e2.windowBits) && (e2.windowBits |= 15), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new n(), this.strm.avail_out = 0;
      var a2 = f.inflateInit2(this.strm, e2.windowBits);
      if (a2 !== c.Z_OK) throw new Error(i[a2]);
      if (this.header = new r(), f.inflateGetHeader(this.strm, this.header), e2.dictionary && ("string" == typeof e2.dictionary ? e2.dictionary = u.string2buf(e2.dictionary) : "[object ArrayBuffer]" === b.call(e2.dictionary) && (e2.dictionary = new Uint8Array(e2.dictionary)), e2.raw && (a2 = f.inflateSetDictionary(this.strm, e2.dictionary)) !== c.Z_OK)) throw new Error(i[a2]);
    }
    function o(t2, e2) {
      var a2 = new s(e2);
      if (a2.push(t2, true), a2.err) throw a2.msg || i[a2.err];
      return a2.result;
    }
    s.prototype.push = function(t2, e2) {
      var a2, i2, n2, r2, s2, o2 = this.strm, l = this.options.chunkSize, h = this.options.dictionary, d = false;
      if (this.ended) return false;
      i2 = e2 === ~~e2 ? e2 : true === e2 ? c.Z_FINISH : c.Z_NO_FLUSH, "string" == typeof t2 ? o2.input = u.binstring2buf(t2) : "[object ArrayBuffer]" === b.call(t2) ? o2.input = new Uint8Array(t2) : o2.input = t2, o2.next_in = 0, o2.avail_in = o2.input.length;
      do {
        if (0 === o2.avail_out && (o2.output = new _.Buf8(l), o2.next_out = 0, o2.avail_out = l), (a2 = f.inflate(o2, c.Z_NO_FLUSH)) === c.Z_NEED_DICT && h && (a2 = f.inflateSetDictionary(this.strm, h)), a2 === c.Z_BUF_ERROR && true === d && (a2 = c.Z_OK, d = false), a2 !== c.Z_STREAM_END && a2 !== c.Z_OK) return this.onEnd(a2), !(this.ended = true);
        o2.next_out && (0 !== o2.avail_out && a2 !== c.Z_STREAM_END && (0 !== o2.avail_in || i2 !== c.Z_FINISH && i2 !== c.Z_SYNC_FLUSH) || ("string" === this.options.to ? (n2 = u.utf8border(o2.output, o2.next_out), r2 = o2.next_out - n2, s2 = u.buf2string(o2.output, n2), o2.next_out = r2, o2.avail_out = l - r2, r2 && _.arraySet(o2.output, o2.output, n2, r2, 0), this.onData(s2)) : this.onData(_.shrinkBuf(o2.output, o2.next_out)))), 0 === o2.avail_in && 0 === o2.avail_out && (d = true);
      } while ((0 < o2.avail_in || 0 === o2.avail_out) && a2 !== c.Z_STREAM_END);
      return a2 === c.Z_STREAM_END && (i2 = c.Z_FINISH), i2 === c.Z_FINISH ? (a2 = f.inflateEnd(this.strm), this.onEnd(a2), this.ended = true, a2 === c.Z_OK) : i2 !== c.Z_SYNC_FLUSH || (this.onEnd(c.Z_OK), !(o2.avail_out = 0));
    }, s.prototype.onData = function(t2) {
      this.chunks.push(t2);
    }, s.prototype.onEnd = function(t2) {
      t2 === c.Z_OK && ("string" === this.options.to ? this.result = this.chunks.join("") : this.result = _.flattenChunks(this.chunks)), this.chunks = [], this.err = t2, this.msg = this.strm.msg;
    }, a.Inflate = s, a.inflate = o, a.inflateRaw = function(t2, e2) {
      return (e2 = e2 || {}).raw = true, o(t2, e2);
    }, a.ungzip = o;
  }, { "./utils/common": 3, "./utils/strings": 4, "./zlib/constants": 6, "./zlib/gzheader": 9, "./zlib/inflate": 11, "./zlib/messages": 13, "./zlib/zstream": 15 }], 3: [function(t, e, a) {
    "use strict";
    var i = "undefined" != typeof Uint8Array && "undefined" != typeof Uint16Array && "undefined" != typeof Int32Array;
    a.assign = function(t2) {
      for (var e2, a2, i2 = Array.prototype.slice.call(arguments, 1); i2.length; ) {
        var n2 = i2.shift();
        if (n2) {
          if ("object" != typeof n2) throw new TypeError(n2 + "must be non-object");
          for (var r2 in n2) e2 = n2, a2 = r2, Object.prototype.hasOwnProperty.call(e2, a2) && (t2[r2] = n2[r2]);
        }
      }
      return t2;
    }, a.shrinkBuf = function(t2, e2) {
      return t2.length === e2 ? t2 : t2.subarray ? t2.subarray(0, e2) : (t2.length = e2, t2);
    };
    var n = { arraySet: function(t2, e2, a2, i2, n2) {
      if (e2.subarray && t2.subarray) t2.set(e2.subarray(a2, a2 + i2), n2);
      else for (var r2 = 0; r2 < i2; r2++) t2[n2 + r2] = e2[a2 + r2];
    }, flattenChunks: function(t2) {
      var e2, a2, i2, n2, r2, s;
      for (e2 = i2 = 0, a2 = t2.length; e2 < a2; e2++) i2 += t2[e2].length;
      for (s = new Uint8Array(i2), e2 = n2 = 0, a2 = t2.length; e2 < a2; e2++) r2 = t2[e2], s.set(r2, n2), n2 += r2.length;
      return s;
    } }, r = { arraySet: function(t2, e2, a2, i2, n2) {
      for (var r2 = 0; r2 < i2; r2++) t2[n2 + r2] = e2[a2 + r2];
    }, flattenChunks: function(t2) {
      return [].concat.apply([], t2);
    } };
    a.setTyped = function(t2) {
      t2 ? (a.Buf8 = Uint8Array, a.Buf16 = Uint16Array, a.Buf32 = Int32Array, a.assign(a, n)) : (a.Buf8 = Array, a.Buf16 = Array, a.Buf32 = Array, a.assign(a, r));
    }, a.setTyped(i);
  }, {}], 4: [function(t, e, a) {
    "use strict";
    var l = t("./common"), n = true, r = true;
    try {
      String.fromCharCode.apply(null, [0]);
    } catch (t2) {
      n = false;
    }
    try {
      String.fromCharCode.apply(null, new Uint8Array(1));
    } catch (t2) {
      r = false;
    }
    for (var h = new l.Buf8(256), i = 0; i < 256; i++) h[i] = 252 <= i ? 6 : 248 <= i ? 5 : 240 <= i ? 4 : 224 <= i ? 3 : 192 <= i ? 2 : 1;
    function d(t2, e2) {
      if (e2 < 65534 && (t2.subarray && r || !t2.subarray && n)) return String.fromCharCode.apply(null, l.shrinkBuf(t2, e2));
      for (var a2 = "", i2 = 0; i2 < e2; i2++) a2 += String.fromCharCode(t2[i2]);
      return a2;
    }
    h[254] = h[254] = 1, a.string2buf = function(t2) {
      var e2, a2, i2, n2, r2, s = t2.length, o = 0;
      for (n2 = 0; n2 < s; n2++) 55296 == (64512 & (a2 = t2.charCodeAt(n2))) && n2 + 1 < s && 56320 == (64512 & (i2 = t2.charCodeAt(n2 + 1))) && (a2 = 65536 + (a2 - 55296 << 10) + (i2 - 56320), n2++), o += a2 < 128 ? 1 : a2 < 2048 ? 2 : a2 < 65536 ? 3 : 4;
      for (e2 = new l.Buf8(o), n2 = r2 = 0; r2 < o; n2++) 55296 == (64512 & (a2 = t2.charCodeAt(n2))) && n2 + 1 < s && 56320 == (64512 & (i2 = t2.charCodeAt(n2 + 1))) && (a2 = 65536 + (a2 - 55296 << 10) + (i2 - 56320), n2++), a2 < 128 ? e2[r2++] = a2 : (a2 < 2048 ? e2[r2++] = 192 | a2 >>> 6 : (a2 < 65536 ? e2[r2++] = 224 | a2 >>> 12 : (e2[r2++] = 240 | a2 >>> 18, e2[r2++] = 128 | a2 >>> 12 & 63), e2[r2++] = 128 | a2 >>> 6 & 63), e2[r2++] = 128 | 63 & a2);
      return e2;
    }, a.buf2binstring = function(t2) {
      return d(t2, t2.length);
    }, a.binstring2buf = function(t2) {
      for (var e2 = new l.Buf8(t2.length), a2 = 0, i2 = e2.length; a2 < i2; a2++) e2[a2] = t2.charCodeAt(a2);
      return e2;
    }, a.buf2string = function(t2, e2) {
      var a2, i2, n2, r2, s = e2 || t2.length, o = new Array(2 * s);
      for (a2 = i2 = 0; a2 < s; ) if ((n2 = t2[a2++]) < 128) o[i2++] = n2;
      else if (4 < (r2 = h[n2])) o[i2++] = 65533, a2 += r2 - 1;
      else {
        for (n2 &= 2 === r2 ? 31 : 3 === r2 ? 15 : 7; 1 < r2 && a2 < s; ) n2 = n2 << 6 | 63 & t2[a2++], r2--;
        1 < r2 ? o[i2++] = 65533 : n2 < 65536 ? o[i2++] = n2 : (n2 -= 65536, o[i2++] = 55296 | n2 >> 10 & 1023, o[i2++] = 56320 | 1023 & n2);
      }
      return d(o, i2);
    }, a.utf8border = function(t2, e2) {
      var a2;
      for ((e2 = e2 || t2.length) > t2.length && (e2 = t2.length), a2 = e2 - 1; 0 <= a2 && 128 == (192 & t2[a2]); ) a2--;
      return a2 < 0 ? e2 : 0 === a2 ? e2 : a2 + h[t2[a2]] > e2 ? a2 : e2;
    };
  }, { "./common": 3 }], 5: [function(t, e, a) {
    "use strict";
    e.exports = function(t2, e2, a2, i) {
      for (var n = 65535 & t2 | 0, r = t2 >>> 16 & 65535 | 0, s = 0; 0 !== a2; ) {
        for (a2 -= s = 2e3 < a2 ? 2e3 : a2; r = r + (n = n + e2[i++] | 0) | 0, --s; ) ;
        n %= 65521, r %= 65521;
      }
      return n | r << 16 | 0;
    };
  }, {}], 6: [function(t, e, a) {
    "use strict";
    e.exports = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_UNKNOWN: 2, Z_DEFLATED: 8 };
  }, {}], 7: [function(t, e, a) {
    "use strict";
    var o = (function() {
      for (var t2, e2 = [], a2 = 0; a2 < 256; a2++) {
        t2 = a2;
        for (var i = 0; i < 8; i++) t2 = 1 & t2 ? 3988292384 ^ t2 >>> 1 : t2 >>> 1;
        e2[a2] = t2;
      }
      return e2;
    })();
    e.exports = function(t2, e2, a2, i) {
      var n = o, r = i + a2;
      t2 ^= -1;
      for (var s = i; s < r; s++) t2 = t2 >>> 8 ^ n[255 & (t2 ^ e2[s])];
      return -1 ^ t2;
    };
  }, {}], 8: [function(t, e, a) {
    "use strict";
    var l, _ = t("../utils/common"), h = t("./trees"), u = t("./adler32"), c = t("./crc32"), i = t("./messages"), d = 0, f = 4, b = 0, g = -2, m = -1, w = 4, n = 2, p = 8, v = 9, r = 286, s = 30, o = 19, k = 2 * r + 1, y = 15, x = 3, z = 258, B = z + x + 1, S = 42, E = 113, A = 1, Z = 2, R = 3, C = 4;
    function N(t2, e2) {
      return t2.msg = i[e2], e2;
    }
    function O(t2) {
      return (t2 << 1) - (4 < t2 ? 9 : 0);
    }
    function D(t2) {
      for (var e2 = t2.length; 0 <= --e2; ) t2[e2] = 0;
    }
    function I(t2) {
      var e2 = t2.state, a2 = e2.pending;
      a2 > t2.avail_out && (a2 = t2.avail_out), 0 !== a2 && (_.arraySet(t2.output, e2.pending_buf, e2.pending_out, a2, t2.next_out), t2.next_out += a2, e2.pending_out += a2, t2.total_out += a2, t2.avail_out -= a2, e2.pending -= a2, 0 === e2.pending && (e2.pending_out = 0));
    }
    function U(t2, e2) {
      h._tr_flush_block(t2, 0 <= t2.block_start ? t2.block_start : -1, t2.strstart - t2.block_start, e2), t2.block_start = t2.strstart, I(t2.strm);
    }
    function T(t2, e2) {
      t2.pending_buf[t2.pending++] = e2;
    }
    function F(t2, e2) {
      t2.pending_buf[t2.pending++] = e2 >>> 8 & 255, t2.pending_buf[t2.pending++] = 255 & e2;
    }
    function L(t2, e2) {
      var a2, i2, n2 = t2.max_chain_length, r2 = t2.strstart, s2 = t2.prev_length, o2 = t2.nice_match, l2 = t2.strstart > t2.w_size - B ? t2.strstart - (t2.w_size - B) : 0, h2 = t2.window, d2 = t2.w_mask, f2 = t2.prev, _2 = t2.strstart + z, u2 = h2[r2 + s2 - 1], c2 = h2[r2 + s2];
      t2.prev_length >= t2.good_match && (n2 >>= 2), o2 > t2.lookahead && (o2 = t2.lookahead);
      do {
        if (h2[(a2 = e2) + s2] === c2 && h2[a2 + s2 - 1] === u2 && h2[a2] === h2[r2] && h2[++a2] === h2[r2 + 1]) {
          r2 += 2, a2++;
          do {
          } while (h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && h2[++r2] === h2[++a2] && r2 < _2);
          if (i2 = z - (_2 - r2), r2 = _2 - z, s2 < i2) {
            if (t2.match_start = e2, o2 <= (s2 = i2)) break;
            u2 = h2[r2 + s2 - 1], c2 = h2[r2 + s2];
          }
        }
      } while ((e2 = f2[e2 & d2]) > l2 && 0 != --n2);
      return s2 <= t2.lookahead ? s2 : t2.lookahead;
    }
    function H(t2) {
      var e2, a2, i2, n2, r2, s2, o2, l2, h2, d2, f2 = t2.w_size;
      do {
        if (n2 = t2.window_size - t2.lookahead - t2.strstart, t2.strstart >= f2 + (f2 - B)) {
          for (_.arraySet(t2.window, t2.window, f2, f2, 0), t2.match_start -= f2, t2.strstart -= f2, t2.block_start -= f2, e2 = a2 = t2.hash_size; i2 = t2.head[--e2], t2.head[e2] = f2 <= i2 ? i2 - f2 : 0, --a2; ) ;
          for (e2 = a2 = f2; i2 = t2.prev[--e2], t2.prev[e2] = f2 <= i2 ? i2 - f2 : 0, --a2; ) ;
          n2 += f2;
        }
        if (0 === t2.strm.avail_in) break;
        if (s2 = t2.strm, o2 = t2.window, l2 = t2.strstart + t2.lookahead, h2 = n2, d2 = void 0, d2 = s2.avail_in, h2 < d2 && (d2 = h2), a2 = 0 === d2 ? 0 : (s2.avail_in -= d2, _.arraySet(o2, s2.input, s2.next_in, d2, l2), 1 === s2.state.wrap ? s2.adler = u(s2.adler, o2, d2, l2) : 2 === s2.state.wrap && (s2.adler = c(s2.adler, o2, d2, l2)), s2.next_in += d2, s2.total_in += d2, d2), t2.lookahead += a2, t2.lookahead + t2.insert >= x) for (r2 = t2.strstart - t2.insert, t2.ins_h = t2.window[r2], t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[r2 + 1]) & t2.hash_mask; t2.insert && (t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[r2 + x - 1]) & t2.hash_mask, t2.prev[r2 & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = r2, r2++, t2.insert--, !(t2.lookahead + t2.insert < x)); ) ;
      } while (t2.lookahead < B && 0 !== t2.strm.avail_in);
    }
    function j(t2, e2) {
      for (var a2, i2; ; ) {
        if (t2.lookahead < B) {
          if (H(t2), t2.lookahead < B && e2 === d) return A;
          if (0 === t2.lookahead) break;
        }
        if (a2 = 0, t2.lookahead >= x && (t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[t2.strstart + x - 1]) & t2.hash_mask, a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart), 0 !== a2 && t2.strstart - a2 <= t2.w_size - B && (t2.match_length = L(t2, a2)), t2.match_length >= x) if (i2 = h._tr_tally(t2, t2.strstart - t2.match_start, t2.match_length - x), t2.lookahead -= t2.match_length, t2.match_length <= t2.max_lazy_match && t2.lookahead >= x) {
          for (t2.match_length--; t2.strstart++, t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[t2.strstart + x - 1]) & t2.hash_mask, a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart, 0 != --t2.match_length; ) ;
          t2.strstart++;
        } else t2.strstart += t2.match_length, t2.match_length = 0, t2.ins_h = t2.window[t2.strstart], t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[t2.strstart + 1]) & t2.hash_mask;
        else i2 = h._tr_tally(t2, 0, t2.window[t2.strstart]), t2.lookahead--, t2.strstart++;
        if (i2 && (U(t2, false), 0 === t2.strm.avail_out)) return A;
      }
      return t2.insert = t2.strstart < x - 1 ? t2.strstart : x - 1, e2 === f ? (U(t2, true), 0 === t2.strm.avail_out ? R : C) : t2.last_lit && (U(t2, false), 0 === t2.strm.avail_out) ? A : Z;
    }
    function K(t2, e2) {
      for (var a2, i2, n2; ; ) {
        if (t2.lookahead < B) {
          if (H(t2), t2.lookahead < B && e2 === d) return A;
          if (0 === t2.lookahead) break;
        }
        if (a2 = 0, t2.lookahead >= x && (t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[t2.strstart + x - 1]) & t2.hash_mask, a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart), t2.prev_length = t2.match_length, t2.prev_match = t2.match_start, t2.match_length = x - 1, 0 !== a2 && t2.prev_length < t2.max_lazy_match && t2.strstart - a2 <= t2.w_size - B && (t2.match_length = L(t2, a2), t2.match_length <= 5 && (1 === t2.strategy || t2.match_length === x && 4096 < t2.strstart - t2.match_start) && (t2.match_length = x - 1)), t2.prev_length >= x && t2.match_length <= t2.prev_length) {
          for (n2 = t2.strstart + t2.lookahead - x, i2 = h._tr_tally(t2, t2.strstart - 1 - t2.prev_match, t2.prev_length - x), t2.lookahead -= t2.prev_length - 1, t2.prev_length -= 2; ++t2.strstart <= n2 && (t2.ins_h = (t2.ins_h << t2.hash_shift ^ t2.window[t2.strstart + x - 1]) & t2.hash_mask, a2 = t2.prev[t2.strstart & t2.w_mask] = t2.head[t2.ins_h], t2.head[t2.ins_h] = t2.strstart), 0 != --t2.prev_length; ) ;
          if (t2.match_available = 0, t2.match_length = x - 1, t2.strstart++, i2 && (U(t2, false), 0 === t2.strm.avail_out)) return A;
        } else if (t2.match_available) {
          if ((i2 = h._tr_tally(t2, 0, t2.window[t2.strstart - 1])) && U(t2, false), t2.strstart++, t2.lookahead--, 0 === t2.strm.avail_out) return A;
        } else t2.match_available = 1, t2.strstart++, t2.lookahead--;
      }
      return t2.match_available && (i2 = h._tr_tally(t2, 0, t2.window[t2.strstart - 1]), t2.match_available = 0), t2.insert = t2.strstart < x - 1 ? t2.strstart : x - 1, e2 === f ? (U(t2, true), 0 === t2.strm.avail_out ? R : C) : t2.last_lit && (U(t2, false), 0 === t2.strm.avail_out) ? A : Z;
    }
    function M(t2, e2, a2, i2, n2) {
      this.good_length = t2, this.max_lazy = e2, this.nice_length = a2, this.max_chain = i2, this.func = n2;
    }
    function P() {
      this.strm = null, this.status = 0, this.pending_buf = null, this.pending_buf_size = 0, this.pending_out = 0, this.pending = 0, this.wrap = 0, this.gzhead = null, this.gzindex = 0, this.method = p, this.last_flush = -1, this.w_size = 0, this.w_bits = 0, this.w_mask = 0, this.window = null, this.window_size = 0, this.prev = null, this.head = null, this.ins_h = 0, this.hash_size = 0, this.hash_bits = 0, this.hash_mask = 0, this.hash_shift = 0, this.block_start = 0, this.match_length = 0, this.prev_match = 0, this.match_available = 0, this.strstart = 0, this.match_start = 0, this.lookahead = 0, this.prev_length = 0, this.max_chain_length = 0, this.max_lazy_match = 0, this.level = 0, this.strategy = 0, this.good_match = 0, this.nice_match = 0, this.dyn_ltree = new _.Buf16(2 * k), this.dyn_dtree = new _.Buf16(2 * (2 * s + 1)), this.bl_tree = new _.Buf16(2 * (2 * o + 1)), D(this.dyn_ltree), D(this.dyn_dtree), D(this.bl_tree), this.l_desc = null, this.d_desc = null, this.bl_desc = null, this.bl_count = new _.Buf16(y + 1), this.heap = new _.Buf16(2 * r + 1), D(this.heap), this.heap_len = 0, this.heap_max = 0, this.depth = new _.Buf16(2 * r + 1), D(this.depth), this.l_buf = 0, this.lit_bufsize = 0, this.last_lit = 0, this.d_buf = 0, this.opt_len = 0, this.static_len = 0, this.matches = 0, this.insert = 0, this.bi_buf = 0, this.bi_valid = 0;
    }
    function Y(t2) {
      var e2;
      return t2 && t2.state ? (t2.total_in = t2.total_out = 0, t2.data_type = n, (e2 = t2.state).pending = 0, e2.pending_out = 0, e2.wrap < 0 && (e2.wrap = -e2.wrap), e2.status = e2.wrap ? S : E, t2.adler = 2 === e2.wrap ? 0 : 1, e2.last_flush = d, h._tr_init(e2), b) : N(t2, g);
    }
    function q(t2) {
      var e2, a2 = Y(t2);
      return a2 === b && ((e2 = t2.state).window_size = 2 * e2.w_size, D(e2.head), e2.max_lazy_match = l[e2.level].max_lazy, e2.good_match = l[e2.level].good_length, e2.nice_match = l[e2.level].nice_length, e2.max_chain_length = l[e2.level].max_chain, e2.strstart = 0, e2.block_start = 0, e2.lookahead = 0, e2.insert = 0, e2.match_length = e2.prev_length = x - 1, e2.match_available = 0, e2.ins_h = 0), a2;
    }
    function G(t2, e2, a2, i2, n2, r2) {
      if (!t2) return g;
      var s2 = 1;
      if (e2 === m && (e2 = 6), i2 < 0 ? (s2 = 0, i2 = -i2) : 15 < i2 && (s2 = 2, i2 -= 16), n2 < 1 || v < n2 || a2 !== p || i2 < 8 || 15 < i2 || e2 < 0 || 9 < e2 || r2 < 0 || w < r2) return N(t2, g);
      8 === i2 && (i2 = 9);
      var o2 = new P();
      return (t2.state = o2).strm = t2, o2.wrap = s2, o2.gzhead = null, o2.w_bits = i2, o2.w_size = 1 << o2.w_bits, o2.w_mask = o2.w_size - 1, o2.hash_bits = n2 + 7, o2.hash_size = 1 << o2.hash_bits, o2.hash_mask = o2.hash_size - 1, o2.hash_shift = ~~((o2.hash_bits + x - 1) / x), o2.window = new _.Buf8(2 * o2.w_size), o2.head = new _.Buf16(o2.hash_size), o2.prev = new _.Buf16(o2.w_size), o2.lit_bufsize = 1 << n2 + 6, o2.pending_buf_size = 4 * o2.lit_bufsize, o2.pending_buf = new _.Buf8(o2.pending_buf_size), o2.d_buf = 1 * o2.lit_bufsize, o2.l_buf = 3 * o2.lit_bufsize, o2.level = e2, o2.strategy = r2, o2.method = a2, q(t2);
    }
    l = [new M(0, 0, 0, 0, function(t2, e2) {
      var a2 = 65535;
      for (a2 > t2.pending_buf_size - 5 && (a2 = t2.pending_buf_size - 5); ; ) {
        if (t2.lookahead <= 1) {
          if (H(t2), 0 === t2.lookahead && e2 === d) return A;
          if (0 === t2.lookahead) break;
        }
        t2.strstart += t2.lookahead, t2.lookahead = 0;
        var i2 = t2.block_start + a2;
        if ((0 === t2.strstart || t2.strstart >= i2) && (t2.lookahead = t2.strstart - i2, t2.strstart = i2, U(t2, false), 0 === t2.strm.avail_out)) return A;
        if (t2.strstart - t2.block_start >= t2.w_size - B && (U(t2, false), 0 === t2.strm.avail_out)) return A;
      }
      return t2.insert = 0, e2 === f ? (U(t2, true), 0 === t2.strm.avail_out ? R : C) : (t2.strstart > t2.block_start && (U(t2, false), t2.strm.avail_out), A);
    }), new M(4, 4, 8, 4, j), new M(4, 5, 16, 8, j), new M(4, 6, 32, 32, j), new M(4, 4, 16, 16, K), new M(8, 16, 32, 32, K), new M(8, 16, 128, 128, K), new M(8, 32, 128, 256, K), new M(32, 128, 258, 1024, K), new M(32, 258, 258, 4096, K)], a.deflateInit = function(t2, e2) {
      return G(t2, e2, p, 15, 8, 0);
    }, a.deflateInit2 = G, a.deflateReset = q, a.deflateResetKeep = Y, a.deflateSetHeader = function(t2, e2) {
      return t2 && t2.state ? 2 !== t2.state.wrap ? g : (t2.state.gzhead = e2, b) : g;
    }, a.deflate = function(t2, e2) {
      var a2, i2, n2, r2;
      if (!t2 || !t2.state || 5 < e2 || e2 < 0) return t2 ? N(t2, g) : g;
      if (i2 = t2.state, !t2.output || !t2.input && 0 !== t2.avail_in || 666 === i2.status && e2 !== f) return N(t2, 0 === t2.avail_out ? -5 : g);
      if (i2.strm = t2, a2 = i2.last_flush, i2.last_flush = e2, i2.status === S) if (2 === i2.wrap) t2.adler = 0, T(i2, 31), T(i2, 139), T(i2, 8), i2.gzhead ? (T(i2, (i2.gzhead.text ? 1 : 0) + (i2.gzhead.hcrc ? 2 : 0) + (i2.gzhead.extra ? 4 : 0) + (i2.gzhead.name ? 8 : 0) + (i2.gzhead.comment ? 16 : 0)), T(i2, 255 & i2.gzhead.time), T(i2, i2.gzhead.time >> 8 & 255), T(i2, i2.gzhead.time >> 16 & 255), T(i2, i2.gzhead.time >> 24 & 255), T(i2, 9 === i2.level ? 2 : 2 <= i2.strategy || i2.level < 2 ? 4 : 0), T(i2, 255 & i2.gzhead.os), i2.gzhead.extra && i2.gzhead.extra.length && (T(i2, 255 & i2.gzhead.extra.length), T(i2, i2.gzhead.extra.length >> 8 & 255)), i2.gzhead.hcrc && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending, 0)), i2.gzindex = 0, i2.status = 69) : (T(i2, 0), T(i2, 0), T(i2, 0), T(i2, 0), T(i2, 0), T(i2, 9 === i2.level ? 2 : 2 <= i2.strategy || i2.level < 2 ? 4 : 0), T(i2, 3), i2.status = E);
      else {
        var s2 = p + (i2.w_bits - 8 << 4) << 8;
        s2 |= (2 <= i2.strategy || i2.level < 2 ? 0 : i2.level < 6 ? 1 : 6 === i2.level ? 2 : 3) << 6, 0 !== i2.strstart && (s2 |= 32), s2 += 31 - s2 % 31, i2.status = E, F(i2, s2), 0 !== i2.strstart && (F(i2, t2.adler >>> 16), F(i2, 65535 & t2.adler)), t2.adler = 1;
      }
      if (69 === i2.status) if (i2.gzhead.extra) {
        for (n2 = i2.pending; i2.gzindex < (65535 & i2.gzhead.extra.length) && (i2.pending !== i2.pending_buf_size || (i2.gzhead.hcrc && i2.pending > n2 && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending - n2, n2)), I(t2), n2 = i2.pending, i2.pending !== i2.pending_buf_size)); ) T(i2, 255 & i2.gzhead.extra[i2.gzindex]), i2.gzindex++;
        i2.gzhead.hcrc && i2.pending > n2 && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending - n2, n2)), i2.gzindex === i2.gzhead.extra.length && (i2.gzindex = 0, i2.status = 73);
      } else i2.status = 73;
      if (73 === i2.status) if (i2.gzhead.name) {
        n2 = i2.pending;
        do {
          if (i2.pending === i2.pending_buf_size && (i2.gzhead.hcrc && i2.pending > n2 && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending - n2, n2)), I(t2), n2 = i2.pending, i2.pending === i2.pending_buf_size)) {
            r2 = 1;
            break;
          }
          T(i2, r2 = i2.gzindex < i2.gzhead.name.length ? 255 & i2.gzhead.name.charCodeAt(i2.gzindex++) : 0);
        } while (0 !== r2);
        i2.gzhead.hcrc && i2.pending > n2 && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending - n2, n2)), 0 === r2 && (i2.gzindex = 0, i2.status = 91);
      } else i2.status = 91;
      if (91 === i2.status) if (i2.gzhead.comment) {
        n2 = i2.pending;
        do {
          if (i2.pending === i2.pending_buf_size && (i2.gzhead.hcrc && i2.pending > n2 && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending - n2, n2)), I(t2), n2 = i2.pending, i2.pending === i2.pending_buf_size)) {
            r2 = 1;
            break;
          }
          T(i2, r2 = i2.gzindex < i2.gzhead.comment.length ? 255 & i2.gzhead.comment.charCodeAt(i2.gzindex++) : 0);
        } while (0 !== r2);
        i2.gzhead.hcrc && i2.pending > n2 && (t2.adler = c(t2.adler, i2.pending_buf, i2.pending - n2, n2)), 0 === r2 && (i2.status = 103);
      } else i2.status = 103;
      if (103 === i2.status && (i2.gzhead.hcrc ? (i2.pending + 2 > i2.pending_buf_size && I(t2), i2.pending + 2 <= i2.pending_buf_size && (T(i2, 255 & t2.adler), T(i2, t2.adler >> 8 & 255), t2.adler = 0, i2.status = E)) : i2.status = E), 0 !== i2.pending) {
        if (I(t2), 0 === t2.avail_out) return i2.last_flush = -1, b;
      } else if (0 === t2.avail_in && O(e2) <= O(a2) && e2 !== f) return N(t2, -5);
      if (666 === i2.status && 0 !== t2.avail_in) return N(t2, -5);
      if (0 !== t2.avail_in || 0 !== i2.lookahead || e2 !== d && 666 !== i2.status) {
        var o2 = 2 === i2.strategy ? (function(t3, e3) {
          for (var a3; ; ) {
            if (0 === t3.lookahead && (H(t3), 0 === t3.lookahead)) {
              if (e3 === d) return A;
              break;
            }
            if (t3.match_length = 0, a3 = h._tr_tally(t3, 0, t3.window[t3.strstart]), t3.lookahead--, t3.strstart++, a3 && (U(t3, false), 0 === t3.strm.avail_out)) return A;
          }
          return t3.insert = 0, e3 === f ? (U(t3, true), 0 === t3.strm.avail_out ? R : C) : t3.last_lit && (U(t3, false), 0 === t3.strm.avail_out) ? A : Z;
        })(i2, e2) : 3 === i2.strategy ? (function(t3, e3) {
          for (var a3, i3, n3, r3, s3 = t3.window; ; ) {
            if (t3.lookahead <= z) {
              if (H(t3), t3.lookahead <= z && e3 === d) return A;
              if (0 === t3.lookahead) break;
            }
            if (t3.match_length = 0, t3.lookahead >= x && 0 < t3.strstart && (i3 = s3[n3 = t3.strstart - 1]) === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3]) {
              r3 = t3.strstart + z;
              do {
              } while (i3 === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3] && i3 === s3[++n3] && n3 < r3);
              t3.match_length = z - (r3 - n3), t3.match_length > t3.lookahead && (t3.match_length = t3.lookahead);
            }
            if (t3.match_length >= x ? (a3 = h._tr_tally(t3, 1, t3.match_length - x), t3.lookahead -= t3.match_length, t3.strstart += t3.match_length, t3.match_length = 0) : (a3 = h._tr_tally(t3, 0, t3.window[t3.strstart]), t3.lookahead--, t3.strstart++), a3 && (U(t3, false), 0 === t3.strm.avail_out)) return A;
          }
          return t3.insert = 0, e3 === f ? (U(t3, true), 0 === t3.strm.avail_out ? R : C) : t3.last_lit && (U(t3, false), 0 === t3.strm.avail_out) ? A : Z;
        })(i2, e2) : l[i2.level].func(i2, e2);
        if (o2 !== R && o2 !== C || (i2.status = 666), o2 === A || o2 === R) return 0 === t2.avail_out && (i2.last_flush = -1), b;
        if (o2 === Z && (1 === e2 ? h._tr_align(i2) : 5 !== e2 && (h._tr_stored_block(i2, 0, 0, false), 3 === e2 && (D(i2.head), 0 === i2.lookahead && (i2.strstart = 0, i2.block_start = 0, i2.insert = 0))), I(t2), 0 === t2.avail_out)) return i2.last_flush = -1, b;
      }
      return e2 !== f ? b : i2.wrap <= 0 ? 1 : (2 === i2.wrap ? (T(i2, 255 & t2.adler), T(i2, t2.adler >> 8 & 255), T(i2, t2.adler >> 16 & 255), T(i2, t2.adler >> 24 & 255), T(i2, 255 & t2.total_in), T(i2, t2.total_in >> 8 & 255), T(i2, t2.total_in >> 16 & 255), T(i2, t2.total_in >> 24 & 255)) : (F(i2, t2.adler >>> 16), F(i2, 65535 & t2.adler)), I(t2), 0 < i2.wrap && (i2.wrap = -i2.wrap), 0 !== i2.pending ? b : 1);
    }, a.deflateEnd = function(t2) {
      var e2;
      return t2 && t2.state ? (e2 = t2.state.status) !== S && 69 !== e2 && 73 !== e2 && 91 !== e2 && 103 !== e2 && e2 !== E && 666 !== e2 ? N(t2, g) : (t2.state = null, e2 === E ? N(t2, -3) : b) : g;
    }, a.deflateSetDictionary = function(t2, e2) {
      var a2, i2, n2, r2, s2, o2, l2, h2, d2 = e2.length;
      if (!t2 || !t2.state) return g;
      if (2 === (r2 = (a2 = t2.state).wrap) || 1 === r2 && a2.status !== S || a2.lookahead) return g;
      for (1 === r2 && (t2.adler = u(t2.adler, e2, d2, 0)), a2.wrap = 0, d2 >= a2.w_size && (0 === r2 && (D(a2.head), a2.strstart = 0, a2.block_start = 0, a2.insert = 0), h2 = new _.Buf8(a2.w_size), _.arraySet(h2, e2, d2 - a2.w_size, a2.w_size, 0), e2 = h2, d2 = a2.w_size), s2 = t2.avail_in, o2 = t2.next_in, l2 = t2.input, t2.avail_in = d2, t2.next_in = 0, t2.input = e2, H(a2); a2.lookahead >= x; ) {
        for (i2 = a2.strstart, n2 = a2.lookahead - (x - 1); a2.ins_h = (a2.ins_h << a2.hash_shift ^ a2.window[i2 + x - 1]) & a2.hash_mask, a2.prev[i2 & a2.w_mask] = a2.head[a2.ins_h], a2.head[a2.ins_h] = i2, i2++, --n2; ) ;
        a2.strstart = i2, a2.lookahead = x - 1, H(a2);
      }
      return a2.strstart += a2.lookahead, a2.block_start = a2.strstart, a2.insert = a2.lookahead, a2.lookahead = 0, a2.match_length = a2.prev_length = x - 1, a2.match_available = 0, t2.next_in = o2, t2.input = l2, t2.avail_in = s2, a2.wrap = r2, b;
    }, a.deflateInfo = "pako deflate (from Nodeca project)";
  }, { "../utils/common": 3, "./adler32": 5, "./crc32": 7, "./messages": 13, "./trees": 14 }], 9: [function(t, e, a) {
    "use strict";
    e.exports = function() {
      this.text = 0, this.time = 0, this.xflags = 0, this.os = 0, this.extra = null, this.extra_len = 0, this.name = "", this.comment = "", this.hcrc = 0, this.done = false;
    };
  }, {}], 10: [function(t, e, a) {
    "use strict";
    e.exports = function(t2, e2) {
      var a2, i, n, r, s, o, l, h, d, f, _, u, c, b, g, m, w, p, v, k, y, x, z, B, S;
      a2 = t2.state, i = t2.next_in, B = t2.input, n = i + (t2.avail_in - 5), r = t2.next_out, S = t2.output, s = r - (e2 - t2.avail_out), o = r + (t2.avail_out - 257), l = a2.dmax, h = a2.wsize, d = a2.whave, f = a2.wnext, _ = a2.window, u = a2.hold, c = a2.bits, b = a2.lencode, g = a2.distcode, m = (1 << a2.lenbits) - 1, w = (1 << a2.distbits) - 1;
      t: do {
        c < 15 && (u += B[i++] << c, c += 8, u += B[i++] << c, c += 8), p = b[u & m];
        e: for (; ; ) {
          if (u >>>= v = p >>> 24, c -= v, 0 === (v = p >>> 16 & 255)) S[r++] = 65535 & p;
          else {
            if (!(16 & v)) {
              if (0 == (64 & v)) {
                p = b[(65535 & p) + (u & (1 << v) - 1)];
                continue e;
              }
              if (32 & v) {
                a2.mode = 12;
                break t;
              }
              t2.msg = "invalid literal/length code", a2.mode = 30;
              break t;
            }
            k = 65535 & p, (v &= 15) && (c < v && (u += B[i++] << c, c += 8), k += u & (1 << v) - 1, u >>>= v, c -= v), c < 15 && (u += B[i++] << c, c += 8, u += B[i++] << c, c += 8), p = g[u & w];
            a: for (; ; ) {
              if (u >>>= v = p >>> 24, c -= v, !(16 & (v = p >>> 16 & 255))) {
                if (0 == (64 & v)) {
                  p = g[(65535 & p) + (u & (1 << v) - 1)];
                  continue a;
                }
                t2.msg = "invalid distance code", a2.mode = 30;
                break t;
              }
              if (y = 65535 & p, c < (v &= 15) && (u += B[i++] << c, (c += 8) < v && (u += B[i++] << c, c += 8)), l < (y += u & (1 << v) - 1)) {
                t2.msg = "invalid distance too far back", a2.mode = 30;
                break t;
              }
              if (u >>>= v, c -= v, (v = r - s) < y) {
                if (d < (v = y - v) && a2.sane) {
                  t2.msg = "invalid distance too far back", a2.mode = 30;
                  break t;
                }
                if (z = _, (x = 0) === f) {
                  if (x += h - v, v < k) {
                    for (k -= v; S[r++] = _[x++], --v; ) ;
                    x = r - y, z = S;
                  }
                } else if (f < v) {
                  if (x += h + f - v, (v -= f) < k) {
                    for (k -= v; S[r++] = _[x++], --v; ) ;
                    if (x = 0, f < k) {
                      for (k -= v = f; S[r++] = _[x++], --v; ) ;
                      x = r - y, z = S;
                    }
                  }
                } else if (x += f - v, v < k) {
                  for (k -= v; S[r++] = _[x++], --v; ) ;
                  x = r - y, z = S;
                }
                for (; 2 < k; ) S[r++] = z[x++], S[r++] = z[x++], S[r++] = z[x++], k -= 3;
                k && (S[r++] = z[x++], 1 < k && (S[r++] = z[x++]));
              } else {
                for (x = r - y; S[r++] = S[x++], S[r++] = S[x++], S[r++] = S[x++], 2 < (k -= 3); ) ;
                k && (S[r++] = S[x++], 1 < k && (S[r++] = S[x++]));
              }
              break;
            }
          }
          break;
        }
      } while (i < n && r < o);
      i -= k = c >> 3, u &= (1 << (c -= k << 3)) - 1, t2.next_in = i, t2.next_out = r, t2.avail_in = i < n ? n - i + 5 : 5 - (i - n), t2.avail_out = r < o ? o - r + 257 : 257 - (r - o), a2.hold = u, a2.bits = c;
    };
  }, {}], 11: [function(t, e, a) {
    "use strict";
    var Z = t("../utils/common"), R = t("./adler32"), C = t("./crc32"), N = t("./inffast"), O = t("./inftrees"), D = 1, I = 2, U = 0, T = -2, F = 1, i = 852, n = 592;
    function L(t2) {
      return (t2 >>> 24 & 255) + (t2 >>> 8 & 65280) + ((65280 & t2) << 8) + ((255 & t2) << 24);
    }
    function r() {
      this.mode = 0, this.last = false, this.wrap = 0, this.havedict = false, this.flags = 0, this.dmax = 0, this.check = 0, this.total = 0, this.head = null, this.wbits = 0, this.wsize = 0, this.whave = 0, this.wnext = 0, this.window = null, this.hold = 0, this.bits = 0, this.length = 0, this.offset = 0, this.extra = 0, this.lencode = null, this.distcode = null, this.lenbits = 0, this.distbits = 0, this.ncode = 0, this.nlen = 0, this.ndist = 0, this.have = 0, this.next = null, this.lens = new Z.Buf16(320), this.work = new Z.Buf16(288), this.lendyn = null, this.distdyn = null, this.sane = 0, this.back = 0, this.was = 0;
    }
    function s(t2) {
      var e2;
      return t2 && t2.state ? (e2 = t2.state, t2.total_in = t2.total_out = e2.total = 0, t2.msg = "", e2.wrap && (t2.adler = 1 & e2.wrap), e2.mode = F, e2.last = 0, e2.havedict = 0, e2.dmax = 32768, e2.head = null, e2.hold = 0, e2.bits = 0, e2.lencode = e2.lendyn = new Z.Buf32(i), e2.distcode = e2.distdyn = new Z.Buf32(n), e2.sane = 1, e2.back = -1, U) : T;
    }
    function o(t2) {
      var e2;
      return t2 && t2.state ? ((e2 = t2.state).wsize = 0, e2.whave = 0, e2.wnext = 0, s(t2)) : T;
    }
    function l(t2, e2) {
      var a2, i2;
      return t2 && t2.state ? (i2 = t2.state, e2 < 0 ? (a2 = 0, e2 = -e2) : (a2 = 1 + (e2 >> 4), e2 < 48 && (e2 &= 15)), e2 && (e2 < 8 || 15 < e2) ? T : (null !== i2.window && i2.wbits !== e2 && (i2.window = null), i2.wrap = a2, i2.wbits = e2, o(t2))) : T;
    }
    function h(t2, e2) {
      var a2, i2;
      return t2 ? (i2 = new r(), (t2.state = i2).window = null, (a2 = l(t2, e2)) !== U && (t2.state = null), a2) : T;
    }
    var d, f, _ = true;
    function H(t2) {
      if (_) {
        var e2;
        for (d = new Z.Buf32(512), f = new Z.Buf32(32), e2 = 0; e2 < 144; ) t2.lens[e2++] = 8;
        for (; e2 < 256; ) t2.lens[e2++] = 9;
        for (; e2 < 280; ) t2.lens[e2++] = 7;
        for (; e2 < 288; ) t2.lens[e2++] = 8;
        for (O(D, t2.lens, 0, 288, d, 0, t2.work, { bits: 9 }), e2 = 0; e2 < 32; ) t2.lens[e2++] = 5;
        O(I, t2.lens, 0, 32, f, 0, t2.work, { bits: 5 }), _ = false;
      }
      t2.lencode = d, t2.lenbits = 9, t2.distcode = f, t2.distbits = 5;
    }
    function j(t2, e2, a2, i2) {
      var n2, r2 = t2.state;
      return null === r2.window && (r2.wsize = 1 << r2.wbits, r2.wnext = 0, r2.whave = 0, r2.window = new Z.Buf8(r2.wsize)), i2 >= r2.wsize ? (Z.arraySet(r2.window, e2, a2 - r2.wsize, r2.wsize, 0), r2.wnext = 0, r2.whave = r2.wsize) : (i2 < (n2 = r2.wsize - r2.wnext) && (n2 = i2), Z.arraySet(r2.window, e2, a2 - i2, n2, r2.wnext), (i2 -= n2) ? (Z.arraySet(r2.window, e2, a2 - i2, i2, 0), r2.wnext = i2, r2.whave = r2.wsize) : (r2.wnext += n2, r2.wnext === r2.wsize && (r2.wnext = 0), r2.whave < r2.wsize && (r2.whave += n2))), 0;
    }
    a.inflateReset = o, a.inflateReset2 = l, a.inflateResetKeep = s, a.inflateInit = function(t2) {
      return h(t2, 15);
    }, a.inflateInit2 = h, a.inflate = function(t2, e2) {
      var a2, i2, n2, r2, s2, o2, l2, h2, d2, f2, _2, u, c, b, g, m, w, p, v, k, y, x, z, B, S = 0, E = new Z.Buf8(4), A = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      if (!t2 || !t2.state || !t2.output || !t2.input && 0 !== t2.avail_in) return T;
      12 === (a2 = t2.state).mode && (a2.mode = 13), s2 = t2.next_out, n2 = t2.output, l2 = t2.avail_out, r2 = t2.next_in, i2 = t2.input, o2 = t2.avail_in, h2 = a2.hold, d2 = a2.bits, f2 = o2, _2 = l2, x = U;
      t: for (; ; ) switch (a2.mode) {
        case F:
          if (0 === a2.wrap) {
            a2.mode = 13;
            break;
          }
          for (; d2 < 16; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          if (2 & a2.wrap && 35615 === h2) {
            E[a2.check = 0] = 255 & h2, E[1] = h2 >>> 8 & 255, a2.check = C(a2.check, E, 2, 0), d2 = h2 = 0, a2.mode = 2;
            break;
          }
          if (a2.flags = 0, a2.head && (a2.head.done = false), !(1 & a2.wrap) || (((255 & h2) << 8) + (h2 >> 8)) % 31) {
            t2.msg = "incorrect header check", a2.mode = 30;
            break;
          }
          if (8 != (15 & h2)) {
            t2.msg = "unknown compression method", a2.mode = 30;
            break;
          }
          if (d2 -= 4, y = 8 + (15 & (h2 >>>= 4)), 0 === a2.wbits) a2.wbits = y;
          else if (y > a2.wbits) {
            t2.msg = "invalid window size", a2.mode = 30;
            break;
          }
          a2.dmax = 1 << y, t2.adler = a2.check = 1, a2.mode = 512 & h2 ? 10 : 12, d2 = h2 = 0;
          break;
        case 2:
          for (; d2 < 16; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          if (a2.flags = h2, 8 != (255 & a2.flags)) {
            t2.msg = "unknown compression method", a2.mode = 30;
            break;
          }
          if (57344 & a2.flags) {
            t2.msg = "unknown header flags set", a2.mode = 30;
            break;
          }
          a2.head && (a2.head.text = h2 >> 8 & 1), 512 & a2.flags && (E[0] = 255 & h2, E[1] = h2 >>> 8 & 255, a2.check = C(a2.check, E, 2, 0)), d2 = h2 = 0, a2.mode = 3;
        case 3:
          for (; d2 < 32; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          a2.head && (a2.head.time = h2), 512 & a2.flags && (E[0] = 255 & h2, E[1] = h2 >>> 8 & 255, E[2] = h2 >>> 16 & 255, E[3] = h2 >>> 24 & 255, a2.check = C(a2.check, E, 4, 0)), d2 = h2 = 0, a2.mode = 4;
        case 4:
          for (; d2 < 16; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          a2.head && (a2.head.xflags = 255 & h2, a2.head.os = h2 >> 8), 512 & a2.flags && (E[0] = 255 & h2, E[1] = h2 >>> 8 & 255, a2.check = C(a2.check, E, 2, 0)), d2 = h2 = 0, a2.mode = 5;
        case 5:
          if (1024 & a2.flags) {
            for (; d2 < 16; ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            a2.length = h2, a2.head && (a2.head.extra_len = h2), 512 & a2.flags && (E[0] = 255 & h2, E[1] = h2 >>> 8 & 255, a2.check = C(a2.check, E, 2, 0)), d2 = h2 = 0;
          } else a2.head && (a2.head.extra = null);
          a2.mode = 6;
        case 6:
          if (1024 & a2.flags && (o2 < (u = a2.length) && (u = o2), u && (a2.head && (y = a2.head.extra_len - a2.length, a2.head.extra || (a2.head.extra = new Array(a2.head.extra_len)), Z.arraySet(a2.head.extra, i2, r2, u, y)), 512 & a2.flags && (a2.check = C(a2.check, i2, u, r2)), o2 -= u, r2 += u, a2.length -= u), a2.length)) break t;
          a2.length = 0, a2.mode = 7;
        case 7:
          if (2048 & a2.flags) {
            if (0 === o2) break t;
            for (u = 0; y = i2[r2 + u++], a2.head && y && a2.length < 65536 && (a2.head.name += String.fromCharCode(y)), y && u < o2; ) ;
            if (512 & a2.flags && (a2.check = C(a2.check, i2, u, r2)), o2 -= u, r2 += u, y) break t;
          } else a2.head && (a2.head.name = null);
          a2.length = 0, a2.mode = 8;
        case 8:
          if (4096 & a2.flags) {
            if (0 === o2) break t;
            for (u = 0; y = i2[r2 + u++], a2.head && y && a2.length < 65536 && (a2.head.comment += String.fromCharCode(y)), y && u < o2; ) ;
            if (512 & a2.flags && (a2.check = C(a2.check, i2, u, r2)), o2 -= u, r2 += u, y) break t;
          } else a2.head && (a2.head.comment = null);
          a2.mode = 9;
        case 9:
          if (512 & a2.flags) {
            for (; d2 < 16; ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            if (h2 !== (65535 & a2.check)) {
              t2.msg = "header crc mismatch", a2.mode = 30;
              break;
            }
            d2 = h2 = 0;
          }
          a2.head && (a2.head.hcrc = a2.flags >> 9 & 1, a2.head.done = true), t2.adler = a2.check = 0, a2.mode = 12;
          break;
        case 10:
          for (; d2 < 32; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          t2.adler = a2.check = L(h2), d2 = h2 = 0, a2.mode = 11;
        case 11:
          if (0 === a2.havedict) return t2.next_out = s2, t2.avail_out = l2, t2.next_in = r2, t2.avail_in = o2, a2.hold = h2, a2.bits = d2, 2;
          t2.adler = a2.check = 1, a2.mode = 12;
        case 12:
          if (5 === e2 || 6 === e2) break t;
        case 13:
          if (a2.last) {
            h2 >>>= 7 & d2, d2 -= 7 & d2, a2.mode = 27;
            break;
          }
          for (; d2 < 3; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          switch (a2.last = 1 & h2, d2 -= 1, 3 & (h2 >>>= 1)) {
            case 0:
              a2.mode = 14;
              break;
            case 1:
              if (H(a2), a2.mode = 20, 6 !== e2) break;
              h2 >>>= 2, d2 -= 2;
              break t;
            case 2:
              a2.mode = 17;
              break;
            case 3:
              t2.msg = "invalid block type", a2.mode = 30;
          }
          h2 >>>= 2, d2 -= 2;
          break;
        case 14:
          for (h2 >>>= 7 & d2, d2 -= 7 & d2; d2 < 32; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          if ((65535 & h2) != (h2 >>> 16 ^ 65535)) {
            t2.msg = "invalid stored block lengths", a2.mode = 30;
            break;
          }
          if (a2.length = 65535 & h2, d2 = h2 = 0, a2.mode = 15, 6 === e2) break t;
        case 15:
          a2.mode = 16;
        case 16:
          if (u = a2.length) {
            if (o2 < u && (u = o2), l2 < u && (u = l2), 0 === u) break t;
            Z.arraySet(n2, i2, r2, u, s2), o2 -= u, r2 += u, l2 -= u, s2 += u, a2.length -= u;
            break;
          }
          a2.mode = 12;
          break;
        case 17:
          for (; d2 < 14; ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          if (a2.nlen = 257 + (31 & h2), h2 >>>= 5, d2 -= 5, a2.ndist = 1 + (31 & h2), h2 >>>= 5, d2 -= 5, a2.ncode = 4 + (15 & h2), h2 >>>= 4, d2 -= 4, 286 < a2.nlen || 30 < a2.ndist) {
            t2.msg = "too many length or distance symbols", a2.mode = 30;
            break;
          }
          a2.have = 0, a2.mode = 18;
        case 18:
          for (; a2.have < a2.ncode; ) {
            for (; d2 < 3; ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            a2.lens[A[a2.have++]] = 7 & h2, h2 >>>= 3, d2 -= 3;
          }
          for (; a2.have < 19; ) a2.lens[A[a2.have++]] = 0;
          if (a2.lencode = a2.lendyn, a2.lenbits = 7, z = { bits: a2.lenbits }, x = O(0, a2.lens, 0, 19, a2.lencode, 0, a2.work, z), a2.lenbits = z.bits, x) {
            t2.msg = "invalid code lengths set", a2.mode = 30;
            break;
          }
          a2.have = 0, a2.mode = 19;
        case 19:
          for (; a2.have < a2.nlen + a2.ndist; ) {
            for (; m = (S = a2.lencode[h2 & (1 << a2.lenbits) - 1]) >>> 16 & 255, w = 65535 & S, !((g = S >>> 24) <= d2); ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            if (w < 16) h2 >>>= g, d2 -= g, a2.lens[a2.have++] = w;
            else {
              if (16 === w) {
                for (B = g + 2; d2 < B; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[r2++] << d2, d2 += 8;
                }
                if (h2 >>>= g, d2 -= g, 0 === a2.have) {
                  t2.msg = "invalid bit length repeat", a2.mode = 30;
                  break;
                }
                y = a2.lens[a2.have - 1], u = 3 + (3 & h2), h2 >>>= 2, d2 -= 2;
              } else if (17 === w) {
                for (B = g + 3; d2 < B; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[r2++] << d2, d2 += 8;
                }
                d2 -= g, y = 0, u = 3 + (7 & (h2 >>>= g)), h2 >>>= 3, d2 -= 3;
              } else {
                for (B = g + 7; d2 < B; ) {
                  if (0 === o2) break t;
                  o2--, h2 += i2[r2++] << d2, d2 += 8;
                }
                d2 -= g, y = 0, u = 11 + (127 & (h2 >>>= g)), h2 >>>= 7, d2 -= 7;
              }
              if (a2.have + u > a2.nlen + a2.ndist) {
                t2.msg = "invalid bit length repeat", a2.mode = 30;
                break;
              }
              for (; u--; ) a2.lens[a2.have++] = y;
            }
          }
          if (30 === a2.mode) break;
          if (0 === a2.lens[256]) {
            t2.msg = "invalid code -- missing end-of-block", a2.mode = 30;
            break;
          }
          if (a2.lenbits = 9, z = { bits: a2.lenbits }, x = O(D, a2.lens, 0, a2.nlen, a2.lencode, 0, a2.work, z), a2.lenbits = z.bits, x) {
            t2.msg = "invalid literal/lengths set", a2.mode = 30;
            break;
          }
          if (a2.distbits = 6, a2.distcode = a2.distdyn, z = { bits: a2.distbits }, x = O(I, a2.lens, a2.nlen, a2.ndist, a2.distcode, 0, a2.work, z), a2.distbits = z.bits, x) {
            t2.msg = "invalid distances set", a2.mode = 30;
            break;
          }
          if (a2.mode = 20, 6 === e2) break t;
        case 20:
          a2.mode = 21;
        case 21:
          if (6 <= o2 && 258 <= l2) {
            t2.next_out = s2, t2.avail_out = l2, t2.next_in = r2, t2.avail_in = o2, a2.hold = h2, a2.bits = d2, N(t2, _2), s2 = t2.next_out, n2 = t2.output, l2 = t2.avail_out, r2 = t2.next_in, i2 = t2.input, o2 = t2.avail_in, h2 = a2.hold, d2 = a2.bits, 12 === a2.mode && (a2.back = -1);
            break;
          }
          for (a2.back = 0; m = (S = a2.lencode[h2 & (1 << a2.lenbits) - 1]) >>> 16 & 255, w = 65535 & S, !((g = S >>> 24) <= d2); ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          if (m && 0 == (240 & m)) {
            for (p = g, v = m, k = w; m = (S = a2.lencode[k + ((h2 & (1 << p + v) - 1) >> p)]) >>> 16 & 255, w = 65535 & S, !(p + (g = S >>> 24) <= d2); ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            h2 >>>= p, d2 -= p, a2.back += p;
          }
          if (h2 >>>= g, d2 -= g, a2.back += g, a2.length = w, 0 === m) {
            a2.mode = 26;
            break;
          }
          if (32 & m) {
            a2.back = -1, a2.mode = 12;
            break;
          }
          if (64 & m) {
            t2.msg = "invalid literal/length code", a2.mode = 30;
            break;
          }
          a2.extra = 15 & m, a2.mode = 22;
        case 22:
          if (a2.extra) {
            for (B = a2.extra; d2 < B; ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            a2.length += h2 & (1 << a2.extra) - 1, h2 >>>= a2.extra, d2 -= a2.extra, a2.back += a2.extra;
          }
          a2.was = a2.length, a2.mode = 23;
        case 23:
          for (; m = (S = a2.distcode[h2 & (1 << a2.distbits) - 1]) >>> 16 & 255, w = 65535 & S, !((g = S >>> 24) <= d2); ) {
            if (0 === o2) break t;
            o2--, h2 += i2[r2++] << d2, d2 += 8;
          }
          if (0 == (240 & m)) {
            for (p = g, v = m, k = w; m = (S = a2.distcode[k + ((h2 & (1 << p + v) - 1) >> p)]) >>> 16 & 255, w = 65535 & S, !(p + (g = S >>> 24) <= d2); ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            h2 >>>= p, d2 -= p, a2.back += p;
          }
          if (h2 >>>= g, d2 -= g, a2.back += g, 64 & m) {
            t2.msg = "invalid distance code", a2.mode = 30;
            break;
          }
          a2.offset = w, a2.extra = 15 & m, a2.mode = 24;
        case 24:
          if (a2.extra) {
            for (B = a2.extra; d2 < B; ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            a2.offset += h2 & (1 << a2.extra) - 1, h2 >>>= a2.extra, d2 -= a2.extra, a2.back += a2.extra;
          }
          if (a2.offset > a2.dmax) {
            t2.msg = "invalid distance too far back", a2.mode = 30;
            break;
          }
          a2.mode = 25;
        case 25:
          if (0 === l2) break t;
          if (u = _2 - l2, a2.offset > u) {
            if ((u = a2.offset - u) > a2.whave && a2.sane) {
              t2.msg = "invalid distance too far back", a2.mode = 30;
              break;
            }
            u > a2.wnext ? (u -= a2.wnext, c = a2.wsize - u) : c = a2.wnext - u, u > a2.length && (u = a2.length), b = a2.window;
          } else b = n2, c = s2 - a2.offset, u = a2.length;
          for (l2 < u && (u = l2), l2 -= u, a2.length -= u; n2[s2++] = b[c++], --u; ) ;
          0 === a2.length && (a2.mode = 21);
          break;
        case 26:
          if (0 === l2) break t;
          n2[s2++] = a2.length, l2--, a2.mode = 21;
          break;
        case 27:
          if (a2.wrap) {
            for (; d2 < 32; ) {
              if (0 === o2) break t;
              o2--, h2 |= i2[r2++] << d2, d2 += 8;
            }
            if (_2 -= l2, t2.total_out += _2, a2.total += _2, _2 && (t2.adler = a2.check = a2.flags ? C(a2.check, n2, _2, s2 - _2) : R(a2.check, n2, _2, s2 - _2)), _2 = l2, (a2.flags ? h2 : L(h2)) !== a2.check) {
              t2.msg = "incorrect data check", a2.mode = 30;
              break;
            }
            d2 = h2 = 0;
          }
          a2.mode = 28;
        case 28:
          if (a2.wrap && a2.flags) {
            for (; d2 < 32; ) {
              if (0 === o2) break t;
              o2--, h2 += i2[r2++] << d2, d2 += 8;
            }
            if (h2 !== (4294967295 & a2.total)) {
              t2.msg = "incorrect length check", a2.mode = 30;
              break;
            }
            d2 = h2 = 0;
          }
          a2.mode = 29;
        case 29:
          x = 1;
          break t;
        case 30:
          x = -3;
          break t;
        case 31:
          return -4;
        case 32:
        default:
          return T;
      }
      return t2.next_out = s2, t2.avail_out = l2, t2.next_in = r2, t2.avail_in = o2, a2.hold = h2, a2.bits = d2, (a2.wsize || _2 !== t2.avail_out && a2.mode < 30 && (a2.mode < 27 || 4 !== e2)) && j(t2, t2.output, t2.next_out, _2 - t2.avail_out) ? (a2.mode = 31, -4) : (f2 -= t2.avail_in, _2 -= t2.avail_out, t2.total_in += f2, t2.total_out += _2, a2.total += _2, a2.wrap && _2 && (t2.adler = a2.check = a2.flags ? C(a2.check, n2, _2, t2.next_out - _2) : R(a2.check, n2, _2, t2.next_out - _2)), t2.data_type = a2.bits + (a2.last ? 64 : 0) + (12 === a2.mode ? 128 : 0) + (20 === a2.mode || 15 === a2.mode ? 256 : 0), (0 === f2 && 0 === _2 || 4 === e2) && x === U && (x = -5), x);
    }, a.inflateEnd = function(t2) {
      if (!t2 || !t2.state) return T;
      var e2 = t2.state;
      return e2.window && (e2.window = null), t2.state = null, U;
    }, a.inflateGetHeader = function(t2, e2) {
      var a2;
      return t2 && t2.state ? 0 == (2 & (a2 = t2.state).wrap) ? T : ((a2.head = e2).done = false, U) : T;
    }, a.inflateSetDictionary = function(t2, e2) {
      var a2, i2 = e2.length;
      return t2 && t2.state ? 0 !== (a2 = t2.state).wrap && 11 !== a2.mode ? T : 11 === a2.mode && R(1, e2, i2, 0) !== a2.check ? -3 : j(t2, e2, i2, i2) ? (a2.mode = 31, -4) : (a2.havedict = 1, U) : T;
    }, a.inflateInfo = "pako inflate (from Nodeca project)";
  }, { "../utils/common": 3, "./adler32": 5, "./crc32": 7, "./inffast": 10, "./inftrees": 12 }], 12: [function(t, e, a) {
    "use strict";
    var D = t("../utils/common"), I = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0], U = [16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78], T = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0], F = [16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64];
    e.exports = function(t2, e2, a2, i, n, r, s, o) {
      var l, h, d, f, _, u, c, b, g, m = o.bits, w = 0, p = 0, v = 0, k = 0, y = 0, x = 0, z = 0, B = 0, S = 0, E = 0, A = null, Z = 0, R = new D.Buf16(16), C = new D.Buf16(16), N = null, O = 0;
      for (w = 0; w <= 15; w++) R[w] = 0;
      for (p = 0; p < i; p++) R[e2[a2 + p]]++;
      for (y = m, k = 15; 1 <= k && 0 === R[k]; k--) ;
      if (k < y && (y = k), 0 === k) return n[r++] = 20971520, n[r++] = 20971520, o.bits = 1, 0;
      for (v = 1; v < k && 0 === R[v]; v++) ;
      for (y < v && (y = v), w = B = 1; w <= 15; w++) if (B <<= 1, (B -= R[w]) < 0) return -1;
      if (0 < B && (0 === t2 || 1 !== k)) return -1;
      for (C[1] = 0, w = 1; w < 15; w++) C[w + 1] = C[w] + R[w];
      for (p = 0; p < i; p++) 0 !== e2[a2 + p] && (s[C[e2[a2 + p]]++] = p);
      if (0 === t2 ? (A = N = s, u = 19) : 1 === t2 ? (A = I, Z -= 257, N = U, O -= 257, u = 256) : (A = T, N = F, u = -1), w = v, _ = r, z = p = E = 0, d = -1, f = (S = 1 << (x = y)) - 1, 1 === t2 && 852 < S || 2 === t2 && 592 < S) return 1;
      for (; ; ) {
        for (c = w - z, s[p] < u ? (b = 0, g = s[p]) : s[p] > u ? (b = N[O + s[p]], g = A[Z + s[p]]) : (b = 96, g = 0), l = 1 << w - z, v = h = 1 << x; n[_ + (E >> z) + (h -= l)] = c << 24 | b << 16 | g | 0, 0 !== h; ) ;
        for (l = 1 << w - 1; E & l; ) l >>= 1;
        if (0 !== l ? (E &= l - 1, E += l) : E = 0, p++, 0 == --R[w]) {
          if (w === k) break;
          w = e2[a2 + s[p]];
        }
        if (y < w && (E & f) !== d) {
          for (0 === z && (z = y), _ += v, B = 1 << (x = w - z); x + z < k && !((B -= R[x + z]) <= 0); ) x++, B <<= 1;
          if (S += 1 << x, 1 === t2 && 852 < S || 2 === t2 && 592 < S) return 1;
          n[d = E & f] = y << 24 | x << 16 | _ - r | 0;
        }
      }
      return 0 !== E && (n[_ + E] = w - z << 24 | 64 << 16 | 0), o.bits = y, 0;
    };
  }, { "../utils/common": 3 }], 13: [function(t, e, a) {
    "use strict";
    e.exports = { 2: "need dictionary", 1: "stream end", 0: "", "-1": "file error", "-2": "stream error", "-3": "data error", "-4": "insufficient memory", "-5": "buffer error", "-6": "incompatible version" };
  }, {}], 14: [function(t, e, a) {
    "use strict";
    var l = t("../utils/common"), o = 0, h = 1;
    function i(t2) {
      for (var e2 = t2.length; 0 <= --e2; ) t2[e2] = 0;
    }
    var d = 0, s = 29, f = 256, _ = f + 1 + s, u = 30, c = 19, g = 2 * _ + 1, m = 15, n = 16, b = 7, w = 256, p = 16, v = 17, k = 18, y = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0], x = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13], z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7], B = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15], S = new Array(2 * (_ + 2));
    i(S);
    var E = new Array(2 * u);
    i(E);
    var A = new Array(512);
    i(A);
    var Z = new Array(256);
    i(Z);
    var R = new Array(s);
    i(R);
    var C, N, O, D = new Array(u);
    function I(t2, e2, a2, i2, n2) {
      this.static_tree = t2, this.extra_bits = e2, this.extra_base = a2, this.elems = i2, this.max_length = n2, this.has_stree = t2 && t2.length;
    }
    function r(t2, e2) {
      this.dyn_tree = t2, this.max_code = 0, this.stat_desc = e2;
    }
    function U(t2) {
      return t2 < 256 ? A[t2] : A[256 + (t2 >>> 7)];
    }
    function T(t2, e2) {
      t2.pending_buf[t2.pending++] = 255 & e2, t2.pending_buf[t2.pending++] = e2 >>> 8 & 255;
    }
    function F(t2, e2, a2) {
      t2.bi_valid > n - a2 ? (t2.bi_buf |= e2 << t2.bi_valid & 65535, T(t2, t2.bi_buf), t2.bi_buf = e2 >> n - t2.bi_valid, t2.bi_valid += a2 - n) : (t2.bi_buf |= e2 << t2.bi_valid & 65535, t2.bi_valid += a2);
    }
    function L(t2, e2, a2) {
      F(t2, a2[2 * e2], a2[2 * e2 + 1]);
    }
    function H(t2, e2) {
      for (var a2 = 0; a2 |= 1 & t2, t2 >>>= 1, a2 <<= 1, 0 < --e2; ) ;
      return a2 >>> 1;
    }
    function j(t2, e2, a2) {
      var i2, n2, r2 = new Array(m + 1), s2 = 0;
      for (i2 = 1; i2 <= m; i2++) r2[i2] = s2 = s2 + a2[i2 - 1] << 1;
      for (n2 = 0; n2 <= e2; n2++) {
        var o2 = t2[2 * n2 + 1];
        0 !== o2 && (t2[2 * n2] = H(r2[o2]++, o2));
      }
    }
    function K(t2) {
      var e2;
      for (e2 = 0; e2 < _; e2++) t2.dyn_ltree[2 * e2] = 0;
      for (e2 = 0; e2 < u; e2++) t2.dyn_dtree[2 * e2] = 0;
      for (e2 = 0; e2 < c; e2++) t2.bl_tree[2 * e2] = 0;
      t2.dyn_ltree[2 * w] = 1, t2.opt_len = t2.static_len = 0, t2.last_lit = t2.matches = 0;
    }
    function M(t2) {
      8 < t2.bi_valid ? T(t2, t2.bi_buf) : 0 < t2.bi_valid && (t2.pending_buf[t2.pending++] = t2.bi_buf), t2.bi_buf = 0, t2.bi_valid = 0;
    }
    function P(t2, e2, a2, i2) {
      var n2 = 2 * e2, r2 = 2 * a2;
      return t2[n2] < t2[r2] || t2[n2] === t2[r2] && i2[e2] <= i2[a2];
    }
    function Y(t2, e2, a2) {
      for (var i2 = t2.heap[a2], n2 = a2 << 1; n2 <= t2.heap_len && (n2 < t2.heap_len && P(e2, t2.heap[n2 + 1], t2.heap[n2], t2.depth) && n2++, !P(e2, i2, t2.heap[n2], t2.depth)); ) t2.heap[a2] = t2.heap[n2], a2 = n2, n2 <<= 1;
      t2.heap[a2] = i2;
    }
    function q(t2, e2, a2) {
      var i2, n2, r2, s2, o2 = 0;
      if (0 !== t2.last_lit) for (; i2 = t2.pending_buf[t2.d_buf + 2 * o2] << 8 | t2.pending_buf[t2.d_buf + 2 * o2 + 1], n2 = t2.pending_buf[t2.l_buf + o2], o2++, 0 === i2 ? L(t2, n2, e2) : (L(t2, (r2 = Z[n2]) + f + 1, e2), 0 !== (s2 = y[r2]) && F(t2, n2 -= R[r2], s2), L(t2, r2 = U(--i2), a2), 0 !== (s2 = x[r2]) && F(t2, i2 -= D[r2], s2)), o2 < t2.last_lit; ) ;
      L(t2, w, e2);
    }
    function G(t2, e2) {
      var a2, i2, n2, r2 = e2.dyn_tree, s2 = e2.stat_desc.static_tree, o2 = e2.stat_desc.has_stree, l2 = e2.stat_desc.elems, h2 = -1;
      for (t2.heap_len = 0, t2.heap_max = g, a2 = 0; a2 < l2; a2++) 0 !== r2[2 * a2] ? (t2.heap[++t2.heap_len] = h2 = a2, t2.depth[a2] = 0) : r2[2 * a2 + 1] = 0;
      for (; t2.heap_len < 2; ) r2[2 * (n2 = t2.heap[++t2.heap_len] = h2 < 2 ? ++h2 : 0)] = 1, t2.depth[n2] = 0, t2.opt_len--, o2 && (t2.static_len -= s2[2 * n2 + 1]);
      for (e2.max_code = h2, a2 = t2.heap_len >> 1; 1 <= a2; a2--) Y(t2, r2, a2);
      for (n2 = l2; a2 = t2.heap[1], t2.heap[1] = t2.heap[t2.heap_len--], Y(t2, r2, 1), i2 = t2.heap[1], t2.heap[--t2.heap_max] = a2, t2.heap[--t2.heap_max] = i2, r2[2 * n2] = r2[2 * a2] + r2[2 * i2], t2.depth[n2] = (t2.depth[a2] >= t2.depth[i2] ? t2.depth[a2] : t2.depth[i2]) + 1, r2[2 * a2 + 1] = r2[2 * i2 + 1] = n2, t2.heap[1] = n2++, Y(t2, r2, 1), 2 <= t2.heap_len; ) ;
      t2.heap[--t2.heap_max] = t2.heap[1], (function(t3, e3) {
        var a3, i3, n3, r3, s3, o3, l3 = e3.dyn_tree, h3 = e3.max_code, d2 = e3.stat_desc.static_tree, f2 = e3.stat_desc.has_stree, _2 = e3.stat_desc.extra_bits, u2 = e3.stat_desc.extra_base, c2 = e3.stat_desc.max_length, b2 = 0;
        for (r3 = 0; r3 <= m; r3++) t3.bl_count[r3] = 0;
        for (l3[2 * t3.heap[t3.heap_max] + 1] = 0, a3 = t3.heap_max + 1; a3 < g; a3++) c2 < (r3 = l3[2 * l3[2 * (i3 = t3.heap[a3]) + 1] + 1] + 1) && (r3 = c2, b2++), l3[2 * i3 + 1] = r3, h3 < i3 || (t3.bl_count[r3]++, s3 = 0, u2 <= i3 && (s3 = _2[i3 - u2]), o3 = l3[2 * i3], t3.opt_len += o3 * (r3 + s3), f2 && (t3.static_len += o3 * (d2[2 * i3 + 1] + s3)));
        if (0 !== b2) {
          do {
            for (r3 = c2 - 1; 0 === t3.bl_count[r3]; ) r3--;
            t3.bl_count[r3]--, t3.bl_count[r3 + 1] += 2, t3.bl_count[c2]--, b2 -= 2;
          } while (0 < b2);
          for (r3 = c2; 0 !== r3; r3--) for (i3 = t3.bl_count[r3]; 0 !== i3; ) h3 < (n3 = t3.heap[--a3]) || (l3[2 * n3 + 1] !== r3 && (t3.opt_len += (r3 - l3[2 * n3 + 1]) * l3[2 * n3], l3[2 * n3 + 1] = r3), i3--);
        }
      })(t2, e2), j(r2, h2, t2.bl_count);
    }
    function X(t2, e2, a2) {
      var i2, n2, r2 = -1, s2 = e2[1], o2 = 0, l2 = 7, h2 = 4;
      for (0 === s2 && (l2 = 138, h2 = 3), e2[2 * (a2 + 1) + 1] = 65535, i2 = 0; i2 <= a2; i2++) n2 = s2, s2 = e2[2 * (i2 + 1) + 1], ++o2 < l2 && n2 === s2 || (o2 < h2 ? t2.bl_tree[2 * n2] += o2 : 0 !== n2 ? (n2 !== r2 && t2.bl_tree[2 * n2]++, t2.bl_tree[2 * p]++) : o2 <= 10 ? t2.bl_tree[2 * v]++ : t2.bl_tree[2 * k]++, r2 = n2, (o2 = 0) === s2 ? (l2 = 138, h2 = 3) : n2 === s2 ? (l2 = 6, h2 = 3) : (l2 = 7, h2 = 4));
    }
    function W(t2, e2, a2) {
      var i2, n2, r2 = -1, s2 = e2[1], o2 = 0, l2 = 7, h2 = 4;
      for (0 === s2 && (l2 = 138, h2 = 3), i2 = 0; i2 <= a2; i2++) if (n2 = s2, s2 = e2[2 * (i2 + 1) + 1], !(++o2 < l2 && n2 === s2)) {
        if (o2 < h2) for (; L(t2, n2, t2.bl_tree), 0 != --o2; ) ;
        else 0 !== n2 ? (n2 !== r2 && (L(t2, n2, t2.bl_tree), o2--), L(t2, p, t2.bl_tree), F(t2, o2 - 3, 2)) : o2 <= 10 ? (L(t2, v, t2.bl_tree), F(t2, o2 - 3, 3)) : (L(t2, k, t2.bl_tree), F(t2, o2 - 11, 7));
        r2 = n2, (o2 = 0) === s2 ? (l2 = 138, h2 = 3) : n2 === s2 ? (l2 = 6, h2 = 3) : (l2 = 7, h2 = 4);
      }
    }
    i(D);
    var J = false;
    function Q(t2, e2, a2, i2) {
      var n2, r2, s2, o2;
      F(t2, (d << 1) + (i2 ? 1 : 0), 3), r2 = e2, s2 = a2, o2 = true, M(n2 = t2), o2 && (T(n2, s2), T(n2, ~s2)), l.arraySet(n2.pending_buf, n2.window, r2, s2, n2.pending), n2.pending += s2;
    }
    a._tr_init = function(t2) {
      J || ((function() {
        var t3, e2, a2, i2, n2, r2 = new Array(m + 1);
        for (i2 = a2 = 0; i2 < s - 1; i2++) for (R[i2] = a2, t3 = 0; t3 < 1 << y[i2]; t3++) Z[a2++] = i2;
        for (Z[a2 - 1] = i2, i2 = n2 = 0; i2 < 16; i2++) for (D[i2] = n2, t3 = 0; t3 < 1 << x[i2]; t3++) A[n2++] = i2;
        for (n2 >>= 7; i2 < u; i2++) for (D[i2] = n2 << 7, t3 = 0; t3 < 1 << x[i2] - 7; t3++) A[256 + n2++] = i2;
        for (e2 = 0; e2 <= m; e2++) r2[e2] = 0;
        for (t3 = 0; t3 <= 143; ) S[2 * t3 + 1] = 8, t3++, r2[8]++;
        for (; t3 <= 255; ) S[2 * t3 + 1] = 9, t3++, r2[9]++;
        for (; t3 <= 279; ) S[2 * t3 + 1] = 7, t3++, r2[7]++;
        for (; t3 <= 287; ) S[2 * t3 + 1] = 8, t3++, r2[8]++;
        for (j(S, _ + 1, r2), t3 = 0; t3 < u; t3++) E[2 * t3 + 1] = 5, E[2 * t3] = H(t3, 5);
        C = new I(S, y, f + 1, _, m), N = new I(E, x, 0, u, m), O = new I(new Array(0), z, 0, c, b);
      })(), J = true), t2.l_desc = new r(t2.dyn_ltree, C), t2.d_desc = new r(t2.dyn_dtree, N), t2.bl_desc = new r(t2.bl_tree, O), t2.bi_buf = 0, t2.bi_valid = 0, K(t2);
    }, a._tr_stored_block = Q, a._tr_flush_block = function(t2, e2, a2, i2) {
      var n2, r2, s2 = 0;
      0 < t2.level ? (2 === t2.strm.data_type && (t2.strm.data_type = (function(t3) {
        var e3, a3 = 4093624447;
        for (e3 = 0; e3 <= 31; e3++, a3 >>>= 1) if (1 & a3 && 0 !== t3.dyn_ltree[2 * e3]) return o;
        if (0 !== t3.dyn_ltree[18] || 0 !== t3.dyn_ltree[20] || 0 !== t3.dyn_ltree[26]) return h;
        for (e3 = 32; e3 < f; e3++) if (0 !== t3.dyn_ltree[2 * e3]) return h;
        return o;
      })(t2)), G(t2, t2.l_desc), G(t2, t2.d_desc), s2 = (function(t3) {
        var e3;
        for (X(t3, t3.dyn_ltree, t3.l_desc.max_code), X(t3, t3.dyn_dtree, t3.d_desc.max_code), G(t3, t3.bl_desc), e3 = c - 1; 3 <= e3 && 0 === t3.bl_tree[2 * B[e3] + 1]; e3--) ;
        return t3.opt_len += 3 * (e3 + 1) + 5 + 5 + 4, e3;
      })(t2), n2 = t2.opt_len + 3 + 7 >>> 3, (r2 = t2.static_len + 3 + 7 >>> 3) <= n2 && (n2 = r2)) : n2 = r2 = a2 + 5, a2 + 4 <= n2 && -1 !== e2 ? Q(t2, e2, a2, i2) : 4 === t2.strategy || r2 === n2 ? (F(t2, 2 + (i2 ? 1 : 0), 3), q(t2, S, E)) : (F(t2, 4 + (i2 ? 1 : 0), 3), (function(t3, e3, a3, i3) {
        var n3;
        for (F(t3, e3 - 257, 5), F(t3, a3 - 1, 5), F(t3, i3 - 4, 4), n3 = 0; n3 < i3; n3++) F(t3, t3.bl_tree[2 * B[n3] + 1], 3);
        W(t3, t3.dyn_ltree, e3 - 1), W(t3, t3.dyn_dtree, a3 - 1);
      })(t2, t2.l_desc.max_code + 1, t2.d_desc.max_code + 1, s2 + 1), q(t2, t2.dyn_ltree, t2.dyn_dtree)), K(t2), i2 && M(t2);
    }, a._tr_tally = function(t2, e2, a2) {
      return t2.pending_buf[t2.d_buf + 2 * t2.last_lit] = e2 >>> 8 & 255, t2.pending_buf[t2.d_buf + 2 * t2.last_lit + 1] = 255 & e2, t2.pending_buf[t2.l_buf + t2.last_lit] = 255 & a2, t2.last_lit++, 0 === e2 ? t2.dyn_ltree[2 * a2]++ : (t2.matches++, e2--, t2.dyn_ltree[2 * (Z[a2] + f + 1)]++, t2.dyn_dtree[2 * U(e2)]++), t2.last_lit === t2.lit_bufsize - 1;
    }, a._tr_align = function(t2) {
      var e2;
      F(t2, 2, 3), L(t2, w, S), 16 === (e2 = t2).bi_valid ? (T(e2, e2.bi_buf), e2.bi_buf = 0, e2.bi_valid = 0) : 8 <= e2.bi_valid && (e2.pending_buf[e2.pending++] = 255 & e2.bi_buf, e2.bi_buf >>= 8, e2.bi_valid -= 8);
    };
  }, { "../utils/common": 3 }], 15: [function(t, e, a) {
    "use strict";
    e.exports = function() {
      this.input = null, this.next_in = 0, this.avail_in = 0, this.total_in = 0, this.output = null, this.next_out = 0, this.avail_out = 0, this.total_out = 0, this.msg = "", this.state = null, this.data_type = 2, this.adler = 0;
    };
  }, {}], "/": [function(t, e, a) {
    "use strict";
    var i = {};
    (0, t("./lib/utils/common").assign)(i, t("./lib/deflate"), t("./lib/inflate"), t("./lib/zlib/constants")), e.exports = i;
  }, { "./lib/deflate": 1, "./lib/inflate": 2, "./lib/utils/common": 3, "./lib/zlib/constants": 6 }] }, {}, [])("/");
})();
if (typeof pako.Deflate !== "function" || typeof pako.Inflate !== "function") throw new Error("vendored pako bundle failed to initialize");
var Deflate = pako.Deflate;
var Inflate = pako.Inflate;

// peerd/extension/shared/bundle/transport.js
var BUNDLE_TRANSPORT_VERSION = 2;
var BUNDLE_TRANSPORT_ENCODING = "gzip";
var BUNDLE_TRANSPORT_CODEC = "pako@1.0.11:gzip:l6:w15:m8:s0:i262144:mtime0:os255";
var MAX_BUNDLE_CONTAINER_BYTES = 7e7;
var MAX_BUNDLE_DECODED_BYTES = 5e7;
var MAX_BUNDLE_FILE_BYTES = 5e7;
var MAX_BUNDLE_FILES = 256;
var MAX_BUNDLE_PATH_CHARS = 512;
var SHA256_HEX = /^[a-f0-9]{64}$/;
var assertBundleTransportDescriptor = (candidate, limits = {}) => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("bundle transport descriptor missing");
  }
  const descriptor = (
    /** @type {any} */
    candidate
  );
  if (descriptor.version !== BUNDLE_TRANSPORT_VERSION || descriptor.encoding !== BUNDLE_TRANSPORT_ENCODING || descriptor.codec !== BUNDLE_TRANSPORT_CODEC) {
    throw new Error("bundle transport version, encoding, or codec unsupported");
  }
  const maxCompressedBytes = limits.maxCompressedBytes ?? 5e7;
  if (!Number.isSafeInteger(descriptor.compressedSize) || descriptor.compressedSize <= 0 || descriptor.compressedSize > maxCompressedBytes || limits.compressedSize !== void 0 && descriptor.compressedSize !== limits.compressedSize) {
    throw new Error("bundle compressed size invalid");
  }
  if (!Number.isSafeInteger(descriptor.uncompressedSize) || descriptor.uncompressedSize <= 0 || descriptor.uncompressedSize > MAX_BUNDLE_CONTAINER_BYTES) {
    throw new Error("bundle uncompressed size invalid");
  }
  if (!SHA256_HEX.test(descriptor.compressedHash) || !SHA256_HEX.test(descriptor.uncompressedHash)) {
    throw new Error("bundle transport hash invalid");
  }
  if (!Array.isArray(descriptor.files) || descriptor.files.length > MAX_BUNDLE_FILES) {
    throw new Error("bundle file commitments invalid");
  }
  const paths = /* @__PURE__ */ new Set();
  let decodedBytes = 0;
  let previousPath = "";
  for (const file of descriptor.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string") {
      throw new Error("bundle file commitment path invalid");
    }
    const path = (
      /** @type {string} */
      file.path
    );
    if (!path || path.length > MAX_BUNDLE_PATH_CHARS || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(path)) {
      throw new Error("bundle file commitment path invalid");
    }
    if (previousPath && path <= previousPath) {
      throw new Error("bundle file commitments must be in lexical path order");
    }
    paths.add(path);
    previousPath = path;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`bundle file commitment size invalid: ${path}`);
    }
    decodedBytes += file.size;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_BUNDLE_DECODED_BYTES) {
      throw new Error("bundle file commitments exceed decoded byte limit");
    }
    if (!SHA256_HEX.test(file.hash)) throw new Error(`bundle file commitment hash invalid: ${path}`);
    if (file.kind !== void 0 && file.kind !== "text" && file.kind !== "binary") {
      throw new Error(`bundle file commitment kind invalid: ${path}`);
    }
  }
  return (
    /** @type {BundleTransportDescriptor} */
    candidate
  );
};
var CODEC_OUTPUT_CHUNK_BYTES = 16 * 1024;
var CODEC_INPUT_CHUNK_BYTES = 256 * 1024;

// peerd/extension/peerd-distributed/content/manifest.js
var signingBytes2 = (manifest) => concat(
  utf8(manifest.v === 2 ? "peerd/manifest/v2" : "peerd/manifest/v1"),
  Uint8Array.from([0]),
  canonicalManifestBytes(manifest)
);
var MAX_BUNDLE_BYTES = MAX_NETWORK_BUNDLE_BYTES;
var MAX_BUNDLE_CHUNKS = Math.ceil(MAX_BUNDLE_BYTES / CHUNK_SIZE);
var MAX_MANIFEST_BYTES = 256e3;
var SHA256_HEX2 = /^[a-f0-9]{64}$/;
var assertBundleWithinLimits = (manifest) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest malformed");
  let encoded;
  try {
    encoded = JSON.stringify(manifest);
  } catch {
    throw new Error("manifest is not JSON-serializable");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("manifest exceeds the wire ceiling");
  }
  const chunks = manifest?.chunks;
  if (!Array.isArray(chunks)) throw new Error("manifest has no chunk list");
  if (chunks.length > MAX_BUNDLE_CHUNKS) {
    throw new Error(`bundle has too many chunks: ${chunks.length} > ${MAX_BUNDLE_CHUNKS}`);
  }
  const stringFields = [["type", 32], ["mime", 128], ["entry", 512], ["publisher", 256], ["sig", 512]];
  for (const [field, cap] of stringFields) {
    const value = manifest[field];
    if (value != null && (typeof value !== "string" || value.length > cap)) {
      throw new Error(`manifest ${field} invalid`);
    }
  }
  let declared = 0;
  const sizesByHash = /* @__PURE__ */ new Map();
  for (const c of chunks) {
    if (!c || typeof c !== "object" || !SHA256_HEX2.test(c.hash)) throw new Error("manifest chunk hash invalid");
    const size = c?.size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > CHUNK_SIZE) {
      throw new Error("manifest chunk size invalid");
    }
    const hash = c?.hash;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("manifest chunk hash invalid");
    }
    const priorSize = sizesByHash.get(hash);
    if (priorSize !== void 0 && priorSize !== size) {
      throw new Error("duplicate manifest chunk has inconsistent sizes");
    }
    sizesByHash.set(hash, size);
    declared += size;
    if (declared > MAX_BUNDLE_BYTES) {
      throw new Error(`bundle too large: chunks declare more than ${MAX_BUNDLE_BYTES} bytes`);
    }
  }
  if (typeof manifest.size !== "number" || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size !== declared) {
    throw new Error(`manifest size ${manifest?.size} does not match its chunk list (${declared})`);
  }
  if (manifest.v === 2) {
    assertBundleTransportDescriptor(manifest.bundle, {
      compressedSize: manifest.size,
      maxCompressedBytes: MAX_BUNDLE_BYTES
    });
  } else if (manifest.v !== void 0 && manifest.v !== 1 || manifest.bundle !== void 0) {
    throw new Error("manifest bundle transport version invalid");
  }
};
var decodeCommittedChunk = (encoded, expectedSize) => {
  if (!Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > CHUNK_SIZE) {
    throw new Error("committed chunk size invalid");
  }
  if (typeof encoded !== "string") throw new Error("chunk bytes must be base64");
  const expectedCharacters = 4 * Math.ceil(expectedSize / 3);
  if (encoded.length !== expectedCharacters) throw new Error("chunk encoded length mismatch");
  if (base64ByteLength(encoded) !== expectedSize) throw new Error("chunk decoded length mismatch");
  const bytes = fromBase64(encoded);
  if (bytes.byteLength !== expectedSize) throw new Error("chunk decoded length mismatch");
  return bytes;
};
var verifyManifest = async (manifest) => {
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, reason: "malformed" };
  }
  if (!manifest.publisher) return { ok: true, publisher: null };
  if (!manifest.sig) return { ok: false, reason: "missing_sig" };
  let ok = false;
  const publisher = (
    /** @type {string} */
    manifest.publisher
  );
  try {
    ok = await verifySignature(
      publisher,
      fromBase64(
        /** @type {string} */
        manifest.sig
      ),
      signingBytes2(manifest)
    );
  } catch {
    return { ok: false, reason: "verify_threw" };
  }
  return ok ? { ok: true, publisher } : { ok: false, reason: "bad_sig" };
};

// peerd/extension/peerd-distributed/content/uri.js
var SCHEME = "peerd://";
var HASH_RE = /^[0-9a-f]{64}$/;
var parsePeerdUri = (s) => {
  if (typeof s !== "string" || !s.startsWith(SCHEME)) {
    throw new Error("parsePeerdUri: not a peerd:// URI");
  }
  let rest = s.slice(SCHEME.length);
  let did;
  if (rest.startsWith("did:")) {
    const slash = rest.indexOf("/");
    if (slash < 0) throw new Error("parsePeerdUri: did present but no content hash");
    did = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  const parts = rest.split("/");
  const hash = (
    /** @type {string} */
    parts.shift()
  );
  if (!HASH_RE.test(hash)) {
    throw new Error("parsePeerdUri: invalid content hash");
  }
  const path = parts.length ? parts.join("/") : void 0;
  return { did, hash, path };
};

// peerd/extension/peerd-distributed/content/transfer.js
var ALPHA = 3;
var createContentResponder = ({ store }) => (msg, send) => {
  switch (msg && msg.t) {
    case "MANIFEST_REQ": {
      const manifest = store.getManifest(msg.hash);
      send(manifest ? { t: "MANIFEST", hash: msg.hash, manifest } : { t: "NOMANIFEST", hash: msg.hash });
      return;
    }
    case "CHUNK_REQ": {
      const bytes = store.getChunk(msg.hash);
      send(bytes ? { t: "CHUNK", hash: msg.hash, bytes: toBase64(bytes) } : { t: "NOCHUNK", hash: msg.hash });
      return;
    }
    default:
      return;
  }
};
var fetchBundle = async ({ uri, channel, onProgress, timeoutMs = 15e3 } = (
  /** @type {{ uri: string, channel: { send: (msg: any) => void, setHandler: (h: ((msg: ContentMsg) => void) | null) => void } }} */
  {}
)) => {
  const { hash } = parsePeerdUri(uri);
  const pending = /* @__PURE__ */ new Map();
  channel.setHandler((msg) => {
    if (!msg || typeof msg.t !== "string") return;
    const key = `${msg.t}:${msg.hash}`;
    const resolve = pending.get(key);
    if (resolve) {
      pending.delete(key);
      resolve(msg);
    }
  });
  const request = (reqType, respTypes, h) => new Promise((resolve, reject) => {
    const settle = (msg) => {
      clearTimeout(timer);
      for (const rt of respTypes) pending.delete(`${rt}:${h}`);
      resolve(msg);
    };
    for (const rt of respTypes) pending.set(`${rt}:${h}`, settle);
    const timer = setTimeout(() => {
      for (const rt of respTypes) pending.delete(`${rt}:${h}`);
      reject(new Error(`transfer timeout waiting for ${respTypes.join("/")} of ${h}`));
    }, timeoutMs);
    channel.send({ t: reqType, hash: h });
  });
  const manResp = await request("MANIFEST_REQ", ["MANIFEST", "NOMANIFEST"], hash);
  if (manResp.t === "NOMANIFEST") throw new Error(`peer does not hold ${hash}`);
  const manifest = manResp.manifest;
  assertBundleWithinLimits(manifest);
  const computed = await manifestHash(manifest);
  if (computed !== hash) throw new Error("manifest hash mismatch — content address does not match payload");
  const v = await verifyManifest(manifest);
  if (!v.ok) throw new Error(`manifest signature invalid: ${v.reason}`);
  onProgress?.({ phase: "manifest", publisher: v.publisher, total: manifest.chunks.length });
  const uniqueHashes = [...new Set(manifest.chunks.map((c) => c.hash))];
  const expectedSizes = new Map(manifest.chunks.map((c) => [c.hash, c.size]));
  const byHash = /* @__PURE__ */ new Map();
  let idx = 0;
  let done = 0;
  const worker = async () => {
    while (idx < uniqueHashes.length) {
      const h = uniqueHashes[idx++];
      const resp = await request("CHUNK_REQ", ["CHUNK", "NOCHUNK"], h);
      if (resp.t === "NOCHUNK") throw new Error(`chunk unavailable: ${h}`);
      const bytes = decodeCommittedChunk(
        resp.bytes,
        /** @type {number} */
        expectedSizes.get(h)
      );
      const got = await sha256hex(bytes);
      if (got !== h) throw new Error(`chunk hash mismatch (tamper?): ${h}`);
      byHash.set(h, bytes);
      done++;
      onProgress?.({ phase: "chunk", done, total: uniqueHashes.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALPHA, uniqueHashes.length || 1) }, worker));
  const payload = concat(...manifest.chunks.map((c) => (
    /** @type {Uint8Array} */
    byHash.get(c.hash)
  )));
  if (payload.length !== manifest.size) throw new Error("reassembled size mismatch");
  if (manifest.v === 2 && await sha256hex(payload) !== manifest.bundle.compressedHash) {
    throw new Error("compressed bundle hash mismatch");
  }
  channel.setHandler(null);
  return { manifest, payload };
};

// peerd/extension/peerd-distributed/transport/mesh.js
var CTRL = Object.freeze({
  PING: 2,
  PONG: 3,
  ROSTER_REQ: 5,
  ROSTER: 6,
  RELAY: 7
});
var CONTENT_REQ = /* @__PURE__ */ new Set(["MANIFEST_REQ", "CHUNK_REQ"]);
var CONTENT_RESP = /* @__PURE__ */ new Set(["MANIFEST", "NOMANIFEST", "CHUNK", "NOCHUNK"]);
var newId = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
var DEFAULT_BUDGET = 16;
var createRoomMesh = ({
  roomId,
  identity,
  now = Date.now,
  budget = DEFAULT_BUDGET,
  // "Are you still there?" cadence — the BACKSTOP for total silence (when neither
  // a clean data-channel close nor ICE 'disconnected' fired, which is rare). PING
  // is cheap (one signed control frame): ping at 8s, drop after 18s (~2 missed
  // pings). The fast paths win in practice: dc.onclose (graceful close, ~secs) and
  // peer.js's ICE-disconnect grace (hard kill, ~5-10s) → onPeerGone → presence
  // forgets the peer at once, so the view drops it without waiting on this.
  pingIntervalMs = 8e3,
  idleTimeoutMs = 18e3,
  // control frames allowed per link per 10s window — generous for honest
  // peers (a ping every 10s), tight for floods.
  ctrlRateLimit = 60,
  audit = null
  // optional (type, detail) => void
} = (
  /** @type {{ roomId: string, identity: Identity }} */
  {}
)) => {
  const links = /* @__PURE__ */ new Map();
  const peerCbs = /* @__PURE__ */ new Set();
  const goneCbs = /* @__PURE__ */ new Set();
  const envelopeCbs = /* @__PURE__ */ new Set();
  const relayCbs = /* @__PURE__ */ new Set();
  const rosterWaiters = /* @__PURE__ */ new Map();
  const contentClients = /* @__PURE__ */ new Map();
  let respondContent = null;
  let pingTimer = null;
  let closed = false;
  const emit = (set, arg) => {
    for (const cb of [...set]) cb(arg);
  };
  const sign = (ch, typ, body) => signEnvelope(buildEnvelope({ ch, typ, from: identity.did, body, id: newId(), ts: now() }), identity);
  const sendTo = (did, env) => {
    const link = links.get(did);
    if (!link) return false;
    link.channel.send(env);
    return true;
  };
  const contentChannelFor = (did) => {
    const link = links.get(did);
    if (!link) return null;
    return {
      /** @param {any} m */
      send: (m) => link.channel.send(m),
      /** @param {((msg: any) => void) | null} h */
      setHandler: (h) => {
        if (h) contentClients.set(did, h);
        else contentClients.delete(did);
      }
    };
  };
  const removeLink = (did, why) => {
    const link = links.get(did);
    if (!link) return;
    links.delete(did);
    link.offClose?.();
    try {
      link.channel.close();
    } catch {
    }
    dlog("mesh", `🔌 peer ${(did || "").slice(-8)} link dropped (${why}) — ${links.size} link(s) left`);
    audit?.("peer_link_closed", { did, why });
    emit(goneCbs, { did, why });
  };
  const ctrlAllowed = (link) => {
    const t = now();
    if (t - link.ctrl.windowStart > 1e4) {
      link.ctrl.windowStart = t;
      link.ctrl.count = 0;
    }
    return ++link.ctrl.count <= ctrlRateLimit;
  };
  const handleControl = async (link, env) => {
    if (!ctrlAllowed(link)) {
      audit?.("peer_ctrl_rate_limited", { did: link.did });
      return;
    }
    const linkLocal = env.from === link.did;
    switch (env.typ) {
      case CTRL.PING:
        if (linkLocal) link.channel.send(await sign(0, CTRL.PONG, { nonce: env.body?.nonce }));
        return;
      case CTRL.PONG:
        return;
      // lastSeen already updated on receipt
      case CTRL.ROSTER_REQ: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const members = [identity.did, ...links.keys()].filter((d) => d !== link.did);
        link.channel.send(await sign(0, CTRL.ROSTER, { room: roomId, members }));
        return;
      }
      case CTRL.ROSTER: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const waiters = rosterWaiters.get(link.did);
        if (waiters) {
          rosterWaiters.delete(link.did);
          for (const res of waiters) res(env.body.members ?? []);
        }
        return;
      }
      case CTRL.RELAY: {
        const b = env.body;
        if (!b || b.room !== roomId || typeof b.to !== "string") return;
        if (b.to === identity.did) {
          emit(relayCbs, { env, via: link.did });
          return;
        }
        if (env.from !== link.did) return;
        if (!sendTo(b.to, env)) audit?.("relay_target_unreachable", { to: b.to, via: link.did });
        return;
      }
      default:
        return;
    }
  };
  const handle = async (link, msg) => {
    if (closed || !msg) return;
    if (typeof msg.t === "string" && CONTENT_REQ.has(msg.t)) {
      respondContent?.(msg, (out) => link.channel.send(out));
      return;
    }
    if (typeof msg.t === "string" && CONTENT_RESP.has(msg.t)) {
      contentClients.get(link.did)?.(msg);
      return;
    }
    if (msg.__t === "HELLO") return;
    if (msg.v !== 1 || !msg.sig) return;
    if (!await verifyEnvelope(msg)) {
      audit?.("peer_envelope_invalid", { via: link.did });
      return;
    }
    link.lastSeen = now();
    if (msg.ch === 0) return handleControl(link, msg);
    if (msg.ch !== 4 && msg.from !== link.did) {
      audit?.("peer_envelope_misattributed", { via: link.did, claimed: msg.from });
      return;
    }
    emit(envelopeCbs, { env: msg, via: link.did });
  };
  const sweep = async () => {
    const t = now();
    for (const [did, link] of [...links]) {
      if (t - link.lastSeen > idleTimeoutMs) {
        removeLink(did, "idle-timeout");
      } else if (t - link.lastSeen > pingIntervalMs) {
        link.channel.send(await sign(0, CTRL.PING, { nonce: newId().slice(0, 8) }));
      }
    }
  };
  const stopTimers = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };
  return Object.freeze({
    roomId,
    selfDid: identity.did,
    // Admit an AUTHENTICATED link (HELLO already done — did is proven).
    /** @param {Channel} channel @param {string} did @param {any} [info] */
    addLink(channel, did, info = {}) {
      if (closed) return false;
      if (did === identity.did) {
        channel.close();
        return false;
      }
      if (links.size >= budget && !links.has(did)) {
        audit?.("peer_budget_refused", { did });
        channel.close();
        return false;
      }
      if (links.has(did)) removeLink(did, "replaced");
      const link = { did, channel, lastSeen: now(), ctrl: { windowStart: now(), count: 0 }, info };
      link.offClose = channel.onClose(() => {
        if (links.get(did) === link) {
          links.delete(did);
          audit?.("peer_link_closed", { did, why: "channel-closed" });
          emit(goneCbs, { did, why: "channel-closed" });
        }
      });
      links.set(did, link);
      channel.setHandler((msg) => {
        handle(link, msg);
      });
      audit?.("peer_connected", { did, room: roomId });
      emit(peerCbs, { did, info });
      return true;
    },
    /** @param {string} did */
    removeLink: (did) => removeLink(did, "removed"),
    /** @param {string} did */
    hasLink: (did) => links.has(did),
    // Merge telemetry onto a link (e.g. the ICE path once stats settle).
    /** @param {string} did @param {any} patch */
    tagLink(did, patch) {
      const link = links.get(did);
      if (link) link.info = { ...link.info, ...patch };
    },
    peers: () => [...links.values()].map((l) => ({ did: l.did, lastSeen: l.lastSeen, info: l.info, channel: l.channel })),
    /** @param {(arg: any) => void} cb */
    onPeer: (cb) => {
      peerCbs.add(cb);
      return () => peerCbs.delete(cb);
    },
    /** @param {(arg: any) => void} cb */
    onPeerGone: (cb) => {
      goneCbs.add(cb);
      return () => goneCbs.delete(cb);
    },
    /** @param {(arg: any) => void} cb */
    onEnvelope: (cb) => {
      envelopeCbs.add(cb);
      return () => envelopeCbs.delete(cb);
    },
    /** @param {(arg: any) => void} cb */
    onRelay: (cb) => {
      relayCbs.add(cb);
      return () => relayCbs.delete(cb);
    },
    // Build-and-sign for upper layers (gossip), so the envelope shape and
    // signing stay in one place.
    sign,
    send: sendTo,
    /** @param {any} env @param {string | null} [exceptDid] */
    broadcast(env, exceptDid = null) {
      for (const [did, link] of links) {
        if (did !== exceptDid) link.channel.send(env);
      }
    },
    // "Who do you see in this room?" — the server-optional roster.
    /** @param {string} did @param {{ timeoutMs?: number }} [opts] */
    requestRoster(did, { timeoutMs = 1e4 } = {}) {
      return new Promise((resolve, reject) => {
        const link = links.get(did);
        if (!link) return reject(new Error(`requestRoster: no link to ${did}`));
        const timer = setTimeout(() => {
          rosterWaiters.get(did)?.delete(settle);
          reject(new Error("roster request timed out"));
        }, timeoutMs);
        const settle = (members) => {
          clearTimeout(timer);
          resolve(members);
        };
        let waiters = rosterWaiters.get(did);
        if (!waiters) {
          waiters = /* @__PURE__ */ new Set();
          rosterWaiters.set(did, waiters);
        }
        waiters.add(settle);
        sign(0, CTRL.ROSTER_REQ, { room: roomId }).then((env) => link.channel.send(env));
      });
    },
    // Send a RELAY frame to `to` THROUGH `via` (a direct link). The body's
    // payload is opaque (SDP); sid correlates offer/answer.
    /**
     * @param {string} via @param {string} to @param {string} kind
     * @param {string} sid @param {any} payload
     */
    async relay(via, to, kind, sid, payload) {
      const env = await sign(0, CTRL.RELAY, { room: roomId, to, kind, sid, payload });
      if (!sendTo(via, env)) throw new Error(`relay: no link to via-peer ${via}`);
    },
    // Content multiplexing on mesh links (announce-set rules unchanged —
    // createContentResponder consults the store).
    /** @param {any} store */
    serveContent(store) {
      respondContent = store ? createContentResponder({ store }) : null;
    },
    // The swarm fetcher reads null as "unreachable" and skips the provider; the
    // per-hop dialer is what later turns a null into a channel for an unlinked
    // provider (it dials first, then this returns a live channel).
    contentChannel: contentChannelFor,
    /** @param {string} did @param {string} uri @param {any} [opts] */
    fetchFrom(did, uri, opts = {}) {
      const channel = contentChannelFor(did);
      if (!channel) return Promise.reject(new Error(`fetchFrom: no link to ${did}`));
      return fetchBundle({ uri, channel, ...opts }).finally(() => contentClients.delete(did));
    },
    // Liveness. start() is explicit so tests (and short-lived dances) can
    // run without timers.
    start: () => {
      if (!pingTimer) pingTimer = setInterval(sweep, Math.min(pingIntervalMs, idleTimeoutMs) / 3);
    },
    stop: stopTimers,
    close: () => {
      if (closed) return;
      closed = true;
      stopTimers();
      for (const did of [...links.keys()]) removeLink(did, "mesh-closed");
    }
  });
};

// peerd/extension/peerd-distributed/transport/session.js
var newId2 = () => crypto.randomUUID();
var createSession = async ({ channel, identity, caps = ["content"], now = Date.now }) => {
  let resolveHello;
  let rejectHello;
  const helloReceived = new Promise((res, rej) => {
    resolveHello = res;
    rejectHello = rej;
  });
  const stashed = [];
  channel.setHandler(async (msg) => {
    if (msg && msg.__t === "HELLO") {
      const ok = await verifyEnvelope(msg.env);
      if (!ok) return rejectHello(new Error("peer HELLO signature invalid"));
      if (msg.env.body?.proto !== 1) {
        return rejectHello(new Error(`unsupported protocol version: ${msg.env.body?.proto}`));
      }
      return resolveHello(msg.env.from);
    }
    stashed.push(msg);
  });
  const hello = await signEnvelope(
    buildEnvelope({ ch: 0, typ: 0, from: identity.did, body: { proto: 1, caps }, id: newId2(), ts: now() }),
    identity
  );
  channel.send({ __t: "HELLO", env: hello });
  const remoteDid = await helloReceived;
  channel.setHandler(null);
  for (const m of stashed) channel.deliver(m);
  return { remoteDid };
};

// peerd/extension/peerd-distributed/transport/rooms.js
var short = (did) => (did || "").slice(-8);
var newId3 = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
var ANSWER_TIMEOUT_MS = 15e3;
var joinRoom = async ({
  roomId,
  identity,
  url = DEFAULT_SIGNALING[0],
  iceServers,
  transport,
  WebSocket: WS = globalThis.WebSocket,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  now = Date.now,
  audit = null,
  budget,
  caps = ["content", "pubsub"],
  kind: peerKind,
  // 'website' = observe-only visitor (own rendezvous cap pool); omitted/default = extension
  awaitInitialRendezvous = true
} = (
  /** @type {{ roomId: string, identity: import('./mesh.js').Identity }} */
  {}
)) => {
  const t = transport ?? createWebrtcTransport({ iceServers });
  const mesh = createRoomMesh({ roomId, identity, now, budget, audit });
  const statusCbs = /* @__PURE__ */ new Set();
  let rendezvousState = url ? "connecting" : "none";
  let session = null;
  let left = false;
  const setStatus = (s) => {
    rendezvousState = s;
    for (const cb of [...statusCbs]) cb({ rendezvous: s });
  };
  const admit = async (channel, expectedDid = null, via = null) => {
    const { remoteDid } = await createSession({ channel, identity, caps, now });
    if (expectedDid && remoteDid !== expectedDid) {
      channel.close();
      audit?.("peer_did_mismatch", { expected: expectedDid, got: remoteDid });
      throw new Error("peer authenticated as a different did than expected");
    }
    if (mesh.hasLink(remoteDid)) {
      dlog("room", `already linked to ${short(remoteDid)} — dropping duplicate channel`);
      channel.close();
      return remoteDid;
    }
    mesh.addLink(channel, remoteDid);
    if (via) mesh.tagLink(remoteDid, { via });
    dlog("room", `✅ CONNECTED to peer ${short(remoteDid)} — data channel open, in the mesh`);
    if (channel.pc) {
      connectionPath(channel.pc).then((p) => {
        mesh.tagLink(remoteDid, { path: p.path });
        dlog("room", `peer ${short(remoteDid)} connectivity: ${p.path}`);
        audit?.("peer_path", { did: remoteDid, path: p.path });
      });
    }
    return remoteDid;
  };
  const makeSignaling = (send) => {
    let handler = null;
    const buffer = [];
    return {
      /** @param {any} payload */
      route: (payload) => {
        if (handler) handler(payload);
        else buffer.push(payload);
      },
      signaling: {
        send,
        /** @param {(payload: any) => void} h */
        onRemote: (h) => {
          handler = h;
          while (buffer.length) h(buffer.shift());
          return () => {
            handler = null;
          };
        }
      }
    };
  };
  const withConnectTimeout = (promise, label) => Promise.race([
    promise,
    /** @type {Promise<T>} */
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ANSWER_TIMEOUT_MS))
  ]);
  const logConnectFail = (what, who, e) => {
    const msg = (
      /** @type {{ message?: string }} */
      e?.message ?? String(e)
    );
    if (msg.includes("timed out")) dlog("room", `${what} ${short(who)} timed out — likely a stale roster member, skipping`);
    else dwarn("room", `${what} ${short(who)} failed: ${msg}`);
  };
  const attachSession = (s) => {
    const routers = /* @__PURE__ */ new Map();
    s.on("signal", async ({ from, payload }) => {
      const route = routers.get(from);
      if (route) {
        route(payload);
        return;
      }
      if (payload?.type !== "offer") return;
      dlog("room", `📥 offer from ${from} — answering (trickle)`);
      const { route: r, signaling } = makeSignaling((p) => s.sendSignal(from, p));
      routers.set(from, r);
      const ac = new AbortController();
      try {
        const { channel } = await t.accept({ offer: payload, iceServers, signaling, signal: ac.signal });
        await admit(await withConnectTimeout(channel, `accept ${from}`), null, "rendezvous");
      } catch (e) {
        logConnectFail("accept from", from, e);
        audit?.("room_accept_failed", { member: from, error: (
          /** @type {{ message?: string }} */
          e?.message
        ) });
      } finally {
        ac.abort();
        routers.delete(from);
      }
    });
    s.on("closed", () => {
      if (s !== session) return;
      audit?.("rendezvous_lost", { roomId });
      scheduleReconnect();
    });
    const dial = async (member) => {
      dlog("room", `📞 dialing ${member} (trickle: offer now, candidates streaming)…`);
      const { route, signaling } = makeSignaling((p) => s.sendSignal(member, p));
      routers.set(member, route);
      const ac = new AbortController();
      try {
        const channel = await withConnectTimeout(
          t.connect({ did: `${roomId}/${member}` }, { iceServers, signaling, signal: ac.signal }),
          `dial ${member}`
        );
        await admit(channel, null, "rendezvous");
      } catch (e) {
        logConnectFail("dial to", member, e);
        audit?.("room_dial_failed", { member, error: (
          /** @type {{ message?: string }} */
          e?.message
        ) });
      } finally {
        ac.abort();
        routers.delete(member);
      }
    };
    return { dial };
  };
  const relayRouters = /* @__PURE__ */ new Map();
  mesh.onRelay(async ({ env, via }) => {
    const { kind, sid, payload } = env.body;
    if (kind === "offer") {
      dlog("room", `📥 relayed offer via ${short(via)} — answering`);
      const { route, signaling } = makeSignaling((p) => mesh.relay(via, env.from, p.type === "answer" ? "answer" : "ice", sid, p));
      relayRouters.set(sid, route);
      const ac = new AbortController();
      try {
        const { channel } = await t.accept({ offer: payload, iceServers, signaling, signal: ac.signal });
        await admit(await withConnectTimeout(channel, `relay accept ${short(env.from)}`), env.from, via);
        audit?.("relay_join_accepted", { did: env.from, via });
      } catch (e) {
        logConnectFail("relay accept", env.from, e);
        audit?.("relay_accept_failed", { from: env.from, error: (
          /** @type {{ message?: string }} */
          e?.message
        ) });
      } finally {
        ac.abort();
        relayRouters.delete(sid);
      }
      return;
    }
    relayRouters.get(sid)?.(payload);
  });
  const dialViaRelay = async (via, targetDid) => {
    const sid = newId3();
    dlog("room", `📞 relay-dialing ${short(targetDid)} via ${short(via)}…`);
    const { route, signaling } = makeSignaling((p) => mesh.relay(via, targetDid, p.type === "offer" ? "offer" : "ice", sid, p));
    relayRouters.set(sid, route);
    const ac = new AbortController();
    try {
      const channel = await withConnectTimeout(
        t.connect({ did: targetDid }, { iceServers, signaling, signal: ac.signal }),
        `relay dial ${short(targetDid)}`
      );
      await admit(channel, targetDid, via);
    } finally {
      ac.abort();
      relayRouters.delete(sid);
    }
  };
  const expandViaPeer = async (viaDid) => {
    const members = (
      /** @type {string[]} */
      await mesh.requestRoster(viaDid)
    );
    const results = await Promise.allSettled(
      members.filter((d) => d !== identity.did && !mesh.hasLink(d)).map((d) => dialViaRelay(viaDid, d))
    );
    for (const r of results) {
      if (r.status === "rejected") audit?.("relay_dial_failed", { error: r.reason?.message });
    }
  };
  let reconnectTimer = null;
  let backoffMs = 2e3;
  const RECONNECT_MAX_MS = 3e4;
  const OUTAGE_WARN_MS = 6e4;
  let reconnectFailures = 0;
  let outageSince = 0;
  let outageWarned = false;
  const connectRendezvous = async () => {
    if (left) return;
    const s = await openRendezvous({ url: (
      /** @type {string} */
      url
    ), room: roomId, WebSocket: WS, kind: peerKind });
    if (left) {
      s.close();
      return;
    }
    session = s;
    setStatus("up");
    backoffMs = 2e3;
    if (outageWarned) dlog("room", `rendezvous recovered after ${Math.round((Date.now() - outageSince) / 1e3)}s`);
    reconnectFailures = 0;
    outageSince = 0;
    outageWarned = false;
    const { dial } = attachSession(session);
    if (session.members.length === 0) dlog("room", "first one here — waiting for others to join and offer");
    else dlog("room", `${session.members.length} member(s) here — dialing each:`, session.members);
    await Promise.allSettled(session.members.map(dial));
  };
  const noteConnectFailure = (e) => {
    if (left) return;
    reconnectFailures += 1;
    if (!outageSince) outageSince = Date.now();
    const downMs = Date.now() - outageSince;
    if (!outageWarned && downMs >= OUTAGE_WARN_MS) {
      outageWarned = true;
      dwarn("room", `rendezvous unreachable for ${Math.round(downMs / 1e3)}s (${reconnectFailures} attempts): ${e?.message ?? e}; still retrying`);
    } else {
      dlog("room", `rendezvous reconnect failed (attempt ${reconnectFailures}): ${e?.message ?? e}; retrying`);
    }
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    scheduleReconnect();
  };
  const scheduleReconnect = () => {
    if (left || reconnectTimer) return;
    setStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRendezvous().catch(noteConnectFailure);
    }, backoffMs);
  };
  dlog("room", `joining room "${roomId}" as ${short(identity.did)} via ${url}`);
  if (url) {
    const initialConnect = connectRendezvous();
    if (awaitInitialRendezvous) await initialConnect;
    else void initialConnect.catch(noteConnectFailure);
  }
  mesh.start();
  dlog("room", `room "${roomId}" assembled — ${mesh.peers().length} live peer link(s)`);
  return Object.freeze({
    roomId,
    did: identity.did,
    mesh,
    peers: mesh.peers,
    onPeer: mesh.onPeer,
    onPeerGone: mesh.onPeerGone,
    onEnvelope: mesh.onEnvelope,
    /** @param {(arg: { rendezvous: string }) => void} cb */
    onStatus: (cb) => {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    rendezvous: () => rendezvousState,
    expandViaPeer,
    // Targeted relay-dial: reach `targetDid` through a peer we already link
    // (`brokerDid` forwards the signaling). The DHT dialer uses this to connect
    // to a lookup contact it doesn't link yet. Resolves once linked, throws on
    // timeout. One hop only — `brokerDid` must be directly linked.
    /** @param {string} brokerDid @param {string} targetDid */
    dialVia: (brokerDid, targetDid) => dialViaRelay(brokerDid, targetDid),
    leave() {
      if (left) return;
      left = true;
      clearTimeout(reconnectTimer ?? void 0);
      try {
        session?.close();
      } catch {
      }
      mesh.close();
    }
  });
};

// peerd/extension/peerd-distributed/gossip/topic.js
var PUB = 0;
var MAX_GOSSIP_ENVELOPE_BYTES = 32 * 1024;
var createGossip = ({
  mesh,
  now = Date.now,
  seenCap = 4096,
  // ~20 msgs/s sustained per sender, bursts to 40 — generous for a doc's
  // CRDT updates + cursors, tight enough that one peer can't bury a room.
  ratePerSec = 20,
  rateBurst = 40,
  maxEnvelopeBytes = MAX_GOSSIP_ENVELOPE_BYTES,
  audit = null
} = (
  /** @type {{ mesh: any }} */
  {}
)) => {
  const subs = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const buckets = /* @__PURE__ */ new Map();
  const muted = /* @__PURE__ */ new Set();
  const taps = /* @__PURE__ */ new Set();
  const markSeen = (sig) => {
    seen.add(sig);
    if (seen.size > seenCap) {
      const first = (
        /** @type {string} */
        seen.values().next().value
      );
      seen.delete(first);
    }
  };
  const allow = (did) => {
    const t = now();
    let b = buckets.get(did);
    if (!b) {
      b = { tokens: rateBurst, last: t };
      buckets.set(did, b);
    }
    b.tokens = Math.min(rateBurst, b.tokens + (t - b.last) / 1e3 * ratePerSec);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const oversized = (env, topic) => {
    if (envelopeBytes(env) <= maxEnvelopeBytes) return false;
    audit?.("gossip_envelope_oversized", { did: env.from, topic, cap: maxEnvelopeBytes });
    return true;
  };
  const deliver = (env, via) => {
    const { topic, data } = env.body;
    const msg = { from: env.from, data, ts: env.ts, id: env.id, env, via };
    for (const cb of [...subs.get(topic) ?? []]) cb(msg);
    for (const cb of [...taps]) cb(msg, topic);
  };
  const offEnvelope = mesh.onEnvelope(({ env, via }) => {
    if (env.ch !== 4 || env.typ !== PUB) return;
    if (!env.body || typeof env.body.topic !== "string") return;
    if (seen.has(env.sig)) return;
    markSeen(env.sig);
    if (muted.has(env.from)) return;
    if (!allow(env.from)) {
      audit?.("gossip_rate_limited", { did: env.from, topic: env.body.topic });
      return;
    }
    if (oversized(env, env.body.topic)) return;
    deliver(env, via);
    mesh.broadcast(env, via);
  });
  return Object.freeze({
    /**
     * @param {string} topic
     * @param {any} data
     */
    async publish(topic, data) {
      const env = await mesh.sign(4, PUB, { topic, data });
      markSeen(env.sig);
      mesh.broadcast(env);
      return env;
    },
    /**
     * @param {string} topic
     * @param {(msg: GossipMsg) => void} cb
     */
    subscribe(topic, cb) {
      let set = subs.get(topic);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        subs.set(topic, set);
      }
      set.add(cb);
      return () => subs.get(topic)?.delete(cb);
    },
    // The sync layer's firehose: every delivered publish, any topic.
    /** @param {(msg: GossipMsg, topic: string) => void} cb */
    tap(cb) {
      taps.add(cb);
      return () => taps.delete(cb);
    },
    // Re-deliver an envelope that arrived OUTSIDE the live flood (backfill
    // sync). Never re-broadcast — backfill is point-to-point (gossip/sync.js).
    //
    // why deliver even when already `seen`: on the SHARED base mesh a peer
    // flood-relays every room's messages, including rooms it hasn't joined — so
    // a topic's frame is often marked seen (for loop-prevention) while no local
    // subscriber existed to receive it. Backfill is exactly how a now-subscribed
    // topic recovers those, so a seen frame must still DELIVER here; it just
    // won't re-mark or re-flood. (A live-delivered retained frame is already in
    // the store, so the have-list keeps it from being re-served — no double
    // delivery in practice; apps id-dedup regardless.) Returns whether the frame
    // was newly seen, so sync.js stores fresh-vs-backfilled correctly.
    /**
     * @param {any} env
     * @param {any} [via]
     */
    ingest(env, via = null) {
      if (env.ch !== 4 || env.typ !== PUB) return false;
      if (!env.body || typeof env.body.topic !== "string") return false;
      if (muted.has(env.from)) return false;
      if (oversized(env, env.body.topic)) return false;
      const fresh = !seen.has(env.sig);
      if (fresh) markSeen(env.sig);
      deliver(env, via);
      return fresh;
    },
    /** @param {string} sig */
    hasSeen: (sig) => seen.has(sig),
    /** @param {string} did */
    mute(did) {
      muted.add(did);
      audit?.("gossip_muted", { did });
    },
    /** @param {string} did */
    unmute(did) {
      muted.delete(did);
    },
    /** @param {string} did */
    isMuted: (did) => muted.has(did),
    close() {
      offEnvelope();
      subs.clear();
      taps.clear();
    }
  });
};

// peerd/extension/peerd-distributed/gossip/sync.js
var SYNC = Object.freeze({ REQ: 2, RESP: 3 });
var MAX_HAVES = 512;
var MAX_RESP = 256;
var createMemoryTopicStore = () => {
  const topics = /* @__PURE__ */ new Map();
  const bucket = (t) => {
    let m = topics.get(t);
    if (!m) {
      m = /* @__PURE__ */ new Map();
      topics.set(t, m);
    }
    return m;
  };
  return {
    /** @param {string} topic @param {any} env */
    put: (topic, env) => {
      bucket(topic).set(env.sig, env);
    },
    /** @param {string} topic @param {string} sig */
    has: (topic, sig) => bucket(topic).has(sig),
    /** @param {string} topic */
    ids: (topic) => [...bucket(topic).keys()],
    /** @param {string} topic */
    list: (topic) => [...bucket(topic).values()]
  };
};
var createTopicSync = ({
  mesh,
  gossip,
  store,
  maxEnvelopeBytes = MAX_GOSSIP_ENVELOPE_BYTES,
  audit = null
} = (
  /** @type {{ mesh: any, gossip: any, store: any }} */
  {}
)) => {
  const retained = /* @__PURE__ */ new Set();
  const admissible = (topic, env) => {
    const bytes = envelopeBytes(env);
    if (bytes <= maxEnvelopeBytes) return true;
    audit?.("sync_env_oversized", { topic, bytes, cap: maxEnvelopeBytes });
    return false;
  };
  const keep = (topic, env) => {
    if (retained.has(topic) && admissible(topic, env)) store.put(topic, env);
  };
  const offTap = gossip.tap((msg, topic) => keep(topic, msg.env));
  const requestFrom = async (did, topic) => {
    const haves = store.ids(topic);
    if (haves.length > MAX_HAVES) audit?.("sync_haves_overflow", { topic, count: haves.length });
    const env = await mesh.sign(4, SYNC.REQ, { topic, haves: haves.slice(-MAX_HAVES) });
    mesh.send(did, env);
  };
  const offEnvelope = mesh.onEnvelope(async ({ env, via }) => {
    if (env.ch !== 4) return;
    if (env.from !== via) return;
    if (env.typ === SYNC.REQ) {
      const { topic, haves } = env.body ?? {};
      if (typeof topic !== "string" || !retained.has(topic)) return;
      const known = new Set(Array.isArray(haves) ? haves : []);
      const missing = store.list(topic).filter((e) => !known.has(e.sig));
      if (missing.length > MAX_RESP) audit?.("sync_resp_overflow", { topic, count: missing.length });
      const resp = await mesh.sign(4, SYNC.RESP, { topic, envs: missing.slice(0, MAX_RESP) });
      mesh.send(via, resp);
      return;
    }
    if (env.typ === SYNC.RESP) {
      const { topic, envs } = env.body ?? {};
      if (typeof topic !== "string" || !retained.has(topic) || !Array.isArray(envs)) return;
      for (const inner of envs) {
        if (!admissible(topic, inner)) continue;
        if (!await verifyEnvelope(inner)) {
          audit?.("sync_env_invalid", { topic, via });
          continue;
        }
        if (gossip.ingest(inner, via)) keep(topic, inner);
        else if (!store.has(topic, inner.sig) && !gossip.isMuted(inner.from)) store.put(topic, inner);
      }
    }
  });
  const offPeer = mesh.onPeer(({ did }) => {
    for (const topic of retained) requestFrom(did, topic);
  });
  return Object.freeze({
    // Mark a topic as retained: stored locally, served to the room, and
    // backfilled from the room. onPeer (above) covers FUTURE links, but the
    // mesh is usually already connected by the time a dwapp retains a topic
    // (the base net links on unlock, long before the app opens) — so reconcile
    // against the peers we're ALREADY linked to too, or a late joiner's history
    // stays empty. requestFrom is a cheap, idempotent have-list exchange.
    /** @param {string} topic */
    retain(topic) {
      retained.add(topic);
      for (const p of mesh.peers()) requestFrom(p.did, topic).catch(() => {
      });
    },
    // Publish-and-retain in one move (feeds want this; ephemeral topics
    // use gossip.publish directly and are never stored).
    /** @param {string} topic @param {any} data */
    async publish(topic, data) {
      const env = await gossip.publish(topic, data);
      keep(topic, env);
      return env;
    },
    /** @param {string} topic */
    history: (topic) => store.list(topic),
    requestFrom,
    close() {
      offTap();
      offEnvelope();
      offPeer();
    }
  });
};

// peerd/extension/peerd-distributed/gossip/presence.js
var PRESENCE_TOPIC = "~presence";
var FORGET_SUPPRESS_MS = 3e3;
var createPresence = ({
  gossip,
  selfDid,
  meta = () => ({}),
  // The gossip topic the beacon rides. Defaults to the lobby's '~presence';
  // a room (sub-protocol) passes a namespaced topic so its membership is
  // scoped to that room while sharing the one base mesh (base-network.js).
  topic = PRESENCE_TOPIC,
  heartbeatMs = 1e4,
  expireMs = 25e3,
  // match the mesh idle timeout — drop a gone peer from both layers together
  now = Date.now
} = (
  /** @type {{ gossip: any, selfDid: string }} */
  {}
)) => {
  const here = /* @__PURE__ */ new Map();
  const forgotten = /* @__PURE__ */ new Map();
  const joinCbs = /* @__PURE__ */ new Set();
  const leaveCbs = /* @__PURE__ */ new Set();
  let beat = null;
  let sweepTimer = null;
  const emit = (set, arg) => {
    for (const cb of [...set]) cb(arg);
  };
  const offSub = gossip.subscribe(topic, ({ from, data }) => {
    if (from === selfDid) return;
    const until = forgotten.get(from);
    if (until !== void 0) {
      if (now() < until) return;
      forgotten.delete(from);
    }
    const known = here.has(from);
    here.set(from, { lastSeen: now(), meta: data?.meta ?? {} });
    if (!known) emit(joinCbs, { did: from, meta: data?.meta ?? {} });
  });
  const sweep = () => {
    const t = now();
    for (const [did, p] of [...here]) {
      if (t - p.lastSeen > expireMs) {
        here.delete(did);
        emit(leaveCbs, { did });
      }
    }
    for (const [did, until] of [...forgotten]) if (t >= until) forgotten.delete(did);
  };
  const beacon = () => gossip.publish(topic, { meta: meta() });
  return Object.freeze({
    start() {
      if (beat) return;
      beacon();
      beat = setInterval(beacon, heartbeatMs);
      sweepTimer = setInterval(sweep, Math.max(1, Math.floor(expireMs / 3)));
    },
    stop() {
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
    announce: beacon,
    // app changed its meta (renamed) — beacon now
    // Drop a peer NOW (don't wait for the beacon to expire) — used when the mesh
    // tells us the link died, so a disconnected peer leaves the view at once.
    // Arms a short suppression window (FORGET_SUPPRESS_MS) so the peer's last
    // in-flight beacon can't immediately resurrect it as a ghost; a genuine
    // re-join keeps beaconing and is re-added once the window passes.
    /** @param {string} did */
    forget: (did) => {
      forgotten.set(did, now() + FORGET_SUPPRESS_MS);
      if (here.delete(did)) emit(leaveCbs, { did });
    },
    list: () => [...here.entries()].map(([did, p]) => ({ did, ...p })),
    /** @param {(arg: { did: string, meta?: any }) => void} cb */
    onJoin: (cb) => {
      joinCbs.add(cb);
      return () => joinCbs.delete(cb);
    },
    /** @param {(arg: { did: string }) => void} cb */
    onLeave: (cb) => {
      leaveCbs.add(cb);
      return () => leaveCbs.delete(cb);
    },
    close() {
      offSub();
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      here.clear();
      forgotten.clear();
    }
  });
};

// peerd/extension/peerd-distributed/messaging/direct.js
var MSG = 0;
var createDirect = ({ mesh }) => {
  const subs = /* @__PURE__ */ new Set();
  const off = mesh.onEnvelope(({ env }) => {
    if (env.ch !== 3 || env.typ !== MSG || !env.body) return;
    const msg = { from: env.from, data: env.body.data, ts: env.ts, id: env.id };
    for (const cb of [...subs]) cb(msg);
  });
  return Object.freeze({
    // Send `data` to ONE recipient over their direct link. Rejects when no
    // live link exists (the recipient isn't a directly-connected peer):
    // honest failure now, store-and-forward to offline peers is §6.2's job.
    /** @param {string} toDid @param {any} data */
    async send(toDid, data) {
      const env = await mesh.sign(3, MSG, { data });
      if (!mesh.send(toDid, env)) throw new Error(`no direct link to ${(toDid || "").slice(-8)}`);
      return { id: env.id, ts: env.ts };
    },
    /** @param {(msg: DirectMsg) => void} cb */
    onMessage(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    close() {
      off();
      subs.clear();
    }
  });
};
export {
  createBufferedChannel,
  DEFAULT_ICE_SERVERS,
  createDirect,
  createGossip,
  createMemoryTopicStore,
  createPresence,
  createTopicSync,
  generateIdentity,
  joinRoom
};
