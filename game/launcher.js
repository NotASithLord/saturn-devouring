import { joinMultiplayerRoom } from '../multiplayer/session.js';
import { StandardGamepad } from './gamepad.js';
import { beginIntroCrawl } from './intro-crawl.js';
import {
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  createInviteCode,
  createPublicLobbyId,
  inviteProof,
  isPublicLobbyId,
  matchRoom,
  normalizeInviteCode,
  privateRoom,
  quickplayRoom,
  rankHosts,
  seedForScope,
  selectOpenLobby,
  shortPeer,
  verifyInviteProof,
} from '../multiplayer/protocol.js';
import {
  acceptsPendingJoin,
  createPendingJoin,
  normalizeLobbyMembers,
  proposalDisposition,
  sameMatchPayload,
  shouldYieldPublicSingleton,
  validLobbyRevision,
  validateLobbyAbort,
  validateMatchProposal,
} from '../multiplayer/lobby-state.js';
import {
  consensusMaintenancePackets,
  createLobbyConsensus,
  reduceLobbyConsensus,
} from '../multiplayer/lobby-consensus.js';
import {
  allAcknowledged,
  allCommitReceipts,
  allGoReceipts,
  createLaunchBarrier,
  launchControl,
  reduceLaunchBarrier,
} from '../multiplayer/match-launch.js';

const byId = (id) => document.getElementById(id);
const launcher = byId('launcher');
byId('protocolVersion').textContent = `SATURN DEVOURING NETWORK PROTOCOL v${PROTOCOL_VERSION}`;
const pages = [...document.querySelectorAll('[data-launch-page]')];
const launcherGamepad = new StandardGamepad();
const lobbyNames = new Map();
const lobbyBodies = new Map();
let session = null;
let lobbyMode = null;
let lobbyVisibility = 'public';
let lobbyId = '';
let lobbyHostDid = '';
let lobbyTerm = 0;
let lobbyRevision = 0;
let matchAttempt = 0;
let inviteCode = '';
let launchStarted = false;
let voiceActive = false;
let voiceMuted = false;
let voicePlaybackBlocked = false;
let voicePending = false;
let joinGeneration = 0;
let lobbyOff = [];
const lobbyMembers = new Set();
const openLobbies = new Map();
const closedLobbyRevisions = new Map();
const hostScores = new Map();
let ownCapacity = { score: 0, outMbps: 0, rttMs: 0 };
let pendingMatch = null;
let pendingJoin = null;
let agentJoinOperation = null;
let agentStartOperation = null;
let joinController = null;
let committing = false;
let lobbyConsensus = createLobbyConsensus();
let lobbyMaintenanceTimer = 0;
let singletonSettleTimer = 0;
let lobbyMaintenanceBusy = false;
let lobbyTransportError = '';
let gameModulePromise = null;

// Fetch, parse and evaluate the shared game graph while the player is still
// choosing solo or multiplayer. main.js warms the common renderer, then parks
// at its launch-data boundary before it can start a hidden simulation.
function warmGame() {
  gameModulePromise ??= import('./main.js?v=1');
  return gameModulePromise;
}

function setInputMode(mode) {
  document.body.dataset.input = mode;
}

window.addEventListener('keydown', () => setInputMode('keyboard'), true);
window.addEventListener('pointerdown', () => setInputMode('keyboard'), true);

// Keep existing storage keys and launch event as compatibility identifiers.
const LAUNCHER_HISTORY_KEY = 'charonLauncher';
const VALID_LAUNCH_PAGES = new Set(['menu', 'multiplayer', 'lobby', 'about', 'docs']);
const focusByPage = new Map();
let activeLaunchPage = 'menu';

function routeFromLocation() {
  const route = location.hash.replace(/^#/, '');
  if (route === 'about') return { page: 'about', doc: '' };
  if (route === 'multiplayer') return { page: 'multiplayer', doc: '' };
  if (route === 'lobby') return { page: 'lobby', doc: '' };
  if (route.startsWith('docs')) return { page: 'docs', doc: route.split('/')[1] || 'overview' };
  return { page: 'menu', doc: '' };
}

function activeDocTab() {
  return document.querySelector('[data-doc-tab][aria-selected="true"]')?.dataset.docTab || 'overview';
}

function routeForPage(page, doc = activeDocTab()) {
  if (page === 'menu') return 'home';
  if (page === 'docs') return `docs/${doc}`;
  return page;
}

function launcherState(page, depth, doc = activeDocTab()) {
  return { [LAUNCHER_HISTORY_KEY]: true, page, doc: page === 'docs' ? doc : '', depth };
}

function updatePrimaryNavigation(page) {
  for (const button of document.querySelectorAll('.hub-nav [data-open-page]')) {
    const current = button.dataset.openPage === page || (page === 'multiplayer' && button.dataset.openPage === 'menu');
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function focusPage(page) {
  const section = document.querySelector(`[data-launch-page="${page}"]`);
  const remembered = focusByPage.get(page);
  const defaultFocus = ['[data-menu-default]', '.hub-button.primary', '.hub-back', 'button', 'input', 'select']
    .map((selector) => section?.querySelector(selector)).find(Boolean);
  const focus = remembered?.isConnected && !remembered.disabled && remembered.getClientRects().length
    ? remembered
    : defaultFocus;
  focus?.focus?.({ preventScroll: true });
}

function renderPage(name, { focus = true } = {}) {
  const pageName = VALID_LAUNCH_PAGES.has(name) ? name : 'menu';
  for (const page of pages) page.hidden = page.dataset.launchPage !== pageName;
  activeLaunchPage = pageName;
  updatePrimaryNavigation(pageName);
  document.body.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (focus) focusPage(pageName);
}

function showPage(name, { historyMode = 'push', focus = true } = {}) {
  const pageName = VALID_LAUNCH_PAGES.has(name) ? name : 'menu';
  const currentFocus = document.activeElement;
  if (currentFocus && currentFocus !== document.body) focusByPage.set(activeLaunchPage, currentFocus);
  const currentDepth = Number(history.state?.depth) || 0;
  const mode = pageName === activeLaunchPage && historyMode === 'push' ? 'replace' : historyMode;
  if (mode !== 'none') {
    const depth = mode === 'push' ? currentDepth + 1 : currentDepth;
    try {
      history[mode === 'push' ? 'pushState' : 'replaceState'](
        launcherState(pageName, depth), '', `#${routeForPage(pageName)}`,
      );
    } catch { /* sandbox may not expose history mutation */ }
  }
  renderPage(pageName, { focus });
}

function replaceDocsRoute(doc) {
  const depth = Number(history.state?.depth) || 0;
  try { history.replaceState(launcherState('docs', depth, doc), '', `#docs/${doc}`); }
  catch { /* sandbox may not expose history mutation */ }
}

function historyBackOr(fallback) {
  if (!history.state?.[LAUNCHER_HISTORY_KEY] || Number(history.state.depth) <= 0) {
    showPage(fallback, { historyMode: 'replace' });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('popstate', finish);
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      showPage(fallback, { historyMode: 'replace' });
      finish();
    }, 500);
    window.addEventListener('popstate', finish, { once: true });
    history.back();
  });
}

function visibleLauncherControls() {
  return [...launcher.querySelectorAll('button, input, select, [tabindex]')].filter((control) => (
    !control.disabled && control.tabIndex >= 0 && !control.closest('[hidden]')
    && control.getClientRects().length > 0
  ));
}

