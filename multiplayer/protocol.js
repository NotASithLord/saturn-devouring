// 18: standalone peers negotiate a direct-first ICE attempt and a coordinated
// TURN restart; older transports cannot answer the fallback offer.
// 17: hosted Flood shots carry the real shooter and target so peers render
// the same gunfight the authority resolved.
// 16: armed-corpse snapshots carry their recoverable ammunition yield.
// 15: sliding doors are deterministic sim state, so combat LOS cannot pass
// through a visibly shut but unlocked panel.
// 14: marine grenade drops and pickup claims synchronize as world state.
// 13: player snapshot rows carry a per-player afterlife body and the
// authority-owned 30-second co-op respawn clock.
// 12: snapshots carry hidden vent/shaft transit so peers cannot draw or aim
// at a form inside the structure; player poses also carry gait speed and the
// lobby-selected body rig.
// 11: the ship graph gained its loop pass (7 new doors) and 'armorpack'
// joined the packet kinds — a v10 peer runs a different map outright.
// 10: world edge bits carry bit 4 (flood-busted door); armor packs land.
// 9: committed lobby admission remains rollback-safe until the requester
// acknowledges its exact nonce/proposal; retained timeout cancels cannot ghost.
// 8: match packets carry a mergeable authority term and launch uses a retained
// prepare/receipt/final decision, healing reconnecting network partitions.
// 7: lobby membership is a nonce-bound accept/confirm/commit state machine;
// launch decisions are retained and receipt-gated with deterministic recovery.
// 6: Quick Match is an explicit public-lobby discovery protocol. It never
// auto-starts a shared queue cohort; lobby ownership and game authority are
// distinct, and every match begins through the same proposal barrier.
// 5: med packs — a peer's use travels as a 'medkit' packet the authority
// validates, and spent-kit ids ride the full snapshot's world section.
// 4: the row carries player armor (moved into the sim to fix a co-op death
// desync — a client used to heal its own agent past the host's damage).
// 3: the snapshot row carries the leap arc (hoverY + leaping). The row is a
// positional array validated on its LENGTH, so a v2 peer would reject every
// v3 row wholesale — the version is what keeps the two builds from meeting in
// the same room at all instead of staring at frozen NPCs.
export const PROTOCOL_VERSION = 18;
export const MAX_PLAYERS = 4;
export const QUICKPLAY_ROOM = `charon:quickplay:v${PROTOCOL_VERSION}`;
const ROOM_PREFIX = `charon:v${PROTOCOL_VERSION}:`;
const SAFE_CODE = /^[a-z0-9][a-z0-9-]{5,47}$/;
const PUBLIC_LOBBY = /^lobby-[a-z0-9]{12,48}$/;
const GAME_KINDS = new Set(['election', 'state', 'hit', 'explosion', 'shot', 'snapshot',
  'medkit', 'armorpack', 'grenadepickup', 'ammopickup']);

export function createInviteCode(random = globalThis.crypto) {
  if (!random?.getRandomValues) throw new Error('secure random values are unavailable');
  const bytes = new Uint8Array(10);
  random.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

export function createPublicLobbyId(random = globalThis.crypto) {
  return `lobby-${createInviteCode(random)}`;
}

export function isPublicLobbyId(value) {
  return typeof value === 'string' && PUBLIC_LOBBY.test(value);
}

// Quick Match fills an existing open lobby before creating another. A caller
// supplies authenticated room presence separately, so replayed advertisements
// from a departed host never win. Full/malformed rosters are ignored.
export function selectOpenLobby(advertisements, onlineDids, selfDid = '') {
  const online = new Set(Array.from(onlineDids ?? [], String));
  const candidates = Array.from(advertisements ?? []).flatMap((value) => {
    if (!value || !isPublicLobbyId(value.lobbyId) || typeof value.host !== 'string'
        || !online.has(value.host) || !Array.isArray(value.members)) return [];
    const members = [...new Set(value.members.map(String))].sort();
    if (members.length < 1 || members.length >= MAX_PLAYERS
        || !members.includes(value.host)
        || members.some((did) => !online.has(did))
        || (selfDid && members.includes(String(selfDid)))) return [];
    return [{
      lobbyId: value.lobbyId,
      host: value.host,
      members,
      ...(Number.isSafeInteger(value.term) ? { term: value.term } : {}),
      ...(Number.isSafeInteger(value.revision) ? { revision: value.revision } : {}),
    }];
  });
  candidates.sort((a, b) => b.members.length - a.members.length
    || a.lobbyId.localeCompare(b.lobbyId)
    || a.host.localeCompare(b.host));
  return candidates[0] ?? null;
}

export function normalizeInviteCode(value) {
  const code = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!SAFE_CODE.test(code)) throw new Error('enter a valid invite code');
  return code;
}

const bytesToHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

export async function privateRoom(code, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('secure invite rooms require WebCrypto');
  const secret = normalizeInviteCode(code);
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(
    `charon-private-v${PROTOCOL_VERSION}:${secret}`,
  ));
  // The room address reveals no reusable invite secret to overlay forwarders.
  // Lobby messages carry a separate DID-bound HMAC, so learning this hash is
  // insufficient to impersonate an invited fireteam member.
  return `${ROOM_PREFIX}private:${bytesToHex(new Uint8Array(digest)).slice(0, 32)}`;
}

export async function inviteProof(code, did, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('secure invite rooms require WebCrypto');
  const secret = normalizeInviteCode(code);
  const key = await cryptoApi.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await cryptoApi.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`charon-invite-v${PROTOCOL_VERSION}:${String(did)}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyInviteProof(code, did, proof, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  const secret = normalizeInviteCode(code);
  const key = await cryptoApi.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  return cryptoApi.subtle.verify(
    'HMAC', key, hexToBytes(proof),
    new TextEncoder().encode(`charon-invite-v${PROTOCOL_VERSION}:${String(did)}`),
  );
}

// One live public queue avoids epoch-boundary starvation. Liveness comes from
// authenticated mesh presence; committed fireteams immediately migrate to a
// high-entropy match room and are no longer part of matchmaking.
export function quickplayRoom(now = Date.now()) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('invalid quick-play clock');
  return QUICKPLAY_ROOM;
}

export function matchScope(dids) {
  const members = [...new Set(dids.map(String))].sort();
  let hash = 2166136261 >>> 0;
  for (const member of members) {
    for (let index = 0; index < member.length; index++) {
      hash ^= member.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `match-${hash.toString(36)}`;
}

export function seedForScope(scope) {
  return `charon-multiplayer-v${PROTOCOL_VERSION}:${String(scope)}`;
}

export function matchRoom(scope) {
  const value = String(scope ?? '');
  if (!/^match-[a-z0-9]+$/.test(value)) throw new Error('invalid match scope');
  return `${ROOM_PREFIX}${value}`;
}

export function rankHosts(dids, capacities = new Map()) {
  return [...new Set(dids.map(String))].sort((a, b) => {
    const score = (did) => {
      const value = capacities instanceof Map ? capacities.get(did) : capacities?.[did];
      return Math.max(0, Math.min(1_000, Number(value?.score ?? value) || 0));
    };
    return score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

export function shortPeer(did) {
  const text = String(did ?? 'unknown');
  return text.length > 9 ? text.slice(-9) : text;
}

export function peerNumber(did) {
  let hash = 2166136261 >>> 0;
  const text = String(did);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function validGamePacket(packet) {
  return !!packet
    && packet.v === PROTOCOL_VERSION
    && GAME_KINDS.has(packet.kind)
    && typeof packet.from === 'string'
    && packet.from.length <= 160
    && typeof packet.authority === 'string'
    && packet.authority.length > 0
    && packet.authority.length <= 160
    && Number.isSafeInteger(packet.authorityTerm)
    && packet.authorityTerm >= 1
    && Number.isSafeInteger(packet.seq)
    && packet.seq > 0
    && packet.seq <= 0x7fffffff;
}