function moveLauncherFocus(dx, dy) {
  const controls = visibleLauncherControls();
  if (!controls.length) return;
  const current = document.activeElement;
  if (!controls.includes(current)) {
    (controls.find((control) => control.matches('.hub-button.primary')) ?? controls[0]).focus();
    return;
  }
  if (current.matches('[data-doc-tab]')) {
    const tabs = [...document.querySelectorAll('[data-doc-tab]')];
    const direction = dx > 0 || dy > 0 ? 1 : -1;
    const next = tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length];
    next.click();
    next.focus();
    return;
  }
  const from = current.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of controls) {
    if (candidate === current) continue;
    const rect = candidate.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const along = (cx - fx) * dx + (cy - fy) * dy;
    if (along <= 1) continue;
    const across = Math.abs((cx - fx) * dy - (cy - fy) * dx);
    const score = along + across * 2.5;
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  best?.focus({ preventScroll: true });
  best?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function adjustFocusedSelect(direction) {
  const select = document.activeElement;
  if (!select?.matches?.('select') || !direction || select.options.length < 2) return false;
  select.selectedIndex = (select.selectedIndex + direction + select.options.length) % select.options.length;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

let launcherNavDirection = '';
let launcherNavRepeatAt = 0;
function launcherGamepadFrame(now) {
  requestAnimationFrame(launcherGamepadFrame);
  if (launcher.hidden) return;
  const state = launcherGamepad.poll();
  if (!state.connected) return;
  if (state.used) setInputMode('gamepad');
  if (document.body.dataset.input !== 'gamepad') return;

  const direction = state.navY < 0 ? 'up' : state.navY > 0 ? 'down'
    : state.navX < 0 ? 'left' : state.navX > 0 ? 'right' : '';
  if (!direction) {
    launcherNavDirection = '';
  } else if (direction !== launcherNavDirection || now >= launcherNavRepeatAt) {
    const vectors = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    if (!(direction === 'left' || direction === 'right')
      || !adjustFocusedSelect(direction === 'right' ? 1 : -1)) {
      moveLauncherFocus(...vectors[direction]);
    }
    launcherNavRepeatAt = now + (direction === launcherNavDirection ? 110 : 360);
    launcherNavDirection = direction;
  }

  if (state.pressed('a')) {
    const active = document.activeElement;
    if (!visibleLauncherControls().includes(active)) moveLauncherFocus(0, 1);
    else if (active.matches('button')) active.click();
    else active.focus();
  }
  if (state.pressed('b')) {
    if (document.activeElement?.matches('input:not([readonly]), select')) document.activeElement.blur();
    else void goBack();
  }
}

const lobbyRevisionKey = (id, host) => `${String(id)}\u0000${String(host)}`;

function savedName() {
  try { return localStorage.getItem('charon-player-name') || ''; }
  catch { return ''; }
}

function rememberName(name) {
  try { localStorage.setItem('charon-player-name', name); }
  catch { /* opaque-origin dwapps intentionally have no durable storage */ }
}

function savedBody() {
  try { return localStorage.getItem('charon-player-body') === 'female' ? 'female' : 'male'; }
  catch { return 'male'; }
}

function playerBody() {
  const body = byId('player-body').value === 'female' ? 'female' : 'male';
  try { localStorage.setItem('charon-player-body', body); }
  catch { /* opaque-origin dwapps intentionally have no durable storage */ }
  return body;
}

function displayError(message) {
  const status = byId('lobby-status');
  status.textContent = message;
  status.dataset.tone = 'error';
  const inline = byId('multiplayer-error');
  if (inline && document.querySelector('[data-launch-page="lobby"]')?.hidden) {
    inline.textContent = message;
    inline.hidden = false;
    byId('invite-code')?.setAttribute('aria-invalid', 'true');
    byId('invite-code')?.focus();
  }
}

function updateVoice(status = {}) {
  voiceActive = !!status.active;
  voiceMuted = !!status.muted;
  voicePlaybackBlocked = !!status.playbackBlocked;
  byId('voice-state').textContent = !voiceActive ? 'microphone off'
    : voicePlaybackBlocked ? 'speaker playback needs a click'
      : voiceMuted ? 'muted · speakers live' : 'microphone + speakers live';
  byId('voice-toggle').textContent = !voiceActive ? 'ENABLE' : voicePlaybackBlocked ? 'ENABLE AUDIO' : voiceMuted ? 'UNMUTE' : 'MUTE';
}

function configureSessionCapabilities() {
  const available = !!session?.supportsVoice;
  const row = document.querySelector('.voice-row');
  if (row) row.hidden = !available;
  byId('voice-toggle').disabled = !available;
  if (!available) {
    updateVoice({ active: false, muted: false });
    byId('voice-state').textContent = 'unavailable in this Peerd bridge';
  }
}

async function toggleVoice() {
  if (!session || !session.supportsVoice || voicePending) return;
  voicePending = true;
  byId('voice-toggle').disabled = true;
  try {
    const status = voicePlaybackBlocked
      ? await session.resumeVoicePlayback()
      : voiceActive ? await session.setVoiceMuted(!voiceMuted)
      : await session.startVoice({ startMuted: false });
    updateVoice(status);
  } catch (error) {
    updateVoice({ active: false, muted: false });
    byId('voice-state').textContent = error.message || 'microphone permission denied';
  } finally {
    voicePending = false;
    byId('voice-toggle').disabled = false;
  }
}

function playerName() {
  const value = byId('player-name').value.trim().slice(0, 24);
  const name = value || `ODST-${Math.floor(Math.random() * 900 + 100)}`;
  byId('player-name').value = name;
  rememberName(name);
  return name;
}

function currentGroup() {
  if (!session) return [];
  // Gossip can replay a signed lobby packet after its author leaves. A lobby's
  // effective roster is always intersected with authenticated room presence.
  const online = new Set([session.did, ...session.roster().map((peer) => peer.did)]);
  return [...lobbyMembers].filter((did) => online.has(did)).sort().slice(0, MAX_PLAYERS);
}

function hostOrder(members = currentGroup()) {
  return rankHosts(members, hostScores);
}

function isLobbyOwner() {
  return !!session && lobbyHostDid === session.did;
}

function isCommittedLobbyPeer(did) {
  return lobbyMembers.has(did) || !!lobbyConsensus.recovery?.eligible.includes(did);
}

function renderRoster() {
  if (!session) return;
  const groupIds = currentGroup();
  const group = new Set(groupIds);
  if (!launchStarted) session.setVoicePeers(groupIds);
  const roster = byId('lobby-roster');
  roster.textContent = '';
  for (const did of groupIds) {
    const row = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    const identity = document.createElement('span');
    identity.className = 'roster-name';
    identity.textContent = did === session.did
      ? `${session.name} (you)`
      : (lobbyNames.get(did) || session.roster().find((peer) => peer.did === did)?.name || shortPeer(did));
    const role = document.createElement('span');
    role.className = 'roster-role';
    const roles = [];
    if (did === lobbyHostDid) roles.push('owner');
    if (did === hostOrder(groupIds)[0]) roles.push('authority');
    roles.push(lobbyBodies.get(did) || 'male');
    role.textContent = roles.join(' · ');
    row.append(dot, identity, role);
    roster.appendChild(row);
  }
  const count = currentGroup().length;
  byId('lobby-count').textContent = `${count} / ${MAX_PLAYERS}`;
  byId('lobby-start').hidden = !isLobbyOwner();
  byId('lobby-start').disabled = count < 2 || !!lobbyConsensus.admission;
  byId('lobby-status').dataset.tone = 'ok';
  if (pendingMatch) {
    byId('lobby-status').textContent = committing
      ? 'Fireteam confirmed. Entering the match room…'
      : `Confirming fireteam · ${pendingMatch.acknowledgements.size} / ${pendingMatch.payload.members.length}`;
    return;
  }
  if (lobbyTransportError) {
    byId('lobby-status').dataset.tone = 'error';
    byId('lobby-status').textContent = lobbyTransportError;
    return;
  }
  if (!lobbyId) {
    byId('lobby-status').textContent = lobbyMode === 'quick'
      ? 'Looking for an open public lobby…'
      : 'Looking for the private lobby host…';
  } else if (isLobbyOwner()) {
    byId('lobby-status').textContent = lobbyConsensus.admission
      ? 'Finalizing the newest survivor’s lobby admission…'
      : count >= 2
      ? 'A player joined. Deploy now, or wait for more survivors.'
      : lobbyVisibility === 'public'
        ? 'Public lobby open. Waiting for another survivor…'
        : 'Private lobby open. Share the invite code with your fireteam.';
  } else {
    byId('lobby-status').textContent = 'Lobby joined. Waiting for the owner to deploy, or for more survivors.';
  }
}

async function broadcastLobby(kind, extra = {}) {
  if (!session) return;
  const proof = lobbyVisibility === 'public' ? null : await inviteProof(inviteCode, session.did);
  const durable = new Set([
    'accept', 'confirm', 'roster', 'roster-commit', 'takeover', 'member-sync',
    'join-cancel', 'admission-ack', 'admission-final',
    'proposal', 'ack', 'commit', 'commit-receipt', 'go', 'go-receipt',
    'launch', 'decision-takeover', 'abort',
  ]).has(kind);
  await session.publish('lobby', {
    v: PROTOCOL_VERSION,
    kind,
    from: session.did,
    name: session.name,
    body: playerBody(),
    ...(proof ? { inviteProof: proof } : {}),
    ...(lobbyId ? { lobbyId } : {}),
    ...extra,
  }, { retain: durable });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installLobbyConsensus(next) {
  lobbyConsensus = next;
  lobbyId = next.lobbyId;
  lobbyHostDid = next.owner;
  lobbyTerm = next.term;
  lobbyRevision = next.revision;
  lobbyVisibility = next.visibility;
  lobbyMembers.clear();
  for (const did of next.members) lobbyMembers.add(did);
}

async function dispatchLobbyConsensus(event, now = Date.now()) {
  const reduced = reduceLobbyConsensus(lobbyConsensus, event, now);
  installLobbyConsensus(reduced.state);
  for (const effect of reduced.effects) {
    await broadcastLobby(effect.kind, effect.payload).catch(() => {});
  }
  renderRoster();
  return reduced;
}

async function dispatchLaunchBarrier(event, now = Date.now()) {
  if (!pendingMatch) return { state: null, effects: [], verdict: 'ignored' };
  const reduced = reduceLaunchBarrier(pendingMatch, event, now);
  pendingMatch = reduced.state;
  for (const effect of reduced.effects) {
    if (effect.kind === 'deploy') await deploy(effect.payload);
    else await broadcastLobby(effect.kind, effect.payload).catch(() => {});
  }
  renderRoster();
  return reduced;
}

function scheduleSingletonConvergence() {
  if (singletonSettleTimer || !session || lobbyVisibility !== 'public'
    || !isLobbyOwner() || currentGroup().length !== 1) return;
  singletonSettleTimer = setTimeout(() => {
    singletonSettleTimer = 0;
    void settlePublicSingleton();
  }, 120 + Math.floor(Math.random() * 180));
}

function startLobbyMaintenance() {
  clearInterval(lobbyMaintenanceTimer);
  let pulse = 0;
  lobbyMaintenanceTimer = setInterval(() => {
    if (!session || launchStarted || lobbyMaintenanceBusy) return;
    lobbyMaintenanceBusy = true;
    void (async () => {
      try {
        await dispatchLobbyConsensus({ type: 'tick' });
        for (const packet of consensusMaintenancePackets(lobbyConsensus)) {
          await broadcastLobby(packet.kind, packet.payload).catch(() => {});
        }
        if (pendingMatch) await dispatchLaunchBarrier({ type: 'tick' });
        if (pendingMatch?.phase === 'decision' && pendingMatch.decisionOwner !== session.did) {
          await broadcastLobby('commit-receipt', launchControl(pendingMatch)).catch(() => {});
        } else if (pendingMatch?.phase === 'go' && pendingMatch.decisionOwner !== session.did) {
          await broadcastLobby('go-receipt', launchControl(pendingMatch)).catch(() => {});
        }
        if (pendingMatch && ['decision', 'go'].includes(pendingMatch.phase)) {
          await session.retain?.('lobby').catch(() => {});
          const recovered = await session.history?.('lobby').catch(() => []) ?? [];
          for (const message of recovered.slice(-32)) await handleLobbyPacket(message).catch(() => {});
          if (pendingMatch?.decisionOwner === session.did) void commitMatch();
        } else if (pendingMatch?.phase === 'aborted') {
          pendingMatch = null;
          committing = false;
          displayError('No decision owner remained. The match was cancelled.');
        }
        if (++pulse % 4 === 0 && isLobbyOwner()) await announceOpenLobby().catch(() => {});
        scheduleSingletonConvergence();
      } finally {
        lobbyMaintenanceBusy = false;
      }
    })();
  }, 500);
}

function stopLobbyMaintenance() {
  clearInterval(lobbyMaintenanceTimer);
  clearTimeout(singletonSettleTimer);
  lobbyMaintenanceTimer = 0;
  singletonSettleTimer = 0;
  lobbyMaintenanceBusy = false;
}

function validAdvertisedRoster(packet) {
  const members = normalizeLobbyMembers(packet?.members);
  return members && members.includes(packet.host)
    && Number.isSafeInteger(packet.term) && packet.term >= 1
    && validLobbyRevision(packet.revision)
    ? members : null;
}

function versionAfter(term, revision, currentTerm = lobbyTerm, currentRevision = lobbyRevision) {
  return term > currentTerm || (term === currentTerm && revision > currentRevision);
}

function versionAtLeast(left, right) {
  return !!left && (left.term > right.term
    || (left.term === right.term && left.revision >= right.revision));
}

async function announceOpenLobby() {
  if (!session || !lobbyId || !isLobbyOwner() || launchStarted || pendingMatch
    || lobbyConsensus.pending || lobbyConsensus.admission) return;
  const members = currentGroup();
  if (!members.includes(session.did)) members.push(session.did);
  members.sort();
  await broadcastLobby('open', {
    host: session.did,
    members,
    term: lobbyTerm,
    revision: lobbyRevision,
    visibility: lobbyVisibility,
    capacity: ownCapacity,
  });
}

async function announceRoster() {
  if (!session || !lobbyId || !isLobbyOwner()) return;
  await broadcastLobby('roster', {
    host: session.did,
    members: currentGroup(),
    term: lobbyTerm,
    revision: lobbyRevision,
    visibility: lobbyVisibility,
  });
}

async function establishOwnedLobby() {
  lobbyId = createPublicLobbyId();
  lobbyHostDid = session.did;
  lobbyTerm = 1;
  lobbyRevision = 1;
  matchAttempt = 0;
  pendingJoin = null;
  lobbyMembers.clear();
  lobbyMembers.add(session.did);
  installLobbyConsensus(createLobbyConsensus({
    selfDid: session.did,
    lobbyId,
    owner: session.did,
    visibility: lobbyVisibility,
    term: lobbyTerm,
    revision: lobbyRevision,
    members: [session.did],
  }));
  await announceOpenLobby();
  await broadcastLobby('ready', { capacity: ownCapacity });
  renderRoster();
}

async function requestLobbyJoin(candidate) {
  if (!session) return false;
  const requested = createPendingJoin(candidate, createInviteCode(), joinGeneration, Date.now(), 8_000);
  if (!requested) return false;
  pendingJoin = requested;
  try {
    await broadcastLobby('join', {
      lobbyId: candidate.lobbyId,
      host: candidate.host,
      term: candidate.term,
      revision: candidate.revision,
      joinNonce: requested.nonce,
      visibility: lobbyVisibility,
      capacity: ownCapacity,
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(100);
      if (lobbyId === candidate.lobbyId && lobbyHostDid === candidate.host
        && lobbyMembers.has(session.did)) return true;
    }
    const cancellation = lobbyConsensus.pending?.proposal;
    await dispatchLobbyConsensus({
      type: 'cancel-pending', member: session.did, joinNonce: requested.nonce,
    });
    await broadcastLobby('join-cancel', {
      lobbyId: candidate.lobbyId,
      host: candidate.host,
      term: candidate.term,
      revision: candidate.revision,
      joinNonce: requested.nonce,
      ...(cancellation?.proposalId ? { proposalId: cancellation.proposalId } : {}),
    }).catch(() => {});
    if (!lobbyId) installLobbyConsensus(createLobbyConsensus({
      selfDid: session.did,
      visibility: lobbyVisibility,
    }));
    return false;
  } finally {
    if (pendingJoin === requested) pendingJoin = null;
  }
}

async function settlePublicSingleton() {
  if (!session || lobbyVisibility !== 'public' || !isLobbyOwner() || currentGroup().length !== 1) return;
  // Two peers can finish the same discovery window before either advertises.
  // Give those simultaneous singleton lobbies one deterministic convergence
  // pass: the lexicographically larger lobby yields to the smaller one.
  await delay(200 + Math.floor(Math.random() * 250));
  await broadcastLobby('discover', { visibility: lobbyVisibility });
  await delay(250);
  if (!session || !isLobbyOwner() || currentGroup().length !== 1) return;
  const online = new Set([session.did, ...session.roster().map((peer) => peer.did)]);
  const candidate = selectOpenLobby(openLobbies.values(), online, session.did);
  if (!shouldYieldPublicSingleton(lobbyId, currentGroup(), candidate)) return;
  const previous = lobbyConsensus;
  await broadcastLobby('closed', { host: session.did, term: lobbyTerm, revision: lobbyRevision }).catch(() => {});
  installLobbyConsensus(createLobbyConsensus({ selfDid: session.did, visibility: lobbyVisibility }));
  if (await requestLobbyJoin(candidate)) return;
  installLobbyConsensus(createLobbyConsensus({
    selfDid: session.did,
    lobbyId: previous.lobbyId,
    owner: session.did,
    visibility: previous.visibility,
    term: previous.term,
    revision: previous.revision + 1,
    members: [session.did],
  }));
  await announceOpenLobby().catch(() => {});
}

async function discoverAndJoinLobby({ createIfMissing }) {
  openLobbies.clear();
  await broadcastLobby('discover', { visibility: lobbyVisibility });
  await delay(600);
  const rejected = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    const online = new Set([session.did, ...session.roster().map((peer) => peer.did)]);
    const available = [...openLobbies.values()].filter((candidate) => !rejected.has(candidate.lobbyId));
    const candidate = lobbyVisibility === 'public'
      ? selectOpenLobby(available, online, session.did)
      : available.filter((value) => value.visibility === 'private'
        && online.has(value.host) && value.members.length < MAX_PLAYERS
        && !value.members.includes(session.did))
        .sort((a, b) => b.members.length - a.members.length || a.lobbyId.localeCompare(b.lobbyId))[0];
    if (!candidate) break;
    if (await requestLobbyJoin(candidate)) return;
    rejected.add(candidate.lobbyId);
  }
  if (createIfMissing) {
    await establishOwnedLobby();
    await settlePublicSingleton();
    return;
  }
  throw new Error('No open private lobby answered. Check the invite code and ask the host to stay in the lobby.');
}

async function startMatch() {
  if (!session || launchStarted || pendingMatch || lobbyConsensus.pending
    || lobbyConsensus.admission || !isLobbyOwner()) return;
  const members = currentGroup();
  if (members.length < 2) return;
  const scope = `match-${createInviteCode()}`;
  const hosts = hostOrder(members);
  const payload = {
    members,
    hosts,
    scope,
    seed: seedForScope(scope),
    host: hosts[0],
    term: lobbyTerm,
    revision: lobbyRevision,
    attempt: ++matchAttempt,
  };
  pendingMatch = createLaunchBarrier({
    payload, ownerDid: session.did, selfDid: session.did,
  });
  byId('lobby-status').textContent = 'Confirming the fireteam…';
  await broadcastLobby('closed', {
    host: session.did,
    term: lobbyTerm,
    revision: payload.revision,
    attempt: payload.attempt,
  }).catch(() => {});
  for (let attempt = 0; attempt < 6 && pendingMatch && !launchStarted; attempt++) {
    await broadcastLobby('proposal', launchControl(pendingMatch)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (pendingMatch && allAcknowledged(pendingMatch)) {
      await commitMatch();
      return;
    }
  }
  if (!launchStarted) {
    await abortMatchAttempt('A fireteam member did not confirm. Check the connection and deploy again.');
  }
}

async function abortMatchAttempt(message = '') {
  const failed = pendingMatch;
  pendingMatch = null;
  committing = false;
  if (failed && session && failed.decisionOwner === session.did) {
    const oldRevision = failed.payload.revision;
    const replacingOwner = lobbyHostDid !== session.did;
    const nextTerm = replacingOwner ? lobbyTerm + 1 : lobbyTerm;
    const nextRevision = replacingOwner ? 1 : Math.max(lobbyRevision, oldRevision) + 1;
    installLobbyConsensus(createLobbyConsensus({
      selfDid: session.did,
      lobbyId,
      owner: session.did,
      visibility: lobbyVisibility,
      term: nextTerm,
      revision: nextRevision,
      members: currentGroup(),
    }));
    matchAttempt = 0;
    const members = currentGroup();
    await broadcastLobby('abort', {
      term: failed.payload.term,
      revision: oldRevision,
      attempt: failed.payload.attempt,
      decisionOwner: failed.decisionOwner,
      decisionTerm: failed.decisionTerm,
      nextOwner: session.did,
      nextTerm,
      nextRevision,
      members,
    }).catch(() => {});
    await announceOpenLobby().catch(() => {});
  }
  renderRoster();
  if (message) displayError(message);
}

async function commitMatch() {
  if (!pendingMatch || committing || launchStarted || pendingMatch.decisionOwner !== session.did) return;
  committing = true;
  const payload = pendingMatch.payload;
  try {
    if (pendingMatch.phase === 'proposal') {
      const begun = await dispatchLaunchBarrier({ type: 'begin-decision' });
      if (begun.verdict !== 'accepted') return;
    }
    if (pendingMatch.phase === 'decision') {
      for (let attempt = 0; attempt < 12 && pendingMatch && !launchStarted; attempt++) {
        await broadcastLobby('commit', launchControl(pendingMatch)).catch(() => {});
        await delay(350);
        if (pendingMatch && allCommitReceipts(pendingMatch)) break;
      }
      if (!pendingMatch || !allCommitReceipts(pendingMatch)) {
        throw new Error('a fireteam member did not receive the commit decision');
      }
      await dispatchLaunchBarrier({ type: 'begin-go' });
    }
    if (pendingMatch?.phase === 'go') {
      for (let attempt = 0; attempt < 12 && pendingMatch && !launchStarted; attempt++) {
        await broadcastLobby('go', launchControl(pendingMatch)).catch(() => {});
        await delay(350);
        if (pendingMatch && allGoReceipts(pendingMatch)) break;
      }
      if (!pendingMatch || !allGoReceipts(pendingMatch)) {
        throw new Error('a fireteam member did not receive the launch prepare');
      }
      await dispatchLaunchBarrier({ type: 'begin-launch' });
    }
    if (pendingMatch?.phase === 'launch') {
      for (let attempt = 0; attempt < 12; attempt++) {
        await broadcastLobby('launch', launchControl(pendingMatch)).catch(() => {});
        await delay(200);
      }
      await deploy(payload);
    }
  } catch (error) {
    if (!launchStarted) await abortMatchAttempt(`Could not confirm the match: ${error.message || error}`);
  } finally {
    if (!launchStarted) committing = false;
  }
}

async function deploy({ members, hosts, scope, seed, host }) {
  if (launchStarted || !session || !members.includes(session.did)) return;
  launchStarted = true;
  stopLobbyMaintenance();
  for (const off of lobbyOff.splice(0)) off();
  const lobbySession = session;
  const name = lobbySession.name;
  const identity = lobbySession.identity;
  const resumeVoice = voiceActive;
  const resumeMuted = voiceMuted;
  lobbySession.setVoicePeers([]);
  await lobbySession.close();
  updateVoice({ active: false, muted: false });
  try {
    session = await joinMultiplayerRoom({ roomId: matchRoom(scope), name, identity });
    session.setScope(scope);
    session.setVoicePeers(members);
    await session.refreshPresence();
    if (resumeVoice) {
      try { updateVoice(await session.startVoice({ startMuted: resumeMuted })); }
      catch { updateVoice({ active: false, muted: false }); }
    }
  } catch (error) {
    session = null;
    launchStarted = false;
    committing = false;
    showPage('multiplayer', { historyMode: 'replace' });
    displayError(`Could not enter the match room: ${error.message}`);
    return;
  }
  await launchGame({
    mode: 'multiplayer',
    session,
    name,
    roomId: session.roomId,
    members,
    scope,
    seed,
    host: host || members[0],
    hostOrder: Array.isArray(hosts) ? hosts : [host || members[0], ...members.filter((did) => did !== host)],
    bodies: Object.fromEntries(members.map((did) => [did,
      did === session.did ? playerBody() : lobbyBodies.get(did) || 'male'])),
  });
}

function validMatchPayload(packet) {
  if (!session || packet?.term !== lobbyTerm || !validLobbyRevision(packet?.revision)
    || packet.revision !== lobbyRevision) return null;
  return validateMatchProposal(packet, {
    expectedMembers: currentGroup(),
    ownerDid: lobbyHostDid,
    term: lobbyTerm,
    revision: packet.revision,
  });
}

function setJoinButtons(disabled) {
  for (const id of ['quick-play', 'host-private', 'join-private']) byId(id).disabled = disabled;
}

function normalizedCapacity(value) {
  return {
    score: Math.max(0, Math.min(1_000, Number(value?.score) || 0)),
    outMbps: Math.max(0, Number(value?.outMbps) || 0),
    rttMs: Math.max(0, Number(value?.rttMs) || 0),
  };
}

async function handleLobbyPacket(message) {
  const packet = message?.data;
  if (!session || !packet || packet.v !== PROTOCOL_VERSION
    || message?.from !== packet.from || packet.from === session.did) return;
  if (lobbyVisibility === 'private'
    && !(await verifyInviteProof(inviteCode, packet.from, packet.inviteProof))) return;
  if (packet.name) lobbyNames.set(packet.from, String(packet.name).slice(0, 24));
  if (packet.body === 'male' || packet.body === 'female') lobbyBodies.set(packet.from, packet.body);

  if (packet.kind === 'discover') {
    if (packet.visibility === lobbyVisibility) await announceOpenLobby();
    return;
  }

  if (packet.kind === 'open') {
    const members = validAdvertisedRoster(packet);
    if (!members || packet.host !== packet.from || !isPublicLobbyId(packet.lobbyId)
      || packet.visibility !== lobbyVisibility) return;
    const closed = closedLobbyRevisions.get(lobbyRevisionKey(packet.lobbyId, packet.host));
    if (closed && versionAtLeast(closed, packet)) return;
    openLobbies.set(packet.lobbyId, {
      lobbyId: packet.lobbyId,
      host: packet.host,
      members,
      term: packet.term,
      revision: packet.revision,
      visibility: packet.visibility,
    });
    hostScores.set(packet.host, normalizedCapacity(packet.capacity));
    // Discovery advertisements never mutate a joined lobby. Membership moves
    // only through the reducer's nonce-bound commit/removal/takeover packets.
    scheduleSingletonConvergence();
    return;
  }

  if (packet.kind === 'closed') {
    const advertised = openLobbies.get(packet.lobbyId);
    if (packet.host === packet.from && Number.isSafeInteger(packet.term) && packet.term >= 1
      && validLobbyRevision(packet.revision)) {
      const key = lobbyRevisionKey(packet.lobbyId, packet.host);
      const previous = closedLobbyRevisions.get(key);
      if (!previous || versionAfter(packet.term, packet.revision, previous.term, previous.revision)) {
        closedLobbyRevisions.set(key, { term: packet.term, revision: packet.revision });
      }
      if (advertised?.host === packet.from && versionAtLeast(packet, advertised)) {
        openLobbies.delete(packet.lobbyId);
      }
    }
    return;
  }

  if (packet.kind === 'join') {
    if (!isLobbyOwner() || packet.host !== session.did || packet.lobbyId !== lobbyId
      || packet.visibility !== lobbyVisibility || packet.term !== lobbyTerm
      || packet.revision !== lobbyRevision || launchStarted || pendingMatch) return;
    if (typeof packet.joinNonce !== 'string' || !/^[a-z0-9]{20,48}$/.test(packet.joinNonce)) return;
    const online = new Set(session.roster().map((peer) => peer.did));
    if (!online.has(packet.from) || (!lobbyMembers.has(packet.from) && currentGroup().length >= MAX_PLAYERS)) return;
    hostScores.set(packet.from, normalizedCapacity(packet.capacity));
    const reduced = await dispatchLobbyConsensus({
      type: 'owner-propose-add',
      member: packet.from,
      joinNonce: packet.joinNonce,
    });
    if (!reduced.effects.length && lobbyConsensus.pending?.proposal.member === packet.from
      && lobbyConsensus.pending.proposal.joinNonce === packet.joinNonce) {
      await broadcastLobby('accept', lobbyConsensus.pending.proposal).catch(() => {});
    }
    return;
  }

  if (packet.kind === 'join-cancel') {
    const admissionHost = lobbyConsensus.pending?.proposal.host
      || lobbyConsensus.admission?.host || session.did;
    if (!isLobbyOwner() || packet.host !== admissionHost || packet.lobbyId !== lobbyId) return;
    const reduced = await dispatchLobbyConsensus({
      type: 'cancel-pending',
      from: packet.from,
      member: packet.from,
      proposalId: packet.proposalId,
      lobbyId: packet.lobbyId,
      host: packet.host,
      term: packet.term,
      revision: packet.revision,
      joinNonce: packet.joinNonce,
    });
    if (reduced.verdict === 'accepted' && !lobbyConsensus.pending && !lobbyConsensus.admission) {
      matchAttempt = 0;
      await announceOpenLobby().catch(() => {});
    }
    return;
  }

  if (packet.kind === 'accept') {
    const adopting = acceptsPendingJoin(pendingJoin, packet, session.did, joinGeneration);
    const existing = packet.lobbyId === lobbyId && packet.host === lobbyHostDid
      && lobbyMembers.has(session.did);
    if (!adopting && !existing) return;
    await dispatchLobbyConsensus({ type: 'accept', packet, pendingJoinMatches: adopting });
    return;
  }

  if (packet.kind === 'confirm') {
    const before = lobbyRevision;
    await dispatchLobbyConsensus({ type: 'confirm', packet });
    if (lobbyRevision !== before && isLobbyOwner()) {
      matchAttempt = 0;
      await announceOpenLobby().catch(() => {});
    }
    return;
  }

  if (packet.kind === 'roster-commit') {
    const expectedHost = lobbyConsensus.pending?.proposal.host || lobbyHostDid;
    if (!expectedHost || packet.from !== expectedHost || packet.host !== expectedHost) return;
    const reduced = await dispatchLobbyConsensus({ type: 'roster-commit', packet });
    if (reduced.verdict === 'accepted' || reduced.verdict === 'idempotent') {
      if (packet.member === session.did) pendingJoin = null;
      if (reduced.verdict === 'accepted') {
        matchAttempt = 0;
        pendingMatch = null;
        committing = false;
      }
      await broadcastLobby('ready', { term: lobbyTerm, revision: lobbyRevision, capacity: ownCapacity });
      if (isLobbyOwner()) await announceOpenLobby().catch(() => {});
    }
    return;
  }

  if (packet.kind === 'roster') {
    const members = validAdvertisedRoster(packet);
    if (!members || !lobbyMembers.has(packet.from)
      || packet.host !== packet.from || packet.host !== lobbyHostDid
      || packet.lobbyId !== lobbyId || packet.visibility !== lobbyVisibility
      || !members.includes(session.did) || !versionAfter(packet.term, packet.revision)) return;
    const reduced = await dispatchLobbyConsensus({ type: 'roster', packet: { ...packet, members } });
    if (reduced.verdict !== 'accepted') return;
    matchAttempt = 0;
    pendingMatch = null;
    committing = false;
    renderRoster();
    return;
  }

  if (packet.kind === 'member-sync') {
    if (!isCommittedLobbyPeer(packet.from)) return;
    await dispatchLobbyConsensus({
      type: 'member-sync',
      packet,
      online: [session.did, ...session.roster().map((peer) => peer.did)],
    });
    return;
  }

  if (packet.kind === 'takeover') {
    if (!isCommittedLobbyPeer(packet.from)) return;
    await dispatchLobbyConsensus({
      type: 'takeover',
      packet,
      online: [session.did, ...session.roster().map((peer) => peer.did)],
    });
    if (isLobbyOwner()) {
      await announceRoster().catch(() => {});
      await announceOpenLobby().catch(() => {});
    }
    return;
  }

  // A retained final may have been authored by the original owner immediately
  // before it departed. That DID is no longer in the current roster, but the
  // reducer still has the exact nonce/proposal admission lineage needed to
  // authenticate (or reject) it. Route only this self-validating control before
  // the ordinary current-member gate.
  if (packet.kind === 'admission-final') {
    await dispatchLobbyConsensus({ type: 'admission-final', packet });
    return;
  }

  if (!lobbyId || packet.lobbyId !== lobbyId || !lobbyMembers.has(packet.from)) return;
  if (packet.kind === 'ready') {
    hostScores.set(packet.from, normalizedCapacity(packet.capacity));
    if (isLobbyOwner()) await announceRoster().catch(() => {});
  } else if (packet.kind === 'admission-ack') {
    const reduced = await dispatchLobbyConsensus({ type: 'admission-ack', packet });
    if (reduced.verdict === 'accepted' && isLobbyOwner()) {
      matchAttempt = 0;
      await announceOpenLobby().catch(() => {});
    }
  } else if (packet.kind === 'proposal') {
    const payload = validMatchPayload(packet);
    if (payload) {
      if (payload.revision > lobbyRevision) {
        lobbyRevision = payload.revision;
        matchAttempt = 0;
        pendingMatch = null;
        committing = false;
      }
      const disposition = proposalDisposition(pendingMatch?.payload, matchAttempt, payload);
      if (disposition === 'duplicate') {
        await broadcastLobby('ack', launchControl(pendingMatch));
      } else if (disposition === 'replace') {
        matchAttempt = Math.max(matchAttempt, payload.attempt);
        pendingMatch = createLaunchBarrier({
          payload, ownerDid: packet.from, selfDid: session.did, follower: true,
        });
        await broadcastLobby('ack', launchControl(pendingMatch));
        const expected = payload;
        setTimeout(() => {
          if (pendingMatch?.decisionOwner !== session.did && pendingMatch?.phase === 'proposal'
            && sameMatchPayload(pendingMatch.payload, expected)) {
            pendingMatch = null;
            committing = false;
            renderRoster();
          }
        }, 5_000);
      }
    }
  } else if (packet.kind === 'ack' && pendingMatch && pendingMatch.decisionOwner === session.did
    && sameMatchPayload(packet, pendingMatch.payload)
    && pendingMatch.payload.members.includes(packet.from)) {
    await dispatchLaunchBarrier({ type: 'ack', packet });
    if (pendingMatch && allAcknowledged(pendingMatch)) {
      await commitMatch();
    }
  } else if (packet.kind === 'abort') {
    if (!pendingMatch || packet.decisionOwner !== pendingMatch.decisionOwner
      || packet.decisionTerm !== pendingMatch.decisionTerm) return;
    const aborted = validateLobbyAbort(packet, {
      ownerDid: pendingMatch.decisionOwner,
      lobbyId,
      term: lobbyTerm,
      revision: lobbyRevision,
      expectedMembers: currentGroup(),
      pendingPayload: pendingMatch?.payload,
      selfDid: session.did,
    });
    if (aborted) {
      installLobbyConsensus(createLobbyConsensus({
        selfDid: session.did,
        lobbyId,
        owner: aborted.nextOwner,
        visibility: lobbyVisibility,
        term: aborted.nextTerm,
        revision: aborted.nextRevision,
        members: aborted.members,
      }));
      matchAttempt = 0;
      pendingMatch = null;
      committing = false;
    }
  } else if (packet.kind === 'commit' && pendingMatch) {
    await dispatchLaunchBarrier({ type: 'commit', packet });
  } else if (packet.kind === 'commit-receipt' && pendingMatch) {
    await dispatchLaunchBarrier({ type: 'commit-receipt', packet });
  } else if (packet.kind === 'go' && pendingMatch) {
    await dispatchLaunchBarrier({ type: 'go', packet });
  } else if (packet.kind === 'go-receipt' && pendingMatch) {
    await dispatchLaunchBarrier({ type: 'go-receipt', packet });
  } else if (packet.kind === 'launch' && pendingMatch) {
    await dispatchLaunchBarrier({ type: 'launch', packet });
  } else if (packet.kind === 'decision-takeover' && pendingMatch) {
    const reduced = await dispatchLaunchBarrier({
      type: 'takeover',
      packet,
      online: [session.did, ...session.roster().map((peer) => peer.did)],
    });
    if (['accepted', 'idempotent'].includes(reduced.verdict)
      && pendingMatch?.decisionOwner === session.did) void commitMatch();
  }
  renderRoster();
}

async function joinLobby(mode) {
  const generation = ++joinGeneration;
  joinController?.abort();
  const controller = new AbortController();
  joinController = controller;
  setJoinButtons(true);
  stopLobbyMaintenance();
  for (const off of lobbyOff.splice(0)) off();
  if (session) await session.close();
  session = null;
  lobbyMode = mode;
  lobbyVisibility = mode === 'quick' ? 'public' : 'private';
  lobbyId = '';
  lobbyHostDid = '';
  lobbyTerm = 0;
  lobbyRevision = 0;
  matchAttempt = 0;
  launchStarted = false;
  committing = false;
  pendingMatch = null;
  pendingJoin = null;
  lobbyMembers.clear();
  openLobbies.clear();
  closedLobbyRevisions.clear();
  hostScores.clear();
  lobbyNames.clear();
  lobbyBodies.clear();
  lobbyTransportError = '';
  const name = playerName();
  byId('multiplayer-error').hidden = true;
  byId('invite-code').removeAttribute('aria-invalid');
  let roomId;
  try {
    if (mode === 'quick') {
      roomId = quickplayRoom();
      inviteCode = '';
    } else if (mode === 'host') {
      inviteCode = createInviteCode();
      roomId = await privateRoom(inviteCode);
    } else {
      inviteCode = normalizeInviteCode(byId('invite-code').value);
      roomId = await privateRoom(inviteCode);
    }
  } catch (error) {
    displayError(error.message);
    if (generation === joinGeneration) setJoinButtons(false);
    return;
  }

  showPage('lobby');
  byId('lobby-title').textContent = mode === 'quick' ? 'QUICK MATCH' : 'PRIVATE FIRETEAM';
  byId('invite-panel').hidden = mode === 'quick';
  byId('invite-value').value = inviteCode;
  byId('lobby-roster').textContent = '';
  byId('lobby-status').dataset.tone = '';
  byId('lobby-status').textContent = 'Opening a peer-to-peer room…';
  let slowConnectionTimer = 0;
  try {
    slowConnectionTimer = setTimeout(() => {
      if (generation === joinGeneration && !session) {
        byId('lobby-status').textContent = 'Still negotiating direct WebRTC connectivity… VPN, NAT, or firewall traversal may take up to 15 seconds.';
      }
    }, 5_000);
    const joined = await joinMultiplayerRoom({ roomId, name, signal: controller.signal });
    if (generation !== joinGeneration) {
      await joined.close();
      return;
    }
    session = joined;
    lobbyBodies.set(session.did, playerBody());
    session.setScope(roomId);
    configureSessionCapabilities();
    installLobbyConsensus(createLobbyConsensus({ selfDid: session.did, visibility: lobbyVisibility }));
    ownCapacity = normalizedCapacity(await session.capacity().catch(() => ({})));
    ownCapacity.score = Math.round(ownCapacity.score);
    ownCapacity.outMbps = Math.round(ownCapacity.outMbps);
    ownCapacity.rttMs = Math.round(ownCapacity.rttMs);
    hostScores.set(session.did, ownCapacity);
    byId('transport-label').textContent = session.transport === 'peerd'
      ? 'PEERD BASE MESH'
      : 'WEBRTC · WEB BUNDLE';
    await session.retain?.('lobby').catch(() => {});
    const offTopic = await session.subscribe('lobby', (message) => {
      void handleLobbyPacket(message).catch(() => {});
    });
    lobbyOff.push(
      offTopic,
      session.on('roster', (roster) => {
        renderRoster(roster);
        if (lobbyConsensus.recovery) {
          broadcastLobby('member-sync', {
            lobbyId: lobbyConsensus.lobbyId,
            previousOwner: lobbyConsensus.recovery.previousOwner,
            term: lobbyConsensus.recovery.term,
          }).catch(() => {});
        }
      }),
      session.on('transport-status', (status) => {
        lobbyTransportError = status?.state === 'failed'
          ? status.error?.message || 'Another player reached this lobby, but WebRTC could not connect.'
          : '';
        renderRoster();
      }),
      session.on('voice', updateVoice),
      session.on('peer-leave', (did) => {
        const wasLobbyMember = lobbyMembers.has(did);
        for (const [id, advertised] of openLobbies) {
          if (advertised.host === did || advertised.members.includes(did)) openLobbies.delete(id);
        }
        if (pendingJoin?.host === did) pendingJoin = null;
        hostScores.delete(did);
        const recoveringDecision = ['decision', 'go', 'launch'].includes(pendingMatch?.phase)
          && pendingMatch.payload.members.includes(did);
        if (pendingMatch?.payload.members.includes(did) && !recoveringDecision) {
          pendingMatch = null;
          committing = false;
          displayError('A fireteam member disconnected. Match confirmation was cancelled.');
        }
        if (recoveringDecision && did === pendingMatch?.decisionOwner) {
          committing = false;
          void dispatchLaunchBarrier({ type: 'owner-left', did });
        }
        if (wasLobbyMember && did === lobbyHostDid && !recoveringDecision) {
          void dispatchLobbyConsensus({ type: 'owner-left', did });
        } else if (wasLobbyMember && isLobbyOwner() && !recoveringDecision) {
          void dispatchLobbyConsensus({ type: 'owner-remove', member: did });
          matchAttempt = 0;
          announceOpenLobby().catch(() => {});
        }
        renderRoster();
      }),
    );
    await session.refreshPresence();
    for (const message of await session.history?.('lobby').catch(() => []) ?? []) {
      await handleLobbyPacket(message).catch(() => {});
    }
    startLobbyMaintenance();
    if (mode === 'host') await establishOwnedLobby();
    else await discoverAndJoinLobby({ createIfMissing: mode === 'quick' });
    renderRoster();
  } catch (error) {
    if (generation === joinGeneration) {
      const failedSession = session;
      session = null;
      stopLobbyMaintenance();
      for (const off of lobbyOff.splice(0)) off();
      await failedSession?.close().catch(() => {});
      if (error?.code !== 'JOIN_CANCELLED') {
        displayError(error.message || 'Could not open the co-op room.');
      }
    }
  } finally {
    clearTimeout(slowConnectionTimer);
    if (joinController === controller) joinController = null;
    if (generation === joinGeneration) setJoinButtons(false);
  }
}

async function launchGame(config) {
  globalThis.__charonLaunch = config;
  document.body.classList.remove('launcher-active');
  launcher.hidden = true;
  byId('intro').style.display = '';
  byId('overlay').style.display = '';
  beginIntroCrawl();
  // If the module is already parked, release it now. If the player launched
  // before warm-up reached that boundary, __charonLaunch above is the same
  // race-free handoff when its body begins evaluating.
  window.dispatchEvent(new CustomEvent('charon:launch', { detail: config }));
  try {
    await warmGame();
  } catch (error) {
    launcher.hidden = false;
    document.body.classList.add('launcher-active');
    showPage('menu');
    const notice = byId('menu-notice');
    notice.textContent = `Could not start Saturn Devouring: ${error.message}`;
    notice.hidden = false;
    throw error;
  }
}

async function closeLobby() {
  joinGeneration += 1;
  joinController?.abort();
  joinController = null;
  stopLobbyMaintenance();
  setJoinButtons(false);
  for (const off of lobbyOff.splice(0)) off();
  if (session) await session.close();
  session = null;
  updateVoice({ active: false, muted: false });
  lobbyNames.clear();
  lobbyBodies.clear();
  lobbyMembers.clear();
  openLobbies.clear();
  closedLobbyRevisions.clear();
  hostScores.clear();
  lobbyId = '';
  lobbyHostDid = '';
  lobbyTerm = 0;
  lobbyRevision = 0;
  matchAttempt = 0;
  pendingJoin = null;
  pendingMatch = null;
  committing = false;
  lobbyConsensus = createLobbyConsensus();
}

async function leaveLobby() {
  await closeLobby();
  await historyBackOr('multiplayer');
}

async function goBack() {
  if (activeLaunchPage === 'menu') return;
  if (activeLaunchPage === 'lobby') {
    await leaveLobby();
    return;
  }
  await historyBackOr('menu');
}

for (const button of document.querySelectorAll('[data-open-page]')) {
  button.addEventListener('click', async () => {
    const target = button.dataset.openPage;
    if (activeLaunchPage === 'lobby' && !launchStarted) {
      await closeLobby();
      showPage(target, { historyMode: 'replace' });
      return;
    }
    showPage(target);
  });
}
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => { void goBack(); });
}
for (const tab of document.querySelectorAll('[data-doc-tab]')) {
  tab.addEventListener('click', () => {
    for (const candidate of document.querySelectorAll('[data-doc-tab]')) {
      candidate.setAttribute('aria-selected', String(candidate === tab));
      candidate.tabIndex = candidate === tab ? 0 : -1;
    }
    for (const panel of document.querySelectorAll('[data-doc-panel]')) {
      panel.hidden = panel.dataset.docPanel !== tab.dataset.docTab;
    }
    replaceDocsRoute(tab.dataset.docTab);
  });
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight'
      && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-doc-tab]')];
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length].click();
    tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length].focus();
  });
}

byId('solo-play').addEventListener('click', () => launchGame({
  mode: 'solo',
  session: null,
  name: playerName(),
  body: playerBody(),
  seed: new URLSearchParams(location.search).get('seed') || undefined,
}));
byId('quick-play').addEventListener('click', () => joinLobby('quick'));
byId('host-private').addEventListener('click', () => joinLobby('host'));
byId('join-private').addEventListener('click', () => joinLobby('join'));
byId('lobby-start').addEventListener('click', startMatch);
byId('lobby-leave').addEventListener('click', leaveLobby);
byId('voice-toggle').addEventListener('click', toggleVoice);
byId('copy-invite').addEventListener('click', async (event) => {
  const input = byId('invite-value');
  const button = byId('copy-invite');
  input.select();
  if (!event.isTrusted) {
    button.textContent = 'TAP OR ENTER TO COPY';
    setTimeout(() => { button.textContent = 'COPY CODE'; }, 1800);
    return;
  }
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = 'COPIED';
  } catch {
    document.execCommand?.('copy');
    button.textContent = 'SELECTED';
  }
  setTimeout(() => { button.textContent = 'COPY CODE'; }, 1800);
});

window.addEventListener('keydown', (event) => {
  if (launcher.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (document.activeElement?.matches('input:not([readonly]), select')) document.activeElement.blur();
    else void goBack();
    return;
  }
  if (!event.key.startsWith('Arrow') || event.target?.matches?.('input, select, [data-doc-tab]')) return;
  const vectors = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  };
  event.preventDefault();
  moveLauncherFocus(...vectors[event.key]);
});

window.addEventListener('popstate', async (event) => {
  const state = event.state?.[LAUNCHER_HISTORY_KEY] ? event.state : routeFromLocation();
  const page = VALID_LAUNCH_PAGES.has(state.page) ? state.page : 'menu';
  if (page === 'lobby' && !session && !joinController) {
    showPage('multiplayer', { historyMode: 'replace' });
    return;
  }
  if (activeLaunchPage === 'lobby' && page !== 'lobby' && !launchStarted) {
    await closeLobby();
  }
  renderPage(page);
  if (page === 'docs') {
    const requested = state.doc || routeFromLocation().doc;
    document.querySelector(`[data-doc-tab="${requested}"]`)?.click();
  }
});

byId('player-name').value = savedName();
byId('player-body').value = savedBody();
let initialRoute = history.state?.[LAUNCHER_HISTORY_KEY]
  ? { page: history.state.page, doc: history.state.doc }
  : routeFromLocation();
if (initialRoute.page === 'lobby') {
  initialRoute = { page: 'multiplayer', doc: '' };
  try {
    history.replaceState(launcherState('multiplayer', Number(history.state?.depth) || 0), '', '#multiplayer');
  } catch { /* sandbox may not expose history mutation */ }
}
if (!history.state?.[LAUNCHER_HISTORY_KEY]) {
  try {
    if (initialRoute.page === 'menu') {
      history.replaceState(launcherState('menu', 0), '', '#home');
    } else {
      const initialHash = `#${routeForPage(initialRoute.page, initialRoute.doc)}`;
      history.replaceState(launcherState('menu', 0), '', '#home');
      history.pushState(launcherState(initialRoute.page, 1, initialRoute.doc), '', initialHash);
    }
  } catch { /* sandbox may not expose history mutation */ }
}
renderPage(initialRoute.page);
if (initialRoute.page === 'docs') {
  document.querySelector(`[data-doc-tab="${initialRoute.doc || 'overview'}"]`)?.click();
}
requestAnimationFrame(launcherGamepadFrame);

// Let the launcher paint first, then begin the one download both play modes
// require. An immediate click calls warmGame synchronously and wins the race.
const scheduleGameWarmup = window.requestIdleCallback
  ? (callback) => window.requestIdleCallback(callback, { timeout: 250 })
  : (callback) => window.setTimeout(callback, 0);
scheduleGameWarmup(() => { void warmGame().catch(() => {}); });

function launcherObservation() {
  const activePage = pages.find((page) => !page.hidden)?.dataset.launchPage || 'menu';
  return {
    screen: activePage,
    playerName: byId('player-name').value,
    playerBody: playerBody(),
    lobby: session ? {
      mode: lobbyMode,
      visibility: lobbyVisibility,
      lobbyId: lobbyId || null,
      owner: lobbyHostDid || null,
      revision: lobbyRevision || null,
      self: session.did,
      isOwner: isLobbyOwner(),
      members: currentGroup().map((did) => ({
        did,
        name: did === session.did ? session.name : lobbyNames.get(did) || shortPeer(did),
        body: lobbyBodies.get(did) || 'male',
        authority: hostOrder()[0] === did,
      })),
      canStart: isLobbyOwner() && currentGroup().length >= 2 && !pendingMatch
        && !lobbyConsensus.pending && !lobbyConsensus.admission,
      transport: session.transport,
      status: byId('lobby-status').textContent,
    } : null,
    error: byId('multiplayer-error')?.hidden ? null : byId('multiplayer-error')?.textContent,
    joinOperation: agentJoinOperation ? { ...agentJoinOperation } : null,
    startOperation: agentStartOperation ? { ...agentStartOperation } : null,
    voiceAvailable: !!session?.supportsVoice,
  };
}

function beginAgentJoin(mode) {
  if (agentJoinOperation?.state === 'pending') throw new Error('a lobby join is already pending');
  const operation = { mode, state: 'pending', startedAt: Date.now() };
  agentJoinOperation = operation;
  joinLobby(mode).then(() => {
    if (agentJoinOperation !== operation) return;
    operation.state = session && lobbyId ? 'complete' : 'failed';
    if (operation.state === 'failed') {
      operation.error = byId('multiplayer-error')?.textContent || 'lobby join did not complete';
    }
    operation.completedAt = Date.now();
  }).catch((error) => {
    if (agentJoinOperation !== operation) return;
    operation.state = 'failed';
    operation.error = String(error?.message || error);
    operation.completedAt = Date.now();
  });
}

function beginAgentStart() {
  if (agentStartOperation?.state === 'pending') throw new Error('a match start is already pending');
  if (!session || !lobbyId || !isLobbyOwner() || currentGroup().length < 2) {
    throw new Error('the lobby owner needs at least two committed members to start');
  }
  if (lobbyConsensus.pending || lobbyConsensus.admission) {
    throw new Error('wait for the current lobby admission to finish');
  }
  const operation = { state: 'pending', startedAt: Date.now() };
  agentStartOperation = operation;
  startMatch().then(() => {
    if (agentStartOperation !== operation) return;
    operation.state = launchStarted ? 'complete' : 'failed';
    if (operation.state === 'failed') {
      operation.error = byId('lobby-status')?.textContent || 'match start did not complete';
    }
    operation.completedAt = Date.now();
  }).catch((error) => {
    if (agentStartOperation !== operation) return;
    operation.state = 'failed';
    operation.error = String(error?.message || error);
    operation.completedAt = Date.now();
  });
}

globalThis.peerd?.agent?.expose({
  observe: launcherObservation,
  act: async ({ action, params = {} } = {}) => {
    if (action === 'open-page') {
      const page = String(params.page || 'menu');
      if (!['menu', 'multiplayer', 'about', 'docs'].includes(page)) throw new Error('unknown launcher page');
      showPage(page);
    } else if (action === 'set-name') {
      const name = String(params.name || '').trim().slice(0, 24);
      if (!name) throw new Error('name is required');
      byId('player-name').value = name;
      rememberName(name);
    } else if (action === 'set-body') {
      byId('player-body').value = params.body === 'female' ? 'female' : 'male';
      playerBody();
    } else if (action === 'solo') {
      void launchGame({ mode: 'solo', session: null, name: playerName(), body: playerBody(), seed: params.seed || undefined });
    } else if (action === 'quick-match') {
      beginAgentJoin('quick');
    } else if (action === 'host-private') {
      beginAgentJoin('host');
    } else if (action === 'join-private') {
      byId('invite-code').value = String(params.code || '');
      beginAgentJoin('join');
    } else if (action === 'start-game') {
      beginAgentStart();
    } else if (action === 'leave-lobby') {
      await leaveLobby();
    } else if (action === 'voice-toggle') {
      await toggleVoice();
    } else {
      throw new Error('unknown launcher action');
    }
    return launcherObservation();
  },
});
