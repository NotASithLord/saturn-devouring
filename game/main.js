import { roomTransmission } from './acoustics.js';
// HALO CHARON — 3D slice (docs/ROADMAP-3D.md): an ODST with a fireteam,
// dropped into the ship while the FULL simulation plays out around them.
// Mechanics layer ported from the first-strike vertical slice (MA5 loop,
// armor-over-health, movement feel). The sim is untouched and authoritative.

import { createShadowBudget } from '../engine/shadow-budget.js';
import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { Sim, fmtTime } from '../sim/sim.js';
import { FACTION, FLAG } from '../shared/agentBuffer.js';
import { combatMeleeImpulse, hurtFloodForm } from '../sim/combat.js';
import { World, elevOf, DOOR_W } from './world.js';
import { Agents3D } from './agents3d.js';
import { Player } from './player.js';
import { HeldWeapon, FlameThrower } from './weapon.js';
import { MA5, FRAG, ODST } from './fps-data.js';
import { meleeArcDistance, strikeAttacker } from './melee.js';
import { GameAudio } from './audio.js';
import { FireFX, SparkFX, BloodFX, FlameJetFX } from '../engine/fx.js';
import { MarineMap } from './map.js';
import { RNG } from '../shared/rng.js';
import {
  buildRifleViewmodel, GUN_TUNE, RIFLE_MUZZLE,
  buildFlamerViewmodel, FLAMER_TUNE,
} from './rifle-model.js';
import { PhysicsWorld, initRapier, PHYS_DT } from '../engine/physics/physics-world.js';
import { PostFX } from '../engine/post.js';
import { LightPool } from '../engine/lights.js';
import { createRenderer, installDeviceLostReload, QualityGovernor, TickScheduler } from '../engine/runtime.js';
import { createGameSync } from '../multiplayer/game-sync.js';
import { StandardGamepad, halo3Actions, singleActionPress } from './gamepad.js';
import { SporeFX } from './spore-fx.js';
import { activeIntroCrawl, beginIntroCrawl, introBody } from './intro-crawl.js';

const canvas = document.getElementById('c');
const gamepad = new StandardGamepad();
let inputMode = document.body.dataset.input === 'gamepad' ? 'gamepad' : 'keyboard';
let refreshInputModeCopy = () => {};
function setInputMode(mode) {
  if (inputMode === mode) return;
  inputMode = mode;
  document.body.dataset.input = mode;
  refreshInputModeCopy();
}
const inputPrompt = (keyboard, controller) => inputMode === 'gamepad' ? controller : keyboard;
window.addEventListener('keydown', () => setInputMode('keyboard'), true);
window.addEventListener('pointerdown', () => setInputMode('keyboard'), true);
// PERF (user: unusable frame rate on an M4 Air): MSAA off — the post chain
// makes canvas MSAA pure waste (FXAA in the grade handles edges) — and the
// pixel ratio caps at 1.25 instead of 2. Retina pr2 was rendering ~4M px
// through the 5-pass HDR pipeline × every light × PCFSoft; at 1.25 + FXAA +
// grain + bloom the difference on a laptop panel is imperceptible and the
// fragment bill drops ~2.6x. `?hd=1` opts back into full resolution;
// `?q=low` / `?q=full` pin the quality ladder (see RUNGS below).
const QP = new URLSearchParams(location.search);
const HD = QP.has('hd');
const QTIER = QP.get('q');
// WEBGPU (user: a discrete GPU behind WebGL can be hostage to the OS's
// per-app GPU routing — WebGPU's adapter request isn't). three's
// WebGPURenderer asks the browser for the high-performance adapter
// directly, so a laptop's discrete card gets used even when the browser
// process sits on the integrated GPU. Falls back to WebGL2 automatically
// (same node/TSL materials compile to GLSL there); ?gl=1 forces the
// fallback for A/B testing.
// Boot through the FTL engine runtime (engine/runtime.js): WebGPU first,
// automatic WebGL2 fallback when WebGPU is missing or fails to init
// (user report: a browser can expose navigator.gpu yet not actually work
// on an older OS — Firefox/macOS). ?gl=1 pins WebGL2 outright.
let renderer;
try {
  renderer = await createRenderer({
    canvas, forceWebGL: QP.has('gl'), pixelRatioCap: HD ? 2 : 1.25,
  });
} catch (err) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:12px;background:#05070a;color:#cfe0ff;'
    + 'font-family:monospace;text-align:center;padding:24px';
  div.innerHTML = '<b style="font-size:20px;letter-spacing:0.2em">RENDERER OFFLINE</b>'
    + `<span style="color:#8ea0b8;max-width:44em">Neither WebGPU nor WebGL2 could start: `
    + `${String(err?.message ?? err)}. Check that hardware acceleration is enabled.</span>`;
  document.body.appendChild(div);
  throw err;
}

// WEBGPU DIAGNOSTICS (live incident: black screen / vanishing draws on real
// WebGPU while the WebGL2 harness path is clean). Validation errors are
// normally swallowed into the console — surface the first few ON SCREEN so a
// playtest screenshot carries the actual GPU error text.
// FAILURES MUST BE VISIBLE. There was no window.onerror and no
// unhandledrejection handler anywhere in this app, so the one hard freeze a
// playtester hit produced a black screen and no evidence whatsoever. Anything
// that escapes now paints itself on screen, so the next report arrives with
// the exception in the screenshot instead of "it froze".
let _fatalShown = 0, _renderFails = 0, _renderStopped = false;
function reportFatal(what, err) {
  console.error('[charon] ' + what, err);
  if (_fatalShown >= 3) return;
  _fatalShown++;
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;left:10px;top:' + (40 + _fatalShown * 92) + 'px;z-index:99;'
    + 'max-width:52em;background:rgba(60,10,10,0.94);color:#ffb0a0;font:11px monospace;'
    + 'padding:6px 8px;border:1px solid #a05040;white-space:pre-wrap;pointer-events:none';
  div.textContent = 'CHARON ' + what.toUpperCase() + ': '
    + String(err?.message ?? err).slice(0, 400)
    + '\n' + String(err?.stack ?? '').split('\n').slice(1, 5).join('\n').slice(0, 600);
  document.body.appendChild(div);
}
window.addEventListener('error', (e) => reportFatal('uncaught error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => {
  // pointer-lock refusals are environmental (sandboxed iframe, focus race) —
  // annoying, never fatal; everything else still gets the red banner
  if (/pointer lock/i.test(String(e.reason?.message ?? e.reason ?? ''))) return;
  reportFatal('unhandled rejection', e.reason);
});
{
  const gpuDev = renderer.backend?.device;
  if (gpuDev?.addEventListener) {
    let shown = 0;
    gpuDev.addEventListener('uncapturederror', (e) => {
      if (shown >= 4) return;
      shown++;
      const div = document.createElement('div');
      div.style.cssText = 'position:fixed;left:10px;top:' + (40 + shown * 64) + 'px;z-index:98;'
        + 'max-width:46em;background:rgba(60,10,10,0.92);color:#ffb0a0;font:11px monospace;'
        + 'padding:6px 8px;border:1px solid #a05040;white-space:pre-wrap;pointer-events:none';
      div.textContent = 'WEBGPU ERROR: ' + String(e.error?.message ?? e.error).slice(0, 500);
      document.body.appendChild(div);
      console.error('[charon webgpu]', e.error);
    });
  }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.Fog(0x05070a, 18, 60);

const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 220);
const post = new PostFX(renderer, scene, camera);
// ONE fixed pool serves every dynamic light source (fires, sparks, room
// fixtures, door spill, NPC muzzles, your muzzle/impacts/grenades) — see
// game/lights.js. Constant light count = bounded fragment cost and ZERO
// shader recompiles (adding/removing real lights recompiled every program).
// 16 slots so the top rungs can afford real weapon lights alongside the room
// fixtures (user: an M2 in Chrome has GPU headroom, spend it on realism). The
// governor shrinks the live count per rung — setActive REMOVES lights from the
// scene, which shortens the light loop compiled into every shader — so the
// lower rungs land at or below the old budget.
const lightPool = new LightPool(scene, 16);
// Real spotlights for the weapon lights. SEVEN of them at the top rungs — a
// fireteam plus stragglers — because a POINT light cannot have a heading, and
// heading is the entire request ("i dont see the direction of the wall hes
// looking at illuminated. I want different illuminated spots coming from
// their heading"). Isolating the two kinds side by side in a blacked-out CIC
// settled it: five spotlights alone gave crisp discs on the exact bulkheads
// the men were facing with everything else at zero, while just TWO of the
// pooled point blobs lit the whole compartment — ceiling, deck, all four
// walls — because a sphere of light radiates into every surface it can see.
// So the spot count went up and the blobs went away as the primary; only the
// overflow past the spot budget still gets one, and only as a small disc.
// They deliberately do NOT cast shadows; only your own torch does.
//
// DECAY 2 IS THE OTHER HALF (user: "i dont think a cone is realistic at
// all... what is it reflecting off of?"). The first pass used decay 1.6 over
// a 28-degree cone, which is a soft even wash: every surface in the room came
// back at roughly the same brightness, so nothing read as a beam LANDING on
// anything. True inverse-square plus a tighter cone means the footprint is
// hot at its centre, falls off hard across the room, and the geometry inside
// it is picked out by N.L instead of flattened.
const TEAM_TORCH_HEX = 0xe2ecff;   // a shade cooler than yours (0xeaf2ff) — same lamp family, tellable apart
const TEAM_TORCH_CD = 560;         // candela; a tighter reflector concentrates the same lumens
const teamTorches = Array.from({ length: 7 }, () => {
  const L = new THREE.SpotLight(TEAM_TORCH_HEX, 0, 24, 0.26, 0.6, 2);
  L.castShadow = false;
  scene.add(L);
  scene.add(L.target);
  return L;
});
let teamSpotN = teamTorches.length;
// same trick as LightPool.setActive: genuinely REMOVE the spare spots from the
// scene on the low rungs, which shortens the light loop compiled into every
// shader rather than just multiplying by a zero uniform
function setTeamSpots(n) {
  n = Math.max(0, Math.min(n, teamTorches.length));
  if (n === teamSpotN) return;
  teamSpotN = n;
  // remove-all-then-re-add, same as LightPool.setActive (perf pass 3): keeps
  // the scene's light ORDER a pure function of n — an append-after-shrink
  // permutation changes the LightsNode cache key and storms every pipeline
  // through a recompile the prewarm never covered
  for (const L of teamTorches) {
    if (L.parent) { L.intensity = 0; scene.remove(L); scene.remove(L.target); }
  }
  for (let i = 0; i < n; i++) { scene.add(teamTorches[i]); scene.add(teamTorches[i].target); }
}

// IMAGE-BASED LIGHTING (the RoomEnvironment recipe, compacted): a tiny
// procedural interior baked through PMREM gives every PBR material real
// specular response — metal rails, rifle bodies and visors pick up soft
// directional sheen instead of rendering flat. environmentIntensity is
// graded with the darkness state so IBL NEVER leaks light into a black room.
{
  const env = new THREE.Scene();
  const em = (color, intensity, w, h, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color }));
    m.material.color.multiplyScalar(intensity);
    m.position.set(x, y, z); m.rotation.y = ry;
    env.add(m);
  };
  env.add(new THREE.Mesh(new THREE.BoxGeometry(20, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0x10141c, side: THREE.BackSide })));
  em(0xbfd8ff, 4, 6, 1, 0, 3.9, 0);            // cool overhead strip
  em(0x8fa8d8, 1.2, 3, 2, -9.9, 1.5, 0, Math.PI / 2);  // pale port glow
  em(0xff5030, 0.8, 2, 1, 9.9, 1.2, 0, -Math.PI / 2);  // faint red starboard
  const pmrem = new THREE.PMREMGenerator(renderer);
  // size 128, not the 256 default: this environment is sampled at 8%
  // intensity as a broad wash (environmentIntensity below), so the extra
  // mip detail is invisible and costs ~4.5 MB of RGBA16F on a machine that
  // shares its 8 GB with the GPU
  scene.environment = pmrem.fromScene(env, 0.04, 0.1, 100, { size: 128 }).texture;
  scene.environmentIntensity = 0.08;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0x9fb2d0, 0x141821, 0.07);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x7d879e, 0.06);
scene.add(ambient);
// THE PLAYER'S ROOM FILL IS A POOL LIGHT (perf pass 5). It used to be a
// permanent scene PointLight, which meant every fragment on every rung paid
// for it whether or not it contributed — the ladder's `lights: N` only ever
// sized LightPool, so rung 4 advertised 6 lights and shaded 10. Declared
// into the pool instead, it competes on the pool's own brightest-and-nearest
// terms and simply does not exist when the room is dark. One analytic light
// off EVERY rung, no rung machinery, and no light-order churn: the light is
// never added to the scene, so it cannot permute LightsNode's cache key.
let _fillX = 0, _fillY = 0, _fillZ = 0, _fillI = 0;
// FLASHLIGHT (user rule): in flood-held darkness this is all you have. In
// spore fog its throw clamps to a few meters instead of the whole room.
// It casts REAL shadows now — a soft-penumbra spot, not a dumb hard cone.
//
// TWO CONES, because that is what a weapon light actually is: a tight hot
// core thrown by the reflector plus a much wider, much dimmer spill from the
// same lens. One medium-wide soft spot reads as a grey smear on the wall —
// there is no bright disc to say "the beam is pointed HERE", and no dark
// surround to say "and nowhere else". The core is narrow enough that the
// shadow map spends all its texels on the part you are looking at, and it is
// the only one of the two that casts.
const torch = new THREE.SpotLight(0xeaf2ff, 0, 30, 0.22, 0.4, 2);
const torchTarget = new THREE.Object3D();
const _torchRifleBase = new THREE.Vector3();
const _torchRifleTip = new THREE.Vector3();
const _torchRifleDirection = new THREE.Vector3();
scene.add(torch, torchTarget);
torch.target = torchTarget;
torch.castShadow = true;
// the spill: keeps you from walking down a black tunnel with a dot in it,
// and puts light on the deck at your feet. No shadow, no cost beyond one more
// light in the loop. Its apex sits ~0.75 m AHEAD of the eye — far enough that
// the whole viewmodel is behind the cone's origin, because at true
// inverse-square a wide cone from the eye puts 100+ lux on a rifle held 0.6 m
// away and the gun renders as a white cutout. The world cannot tell the
// difference between an apex at the eye and one at arm's length.
const torchSpill = new THREE.SpotLight(0xeaf2ff, 0, 14, 0.50, 0.95, 2);
torchSpill.castShadow = false;
torchSpill.target = torchTarget;
scene.add(torchSpill);
// ...which leaves the rifle lit by nothing at all, so it gets its own rig, the
// way every shooter lights a viewmodel. A 1.5 m point light parented to the
// camera physically cannot reach the room (a bulkhead you are pressed against
// takes ~5% of what the gun takes), so the compartment stays honest.
const gunFill = new THREE.PointLight(0xdfeaff, 0, 1.5, 1);
gunFill.position.set(0.06, 0.02, -0.42);
camera.add(gunFill);
const _torchDir = new THREE.Vector3(); // per-frame scratch (was allocating one a frame)
// HALF-RATE SHADOWS: the WebGPU renderer throttles per-light — the loop
// stamps shadow.needsUpdate at 30Hz instead of every frame
torch.shadow.autoUpdate = false;
const fixedShadowSize = renderer.backend.isWebGPUBackend && !HD ? 768 : 1024;
torch.shadow.mapSize.set(fixedShadowSize, fixedShadowSize);
torch.shadow.camera.near = 0.3;
torch.shadow.camera.far = 32;
torch.shadow.bias = -0.002;
torch.shadow.radius = 4; // soft edges on everything the beam throws
// NEVER pitch black (user: torch shadows of lying bodies read as flat black
// "shader glitch" splats — a corpse under the beam at a grazing angle throws
// a long razor umbra with zero fill). Part-lit shadows keep the depth cue
// without the cardboard-cutout artifact.
torch.shadow.intensity = 0.62;
const torchShadows = createShadowBudget(torch);

// Launcher warm-up imports this whole graph from the menu. Code fetch/parse
// and the launch-independent renderer/environment setup above happen early;
// then evaluation parks here before seed-dependent sim, world or asset work.
const LAUNCH = globalThis.__charonLaunch ?? await new Promise((resolve) => {
  window.addEventListener('charon:launch', (event) => resolve(event.detail), { once: true });
});

// --- boot: random ship every run unless a seed is pinned in the URL
// (?seed=... for a reproducible one), starting flood kept light (10–12
// infection forms before co-op scaling, no combat forms/carriers yet) ---
const seedFromUrl = LAUNCH.seed || new URLSearchParams(location.search).get('seed');
const seed = seedFromUrl || 'run-' + Math.random().toString(36).slice(2, 10);

// SAFETY NET (engine/runtime.js): device loss reloads onto the WebGL2
// fallback (WebGPU) or in place with a session cap (WebGL2), rebooting
// into the same seed — same ship.
installDeviceLostReload(renderer, {
  label: 'charon', storageKey: 'charon-gl-lost', params: { seed },
});
// MORE GUNS, MORE FLOOD: every additional fireteam member adds three forms.
// initRun chooses the 10/12 solo base from the seeded crash deck. The member
// list is already consensus-validated, so every client consumes the same RNG
// stream while constructing the ship.
const coopPlayers = LAUNCH.session ? Math.max(1, new Set(LAUNCH.members || []).size) : 1;
const PLAYER_SPAWN_ID = 'cic';
const sim = new Sim(seed, null, { playerCount: coopPlayers, playerSpawnId: PLAYER_SPAWN_ID });
const briefing = activeIntroCrawl() ?? beginIntroCrawl();
briefing.setBody(introBody(sim.graph.node(sim.graph.breachNode).name));
const world = new World(scene, sim.graph, seed);
const sporeFX = new SporeFX(scene, camera, world, sim);
const agents = new Agents3D(scene, sim, world);
// ?nosc=1: disable the shadow-caster curation (A/B lever for the live
// real-WebGPU incident — webgl2 validates clean, webgpu can't run headless)
world.shadowCull = agents.shadowCull = !QP.has('nosc');

// spawn: CIC on the command deck (user tuning) — an ODST detail with a fireteam.
// Created synchronously WITHOUT physics so the intro/UI never blocks on the
// wasm load.
const cic = sim.graph.byId.get(PLAYER_SPAWN_ID);
const networkPlayers = new Map();
const networkSquads = new Map();
const bodyFor = (did) => (LAUNCH.bodies?.[did] ?? LAUNCH.body) === 'female' ? 'female' : 'male';
if (LAUNCH.session) {
  for (const did of [...new Set(LAUNCH.members || [LAUNCH.session.did])].sort()) {
    const agent = sim.attachPlayer(cic, { odst: true, bodyType: bodyFor(did) });
    networkPlayers.set(did, agent);
    networkSquads.set(did, sim.attachPlayerSquad(agent, 3));
  }
}
const player = new Player(canvas, world, sim, cic, null,
  networkPlayers.get(LAUNCH.session?.did), bodyFor(LAUNCH.session?.did));

// Rapier physics: the player's authoritative horizontal collision, built from
// the same wall meshes the world just extruded (world.collisionBoxes()). Loaded
// OFF the boot path — a slow or failed wasm load must never wedge the game on
// the loading screen — and attached to the player when it resolves.
let physics = null;
initRapier().then(() => {
  physics = new PhysicsWorld({ staticBoxes: world.collisionBoxes() });
  // door colliders are DYNAMIC (doors jam/unjam mid-session, and the armory
  // seal releases): one parked/placed fixed box per door, toggled below
  physics.setDoorBoxes(world.doorBoxes());
  player.attachPhysics(physics);
}).catch((e) => console.error('[charon] Rapier physics failed to initialise:', e));
agents.playerId = player.agent.id;
const fireteam = networkSquads.get(LAUNCH.session?.did) ?? sim.attachPlayerSquad(player.agent, 3);
// The ship-strength meter tracks the mobile fighting complement. Deck 1 room
// sentries are a local alarm network, not a meaningful share of shipwide
// strength; players and converted player bodies are excluded for the same
// reason.
const shipMarines0 = sim.agents.filter((a) => a.faction === FACTION.MARINE
  && !a.isPlayer && !a.fromPlayer && !a.deckGuard).length;
const gameSync = createGameSync({
  session: LAUNCH.session,
  scene,
  world,
  sim,
  player,
  agents,
  name: LAUNCH.name || 'ODST',
  members: LAUNCH.members || [],
  host: LAUNCH.host,
  hostOrder: LAUNCH.hostOrder || [],
  playerAgents: networkPlayers,
});
const isSimAuthority = () => !LAUNCH.session || gameSync?.isAuthority();
// mic state, mirrored from the voice stack for the comms roster
let voiceMuted = false, voiceActive = false, voiceBlocked = false;
const gameVoice = document.getElementById('gameVoice');
if (LAUNCH.session) {
  const networkHud = document.getElementById('networkHud');
  const networkState = document.getElementById('networkState');
  networkHud.hidden = false;
  const updateNetwork = () => {
    const online = new Set(LAUNCH.session.roster().map((peer) => peer.did));
    const peers = (LAUNCH.members || [...online]).filter((did) => online.has(did)).length;
    networkState.textContent = `P2P · ${peers} ONLINE · ${LAUNCH.session.transport === 'peerd' ? 'PEERD' : 'WEBRTC'}`;
  };
  const updateVoice = (status) => {
    gameVoice.textContent = !status?.active ? 'ENABLE MIC'
      : status.playbackBlocked ? 'ENABLE AUDIO' : status.muted ? 'MIC MUTED' : 'MIC LIVE';
    voiceActive = !!status?.active;
    voiceMuted = !!status?.muted;
    // "HE CAN'T HEAR ME BUT I CAN HEAR HIM" is almost always this: Chrome
    // blocked the remote audio element from playing until the tab gets a
    // gesture, so one end goes deaf while its own mic keeps transmitting
    // fine. It was only ever surfaced as small text on the mic button.
    voiceBlocked = !!status?.playbackBlocked;
    const warn = document.getElementById('commsWarn'); // direct: the el helper is declared later
    if (warn) {
      warn.className = voiceBlocked ? 'on' : '';
      warn.textContent = voiceBlocked ? '🔇 AUDIO BLOCKED — CLICK TO HEAR YOUR TEAM' : '';
    }
    // only meter our own mic once the player has actually turned voice on
    if (!voiceActive) player.talking = false;
  };
  LAUNCH.session.on('roster', updateNetwork);
  LAUNCH.session.on('voice', updateVoice);
  updateNetwork();
  LAUNCH.session.voiceStatus().then(updateVoice).catch(() => updateVoice(null));
  // ...and heal it without the player having to understand any of that: the
  // next click or keypress anywhere resumes playback.
  let _resumeAt = 0;
  const tryResumeVoice = (event) => {
    // NOT for clicks on the mic button itself: this is a CAPTURE-phase
    // listener, so it would clear playbackBlocked before the button's own
    // handler reads the status — which then falls through to the "already
    // active" branch and MUTES you. Clicking ENABLE AUDIO would mute your mic.
    if (!voiceBlocked || (event && event.target === gameVoice)) return;
    if (performance.now() - _resumeAt < 800) return; // one attempt per gesture burst
    _resumeAt = performance.now();
    LAUNCH.session.resumeVoicePlayback().then(updateVoice).catch(() => {});
  };
  window.addEventListener('pointerdown', tryResumeVoice, true);
  window.addEventListener('keydown', tryResumeVoice, true);
  document.getElementById('commsWarn')?.addEventListener('click', tryResumeVoice);
  gameVoice.addEventListener('click', async () => {
    gameVoice.disabled = true;
    try {
      const status = await LAUNCH.session.voiceStatus().catch(() => ({ active: false, muted: false }));
      const next = status.playbackBlocked
        ? await LAUNCH.session.resumeVoicePlayback()
        : status.active ? await LAUNCH.session.setVoiceMuted(!status.muted)
        : await LAUNCH.session.startVoice({ startMuted: false });
      updateVoice(next);
    } catch (error) {
      updateVoice(null);
      gameVoice.title = error?.message || 'Microphone unavailable';
    } finally {
      gameVoice.disabled = false;
    }
  });
}
// MARINE TACNET (user request): the sim view's plan, filtered to what the
// marine teams actually see. Intel accumulates whether the map is open or not.
const marineMap = new MarineMap(
  document.getElementById('mapcanvas'), document.getElementById('mapside'),
  sim, fireteam.id, player.agent.id);
const mapDeckButtons = [...document.querySelectorAll('#mapdecks [data-deck]')];
function selectMapDeck(deck) {
  marineMap.selectDeck(deck);
  for (const button of mapDeckButtons) button.classList.toggle('active', Number(button.dataset.deck) === deck);
}
for (const button of mapDeckButtons) {
  button.addEventListener('click', () => selectMapDeck(Number(button.dataset.deck)));
}
let mapOpen = false;
function toggleMap(open = !mapOpen) {
  mapOpen = open;
  if (mapOpen) {
    marineMap.followPlayer();
    selectMapDeck(marineMap.selectedDeck());
  }
  document.getElementById('mapview').classList.toggle('mv-hidden', !mapOpen);
}
const audio = new GameAudio();
audio.transmission = (at, listener) => {
  const listenerDeck = listener.deck ?? player.deck;
  const sourceDeck = at.deck ?? listenerDeck;
  const [lx, ly] = world.worldToSim(listener.x, listener.z, listenerDeck);
  const [sx, sy] = world.worldToSim(at.x, at.z, sourceDeck);
  const from = world.roomAt(listenerDeck, lx, ly);
  const to = at.node ?? world.roomAt(sourceDeck, sx, sy);
  const transmission = roomTransmission(sim.graph, from, to);
  if (sourceDeck !== listenerDeck && transmission.cutoff > 350
    && !sim.losClear(lx, ly, from, sx, sy, to)) return { gain: 0.16, cutoff: 350 };
  return transmission;
};
canvas.addEventListener('click', () => audio.ensure());
const audioGate = document.getElementById('audioGate');
const ensureTrustedAudio = () => audio.ensure();
window.addEventListener('keydown', ensureTrustedAudio, true);
window.addEventListener('pointerdown', ensureTrustedAudio, true);
audioGate.addEventListener('click', ensureTrustedAudio);
function syncAudioGate() {
  audioGate.hidden = !(inputMode === 'gamepad' && introGone
    && (!audio.ctx || audio.ctx.state !== 'running'));
}

// SOUND BOARD (user: "the sounds are so goofy, create a menu item where i can
// play each sound one at a time and i can tell you which im talking about").
// K opens it. It enumerates audio.buffers at runtime rather than a hand-kept
// list, so it can never drift out of date as the bank changes — every voice
// the game can make is in here, named exactly as game/audio.js names it, and
// played non-positionally at full gain with the rate limiter bypassed.
let soundBoard = null;
function toggleSoundBoard() {
  if (soundBoard) { soundBoard.remove(); soundBoard = null; return; }
  audio.ensure();
  document.exitPointerLock?.();
  const names = Object.keys(audio.buffers).sort();
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;'
    + 'width:min(560px,92vw);max-height:82vh;overflow:auto;background:rgba(6,10,16,0.96);'
    + 'border:1px solid #2a3a4e;padding:14px 16px;font:12px/1.6 ui-monospace,Menlo,monospace;'
    + 'color:#bfd4f2;box-shadow:0 8px 40px rgba(0,0,0,0.7)';
  const head = document.createElement('div');
  head.style.cssText = 'color:#7fe3ff;letter-spacing:0.14em;margin-bottom:10px';
  head.textContent = `SOUND BOARD — ${names.length} VOICES · K TO CLOSE`;
  d.appendChild(head);
  for (const n of names) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:3px 0;border-bottom:1px solid #16202c';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;color:#dce6ff';
    label.textContent = n;
    const btn = document.createElement('button');
    btn.textContent = 'play';
    btn.style.cssText = 'background:#16283a;color:#9fd8ff;border:1px solid #2f4a63;'
      + 'padding:2px 14px;font:11px ui-monospace,monospace;cursor:pointer';
    btn.onclick = () => audio.play(n, null, 1);
    row.append(label, btn);
    d.appendChild(row);
  }
  soundBoard = d;
  document.body.appendChild(d);
}

// AUDIO LOG (user: "so i can see what's playing visually by name"). The board
// above answers "what does X sound like"; this answers the harder one — "what
// WAS that?" — by naming every cue as it fires. It is a HUD, not a dialog: it
// does not take pointer lock, so you can watch it while you play.
//   J opens it. Rows are newest-first. A cue repeating inside 1.2 s collapses
// to a xN counter instead of scrolling the interesting things off the top,
// which matters because a firefight repeats `shot`.
// A debug panel you cannot find is indistinguishable from a key that did not
// register, and the two have very different fixes. This says which happened.
function debugToast(msg) {
  const t = document.createElement('div');
  t.className = 'hud';
  t.style.cssText = 'left:50%;top:64px;transform:translateX(-50%);z-index:9;'
    + 'font:12px ui-monospace,Menlo,monospace;color:#7fe3ff;letter-spacing:0.1em;'
    + 'background:rgba(6,10,16,0.9);border:1px solid #2a3a4e;padding:5px 12px';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

let audioLog = null;
function toggleAudioLog() {
  if (audioLog) { audioLog.stop(); audioLog = null; debugToast('AUDIO LOG OFF'); return; }
  debugToast('AUDIO LOG ON — top left');
  audio.ensure();
  const d = document.createElement('div');
  d.className = 'hud';
  // LEFT COLUMN. The right edge is #equipmentHud (ammo/room/FPS) from
  // top:12px down; a panel there lands on top of the numbers you play by.
  // Left is empty between #topbar and the tracker in the bottom corner.
  d.style.cssText = 'left:14px;top:250px;width:210px;z-index:8;'
    + 'font:11px/1.5 ui-monospace,Menlo,monospace;color:#bfd4f2;'
    + 'background:rgba(6,10,16,0.82);border:1px solid #2a3a4e;padding:8px 10px';
  const rows = document.createElement('div');
  const head = document.createElement('div');
  head.style.cssText = 'color:#7fe3ff;letter-spacing:0.12em;margin-bottom:6px';
  head.textContent = 'AUDIO LOG · J';
  d.append(head, rows);
  document.body.appendChild(d);

  const render = () => {
    const now = performance.now();
    // collapse consecutive repeats walking newest -> oldest
    const out = [];
    for (let i = audio.cues.length - 1; i >= 0 && out.length < 12; i--) {
      const c = audio.cues[i];
      const last = out[out.length - 1];
      if (last && last.name === c.name && last.far === c.far && last.t - c.t < 1200) {
        last.n++;
        last.t = c.t;
        continue;
      }
      out.push({ name: c.name, far: c.far, t: c.t, d: c.d, positional: c.positional, n: 1 });
    }
    rows.textContent = '';
    if (!out.length) {
      const empty = document.createElement('div');
      empty.style.color = '#4a5a6e';
      empty.textContent = 'silence';
      rows.appendChild(empty);
      return;
    }
    for (const c of out) {
      const age = (now - c.t) / 1000;
      const row = document.createElement('div');
      // the newest cue is the one you are asking about, so it stays bright and
      // the rest dim out over ~8 s — the panel reads as a decaying tail
      row.style.cssText = `display:flex;gap:6px;opacity:${Math.max(0.28, 1 - age / 8).toFixed(2)}`;
      const name = document.createElement('span');
      name.style.cssText = 'flex:1;color:' + (c.far ? '#8fa8c4' : '#dce6ff');
      name.textContent = c.far ? `${c.name} (far)` : c.name;
      const meta = document.createElement('span');
      meta.style.color = '#5f7c8f';
      meta.textContent = (c.n > 1 ? `x${c.n} ` : '') + (c.positional ? `${c.d.toFixed(0)}m` : 'ear');
      row.append(name, meta);
      rows.appendChild(row);
    }
  };

  render();
  audio.onCue = render;
  const tick = setInterval(render, 400); // ages the opacity out while nothing fires
  audioLog = {
    stop() { clearInterval(tick); if (audio.onCue === render) audio.onCue = null; d.remove(); },
  };
}

// FLOOD READOUT (user: "a flood strength/number indicator for debugging"). H
// opens it. Everything here is read straight off sim.hive.stats — the numbers
// the hive scored its own decisions with — so if the panel says AGGRESSIVE, it
// is aggressive; there is no second opinion to drift.
//   mass = infection + combat*2 + carriers*2, the same figure that arms ALL-IN
// at >= 50 and >= 3x the believed survivors. scarcity gates the posture flip.
let floodHud = null;
function toggleFloodHud() {
  if (floodHud) { floodHud.stop(); floodHud = null; debugToast('FLOOD READOUT OFF'); return; }
  debugToast('FLOOD READOUT ON — top left');
  const d = document.createElement('div');
  d.className = 'hud';
  d.style.cssText = 'left:14px;top:44px;width:210px;z-index:8;'
    + 'font:11px/1.5 ui-monospace,Menlo,monospace;color:#bfd4f2;'
    + 'background:rgba(6,10,16,0.82);border:1px solid #3a2a2e;padding:8px 10px';
  document.body.appendChild(d);

  const render = () => {
    const s = sim.hive?.stats;
    if (!s) { d.textContent = 'FLOOD · H — hive has not ticked yet'; return; }
    const row = (k, v, hot) =>
      `<div style="display:flex;gap:6px"><span style="flex:1;color:#8fa8c4">${k}</span>`
      + `<span style="color:${hot ? '#ff8a6a' : '#dce6ff'}">${v}</span></div>`;
    d.innerHTML = `<div style="color:#ff8a6a;letter-spacing:0.12em;margin-bottom:6px">FLOOD · H</div>`
      + row('mass', s.mass, s.mass >= 50)
      + row('infection', s.I)
      + row('combat', s.C)
      + row('carriers', s.K)
      + row('bodies free', s.bodies)
      + row('scarcity', s.S.toFixed(2), s.S > 1.05)
      + row('believed alive', s.believedAlive)
      + row('marines left (its count)', s.marinesLeft ?? '—')
      + row('posture', s.posture, s.posture === 'AGGRESSIVE')
      + row('phase', s.opening ? 'opening' : 'steady')
      + (s.allIn ? '<div style="margin-top:4px;color:#ff8a6a">ALL-IN — every form converging</div>' : '');
  };

  render();
  // the hive thinks on a 2.5 s tick; polling twice that fast is enough to look
  // live without pretending to a resolution the sim does not have
  const tick = setInterval(render, 1200);
  floodHud = { stop() { clearInterval(tick); d.remove(); } };
}

// ?debug=1 opens both panels at load. The keys are the ergonomic way in, but
// they are also one more thing that can be wrong when a panel does not appear
// — this way the URL alone is the whole instruction, with no keypress, no
// focus and no intro gate in between. The hub routes on the hash, so the flag
// is read from either half of the URL.
if (QP.has('debug') || location.hash.includes('debug')) {
  toggleFloodHud();
  toggleAudioLog();
}

// FIRE (user rule): fires are SIM objects now — the breach blaze plus the
// ship's broken (jammed) doors, all seeded in the sim itself so the flames
// that hurt you are exactly the flames you see. The sim's flamethrower
// burns still light up live below.
const fire = new FireFX(scene, lightPool);
const blood = new BloodFX(scene);
for (let i = 0; i < sim.fires.length; i++) {
  const f = sim.fires[i];
  const [fx2, fz2] = world.simToWorld(f.x, f.y, f.deck);
  fire.add(`sim${i}`, fx2, fz2, elevOf(f.deck), f.scale);
}
// DAMAGE THROUGH THE SHIP (user: small high-fidelity fires + glow where it's
// dark, sparking junctions): render-only sites seeded per run — the portal
// event rattled the whole hull, so every deck carries a few small smolders
// and shorted panels. Never on the player's spawn room.
const sparks = new SparkFX(scene, lightPool);
// the flamethrower's stream: declared per frame from agents3d's FLAG.FLAMING
// carriers, exactly as the weapon lights are (see updateFlameJets)
const jets = new FlameJetFX(scene, lightPool);
fire.camera = camera;   // embers/sparks are instanced quads that billboard
sparks.camera = camera; // to the camera each update
jets.camera = camera;
{
  const dmgRng = new RNG(seed + ':damage');
  const byDeck = new Map();
  for (const n of sim.graph.nodes) {
    if (n.idx === sim.graph.breachNode || n.idx === player.agent.node) continue;
    if (!['corridor'].includes(n.type) && !n.roles.some((r) => ['maintenance', 'cargo', 'engineering', 'power', 'hangar'].includes(r))) continue;
    (byDeck.get(n.deck) ?? byDeck.set(n.deck, []).get(n.deck)).push(n);
  }
  for (const [deck, rooms] of byDeck) {
    for (let i = 0; i < 2 && rooms.length; i++) {
      const n = rooms[Math.floor(dmgRng.next() * rooms.length)];
      const [wx, wz] = world.simToWorld(
        n.x + dmgRng.range(-(n.w / 2 - 1.4), n.w / 2 - 1.4),
        n.y + (dmgRng.chance(0.5) ? -(n.d / 2 - 0.9) : n.d / 2 - 0.9), deck);
      if (dmgRng.chance(0.5)) fire.add(`dmg${deck}:${i}`, wx, wz, elevOf(deck), 0.45);
      else sparks.add(wx, elevOf(deck) + 1.7, wz);
    }
  }
}

// DUST IN THE AIR (fidelity pass): a drift of fine particulate rides along
// with the player — visible where light crosses it, invisible in the black.
// Motes wrap around a 9m cube centered on you so the cloud never runs out.
const motes = (() => {
  const N = 36, HALF = 4.5; // cut hard from 140 (user: fewer, smaller — gladly)
  // instanced billboard quads — the node renderer draws point primitives at
  // a fixed 1px, so the old THREE.Points motes silently vanished
  const p = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    p[i * 3] = (Math.random() - 0.5) * HALF * 2;
    p[i * 3 + 1] = Math.random() * 2.6 + 0.2;
    p[i * 3 + 2] = (Math.random() - 0.5) * HALF * 2;
    seeds[i] = Math.random() * 10;
  }
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(8, 8, 0.5, 8, 8, 7.5);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 16, 16);
  const tex = new THREE.CanvasTexture(c);
  const pts = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x9daabb, transparent: true, opacity: 0.1,
      map: tex, alphaMap: tex, depthWrite: false, fog: false,
    }), N);
  pts.frustumCulled = false;
  scene.add(pts);
  return {
    pts, p, seeds, HALF, t: 0, count: N,
    setCount(n) { this.count = Math.min(N, n); this.pts.count = this.count; },
  };
})();
const _moteM4 = new THREE.Matrix4();
const _moteV = new THREE.Vector3();
const _moteS = new THREE.Vector3(0.014, 0.014, 0.014);
function updateMotes(dt) {
  motes.t += dt;
  const H = motes.HALF;
  const p = motes.p;
  const q = camera.quaternion;
  for (let i = 0; i < motes.count; i++) {
    const s = motes.seeds[i];
    let x = p[i * 3] + Math.sin(motes.t * 0.3 + s) * 0.0012 + 0.0007;
    let y = p[i * 3 + 1] + Math.sin(motes.t * 0.22 + s * 2.1) * 0.0009 - 0.0004;
    let z = p[i * 3 + 2] + Math.cos(motes.t * 0.26 + s) * 0.0012;
    if (x > H) x -= H * 2; if (x < -H) x += H * 2;
    if (z > H) z -= H * 2; if (z < -H) z += H * 2;
    if (y < 0.1) y = 2.8; if (y > 2.9) y = 0.2;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    _moteM4.compose(_moteV.set(x, y, z), q, _moteS);
    motes.pts.setMatrixAt(i, _moteM4);
  }
  motes.pts.instanceMatrix.needsUpdate = true;
  motes.pts.position.set(player.x, elevOf(player.deck), player.z);
}

// shadow plumbing: the world is built — floors/ceilings receive, cover and
// bodies cast. Additive/transparent FX never cast.
scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  if (o.material?.transparent || o.material?.blending === THREE.AdditiveBlending) return;
  o.receiveShadow = true;
});
for (const m of world.wallMeshes) { m.castShadow = true; }
for (const set of [agents.civSet, agents.armedSet, agents.marineSet,
  agents.infectionSet, agents.combatCivSet, agents.combatOdstSet]) {
  for (const mesh of set) mesh.castShadow = true;
}
agents.carrier.castShadow = true;
agents.rifle.castShadow = true;

// QUALITY LADDER (user: framerate on an M2 Air — accessibility is the
// target). The old binary full/low tier is now a governed DEGRADATION
// LADDER: each rung sheds one cost, ordered cheapest-look-loss first, and
// the governor walks it per machine — resolution first inside a rung, then
// down a rung when pinned at the floor and still slow, back up after a
// long stable stretch. Every machine finds its own level; no guessing.
//   0  full: PCFSoft 1024 shadows @30Hz (768 on WebGPU laptops), 10 lights, bloom 0.5, 36 motes
//   1  tighter res window, shadow map 768
//   2  shadow map 512, 8 lights, bloom 0.375        (one recompile)
//   3  shadows OFF                                  (one recompile)
//   4  6 lights, bloom 0.25, 12 motes, floor 0.55   (one recompile; = old low)
// The recompile rungs are PREWARMED behind the intro (compileAsync), so
// stepping down mid-fight costs a uniform change, not a shader storm.
// ?q=full pins rung 0, ?q=low pins rung 4; ?hd=1 pins 0 with a 2.0 cap.
let _shadowAt = 0; // torch shadow refresh clock (wall time, not frame parity)
// NOTE: the shadow MAP SIZE is deliberately NOT per-rung — resizing the map
// orphans the old target and Dawn crashed on exactly that ("Destroyed
// texture [ShadowDepthTexture] used in a submit"). It is fixed for the
// session at boot (fixedShadowSize below); rungs only stop the caster.
const RUNGS = [
  { res: [0.85, 1.25], shadows: true, lights: 14, bloom: 0.5, litePost: false, motes: 36, spores: [56, 20], rag: 48, rifleLights: 6, teamSpots: 3 },
  { res: [0.7, 1.1], shadows: true, lights: 14, bloom: 0.5, litePost: false, motes: 36, spores: [48, 18], rag: 48, rifleLights: 6, teamSpots: 3 },
  { res: [0.7, 1.0], shadows: true, lights: 10, bloom: 0.375, litePost: false, motes: 24, spores: [40, 14], rag: 32, rifleLights: 4, teamSpots: 2 },
  { res: [0.6, 1.0], shadows: false, lights: 8, bloom: 0.375, litePost: true, motes: 24, spores: [28, 10], rag: 24, rifleLights: 3, teamSpots: 1 },
  { res: [0.55, 0.9], shadows: false, lights: 6, bloom: 0.25, litePost: true, motes: 12, spores: [18, 6], rag: 16, rifleLights: 2, teamSpots: 0 },
];
// whole-frame pixel budget: huge windows can't buy retina supersampling on
// an integrated GPU — the cap yields before the budget does (HD opts out)
const PIXEL_BUDGET = 3.0e6;
let rung = 0;
// the governor (engine/runtime.js) walks the ladder; the per-rung EFFECTS
// stay here — they touch this game's torch, light pool, bloom and motes
const governor = new QualityGovernor({
  renderer, rungs: RUNGS, pixelBudget: PIXEL_BUDGET, hd: HD, label: 'charon',
  apply: (R, i) => {
    rung = i;
    // Keep castShadow and map size fixed: cached WebGPU pipelines retain
    // shadow nodes. Low quality removes shadow influence and update work
    // without disposing a target that another cached pipeline still uses.
    torchShadows.setEnabled(R.shadows);
    if (R.shadows) _shadowAt = performance.now();
    lightPool.setActive(R.lights);
    setTeamSpots(R.teamSpots ?? 3);
    post.setBloomScale(R.bloom);
    post.setLite(R.litePost);
    motes.setCount(R.motes);
    sporeFX.setBudget(...R.spores);
    // CPU lever (swarm finding: the ladder shed only GPU cost): fewer live
    // ragdoll solvers on the low rungs — the cap gates new flops, extras
    // evict oldest-asleep exactly as at the full cap
    if (agents.ragdolls) agents.ragdolls.p.maxActive = R.rag ?? 48;
  },
  onResize: (w, h) => post.setSize(w, h),
});
const applyRung = (i) => governor.applyRung(i);
window.__quality = (i) => { governor.pinned = false; applyRung(Math.max(0, Math.min(RUNGS.length - 1, i))); };
if (QTIER === 'low') { applyRung(RUNGS.length - 1); governor.pinned = true; }
else if (QTIER === 'full' || HD) { applyRung(0); governor.pinned = true; }
else {
  try {
    // WebGPU exposes GPUAdapterInfo; the WebGL2 fallback still has the
    // debug-renderer string. Known-weak silicon starts near the bottom
    // (still free to climb if it proves fast).
    let gpu = '';
    if (renderer.backend.isWebGPUBackend) {
      // GPUDevice.adapterInfo — the backend stores the device, not the adapter
      const a = renderer.backend.device?.adapterInfo;
      gpu = [a?.vendor, a?.architecture, a?.device, a?.description].filter(Boolean).join(' ');
    } else {
      const gl = renderer.backend.gl;
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    }
    const weak = /Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Intel\(R\)? (U?HD|Iris|GMA)|\bgen-9|software/i.test(gpu)
      || (navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4);
    if (weak) applyRung(3);
  } catch { /* boot heuristic only — the governor still catches slow machines */ }
}

// PREWARM (perf): compile the recompile-heavy rung variants behind the
// intro screen (engine governor). forceWarm flips the late-appearing
// pipelines on — count-0 instanced sets, hidden flood veils — so the FIRST
// muzzle flash / veil / decal of a run doesn't compile mid-fight; the
// governor guarantees the restore runs even if a compile fails.
// THE CAMERA SUBTREE MUST BE IN THE SCENE BEFORE PREWARM (perf pass 5
// audit). scene.add(camera) used to run ~290 lines below this call, and
// prewarm's first rung compiles synchronously — so rung 2 was compiled
// against a scene with no camera child: the viewmodel and flamer meshes were
// never warmed at all, and their pipelines compiled mid-game on first sight,
// which is exactly the shader storm prewarm exists to prevent.
scene.add(camera);
governor.prewarm(scene, camera, {
  forceWarm: (s) => {
    const warmed = [];
    s.traverse((o) => {
      if (o.isInstancedMesh && o.count === 0) { warmed.push([o, 'count', 0]); o.count = 1; }
    });
    for (const v of world.darkVeils) {
      if (v && !v.visible) { warmed.push([v, 'visible', false]); v.visible = true; }
    }
    // materials that exist ONLY in runtime-spawned meshes (perf pass 3 —
    // they compiled synchronously mid-fight, always at the worst moment):
    // the thrown frag's plain standard material, and the flamethrower jet
    // rig (heavy fbm TSL graph) that _rig() builds lazily on first burst
    const warmFrag = new THREE.Mesh(fragGeo, fragMat);
    warmFrag.position.set(0, -50, 0);
    scene.add(warmFrag);
    jets.frame();
    jets.emit(0, -50, 0, 0, 1, 0, 0.5, 0);
    jets.update(0.016, 0, 0, 0);
    // agent sets cast shadows in play (curated by distance): flip every
    // caster on so compileRung's warm render also builds the shadow-depth
    // pipeline variants the first close-quarters fight would otherwise
    // compile mid-frame
    const prevCull = agents.shadowCull;
    agents.shadowCull = world.shadowCull = false;
    return () => {
      for (const [o, k, val] of warmed) o[k] = val;
      scene.remove(warmFrag);
      jets.frame();
      jets.update(0.016, 0, 0, 0); // hides the warmed rig
      agents.shadowCull = world.shadowCull = prevCull;
    };
  },
  // compile against the targets the game ACTUALLY renders into (see the
  // engine note: pipelines are target-format specific): the scene against
  // the PassNode HDR target asynchronously, then one real post render to
  // build the fullscreen chain, bloom mips, bind groups and — with the
  // casters forced on above — the shadow-depth pipelines, all behind the
  // intro instead of mid-fight
  compileRung: (R, _i, signal) => post.prewarm({
    lite: R.litePost,
    signal,
    beforeRender: () => {
      if (torchShadows.requestUpdate()) _shadowAt = performance.now();
    },
  }),
});
// LITE-FREE IS DISARMED (playtest: first-ever black screen / freeze on an M4
// at rung 2, right after perf pass 5 shipped). It is the only thing in that
// pass that mutates GPU render-target state behind three's back, and it is
// worth ~10-14 MB of VRAM and ZERO frame time — nowhere near enough to
// justify being a suspect in a black screen. Re-arm only with a repro.
// post.allowLiteFree();

// REAL FLICKER SPILL (user: flickering lighting for real in each room): the
// ceiling strips' flicker used to be emissive-only — visible on the fixture,
// invisible on the room. A small pool of pooled point lights now rides the
// nearest unsteady fixtures on your deck, so a guttering room actually
// throws guttering light on its walls, floor and occupants.
function updateRoomLightPool(inDark, pnode, pDeck, pX, pZ) {
  // every powered fixture and every dead-room red lamp declares a VIRTUAL
  // light — the global pool picks the winners near the POV (dead ship,
  // discrete sources instead of an ambient wash; the POV is the ghost's room
  // when the flood has taken you)
  for (let n = 0; n < sim.graph.n; n++) {
    const L = world.roomLights[n];
    if (!L || L.x === undefined) continue;
    if (sim.darkAt(n)) continue; // flood-held rooms are DARK — nothing burns there
    const nd = sim.graph.node(n);
    if (nd.deck !== pDeck) continue;
    const d2 = (L.x - pX) * (L.x - pX) + (L.z - pZ) * (L.z - pZ);
    if (d2 > 40 * 40) continue;
    // NEIGHBOURS DON'T SHINE THROUGH THE BULKHEAD. A pooled point light has
    // no occluder — a strip two compartments away with a 19 m reach lit our
    // walls from BEHIND, and that unowned leak was what kept a blacked-out
    // room sitting at a flat blue lift instead of at zero. It is invisible
    // when you are in a lit room, and it is the entire problem when you are
    // not. Shortening the reach of everything outside your own compartment
    // kills the leak but still lets a lit room read as lit when you look into
    // it through a hatch; the doorway transfer itself is updateDoorSpill's
    // job, and that one is placed with knowledge of the wall.
    const leak = inDark && n !== pnode ? 0.47 : 1;
    if (L.mode === 'dead' && L.emergency) {
      // red battery lamp over the hatch — dim, warm, with a slow breathe
      lightPool.add(L.em.x, L.em.y, L.em.z, 0xff4030,
        2.6 + Math.sin(performance.now() * 0.0011 + L.phase) * 0.5, 11 * leak, 1.9);
    } else {
      // Hung WELL below each visible strip: the throw pools on the deck and
      // walls while the ceiling above stays near-black. The renderer owns the
      // fixture layout, so a source can never exist without matching hardware.
      // The fallback keeps a hot local reload safe if the browser briefly
      // pairs this module with a cached pre-layout World instance.
      for (const fixture of L.fixtures ?? [L]) {
        // A ceiling strip is an AREA source. Approximating it with a compact
        // inverse-square point made anyone directly beneath it clip white,
        // while the rest of the room stayed dark. The softer curve and lower
        // candela keep the same level at 4 m, halve the near-field hotspot,
        // and spread the fixture more evenly across the compartment.
        lightPool.add(fixture.x, fixture.y - 1.25, fixture.z,
          0xbfd4f2, L.mode === 'steady' ? 6 : 6.4 * L.lvl, 19 * leak, 1.3);
      }
    }
  }
  // WEAPON LIGHTS (user: a light on their rifle that does real work, so you
  // naturally see more in a dark room with your fireteam than without —
  // from the pure physics). agents3d declares one per armed body standing in
  // a blacked-out room; they compete in the same pool as everything else, and
  // in a dark room the fixtures are off, so there is little to compete with.
  // Nearest-first, budgeted per rung.
  // TEAM TORCHES (user: "in pitch darkness all you see is your lights but also
  // your teams lights illuminating things in the same room"). The nearest few
  // get a REAL SPOTLIGHT aimed down the barrel, so you see the beam's footprint
  // sweep the deck and bulkheads the way your own torch does — a point light at
  // the wall is just a round blob. Everyone beyond those slots still declares a
  // cheap pooled point light at the spot their beam lands, so a crowded dark
  // room is many separate pools rather than an ambient lift.
  const lit = [];
  for (let i = 0; i < agents.rifleLightN; i++) lit.push(agents.rifleLights[i]);
  lit.sort((a, b) => a.d2 - b.d2);
  const spots = Math.min(teamSpotN, lit.length);
  for (let i = 0; i < teamSpotN; i++) {
    const T = teamTorches[i], r = i < spots ? lit[i] : null;
    if (!r) { T.intensity = 0; continue; }
    T.position.set(r.ox, r.oy, r.oz);
    // NOSE-DOWN. agents3d solves the aim purely in plan view, so every beam
    // came out dead level at 1.05 m and a room full of marines read as a line
    // of dots ruled around the bulkhead at exactly chest height. Men clearing
    // a compartment hold the light down: a 3-degree depression puts the pool
    // low on the far wall, and on a long throw it lands on the DECK short of
    // the wall instead — which is where you actually look for a body.
    // agents3d now emits the barrel's REAL elevation, so the old flat ~3%
    // depression here would double-count to ~6 degrees and drop every pool
    // short of what the man is actually pointing at
    T.target.position.set(r.tx, r.ty, r.tz);
    T.target.updateMatrixWorld();
    // three windows the inverse-square falloff to zero at `distance` with a
    // pow4 ramp, so a cutoff set just past the wall eats about half the
    // landing brightness. Put the cutoff well beyond the throw and let the
    // decay do the work — the beam then dies with range instead of with an
    // arbitrary radius.
    T.distance = r.throw * 1.6 + 8;
    T.intensity = TEAM_TORCH_CD;
  }
  // OVERFLOW ONLY, and kept on a very short leash. A point light AT the wall
  // grazes it and dumps most of its output backwards into the room, which is
  // why the old blobs washed everything; backing it 1.3 m off the surface
  // along the man's own beam makes it face the wall and read as a disc, and a
  // 5 m reach means it physically cannot reach the compartment behind it.
  const rlCap = RUNGS[rung].rifleLights ?? 4;
  for (let i = spots; i < Math.min(lit.length, spots + rlCap); i++) {
    const r = lit[i];
    const bx = r.tx - r.ox, bz = r.tz - r.oz;
    const bl = Math.hypot(bx, bz) || 1;
    lightPool.add(r.tx - bx / bl * 1.3, r.ty, r.tz - bz / bl * 1.3,
      TEAM_TORCH_HEX, 26, 5, 2);
  }
}

// LIGHT TRANSFERS BETWEEN ROOMS (user rule): a lit room next to a dark one
// doesn't end at a flat black doorway — its fixtures push a pool of light a
// little way into the dark side. A small pool of spill lights sits just
// inside the dark room at each lit->dark doorway near the player.
function updateDoorSpill(pDeck, pX, pZ) {
  for (const d of world.doors) {
    if (d.deck !== pDeck) continue;
    const dx = d.x - pX, dz = d.z - pZ;
    if (dx * dx + dz * dz > 30 * 30) continue;
    if (d.open01 < 0.05) continue; // a shut door spills nothing
    const a = d.edge.a, b = d.edge.b;
    const litA = world.lightLevel(a) > 0.1 && !sim.darkAt(a);
    const litB = world.lightLevel(b) > 0.1 && !sim.darkAt(b);
    if (litA === litB) continue; // both lit or both dark — no gradient
    const darkN = litA ? b : a;
    if (sim.darkAt(darkN)) continue; // the growth eats the spill
    const nd = sim.graph.node(darkN);
    const [cx2, cz2] = world.simToWorld(nd.x, nd.y, nd.deck);
    const ox = cx2 - d.x, oz = cz2 - d.z, ol = Math.hypot(ox, oz) || 1;
    lightPool.add(d.x + (ox / ol) * 1.4, elevOf(d.deck) + 1.7, d.z + (oz / ol) * 1.4,
      0xaec6e8, 2.2 * d.open01, 7, 2.0); // swells as the door slides up
  }
}

// GUNFIRE IS A LIGHT SOURCE (user rule): NPC muzzle flashes declare virtual
// lights — a dark room in a firefight strobes, through the global pool.
function updateMuzzleLights() {
  for (const p of agents.flashPoints ?? []) {
    lightPool.add(p.x, p.y, p.z, 0xffd9a0, 22, 9, 2.0);
  }
  // the player's own transients ride the pool too (they always win a slot)
  if (muzzleFlash.intensity > 0.02) lightPool.add(muzzleFlash.position.x, muzzleFlash.position.y, muzzleFlash.position.z, 0xffd9a0, muzzleFlash.intensity, 7, 2);
  if (wallSpark.intensity > 0.02) lightPool.add(wallSpark.position.x, wallSpark.position.y, wallSpark.position.z, 0xffb060, wallSpark.intensity, 4, 2.4);
  if (boomLight.intensity > 0.02) lightPool.add(boomLight.position.x, boomLight.position.y, boomLight.position.z, 0xffc890, boomLight.intensity, 22, 1.6);
}

// live flamethrower burns from the sim.
// THE FIRE LANDS WHERE THE FLAME WENT. This used to light the blaze at the
// room's GEOMETRIC CENTRE, because the node was all the sim handed over — so
// in a hangar the flame hit a body against a bulkhead and a fire lit up thirty
// metres away mid-deck. The sim now records the spot the fuel landed on
// (graph.burnX/burnY, written wherever burningUntil is), the same route the
// blood marks take, and FireFX.add has always taken an arbitrary world point.
function syncBurnFires() {
  for (let n = 0; n < sim.graph.n; n++) {
    const key = `burn${n}`;
    const burning = sim.graph.burningUntil[n] > sim.t;
    if (burning) {
      const nd = sim.graph.node(n);
      const [wx, wz] = world.simToWorld(sim.graph.burnX[n], sim.graph.burnY[n], nd.deck);
      if (!fire.fires.has(key)) fire.add(key, wx, wz, elevOf(nd.deck), 1.2);
      else fire.move(key, wx, wz, elevOf(nd.deck), 1.2);
    } else if (!burning && fire.fires.has(key)) fire.remove(key);
  }
}

// THE FLAME JET (item 1): agents3d hands over one record per marine with the
// trigger down — origin at his nozzle, direction down his barrel, length out to
// the spot the sim says the fuel is landing on. Drained here, like rifleLights,
// so the FX and its three pooled lights live with the rest of the effects.
// The roar is retriggered on a key gap slightly under the sample length, so a
// sustained burn sounds continuous and a corpse-cache squirt is one bark.
function updateFlameJets(dtReal) {
  jets.frame();
  for (let i = 0; i < agents.flameJetN; i++) {
    const r = agents.flameJets[i];
    jets.emit(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz, r.len, r.seed);
    if (Math.hypot(r.ox - player.x, r.oz - player.z) < 34) {
      audio.play('flame', { x: r.ox, z: r.oz, deck: r.deck }, 0.7, `flame${r.seed}`, 900);
    }
  }
  // YOUR OWN stream rides the same pool and the same roar — one flame system
  // in the game, whoever is holding the trigger. Louder and unpositioned: it
  // is going off beside your head, not across the compartment.
  if (_flameJet) {
    const j = _flameJet;
    jets.emit(j.ox, j.oy, j.oz, j.dx, j.dy, j.dz, j.len, _flameSeed);
    audio.play('flame', null, 1.0, 'flame-player', 900);
  }
  jets.update(dtReal, camera.position.x, camera.position.y, camera.position.z);
}

const weapon = new HeldWeapon(MA5);
// THE FLAMETHROWER YOU CAN CARRY (user). `hasFlamer` is the pickup; `heldIsFlamer`
// is which of the two is up. You never lose the MA5 — the flamer is a second
// weapon on the sling, because a tank that empties in twelve seconds would be
// a death sentence if taking it meant dropping the rifle.
const FLAME = sim.P.flamethrower.player;
const flamer = new FlameThrower(FLAME);
let hasFlamer = false, heldIsFlamer = false;
// the "you can swap now" prompt: raised when the first flamethrower reaches
// your hands, cleared on a deadline or the first swap. The hint element is
// rebuilt from scratch every frame, so it needs a timestamp to live on.
const SWAP_HINT_MS = 8000;
let swapHintAt = 0;
// KNOCKED BACK: the shove already moves the capsule (FpsController.shoveX);
// this is the part that makes it READ as a hit rather than a physics glitch —
// the view lurches with the body. Scaled off the strength so a glancing swipe
// is a nudge and a charging form's whip snaps the camera.
player.onShoved = (mps) => { shake = Math.min(1.4, shake + mps * 0.16); };

player.onAmmoTaken = (src) => {
  if (src === 'armory') { sim.armoryStock--; weapon.reserve += 120; frags = Math.min(FRAG.max, frags + 4); sim.log('combat', `you strip mags and a bandolier of frags from the rack (${sim.armoryStock} rifles left)`); }
  else {
    const available = src.ammoRounds ?? 60;
    const rounds = isSimAuthority()
      ? sim.claimAmmoDrop(player.agent, src.id, available)
      : available;
    if (!rounds) return;
    if (!isSimAuthority()) {
      src.wasArmed = false;
      src.ammoRounds = 0;
      gameSync?.ammoPickup(src.id, rounds);
    }
    weapon.reserve += rounds;
    sim.log('combat', `you take ${rounds / MA5.mag} magazine${rounds === MA5.mag ? '' : 's'} off the dead`);
  }
};
player.onGrenadesTaken = () => {
  const drop = player.grenadeSource(frags, FRAG.max);
  if (!drop) return false;
  const taken = sim.claimGrenadeDrop(player.agent, drop.id, FRAG.max - frags);
  if (!taken) return false;
  frags += taken;
  if (!isSimAuthority()) gameSync?.grenadePickup(drop.id, taken);
  sim.log('combat', `you recover ${taken} frag${taken === 1 ? '' : 's'} from the fallen (you)`, drop.node, drop.x, drop.y);
  return true;
};
// E on a flamethrower source. Offered ahead of the ammo prompt (see the hint
// block) because the flamer is the rarer find and a body can carry both.
player.onFlamerTaken = () => {
  const src = player.flamerSource(hasFlamer, flamer.frac);
  if (!src) return false;
  if (src === 'refuel') {
    flamer.fuel = sim.playerRefuel(flamer.fuel);
    sim.log('combat', 'you swap a fuel can into the flamethrower (you)');
  } else {
    flamer.fuel = sim.playerTakeFlamer(player.agent, src === 'armory' ? null : src);
    if (!hasFlamer) {
      hasFlamer = true; heldIsFlamer = true; // the first one comes straight up
      // TELL THEM THE SWAP EXISTS, at the one moment they have two weapons for
      // the first time. The user played a whole run without discovering Q.
      // Both channels: the radio log keeps it (it scrolls, but it is there to
      // scroll back to), the hint line puts it under the reticle right now.
      sim.log('combat', inputPrompt(
        'flamethrower up — Q, or the mouse wheel UP, brings the MA5 back',
        'flamethrower up — Y brings the MA5 back',
      ));
      swapHintAt = performance.now();
    }
  }
  return true;
};

// MED PACKS (user: Halo CE style — "just a button to use on the spot,
// restores to full health regardless of how low"). Applied through the local
// sim in every case: on the authority that IS the truth; on a peer it's an
// optimistic apply the authority's medkit packet + next snapshot confirm.
let healFlash = 0;
player.onMedkitUsed = () => {
  const kit = player.medkitSource();
  if (!kit) return false;
  if (!sim.playerUseMedkit(player.agent)) return false;
  if (!isSimAuthority()) gameSync?.medkit();
  healFlash = 1;
  return true;
};

// ARMOR PACKS (user: armor replaces shields — no regen, replenished only by
// packs). Same authority pattern as the med packs.
player.onArmorUsed = () => {
  const pack = player.armorSource();
  if (!pack) return false;
  if (!sim.playerUseArmorPack(player.agent)) return false;
  if (!isSimAuthority()) gameSync?.armorpack();
  healFlash = 1;
  return true;
};

// the packs themselves, out in the world: Halo CE's white case with the red
// cross, small enough to sit on a crate lid, emissive enough to read in a
// blacked-out compartment. One group per kit; visibility tracks kit.used.
const medkitMeshes = [];
{
  const caseMat = new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.5, metalness: 0.1, emissive: 0x1a1a18, emissiveIntensity: 0.5 });
  const crossMat = new THREE.MeshStandardMaterial({ color: 0xc1272d, roughness: 0.55, metalness: 0.05, emissive: 0x7a1518, emissiveIntensity: 0.7 });
  const caseGeo = new THREE.BoxGeometry(0.34, 0.115, 0.24);
  const barGeo = new THREE.BoxGeometry(0.19, 0.012, 0.055);
  const barGeo2 = new THREE.BoxGeometry(0.055, 0.012, 0.19);
  const stripeGeo = new THREE.BoxGeometry(0.342, 0.036, 0.242);
  // a kit hashed into the same spot as a cover crate would be swallowed by
  // the mesh — shove it just clear along the shortest exit. Deterministic
  // (props are a pure seed hash), and written back to the KIT so the sim's
  // use-radius agrees with where the player actually sees the box.
  const clearOfProps = (kit) => {
    for (const p of world.props) {
      if (p.deck !== kit.deck) continue;
      const dx = kit.x - p.x, dy = kit.y - p.y;
      if (Math.abs(dx) >= p.hw + 0.2 || Math.abs(dy) >= p.hd + 0.2) continue;
      const pushX = (p.hw + 0.25 - Math.abs(dx)) * (dx >= 0 ? 1 : -1);
      const pushY = (p.hd + 0.25 - Math.abs(dy)) * (dy >= 0 ? 1 : -1);
      if (Math.abs(pushX) <= Math.abs(pushY)) kit.x += pushX; else kit.y += pushY;
    }
  };
  for (const kit of sim.medkits) {
    clearOfProps(kit);
    const g = new THREE.Group();
    const body = new THREE.Mesh(caseGeo, caseMat);
    body.position.y = 0.0575;
    const stripe = new THREE.Mesh(stripeGeo, crossMat); // red band around the middle
    stripe.position.y = 0.0575;
    const bar = new THREE.Mesh(barGeo, crossMat);
    bar.position.y = 0.116;
    const bar2 = new THREE.Mesh(barGeo2, crossMat);
    bar2.position.y = 0.116;
    g.add(body, stripe, bar, bar2);
    const [wx, wz] = world.simToWorld(kit.x, kit.y, kit.deck);
    g.position.set(wx, elevOf(kit.deck), wz);
    g.rotation.y = (kit.id * 2654435761 % 360) * Math.PI / 180; // stable scatter yaw
    scene.add(g);
    medkitMeshes.push({ kit, mesh: g });
  }
}

// ARMOR PACKS (user): a gunmetal case with a gold plate-glow — reads as
// hardware, not medicine, from across a dark room. Same lifecycle as the
// med packs: one group per pack, visibility tracks pack.used.
const armorPackMeshes = [];
{
  const caseMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.45, metalness: 0.55, emissive: 0x11141a, emissiveIntensity: 0.5 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.4, metalness: 0.6, emissive: 0x8a6a12, emissiveIntensity: 0.9 });
  const caseGeo = new THREE.BoxGeometry(0.36, 0.13, 0.26);
  const plateGeo = new THREE.BoxGeometry(0.26, 0.02, 0.16);
  const ribGeo = new THREE.BoxGeometry(0.362, 0.03, 0.06);
  const clearOfProps = (kit) => {
    for (const p of world.props) {
      if (p.deck !== kit.deck) continue;
      const dx = kit.x - p.x, dy = kit.y - p.y;
      if (Math.abs(dx) >= p.hw + 0.2 || Math.abs(dy) >= p.hd + 0.2) continue;
      const pushX = (p.hw + 0.25 - Math.abs(dx)) * (dx >= 0 ? 1 : -1);
      const pushY = (p.hd + 0.25 - Math.abs(dy)) * (dy >= 0 ? 1 : -1);
      if (Math.abs(pushX) <= Math.abs(pushY)) kit.x += pushX; else kit.y += pushY;
    }
  };
  for (const pack of sim.armorPacks) {
    clearOfProps(pack);
    const g = new THREE.Group();
    const body = new THREE.Mesh(caseGeo, caseMat);
    body.position.y = 0.065;
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.y = 0.14;
    const rib = new THREE.Mesh(ribGeo, plateMat);
    rib.position.y = 0.065;
    g.add(body, plate, rib);
    const [wx, wz] = world.simToWorld(pack.x, pack.y, pack.deck);
    g.position.set(wx, elevOf(pack.deck), wz);
    g.rotation.y = (pack.id * 2654435761 % 360) * Math.PI / 180;
    scene.add(g);
    armorPackMeshes.push({ pack, mesh: g });
  }
}

// A dead marine's unused frags remain on the deck even if the body is moved
// or converted. Two compact olive shells are enough to read as a pickup in a
// flashlight beam; the sim record owns count and multiplayer reconciliation.
const grenadeDropMeshes = new Map();
const grenadeDropGeo = new THREE.DodecahedronGeometry(0.11, 0);
const grenadeDropMat = new THREE.MeshStandardMaterial({
  color: 0x65734d, roughness: 0.48, metalness: 0.55,
  emissive: 0x243018, emissiveIntensity: 0.8,
});
function syncGrenadeDropMeshes() {
  const live = new Set();
  for (const drop of sim.grenadeDrops) {
    live.add(drop.id);
    let group = grenadeDropMeshes.get(drop.id);
    if (!group) {
      group = new THREE.Group();
      for (const offset of [-0.08, 0.08]) {
        const grenade = new THREE.Mesh(grenadeDropGeo, grenadeDropMat);
        grenade.position.set(offset, 0.11, Math.abs(offset) * 0.45);
        grenade.scale.set(0.8, 1.25, 0.8);
        group.add(grenade);
      }
      scene.add(group);
      grenadeDropMeshes.set(drop.id, group);
    }
    const [wx, wz] = world.simToWorld(drop.x, drop.y, drop.deck);
    group.position.set(wx, elevOf(drop.deck), wz);
    group.rotation.y = (drop.id * 2.399963) % (Math.PI * 2);
    group.visible = drop.count > 0;
    for (let index = 0; index < group.children.length; index++) {
      group.children[index].visible = index < drop.count;
    }
  }
  for (const [id, group] of grenadeDropMeshes) {
    if (live.has(id)) continue;
    scene.remove(group);
    grenadeDropMeshes.delete(id);
  }
}

// MA5 viewmodel — the real ported first-strike asset (game/rifle-model.js),
// at first-strike's exact CE reference placement (js/main.js gunTune),
// translated for Three's -Z-forward camera convention (their engine is
// +Z-forward; only the forward axis flips, right/up match 1:1).
const rifleMesh = buildRifleViewmodel();
const viewmodel = new THREE.Group();
viewmodel.add(rifleMesh);
viewmodel.position.set(GUN_TUNE.x, GUN_TUNE.y, -GUN_TUNE.z);
viewmodel.rotation.set(GUN_TUNE.rx, GUN_TUNE.ry, GUN_TUNE.rz);
viewmodel.scale.setScalar(GUN_TUNE.s);
camera.add(viewmodel);
// the flamer's own viewmodel, on the same camera rig. Both exist for the
// whole session and visibility picks between them — building one on a weapon
// swap would hitch the first time you switch, mid-fight, in the dark.
const flamerMesh = buildFlamerViewmodel();
const flamerModel = new THREE.Group();
flamerModel.add(flamerMesh);
flamerModel.scale.setScalar(FLAMER_TUNE.s);
flamerModel.visible = false;
camera.add(flamerModel);

// --- THE BUTT-STROKE ------------------------------------------------------
// User: melee should be "the barrel of the gun coming to the left as you
// strike forward with the butt of the gun in a fast manner". What was here
// lifted the weapon 0.3m and pitched it 0.95 rad nose-up off one symmetric
// sin() hump — the "weird upward gun motion" in the report — and the hump also
// made the recover exactly as fast as the strike, which reads as a wobble
// rather than a hit.
//
// TIMING. `p` is 0 at the start of the swing and 1 at the end. weapon.js fires
// melee_hit at 0.2s of the 0.52s swing (p = 0.385), so the strike peaks at
// p = 0.42 — a frame past the damage, which is where a hit lands. Before that
// there is a short cock BACKWARD (a negative value, which pulls every axis
// back for free), and after it a recover spread over the remaining 0.58 of the
// swing: out in ~0.12s, back in ~0.30s. Sharp out, slow recover.
function buttStroke01(meleeT, duration) {
  if (meleeT <= 0) return 0;
  const p = 1 - meleeT / duration;
  const COCK = 0.18, PEAK = 0.42, BACK = 0.22;
  if (p < COCK) return -BACK * Math.sin((p / COCK) * Math.PI * 0.5);
  if (p < PEAK) return -BACK + (1 + BACK) * Math.sin(((p - COCK) / (PEAK - COCK)) * Math.PI * 0.5);
  return Math.cos(((p - PEAK) / (1 - PEAK)) * Math.PI * 0.5);
}

// SIGN CONVENTIONS. Camera space is -Z forward, +X right, +Y up, and both
// viewmodels are authored +Z-forward then yawed by PI (rifle-model.js), so a
// weapon's barrel points down the group's local -Z. THREE's Euler 'XYZ' maps
// local -Z to world x = -sin(ry), so a POSITIVE rotation.y sweeps the muzzle
// toward -X — the player's LEFT. (Cross-check: FLAMER_TUNE.ry is -0.35 and its
// comment says that turn brings the weapon's flank into frame, which for a
// weapon held out at x = +0.23 is the muzzle rotating outward to the RIGHT.
// Same axis, opposite sign.) Confirmed on screen, not on paper — see the
// swing capture in the melee screenshots.
//
// So: +yaw whips the barrel left, -Z drives the stock forward at the target,
// and the whole weapon slides left with it so the butt arrives near the middle
// of the view instead of pivoting out of frame to the right.
const BUTT = {
  yaw: 1.00,    // rad the muzzle sweeps left (~57 deg)
  fwd: 0.30,    // m the weapon drives forward (-Z) — the stock going in
  side: 0.34,   // m it travels left (-X). Sliding the weapon left as it turns
                // is what a stock-anchored pivot looks like: without it the
                // model spins about its own middle and the butt leaves frame
                // to the right, so the strike you SEE is only the barrel.
  drop: 0.02,   // m it settles (-Y): level or below the eye, NEVER lifted
  pitch: 0.16,  // rad nose-DOWN — drops the muzzle and brings the STOCK up
                // into the frame, the exact opposite of the old nose-up lift
  roll: 0.30,   // rad the receiver rolls over as the stock comes round
};
function applyButtStroke(model, s) {
  if (!s) return;
  model.position.x -= BUTT.side * s;
  model.position.y -= BUTT.drop * s;
  model.position.z -= BUTT.fwd * s;
  model.rotation.x -= BUTT.pitch * s;
  model.rotation.y += BUTT.yaw * s;
  model.rotation.z += BUTT.roll * s;
}
// transient combat lights are VIRTUAL now — they ride the global pool
// (near the player they always win a slot, so the look is unchanged)
const muzzleFlash = { position: new THREE.Vector3(), intensity: 0 };
const wallSpark = { position: new THREE.Vector3(), intensity: 0 };
const wallRay = new THREE.Raycaster();

// --- HUD ---
const el = (id) => document.getElementById(id);
// dirty-checked DOM writes (perf: setting textContent/style every frame
// forces style work even when the value is unchanged)
const _hudCache = {};
function setText(id, s) {
  if (_hudCache[id] !== s) { _hudCache[id] = s; el(id).textContent = s; }
}
function setStyle(id, prop, v) {
  const k = id + ':' + prop;
  if (_hudCache[k] !== v) { _hudCache[k] = v; el(id).style[prop] = v; }
}
let _strengthHudAt = -Infinity;
function updateStrengthHud(now) {
  if (now - _strengthHudAt < 250) return;
  _strengthHudAt = now;
  let infectionMass = 0, marinesAlive = 0;
  // Read the live entities rather than hive.stats: non-authority co-op peers
  // receive these poses but do not run the hive's strategic tick locally.
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0) continue;
    if (a.faction === FACTION.INFECTION && !a.downed) infectionMass++;
    else if (a.faction === FACTION.COMBAT && !a.downed) infectionMass += 2;
    else if (a.faction === FACTION.CARRIER) infectionMass += 2;
    else if (a.faction === FACTION.MARINE && !a.isPlayer && !a.fromPlayer && !a.deckGuard) marinesAlive++;
  }
  const infectionScale = Math.max(1, sim.P.carrier.productionBackpressure);
  setStyle('infectionStrengthBar', 'transform',
    `scaleX(${Math.min(1, infectionMass / infectionScale).toFixed(3)})`);
  setStyle('shipStrengthBar', 'transform',
    `scaleX(${Math.min(1, marinesAlive / Math.max(1, shipMarines0)).toFixed(3)})`);
}
const overlay = el('overlay');

// --- INTRO (user request): the briefing types itself out like a military
// report. Any key or click while it types reveals the whole thing; when it's
// done, a click deploys you (that click doubles as the pointer-lock and
// audio gesture). The sim runs cold underneath — by the time you hit the
// deck, the ship's log already has a history.
const intro = el('intro'), introHint = el('introHint');
const introScroll = el('introScroll');
let introGone = false;
function dismissIntro() {
  governor.cancelPrewarm();
  introGone = true;
  intro.style.display = 'none';
  overlay.classList.add('hidden');
  audio.ensure();
  if (inputMode !== 'gamepad') {
    canvas.requestPointerLock()?.catch?.(() => {}); // sandboxed iframes refuse — not fatal
  }
}
intro.addEventListener('click', () => {
  if (briefing.done) dismissIntro();
  else briefing.complete();
});
window.addEventListener('keydown', (event) => {
  if (introGone) return;
  if (!briefing.done) briefing.complete();
  else if (event.code === 'Enter' || event.code === 'Space') {
    event.preventDefault();
    dismissIntro();
  }
});
const afterlifeBody = () => {
  const body = sim.byId.get(player.agent.afterlifeId);
  return body && !body.dead ? body : null;
};
const livingTeammate = () => mates.find((mate) => mate.agent && !mate.agent.dead && mate.agent.hp > 0) ?? null;
overlay.addEventListener('click', (event) => {
  if (event.target.closest('button') || ended) return;
  if (gamepadPaused) { resumeGamepadControls(); return; }
  overlay.classList.add('hidden');
  if (!player.dead) canvas.requestPointerLock()?.catch?.(() => {});
});
let ended = false;
const KEYBOARD_CONTROLS = 'WASD move · MOUSE look · SPACE jump · CLICK fire · G frag · E pick up / use / climb / reload · F melee · Q / WHEEL swap · M map · SHIFT sprint';
const CONTROLLER_CONTROLS = 'HALO 3 · LEFT STICK move · RIGHT STICK look · A jump · RT fire · LT frag · RB pick up / use / climb / reload · B melee · Y swap · L3 sprint · VIEW map · D-PAD orders';
function refreshOverlayPrompt() {
  if (!introGone) {
    introHint.textContent = briefing.done
      ? inputPrompt('CLICK TO DEPLOY', 'A — DEPLOY')
      : inputPrompt('ANY KEY OR CLICK — SKIP', 'ANY BUTTON — SKIP');
  }
  if (overlay.dataset.screen === 'pause') {
    const voice = !LAUNCH.session ? ''
      : voiceBlocked ? ' · TAP SCREEN OR PRESS A KEY FOR TEAM AUDIO'
        : voiceActive ? ` · Y ${voiceMuted ? 'UNMUTE' : 'MUTE'} MIC`
          : ' · TAP MIC TO ENABLE VOICE';
    overlay.querySelector('.keys').textContent = inputPrompt(
      `${KEYBOARD_CONTROLS} · CLICK — return to action`,
      `${CONTROLLER_CONTROLS} · A / MENU resume${voice}`,
    );
  } else if (overlay.dataset.screen === 'result') {
    overlay.querySelector('.keys').textContent = inputPrompt(
      'TAB / ARROWS choose · ENTER activate',
      'D-PAD / LEFT STICK choose · A activate · share/copy require tap or Enter',
    );
  } else if (overlay.dataset.screen === 'watch') {
    overlay.querySelector('.keys').textContent = inputPrompt('click to keep watching', 'A — keep watching');
  }
}
refreshInputModeCopy = refreshOverlayPrompt;
refreshOverlayPrompt();
function endScreen(title, text, final = true) {
  if (ended) return;
  if (final) {
    ended = true;
    marineMap.setOmniscient(true);
    el('maptitle').textContent = 'AFTER ACTION TACNET — FULL SHIP PICTURE';
    el('maplegend').innerHTML = '<span data-input-copy="keyboard">M close · 1–5 or ←/→ switch deck</span><span data-input-copy="gamepad">VIEW or B close · D-PAD ←/→ switch deck</span> · all Flood and marine positions are live; fog of war and radio uncertainty are disabled';
  }
  document.exitPointerLock?.();
  el('ovTitle').textContent = title;
  el('ovText').textContent = text;
  overlay.dataset.screen = final ? 'result' : 'watch';
  refreshOverlayPrompt();
  overlay.classList.remove('hidden');
}

// ONE END CARD, WIN OR LOSE (user: "the end screen should always be the
// same, just different messaging — if you survive you win with a time; if
// you don't, you at least survived for X"). The same card renders both ways:
// headline, the big clock, the stats line, the share row. Only the words and
// the color change.
//   WIN  — ranks on the clock, Halo's own difficulty names:
//          LEGENDARY under 5:00 · HEROIC under 7:00 · MISSION ACCOMPLISHED.
//          Time = sim.outcomeAt, frozen when the last form went down.
//   LOSS — OVERRUN, and the clock is YOUR time: how long you lasted before
//          the ship took you (playerFellAt — the moment you were grabbed or
//          killed, not the later moment your walking corpse was put down).
const VICTORY_RANKS = [
  { under: 300, name: 'LEGENDARY', color: '#ffcf5a',
    blurb: 'Under five minutes. The ship was never even close to lost.' },
  { under: 420, name: 'HEROIC', color: '#9fd8ff',
    blurb: 'Under seven minutes. Fast enough that most of the crew are still breathing.' },
  { under: Infinity, name: 'MISSION ACCOMPLISHED', color: '#7fd1a0',
    blurb: 'It took a while, but the Saturn Devouring survives.' },
];
let playerFellAt = null; // sim seconds when the player was taken/killed
function victoryScreen() {
  if (ended) return;
  const secs = sim.outcomeAt ?? sim.t;
  const rank = VICTORY_RANKS.find((r) => secs < r.under);
  endScreen('OUTBREAK CONTAINED', rank.blurb);
  resultCard({
    headline: rank.name, color: rank.color, label: 'FINAL TIME', secs,
    share: `I contained the Flood outbreak aboard the UNSC Saturn Devouring in ${fmtTime(secs)} — ${rank.name}. #HaloCharon`,
  });
}
function defeatScreen(title, text) {
  if (ended) return;
  const secs = playerFellAt ?? sim.t;
  endScreen(title, text);
  resultCard({
    headline: 'OVERRUN', color: '#ff6a4d', label: 'YOU SURVIVED', secs,
    share: `The Flood took the UNSC Saturn Devouring — I survived ${fmtTime(secs)}. #HaloCharon`,
  });
}
function resultCard({ headline, color, label, secs, share }) {
  const time = fmtTime(secs);
  // the seed rides in from ?seed= / the lobby config, so it is untrusted text
  const escq = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  overlay.querySelector('#victoryCard')?.remove();
  const card = document.createElement('div');
  card.id = 'victoryCard';
  card.style.cssText = 'margin:18px auto 0;max-width:520px;text-align:center;'
    + 'font:13px/1.7 ui-monospace,Menlo,monospace';
  const url = location.origin + location.pathname;
  card.innerHTML =
    `<div style="font:700 26px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.14em;color:${color}">${headline}</div>`
    + `<div style="margin-top:10px;color:#8fa8c4;letter-spacing:0.18em;font-size:11px">${label}</div>`
    + `<div style="font:700 40px/1.1 ui-monospace,Menlo,monospace;color:#e8eef7">${time}</div>`
    + `<div style="margin-top:14px;color:#6a7686">${sim.stats.combatFormsDowned} forms put down · seed ${escq(sim.seed)}</div>`
    + '<textarea id="resultShareText" readonly aria-label="Share result text"></textarea>'
    + `<div id="shareRow" style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"></div>`
    + `<div id="shareNote" style="margin-top:8px;height:16px;color:#7fd1a0;font-size:11px"></div>`;
  overlay.querySelector('.keys').before(card);

  const row = card.querySelector('#shareRow');
  const note = card.querySelector('#shareNote');
  const shareText = card.querySelector('#resultShareText');
  shareText.value = `${share}\n${url}`;
  const activationFallback = (button) => {
    shareText.select();
    button.focus({ preventScroll: true });
    note.textContent = 'tap this action or press Enter; result text is available above';
  };
  const mkBtn = (label, fn, requiresActivation = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (requiresActivation) b.dataset.requiresActivation = 'true';
    b.onclick = (event) => requiresActivation && !event.isTrusted ? activationFallback(b) : fn();
    row.appendChild(b);
    return b;
  };
  mkBtn('COPY RESULT', async () => {
    try {
      await navigator.clipboard.writeText(`${share}\n${url}`);
      note.textContent = 'copied to clipboard';
    } catch { note.textContent = 'clipboard blocked — select the text above'; }
  }, true);
  mkBtn('POST TO X', () => {
    location.href = `https://x.com/intent/tweet?text=${encodeURIComponent(share)}&url=${encodeURIComponent(url)}`;
  });
  // phones and Safari get the real share sheet; everything else has the two above
  if (navigator.share) {
    mkBtn('SHARE…', () => navigator.share({ title: 'Halo Charon', text: share, url }).catch(() => {}), true);
  }
  if (player.dead) {
    mkBtn('WATCH BODY', () => {
      toggleMap(false);
      overlay.classList.add('hidden');
      el('postgameHud').style.display = 'block';
    });
    mkBtn('FULL TACNET', () => {
      overlay.classList.add('hidden');
      el('postgameHud').style.display = 'block';
      toggleMap(true);
    });
  }
  const restart = mkBtn('PLAY AGAIN', () => location.reload());
  restart.dataset.primary = 'true';
  restart.focus({ preventScroll: true });
}

let lastEvent = 0;
// RADIO NET (user: the log is radio-report transcripts now, and its
// unreliability is IMPLICIT). Every line the player sees is a broadcast
// from a NAMED crew member. The rules:
//   - an event needs a living WITNESS in or adjacent to the room, or
//     nobody transmits and the player never hears about it;
//   - same-deck broadcasts always reach you;
//   - everything cross-deck is a crapshoot (the comms are dying);
//   - the armory ODSTs' hardened gear ALWAYS punches through.
// The sim debug page keeps the full omniscient log; the flood's mind is
// still never narrated here.
const _ominousAt = {};
const HUMAN_F = new Set([0, 1, 2]); // civilian, armed, marine
function humanIn(node, pred) {
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0 || a.isPlayer || !a.callsign) continue;
    if (!HUMAN_F.has(a.faction) || a.node !== node) continue;
    if (!pred || pred(a)) return a;
  }
  return null;
}
function witnessNear(node, pred = null) {
  if (node == null || node < 0) return null;
  const here = humanIn(node, pred);
  if (here) return here;
  for (const { to } of sim.graph.adj.std[node] ?? []) {
    const w = humanIn(to, pred);
    if (w) return w;
  }
  return null;
}
function squadSpeaker(msg) {
  const m = msg.match(/squad (\d+)/) ?? msg.match(/patrol (\d+)/);
  if (!m) return null;
  const isPatrol = m[0].startsWith('patrol');
  const squad = sim.squads.find((s) => isPatrol ? s.patrolNo === +m[1] : s.id === +m[1] - 1);
  if (!squad) return null;
  for (const id of squad.members) {
    const a = sim.byId.get(id);
    if (a && !a.dead && a.hp > 0 && a.callsign) return a;
  }
  return null;
}
function odstSpeaker() {
  for (const a of sim.agents) {
    if (a.odst && !a.dead && a.hp > 0 && !a.isPlayer && a.callsign) return a;
  }
  return null;
}
// did the broadcast reach you? (Math.random is fine here — receipt is a
// display-layer concern; the sim never sees it)
function delivered(speaker, always = false) {
  if (always) return true;
  if (!speaker) return false;               // nobody transmitted
  if (speaker.odst) return true;            // ODST comms always punch through
  if (speaker.deck === player.deck) return true;
  return Math.random() < 0.45;              // cross-deck: the net is dying
}
const spkName = (a) => a?.callsign ? `${a.callsign.rank} ${a.callsign.name}`.toUpperCase() : null;
function rx(e, speaker, msg, { always = false, type = 'radio', spk } = {}) {
  if (!delivered(speaker, always)) return null;
  return { t: e.t, type, spk: spk ?? spkName(speaker), msg };
}
// DIALOGUE VARIETY (user: dozens of diverse phrasings for every reportable
// event). Each transmission draws a random line from its pool — Math.random
// is fine, receipt and phrasing are display-layer; the sim never sees them.
// `r` is the room name (caller guarantees a fallback).
const VOICES = {
  ambush: [
    (r) => `contact! they were waiting for us in ${r}!`,
    (r) => `it's a trap — they were dug in at ${r}!`,
    (r) => `ambush! ambush in ${r}!`,
    (r) => `they hit us the second we cleared the hatch — ${r} is hot!`,
    (r) => `hostiles were sitting on ${r} — walked right into it!`,
    (r) => `they let us walk in. ${r}. everybody down!`,
    (r) => `contact rear! they were behind the racks in ${r}!`,
    (r) => `they were WAITING — say again, ${r} was staged!`,
    (r) => `sprung on us in ${r} — need guns here now!`,
    (r) => `point man's hit — they boxed us in at ${r}!`,
    (r) => `out of the dark, all sides — ${r}!`,
    (r) => `set-piece ambush in ${r}, they knew we were coming!`,
  ],
  taken: [
    (r) => `screams coming from ${r} — someone's in trouble`,
    (r) => `somebody's screaming in ${r}, we can't get to them`,
    (r) => `we heard a scream cut off in ${r}. it just stopped`,
    (r) => `someone in ${r} is yelling for help — who's closest?`,
    (r) => `they got somebody in ${r}. we heard the whole thing`,
    (r) => `there's screaming out of ${r} — repeat, screaming`,
    (r) => `struggle in ${r}. sounded bad. then nothing`,
    (r) => `we lost voice contact with ${r} mid-sentence`,
    (r) => `someone was calling for help near ${r} — gone quiet now`,
    (r) => `people are getting dragged down in ${r}, we can hear it`,
    (r) => `banging and screaming through the bulkhead from ${r}`,
    (r) => `that was a human voice in ${r}. was.`,
  ],
  strange: [
    (r) => `strange noises out of ${r}`,
    (r) => `hearing something wet moving around in ${r}`,
    (r) => `there's something in ${r}. don't know what`,
    (r) => `movement in ${r} — doesn't sound like boots`,
    (r) => `anyone else hearing that from ${r}?`,
    (r) => `something's scraping along the deck in ${r}`,
    (r) => `noises out of ${r} again. it's not the ventilation`,
    (r) => `${r} sounds wrong. requesting someone check it`,
    (r) => `low sounds from ${r} — like breathing, but not right`,
    (r) => `we keep hearing movement in ${r} and nobody's posted there`,
    (r) => `something knocked over a rack in ${r}. nobody's in there`,
    (r) => `can't explain what we're hearing out of ${r}`,
  ],
  rampage: [
    (r) => `heavy movement near ${r} — multiple contacts`,
    (r) => `multiple hostiles moving through ${r}!`,
    (r) => `they're pouring through ${r} — count is double digits`,
    (r) => `${r} is crawling with them!`,
    (r) => `mass movement in ${r}, headed our way!`,
    (r) => `we've got a swarm in ${r} — say again, a SWARM`,
    (r) => `whatever's in ${r}, it's not one of them, it's a lot`,
    (r) => `hostiles rampaging through ${r} — they're tearing it apart`,
    (r) => `stampede through ${r}! get clear of the hatches!`,
    (r) => `they're moving in force through ${r}`,
    (r) => `activity spike in ${r} — it's a push, they're pushing!`,
    (r) => `everything on this deck is converging on ${r}`,
  ],
  revive: [
    (r) => `something's moving in ${r}... it was down a second ago`,
    (r) => `the one we dropped in ${r} — it's getting up`,
    (r) => `body in ${r} just moved. bodies don't move`,
    (r) => `confirm your kills! the dead in ${r} aren't staying dead!`,
    (r) => `it stood back up. ${r}. it STOOD BACK UP`,
    (r) => `we put it down in ${r} and it's walking again`,
    (r) => `casualty in ${r} just... reanimated. engaging again`,
    (r) => `they don't stay down — another one's up in ${r}`,
    (r) => `movement from the casualties in ${r}. all of you, eyes on the floor`,
    (r) => `that thing in ${r} took a full mag and it's up again`,
    (r) => `dead pile in ${r} is moving. burn them. BURN them`,
    (r) => `whatever we killed in ${r}, we didn't kill it`,
  ],
  duct: [
    (r) => `hearing something in the ducts near ${r}`,
    (r) => `movement in the trunking over ${r}`,
    (r) => `there's something crawling through the vents by ${r}`,
    (r) => `scratching in the overhead near ${r} — it's in the ductwork`,
    (r) => `vent noise over ${r}. something heavy. moving fast`,
    (r) => `the trunking above ${r} just flexed — something's inside it`,
    (r) => `slithering sounds in the air handling near ${r}`,
    (r) => `it's in the walls. ${r}. it's IN the walls`,
    (r) => `duct grate rattling in ${r} — nobody's on maintenance rotation`,
    (r) => `tell me that's the fans in ${r}. that's not the fans`,
    (r) => `something's using the vents to move around ${r}`,
    (r) => `overhead noise tracking across ${r} — it's headed somewhere`,
  ],
  manDown: [
    (r) => `we have a man down in ${r}!`,
    (r) => `man down! man down in ${r}!`,
    (r) => `marine down in ${r} — we need help NOW`,
    (r) => `we lost one in ${r}!`,
    (r) => `casualty in ${r}! still taking fire!`,
    (r) => `he's down — ${r} — he's not moving`,
    (r) => `they got one of ours in ${r}!`,
    (r) => `KIA in ${r}. we couldn't reach him`,
    (r) => `one of my people is down in ${r}, request immediate support`,
    (r) => `we're carrying a casualty out of ${r} — cover the corridor!`,
    (r) => `${r} — man down, man down, MAN DOWN`,
    (r) => `lost another one in ${r}. that's on me`,
  ],
  // FIRST CONTACT (user): the first squads to see the flood don't call in a
  // clean contact report — they call in confusion. Nobody briefed them for
  // this, and the one thing they know for sure is that it isn't Covenant.
  firstContact: [
    (r) => `contact in ${r} — be advised, these are NOT Covenant`,
    (r) => `what the hell are these things?! ${r}, we are engaging!`,
    (r) => `${r}, contact, type... unknown. it's not Covenant. say again, NOT Covenant`,
    (r) => `visual on hostiles in ${r} — they're wearing our uniforms. god, they used to be crew`,
    (r) => `something is very wrong in ${r} — they're not stopping, they're NOT STOPPING`,
    (r) => `unknown hostiles in ${r}. no shields, no plasma — they just keep walking at us`,
    (r) => `it took a full burst center mass and kept coming! ${r}!`,
    (r) => `these aren't elites, they aren't grunts, they aren't anything we were briefed on — ${r}!`,
    (r) => `eyes on ${r} — hostile bio, type unknown. it moves like something's puppeting it`,
    (r) => `what IS that?! ${r} — I need somebody to tell me what I'm shooting at!`,
    (r) => `${r} — whatever came off that thing from HIGH CHARITY, it's in here with us`,
    (r) => `they came out of the dark all wrong — ${r}, that is not a Covenant boarding party`,
  ],
  distress: [
    (r) => `taking fire in ${r}! anyone copy?`,
    (r) => `contact in ${r}! we are engaged!`,
    (r) => `${r} — we're in it, need backup!`,
    (r) => `any station, any station — firefight in ${r}!`,
    (r) => `we are pinned in ${r}! somebody answer!`,
    (r) => `heavy contact in ${r} — expending fast!`,
    (r) => `they're on us in ${r}! copy anyone!`,
    (r) => `mayday from ${r}, we cannot hold this room alone!`,
    (r) => `who's near ${r}?! we need shooters!`,
    (r) => `engaged in ${r} — they just keep coming!`,
    (r) => `${r} is falling, say again ${r} is falling!`,
    (r) => `does ANYONE copy?! ${r}! now!`,
  ],
  burn: [
    (r) => `burning the bodies in ${r}`,
    (r) => `torching the casualties in ${r} — orders stand`,
    (r) => `flame team working through ${r}`,
    (r) => `putting the dead in ${r} to the torch. all of them`,
    (r) => `${r} cleared — burning what's left`,
    (r) => `incinerating remains in ${r}. don't let them lie`,
    (r) => `it's ugly work but ${r}'s bodies won't get back up`,
    (r) => `burn detail on ${r}. nothing rises from ash`,
  ],
  powerBack: [
    (r) => `power's coming back in ${r}`,
    (r) => `${r} just got mains power again`,
    (r) => `lights back up in ${r}`,
    (r) => `${r} is lit again — engineering came through`,
    (r) => `power restored to ${r}, we can see again`,
    (r) => `breakers reset — ${r} has lighting`,
  ],
  airClear: [
    (r) => `air's finally clearing in ${r}`,
    (r) => `the fog in ${r} is thinning out`,
    (r) => `scrubbers caught up — ${r} air is breathable`,
    (r) => `visibility improving in ${r}`,
    (r) => `${r} spore count dropping, masks stay ON`,
    (r) => `you can see across ${r} again`,
  ],
  armoryArms: [
    () => 'civilians drawing rifles off the racks — arming everyone who can hold one',
    () => 'racks are open — putting weapons in every pair of hands we have',
    () => 'handing out MA5s to the crew. everyone fights now',
    () => 'civilians are arming up off the racks. god help us',
    () => 'weapons free for all hands — the racks are stripped',
    () => 'every adult on this deck is carrying now. no more bystanders',
  ],
  coDown: [
    () => 'command net silent. the CO is down. say again — the CO is down',
    () => 'we lost the commander. CIC is not answering',
    () => 'the old man\'s channel just went dead. nobody is running this net now',
    () => 'be advised: command is gone. we are on our own',
    () => 'no more orders coming. the CO didn\'t make it',
    () => 'CIC has gone quiet. assume command casualties. hold where you are',
  ],
  cdrOrder: [
    (sq, r) => `squad ${sq}, push to ${r} — contact reported, sweep and clear`,
    (sq, r) => `squad ${sq}, this is actual — move to ${r} and engage`,
    (sq, r) => `re-tasking squad ${sq}: ${r}, weapons free`,
    (sq, r) => `squad ${sq}, we have a confirmed report at ${r}. take it back`,
    (sq, r) => `all units copy — squad ${sq} moves on ${r}`,
    (sq, r) => `squad ${sq}, ${r}, double-time. don't let it dig in`,
    (sq, r) => `squad ${sq}, break off and clear ${r} — report when done`,
    (sq, r) => `contact logged at ${r}. squad ${sq}, it's yours`,
  ],
  respond: [
    (r) => `we are responding to distress in ${r}`,
    (r) => `copy the mayday — moving to ${r} now`,
    (r) => `en route to ${r}, hold what you've got`,
    (r) => `we're coming to you — ${r}, two minutes`,
    (r) => `heard you, ${r}. we're on our way`,
    (r) => `moving to reinforce ${r}`,
    (r) => `${r}, help is coming — keep shooting`,
    (r) => `double-timing it to ${r}`,
    (r) => `on our way to ${r} — watch your crossfire when we come in`,
    (r) => `hang on ${r}, we are inbound`,
  ],
  // the door rotation, heard as the crew hears it (user: the raw sim line
  // "a door mechanism seizes between X and Y" read as third-person leftover)
  doorJam: [
    (a, b) => `the door between ${a} and ${b} just slammed itself shut — it won't budge`,
    (a, b) => `door mechanism's seized between ${a} and ${b}. we're cut off that way`,
    (a, b) => `that door between ${a} and ${b} just ground shut on its own. it's stuck fast`,
    (a, b) => `lost the door between ${a} and ${b} — motor's dead, panel's dark`,
    (a, b) => `the ${a} door just froze mid-track on the ${b} side. it is NOT opening`,
    (a, b) => `door's stuck between ${a} and ${b}. find another way around`,
    (a, b) => `great. the door between ${a} and ${b} picked NOW to die`,
    (a, b) => `something in the track let go — ${a} to ${b} is sealed tight`,
  ],
  doorFree: [
    (a, b) => `the jammed door between ${a} and ${b} just popped free`,
    (a, b) => `door between ${a} and ${b} is moving again — must've shaken itself loose`,
    (a, b) => `that stuck door between ${a} and ${b} finally gave. it's open`,
    (a, b) => `the ${a} door ground back open on its own. I don't trust it`,
    (a, b) => `door's cycling again between ${a} and ${b}`,
    (a, b) => `whatever seized the ${a} door let go — it just slid open`,
  ],
  // friendly-fire discipline (user: marines hold and reposition when a
  // squadmate wanders into the lane — and pay for it in blood when the
  // chaos wins anyway)
  checkFire: [
    (r) => `hold fire, hold fire — got a man in my lane in ${r}!`,
    (r) => `check your lanes in ${r}, we are crossing each other!`,
    (r) => `can't shoot — friendly in my line in ${r}. moving for an angle`,
    (r) => `watch your spacing in ${r}! I keep losing my lane`,
    (r) => `shifting left for a clear lane in ${r} — nobody wander into my fire`,
    (r) => `you're in my line! step out, step OUT — ${r}`,
  ],
  ffHit: [
    (r) => `CHECK YOUR FIRE! CHECK YOUR FIRE! man hit in ${r}!`,
    (r) => `who's shooting?! you just clipped one of ours in ${r}!`,
    (r) => `blue on blue in ${r}! I say again, blue on blue!`,
    (r) => `cease fire, cease fire — we're hitting our own in ${r}!`,
    (r) => `friendly hit in ${r} — watch your damn lanes!`,
    (r) => `round just took a piece of my squadmate — ${r}, tighten it UP!`,
  ],
  confirmKill: [
    (r) => `making sure the downed one in ${r} stays down`,
    (r) => `double-tap on the body in ${r}. learned that the hard way`,
    (r) => `putting another burst in the one we dropped in ${r}`,
    (r) => `confirming the kill in ${r} — we don't take chances anymore`,
    (r) => `it doesn't get back up this time. ${r} secure`,
    (r) => `round in every body in ${r}. new policy`,
    (r) => `the one in ${r} won't be standing up again`,
    (r) => `securing the downed contact in ${r} before it decides otherwise`,
  ],
};
const say = (key, ...args) => { const p = VOICES[key]; return p[(Math.random() * p.length) | 0](...args); };
let _firstContacts = 0; // the first few flood calls read as confusion, not procedure
function gameLogView(e) {
  const room = e.node >= 0 ? sim.graph.node(e.node).name : null;
  const throttle = (key, sec = 20) => {
    if (e.t - (_ominousAt[key] ?? -999) < sec) return false;
    _ominousAt[key] = e.t;
    return true;
  };
  const msg = e.msg;
  switch (e.type) {
    case 'hive': case 'carrier': case 'bait': case 'vent':
      return null; // the hive does not report to the bridge
    case 'init':
      return { ...e, spk: 'FLEETCOM' };
    case 'end':
      return e; // endgame banner, not radio
    case 'ambush': {
      const w = witnessNear(e.node);
      return room ? rx(e, w, say('ambush', room), { type: 'combat' }) : e;
    }
    case 'convert': {
      if (!room || !throttle('c' + e.node)) return null;
      const w = witnessNear(e.node);
      return rx(e, w, say(msg.includes('taken') ? 'taken' : 'strange', room));
    }
    case 'rampage': {
      if (!room || !throttle('m' + e.node, 15)) return null;
      const w = witnessNear(e.node);
      return rx(e, w, say('rampage', room), { type: 'combat' });
    }
    case 'revive': case 'reanimate': {
      if (!room || !throttle('r' + e.node)) return null;
      const w = witnessNear(e.node);
      return rx(e, w, say('revive', room));
    }
    case 'duct': {
      // someone has to be close enough to HEAR the ductwork, then transmit,
      // then you have to receive it
      const w = witnessNear(e.node);
      return rx(e, w, say('duct', room ?? 'my position'));
    }
    case 'combat': {
      if (msg.includes('(you)') || msg.startsWith('you ')) return e; // your own actions, no radio
      if (msg.startsWith('a marine falls')) {
        const w = witnessNear(e.node, (a) => a.faction === 2 || a.faction === 1);
        return rx(e, w, say('manDown', room ?? 'here'), { type: 'combat' });
      }
      if (msg.includes('arms up at the armory')) {
        return rx(e, odstSpeaker(), say('armoryArms'), { always: !sim.armoryLocked });
      }
      if (msg.includes('make sure of a downed form')) {
        // the confirm-kill habit, reported over the same unreliable net —
        // and throttled: a sweep through a room is one report, not five
        if (!throttle('k' + e.node, 25)) return null;
        const w = witnessNear(e.node, (a) => a.faction === 2);
        return rx(e, w, say('confirmKill', room ?? 'here'));
      }
      return e;
    }
    case 'burn': {
      const w = witnessNear(e.node, (a) => a.faction === 2);
      return rx(e, w, room ? say('burn', room) : msg);
    }
    case 'sweep': case 'morale': {
      const s = squadSpeaker(msg);
      return rx(e, s, msg, { type: e.type });
    }
    case 'radio': {
      if (msg.includes('(you)') || msg.startsWith('your fireteam') || msg.startsWith('fireteam:')) return e;
      if (msg.startsWith('ARMORY SEAL RELEASED')) {
        return rx(e, odstSpeaker(), 'armory seal released — ODST reserve deploying. racks are open', { always: true });
      }
      if (msg.startsWith('command net silent')) {
        // the whole net notices the command channel drop — always lands
        return rx(e, null, say('coDown'), { always: true, spk: 'NET' });
      }
      if (msg.startsWith('CDR orders')) {
        const m2 = msg.match(/^CDR orders squad (\d+) to (.+) — /);
        const cdr = sim.cdrId !== undefined ? sim.byId.get(sim.cdrId) : null;
        if (m2 && cdr) {
          const p = VOICES.cdrOrder;
          return rx(e, cdr, p[(Math.random() * p.length) | 0](m2[1], m2[2]));
        }
        return e;
      }
      {
        const dj = msg.match(/^a door mechanism seizes between (.+) and (.+)$/);
        if (dj) return rx(e, witnessNear(e.node), say('doorJam', dj[1], dj[2]));
        const df = msg.match(/^the jammed door between (.+) and (.+) grinds free$/);
        if (df) return rx(e, witnessNear(e.node), say('doorFree', df[1], df[2]));
        const cf = msg.match(/^check your fire — friendlies in the lane in (.+)$/);
        if (cf) return rx(e, witnessNear(e.node), say('checkFire', cf[1]));
        const fh = msg.match(/^a stray round hits a friendly in (.+)$/);
        if (fh) return rx(e, witnessNear(e.node), say('ffHit', fh[1]), { type: 'combat' });
      }
      if (msg.startsWith('distress call')) {
        const w = witnessNear(e.node);
        // the first few contact calls of the run are CONFUSION, not procedure
        // — nobody knows what these things are yet (user: "what the hell are
        // these things", "it's not Covenant")
        if (_firstContacts < 3) {
          _firstContacts++;
          return rx(e, w, say('firstContact', room ?? 'here'), { type: 'combat' });
        }
        return rx(e, w, say('distress', room ?? 'here'), { type: 'combat' });
      }
      if (msg.startsWith('FALL BACK')) {
        // CIC all-hands broadcast — strong transmitter, but the same rules:
        // command deck is deck 1; if you're below and the net drops it, you
        // find out when the stragglers do
        const cic = { deck: 1, callsign: null };
        return rx(e, cic, msg.toLowerCase().replace('fall back', 'FALL BACK'), { spk: 'CIC' });
      }
      if (msg.includes('souls heard the call') || msg.includes('stragglers')) {
        return rx(e, { deck: 1 }, msg, { spk: 'CIC' });
      }
      {
        const d1 = msg.match(/^Deck 1 net redirects (\d+) sentr(?:y|ies) to (.+)$/);
        if (d1) {
          return rx(e, { deck: 1, callsign: null },
            `${d1[1]} sentries moving to ${d1[2]}`, { spk: 'D1 NET' });
        }
      }
      if (msg.includes('missed a distress call')) return null; // non-receipt IS silence now
      if (msg.includes('word of the outbreak')) return null;   // omniscient narration
      if (msg.startsWith('squad') || msg.startsWith('patrol')) {
        const s = squadSpeaker(msg);
        const dm = msg.match(/responding to distress in (.+)$/);
        if (dm) return rx(e, s, say('respond', dm[1]));
        return rx(e, s, msg.replace(/^(squad|patrol) \d+ /, 'we are '));
      }
      if (msg.includes('spore fog') || msg.includes('power flickers')) {
        const w = witnessNear(e.node);
        return rx(e, w, say(msg.includes('power') ? 'powerBack' : 'airClear', room ?? 'this section'));
      }
      const w = e.node >= 0 ? witnessNear(e.node) : null;
      return w ? rx(e, w, msg) : e;
    }
    default:
      return e;
  }
}
function renderLog() {
  // lastEvent is an ABSOLUTE counter matched against sim.eventTotal, with
  // sim.eventBase mapping into the (splice-capped) events array — the old
  // array-length compare wedged the log for 200 events every time the 1600
  // cap hit, then silently skipped them (user report: log stuck at min 12)
  const total = sim.eventTotal ?? sim.events.length;
  // no new events -> touch NOTHING (swarm finding: the scroll-metric reads
  // below force a synchronous reflow, and they ran every frame)
  if (lastEvent >= total) return;
  const base = sim.eventBase ?? 0;
  if (lastEvent < base) lastEvent = base; // events already aged off the buffer
  const log = el('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  let added = false;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  while (lastEvent < total) {
    const raw = sim.events[lastEvent++ - base];
    // PHYSICAL side-effects of raw events, independent of radio receipt:
    // blood marks where people are taken or fall, the 1MC PA for shipwide
    // orders (the speakers are in every compartment — no radio needed)
    // BLOOD LANDS ON THE BODY (user: splats belong right over the reanimated
    // bodies). The sim now carries the exact spot on the event — before this,
    // conversions passed NO node at all (so they left no mark whatsoever) and
    // the marine-falls mark was stamped at the room's geometric centre, which
    // in a hangar is tens of metres from the corpse.
    if (raw.node >= 0 && (raw.type === 'convert' || raw.type === 'reanimate'
      || (raw.type === 'combat' && raw.msg.startsWith('a marine falls')))) {
      const nd = sim.graph.node(raw.node);
      const [bx, bz] = world.simToWorld(raw.x ?? nd.x, raw.y ?? nd.y, nd.deck);
      // a body that gets back up drags a fresh pool out from under itself
      blood.add(bx, bz, elevOf(nd.deck), lastEvent * 7919, raw.type === 'convert' ? 1.25 : 1);
    }
    if (raw.type === 'radio' && (raw.msg.startsWith('FALL BACK') || raw.msg.startsWith('ARMORY SEAL'))) {
      audio.play('pa', null, 0.55, 'pa', 6000);
    }
    const e = gameLogView(raw);
    if (!e) continue;
    const div = document.createElement('div');
    div.className = `ev ev-${e.type}`;
    const spk = e.spk ? `<span class="spk">[${esc(e.spk)}]</span> ` : '';
    div.innerHTML = `<span class="t">${fmtTime(e.t)}</span> ${spk}${esc(e.msg)}`;
    log.appendChild(div);
    added = true;
  }
  if (added) {
    while (log.childNodes.length > 400) log.removeChild(log.firstChild);
    // a huge scrollTop clamps to the bottom WITHOUT reading scrollHeight —
    // the read after the appends above forced a second synchronous reflow
    // on every frame that logged an event (perf pass 3)
    if (atBottom) log.scrollTop = 1e9;
  }
}

// RETICLE NAMEPLATE (user): point at anyone — living crew, a corpse on the
// deck, or the combat form sprinting at you — and their rank+name floats
// above them. Conversions keep the host's callsign, so the thing wearing
// Pvt Jenkins still reads PVT JENKINS. Infection forms were never anyone.
const _npDir = new THREE.Vector3();
const _npVec = new THREE.Vector3();
const _npRay = new THREE.Raycaster();
let _npSticky = null; // hysteresis: the current target keeps a wider cone
let _npAt = 0; // target-selection throttle clock (swarm finding: the full
// agent scan + no-BVH triangle raycast ran every frame; ~15Hz is invisible
// with the sticky hysteresis, and the cached target reprojects every frame)
let _npBest = null;
// --- CO-OP TEAMMATE MARKERS (user: "it needs to be very obvious who the
// other human players are, on the map and on the screen"). One marker per
// remote player, drawn every frame with no occlusion test: through walls,
// through decks, and clamped to the screen edge as an arrow when they are
// off-camera or behind you. Colour is assigned by sorted DID, so every client
// agrees on who is cyan and who is amber, and the tacnet map uses the same
// table. At most three of these exist (MAX_PLAYERS 4), so the per-frame cost
// is three projections and a few style writes.
const MATE_COLORS = ['#4dd2ff', '#ffcf5a', '#b98cff', '#7fd1a0'];
const mates = [];
{
  const layer = el('mates');
  const dids = [...new Set(LAUNCH.members || [])].sort();
  dids.forEach((did, i) => {
    if (!LAUNCH.session || did === LAUNCH.session.did) return;
    const agent = networkPlayers.get(did);
    if (!agent || !layer) return;
    const node = document.createElement('div');
    node.className = 'mate';
    node.innerHTML = '<div class="mate-pip"></div><div class="mate-name"></div>'
      + '<div class="mate-sub"></div><div class="mate-bar"><i></i></div>';
    node.style.color = MATE_COLORS[i % MATE_COLORS.length];
    layer.appendChild(node);
    mates.push({
      did, agent, node,
      nameEl: node.querySelector('.mate-name'),
      subEl: node.querySelector('.mate-sub'),
      barEl: node.querySelector('.mate-bar > i'),
      color: MATE_COLORS[i % MATE_COLORS.length],
      label: `P${i + 1}`,
    });
  });
}
// THE COMMS ROSTER, bottom right. Rebuilt once (rows are stable for the
// session) and then only its text/classes are touched, at 8 Hz — a roster is
// not worth a per-frame relayout.
const commsRows = [];
{
  const box = el('comms'), rows = el('commsRows');
  if (box && rows && LAUNCH.session && mates.length) {
    box.style.display = 'block';
    const self = document.createElement('div');
    self.className = 'cm';
    self.style.color = '#f2f6ff';
    self.innerHTML = '<i class="cm-dot"></i><span class="cm-name">YOU</span><span class="cm-mic"></span>';
    rows.appendChild(self);
    commsRows.push({ self: true, node: self, micEl: self.querySelector('.cm-mic') });
    for (const m of mates) {
      const node = document.createElement('div');
      node.className = 'cm';
      node.style.color = m.color;
      node.innerHTML = '<i class="cm-dot"></i><span class="cm-name"></span><span class="cm-mic"></span>';
      rows.appendChild(node);
      commsRows.push({
        did: m.did, mate: m, node,
        nameEl: node.querySelector('.cm-name'), micEl: node.querySelector('.cm-mic'),
      });
    }
  }
}
// NO SECOND MIC CAPTURE (co-op report: voice went from one-way to dead in
// BOTH directions after this shipped). Measuring our own level for the
// SPEAKING dot meant a second getUserMedia on the same device alongside the
// one the voice stack is already holding — two captures, one microphone,
// and on this hardware it took the call down with it. The indicator is not
// worth the call: the roster reports MIC / MUTED from the voice stack's own
// status instead, and `talking` stays false until the voice layer can hand
// us a real level.
let _commsAt = 0;
function updateComms(now) {
  if (!commsRows.length || now - _commsAt < 125) return;
  _commsAt = now;
  for (const row of commsRows) {
    if (row.self) {
      row.node.className = player.talking ? 'cm talking' : 'cm';
      row.micEl.textContent = !voiceActive ? '' : voiceMuted ? 'MUTED' : 'MIC';
      continue;
    }
    const talking = !!gameSync?.peerTalking(row.did);
    const live = !!gameSync?.peerLive(row.did);
    const dead = row.mate.agent?.dead;
    row.node.className = `cm${talking ? ' talking' : ''}${dead || !live ? ' gone' : ''}`;
    row.nameEl.textContent = (gameSync?.peerName(row.did) || row.mate.label).toUpperCase();
    row.micEl.textContent = dead ? 'DOWN' : !live ? '···' : talking ? 'SPEAKING' : '';
  }
}
const _mateVec = new THREE.Vector3();
function updateMates() {
  if (!mates.length) return;
  const EDGE = 42;
  for (const m of mates) {
    const a = m.agent;
    if (!a || a.dead) { m.node.style.display = 'none'; continue; }
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const base = world.groundHeightAt(a.deck, wx, wz);
    _mateVec.set(wx, base + 2.1, wz).project(camera);
    const behind = _mateVec.z > 1;
    let sx = (_mateVec.x * 0.5 + 0.5) * canvasW;
    let sy = (-_mateVec.y * 0.5 + 0.5) * canvasH;
    // a point behind the camera projects MIRRORED — flip it before clamping
    // or the edge arrow points at the opposite wall
    if (behind) { sx = canvasW - sx; sy = canvasH - sy; }
    const outside = behind || sx < EDGE || sx > canvasW - EDGE || sy < EDGE || sy > canvasH - EDGE;
    let rot = 0;
    if (outside) {
      const cx = canvasW / 2, cy = canvasH / 2;
      const dx = sx - cx, dy = sy - cy;
      const scale = Math.min(
        (canvasW / 2 - EDGE) / Math.max(1e-3, Math.abs(dx)),
        (canvasH / 2 - EDGE) / Math.max(1e-3, Math.abs(dy)),
      );
      sx = cx + dx * scale; sy = cy + dy * scale;
      rot = Math.atan2(dy, dx) - Math.PI / 2; // the pip is a triangle pointing up
    }
    const dist = Math.hypot(wx - player.x, wz - player.z);
    const dd = a.deck - player.deck;
    m.node.style.display = 'block';
    m.node.className = outside ? 'mate off' : 'mate';
    m.node.style.left = `${Math.round(sx)}px`;
    m.node.style.top = `${Math.round(sy)}px`;
    m.node.style.transform = `translate(-50%, -50%) rotate(${outside ? rot : 0}rad)`;
    m.nameEl.textContent = (gameSync?.peerName(m.did) || m.label).toUpperCase();
    m.subEl.textContent = dd === 0 ? `${Math.round(dist)}m`
      : `${Math.round(dist)}m ${dd > 0 ? '▼' : '▲'}${Math.abs(dd)}`;
    m.barEl.style.width = `${Math.max(0, Math.min(1, a.hp / (a.maxHp || 1))) * 100}%`;
    // the text must stay upright even when the arrow is rotated
    const upright = outside ? `rotate(${-rot}rad)` : '';
    m.nameEl.style.transform = upright;
    m.subEl.style.transform = upright;
  }
}

function updateNameplate() {
  const np = el('nameplate');
  if (player.dead) { np.style.display = 'none'; return; }
  const nowNp = performance.now();
  if (nowNp - _npAt > 66) {
    _npAt = nowNp;
    _npBest = pickNameplateTarget();
    _npSticky = _npBest?.a ?? null;
  }
  const best = _npBest;
  if (!best || best.a.dead) { np.style.display = 'none'; return; }
  const a = best.a;
  _npVec.set(best.wx, best.labelY, best.wz).project(camera);
  if (_npVec.z > 1) { np.style.display = 'none'; return; }
  np.style.left = `${(_npVec.x * 0.5 + 0.5) * canvasW}px`;
  np.style.top = `${Math.max(20, (-_npVec.y * 0.5 + 0.5) * canvasH)}px`;
  np.className = a.faction === 4 || a.faction === 5 ? 'np-flood'
    : a.faction === 6 ? 'np-corpse'
      : a.faction === 2 || a.odst ? 'np-marine' : 'np-crew';
  np.textContent = `${a.callsign.rank} ${a.callsign.name}`.toUpperCase();
  np.style.display = 'block';
}
function pickNameplateTarget() {
  camera.getWorldDirection(_npDir);
  let best = null, bestScore = 1;
  for (const a of sim.agents) {
    if (a.isPlayer || !a.callsign || a.deck !== player.deck) continue;
    const low = a.faction === 6 || a.downed; // corpses and downed forms lie on the deck
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    // anchor on the actual surface underfoot (stair ring, raised launch
    // apron) — a flat deck elevation put plates inside raised floors
    const base = world.groundHeightAt(a.deck, wx, wz);
    _npVec.set(wx, base + (low ? 0.3 : 1.45), wz).sub(camera.position);
    const dist = _npVec.length();
    if (dist > 32 || dist < 0.4) continue;
    _npVec.divideScalar(dist);
    const err = Math.hypot(_npVec.x - _npDir.x, _npVec.y - _npDir.y, _npVec.z - _npDir.z);
    // the cone widens up close (a body fills the screen at arm's length):
    // accept ~0.7m of lateral miss at any range, floor ~5 degrees far out;
    // the target you already have holds on with a wider cone so a shuffling
    // marine at arm's length doesn't strobe the plate
    const cone = Math.max(0.09, 0.7 / dist) * (a === _npSticky ? 1.8 : 1);
    if (err < cone && err / cone < bestScore) {
      bestScore = err / cone;
      best = { a, wx, wz, dist, labelY: base + (low ? 0.6 : 2.05) };
    }
  }
  if (best) {
    // DIRECT LINE OF SIGHT ONLY (user rule): a wall between you and them
    // kills the plate. The far margin is razor-thin — a crewman hugging the
    // other side of a wall used to slip his chest point past a fat margin
    // and read through the plating. Closed door panels count as walls too.
    _npVec.set(best.wx, best.labelY - 0.6, best.wz).sub(camera.position).normalize();
    _npRay.set(camera.position, _npVec);
    _npRay.far = best.dist - 0.06;
    if (_npRay.intersectObjects(world.wallMeshes, false).length
      || _npRay.intersectObjects(world.doorPanelMeshes ?? [], false).length) best = null;
  }
  return best;
}

// debug: raycast from the camera in a direction, report what's hit
window.__probe = (dx, dy, dz) => {
  const rc = new THREE.Raycaster(camera.position.clone(), new THREE.Vector3(dx, dy, dz).normalize());
  rc.far = 40;
  const solids = scene.children.filter((o) => o.isMesh && !o.isInstancedMesh);
  return rc.intersectObjects(solids, false).slice(0, 5).map((h) => ({
    d: +h.distance.toFixed(2), type: h.object.type,
    col: h.object.material?.color?.getHexString?.(), vis: h.object.visible,
  }));
};
// perf instrumentation (headless harness + on-device debugging)
window.__perf = () => {
  let meshes = 0, lights = 0;
  scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) meshes++;
    if (o.isLight && (o.intensity ?? 0) > 0.01) lights++;
  });
  return {
    calls: renderer.info.render.drawCalls, tris: renderer.info.render.triangles,
    meshes, lights, pr: renderer.getPixelRatio(), rung,
    backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
  };
};

// canvas client size, cached on resize (perf pass 3): the per-frame
// clientWidth/clientHeight reads in the nameplate and reticle paths forced
// a synchronous reflow right after the frame's HUD writes dirtied layout —
// the classic write-then-read layout thrash, every combat frame. The canvas
// is inset:0 so the window size IS the client size.
let canvasW = 1280, canvasH = 720;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  canvasW = w; canvasH = h;
  renderer.setSize(w, h, false);
  post.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
let _vpW = window.innerWidth, _vpH = window.innerHeight;
window.addEventListener('resize', () => { _vpW = window.innerWidth; _vpH = window.innerHeight; });
window.addEventListener('resize', resize);
resize();

// --- firing: MA5 events route into the sim's own damage model. Every shot
// is LOUD. Through-deck shots work when you and the target share an open
// vertical shaft's line ---
let fireHeld = false, gamepadFireHeld = false, reloadPressed = false, meleePressed = false;
let gamepadPaused = false;
let gamepadMapNavX = 0;
let gamepadOverlayNav = 0;
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) fireHeld = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) fireHeld = false; });
let fragPressed = false;
let frags = FRAG.count;
// WEAPON SWAP. The mechanic already worked on Q; what it lacked was anyone
// knowing it (user asked for "a way to weapon switch between the flamethrower
// and the ar if you have both" while Q was already doing exactly that). One
// function so the key and the wheel cannot drift apart.
let _swapAt = 0;
// Both inputs land here, and it SELECTS a slot rather than toggling one — the
// wheel needs that (see below) and the key loses nothing by it.
function selectWeapon(wantFlamer) {
  if (!hasFlamer || player.dead || wantFlamer === heldIsFlamer) return;
  heldIsFlamer = wantFlamer;
  _swapAt = performance.now();
}
function swapWeapon() { selectWeapon(!heldIsFlamer); } // Q: one press, one swap
// wheel is the FPS convention and the first thing a player tries. DIRECTION
// PICKS THE GUN — down for the torch, up for the rifle — because a toggle
// cannot survive a precision trackpad: one flick emits momentum wheel events
// for a second or more, so a toggle lands on whatever parity the burst happens
// to end on (effectively random with two weapons) with the viewmodel popping
// between MA5 and flamer the whole way down. A debounce only hides the first
// 220 ms of that. Selecting is idempotent: the twentieth event of a burst asks
// for the same weapon the first one did, so no debounce is needed at all.
window.addEventListener('wheel', (e) => {
  // pointer lock keeps it from swapping your gun while you scroll the launcher
  // page behind ESC; mapOpen because the tac map does NOT release the lock and
  // reading it is a scroll — the weapon would change under you while you read.
  if (!introGone || !player.locked || player.dead || mapOpen) return;
  // deltaY ONLY: a two-finger horizontal swipe or a tilt-wheel nudge passed the
  // old `|deltaY| < 1 && |deltaX| < 1` test and swapped the gun mid-fight.
  if (Math.abs(e.deltaY) < 1) return;
  selectWeapon(e.deltaY > 0);
}, { passive: true });
window.addEventListener('keydown', (e) => {
  if (!introGone) return; // still on the briefing — keys only skip the typing
  if (ended && overlay.classList.contains('hidden') && e.code === 'Enter') {
    e.preventDefault();
    toggleMap(false);
    el('postgameHud').style.display = 'none';
    overlay.classList.remove('hidden');
    return;
  }
  if (ended && !overlay.classList.contains('hidden')) {
    if (e.code === 'Tab') {
      e.preventDefault();
      moveOverlayTabFocus(e.shiftKey ? -1 : 1);
      return;
    }
    if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.code)) {
      e.preventDefault();
      moveOverlayFocus(e.code === 'ArrowLeft' || e.code === 'ArrowUp' ? -1 : 1);
      return;
    }
  }
  if (e.code === 'KeyM') {
    if (ended) {
      overlay.classList.add('hidden');
      el('postgameHud').style.display = 'block';
    }
    toggleMap();
    return;
  }
  if (mapOpen) {
    const deck = /^[1-5]$/.test(e.key) ? e.key : /^Digit([1-5])$/.exec(e.code)?.[1];
    if (deck) selectMapDeck(Number(deck));
    if (e.code === 'ArrowLeft') selectMapDeck(Math.max(1, marineMap.selectedDeck() - 1));
    if (e.code === 'ArrowRight') selectMapDeck(Math.min(5, marineMap.selectedDeck() + 1));
    return;
  }
  // ONE ACTION KEY, matching controller RB: a live context gets E first;
  // without one, the same press reloads.
  if (e.code === 'KeyE' && !e.repeat
    && singleActionPress(true, contextualActionAvailable()).reloadPressed) reloadPressed = true;
  if (e.code === 'KeyF') meleePressed = true;
  if (e.code === 'KeyG') fragPressed = true;
  if (e.code === 'KeyK') toggleSoundBoard();
  if (e.code === 'KeyJ') toggleAudioLog();
  if (e.code === 'KeyH') toggleFloodHud();
  // WEAPON SWAP: Q. NOT 1/2 — those are the fireteam order keys (follow /
  // hold / advance) and binding a weapon to them would fire both actions off
  // one press. Silently ignored until you have actually found a flamethrower.
  if (e.code === 'KeyQ') swapWeapon();
  // AMMO ECONOMY (user): T hands a mag from your reserve to the neediest
  // fireteam marine in reach — they burn real magazines now (combat.js)
  if (e.code === 'KeyT') giveMagazine();
  // FIRETEAM ORDERS (review P1): the sim's command layer, on your keys
  if (!player.dead && player.locked) {
    if (e.code === 'Digit1') setOrder('follow');
    else if (e.code === 'Digit2') setOrder('hold');
    else if (e.code === 'Digit3') setOrder('advance');
  }
});

function giveMagazine() {
  if (player.dead || weapon.reserve < 32) return;
  if (sim.giveMag(player.agent)) weapon.reserve -= 32;
}

function contextualActionAvailable() {
  if (player.dead) return false;
  return !!(player.flamerSource(hasFlamer, flamer.frac)
    || player.medkitSource()
    || player.armorSource()
    || player.grenadeSource(frags, FRAG.max)
    || player.ammoSource()
    || world.trunkAt(player.deck, player.x, player.z));
}

function moveOverlayFocus(direction) {
  const controls = [...overlay.querySelectorAll('#victoryCard button')];
  if (!controls.length) return;
  const current = controls.indexOf(document.activeElement);
  const fallback = controls.findIndex((button) => button.dataset.primary === 'true');
  const index = current < 0 ? Math.max(0, fallback)
    : (current + direction + controls.length) % controls.length;
  controls[index].focus({ preventScroll: true });
}

function moveOverlayTabFocus(direction) {
  const controls = [...overlay.querySelectorAll('#victoryCard textarea, #victoryCard button')];
  if (!controls.length) return;
  const current = controls.indexOf(document.activeElement);
  const fallback = controls.findIndex((control) => control.dataset.primary === 'true');
  const index = current < 0 ? Math.max(0, fallback)
    : (current + direction + controls.length) % controls.length;
  controls[index].focus({ preventScroll: true });
}

function pauseGamepadControls() {
  if (ended || gamepadPaused) return;
  gamepadPaused = true;
  gamepadFireHeld = false;
  player.setGamepadInput(null);
  document.exitPointerLock?.();
  el('ovTitle').textContent = 'CONTROLS RELEASED';
  el('ovText').textContent = LAUNCH.session
    ? 'The fireteam and ship simulation continue while your controls are released.'
    : 'The ship simulation continues while your controls are released.';
  overlay.dataset.screen = 'pause';
  refreshOverlayPrompt();
  overlay.classList.remove('hidden');
}

function resumeGamepadControls() {
  if (!gamepadPaused) return;
  gamepadPaused = false;
  delete overlay.dataset.screen;
  overlay.classList.add('hidden');
  audio.ensure();
}

function handleGamepad(state, dt) {
  if (state.used) setInputMode('gamepad');
  if (!state.connected || inputMode !== 'gamepad') {
    gamepadFireHeld = false;
    player.setGamepadInput(null);
    return;
  }

  if (!introGone) {
    gamepadFireHeld = false;
    player.setGamepadInput(null);
    if (briefing.done) introHint.textContent = inputPrompt('CLICK TO DEPLOY', 'A — DEPLOY');
    if (state.used && !briefing.done) {
      briefing.complete();
    } else if (briefing.done) {
      const lookScroll = Math.abs(state.lookY) > 0.3 ? state.lookY * 12 : 0;
      introScroll.scrollTop += state.navY * 8 + lookScroll;
      if (state.pressed('a')) dismissIntro();
    }
    return;
  }

  if (gamepadPaused) {
    gamepadFireHeld = false;
    player.setGamepadInput(null);
    refreshOverlayPrompt();
    if (state.pressed('view')) {
      resumeGamepadControls();
      toggleMap(true);
    } else if (state.pressed('y') && LAUNCH.session && voiceActive && !voiceBlocked) {
      gameVoice.click();
    } else if (state.pressed('a') || state.pressed('menu')) resumeGamepadControls();
    return;
  }

  if (!overlay.classList.contains('hidden')) {
    gamepadFireHeld = false;
    player.setGamepadInput(null);
    refreshOverlayPrompt();
    if (ended) {
      const nav = state.navY || state.navX;
      if (nav && nav !== gamepadOverlayNav) moveOverlayFocus(nav > 0 ? 1 : -1);
      gamepadOverlayNav = nav;
      if (state.pressed('a')) {
        const focused = document.activeElement;
        if (focused?.closest?.('#victoryCard')) focused.click();
        else moveOverlayFocus(1);
      }
    } else if (state.pressed('a')) {
      overlay.classList.add('hidden');
      delete overlay.dataset.screen;
    }
    return;
  }
  gamepadOverlayNav = 0;

  if (state.pressed('menu')) {
    pauseGamepadControls();
    return;
  }
  if (state.pressed('view')) toggleMap();
  if (mapOpen) {
    gamepadFireHeld = false;
    player.setGamepadInput(null);
    if (state.pressed('b')) toggleMap(false);
    else if (state.navX && state.navX !== gamepadMapNavX) {
      selectMapDeck(Math.max(1, Math.min(5, marineMap.selectedDeck() + state.navX)));
    }
    gamepadMapNavX = state.navX;
    return;
  }
  gamepadMapNavX = 0;

  const actions = halo3Actions(state, contextualActionAvailable());
  player.setGamepadInput({
    active: true,
    moveX: state.moveX,
    moveY: state.moveY,
    lookX: state.lookX,
    lookY: state.lookY,
    sprint: state.held('leftStick'),
    jump: actions.jumpHeld,
    jumpPressed: actions.jumpPressed,
    interact: actions.interactHeld,
    interactPressed: actions.interactPressed,
  });
  player.stepGamepadLook(dt);
  gamepadFireHeld = actions.fireHeld;
  if (!player.dead && player.locked) {
    if (actions.reloadPressed) reloadPressed = true;
    if (actions.swapPressed) swapWeapon();
    if (actions.meleePressed) meleePressed = true;
    if (actions.grenadePressed) fragPressed = true;
    if (state.pressed('dpadUp')) setOrder('follow');
    else if (state.pressed('dpadLeft')) setOrder('hold');
    else if (state.pressed('dpadRight')) setOrder('advance');
    else if (state.pressed('dpadDown')) giveMagazine();
  }
}

// the neediest fireteam marine in hand-off reach, throttled to ~3Hz —
// drives the "T — hand a mag" hint (ammo economy)
let _dryNear = null, _dryNearAt = 0;
function dryEscortName() {
  if (performance.now() - _dryNearAt > 300) {
    _dryNearAt = performance.now();
    _dryNear = null;
    let bd = Infinity;
    for (const id of fireteam.members) {
      const m = sim.byId.get(id);
      if (!m || m.dead || m.hp <= 0 || m.mags === undefined) continue;
      if (m.mags * 32 + m.rounds > 40) continue; // only when genuinely low
      if (m.deck !== player.agent.deck) continue;
      const d = Math.hypot(m.x - player.agent.x, m.y - player.agent.y);
      if (d > 3.5 || d >= bd) continue;
      bd = d;
      _dryNear = m.callsign ? `${m.callsign.rank} ${m.callsign.name}`.toUpperCase() : 'your marine';
    }
  }
  return _dryNear;
}

function setOrder(kind) {
  const lead = fireteam.members.map((id) => sim.byId.get(id)).find((m) => m && !m.dead);
  if (!lead) return;
  if (kind === 'follow') {
    fireteam.order = { kind: 'order:escort', entityId: player.agent.id };
    sim.log('radio', 'fireteam: on me');
  } else if (kind === 'hold') {
    fireteam.order = { kind: 'order:guard', node: lead.node };
    sim.log('radio', `fireteam: hold ${sim.graph.node(lead.node).name}`);
  } else {
    // advance: send them at the room you're looking at (ray to nearest room
    // center in your facing cone, this deck)
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    let best = -1, bestScore = Infinity;
    for (const n of sim.graph.nodes) {
      if (n.deck !== player.deck || n.idx === player.agent.node) continue;
      const [nx, nz] = world.simToWorld(n.x, n.y, n.deck);
      const dx = nx - player.x, dz = nz - player.z;
      const d = Math.hypot(dx, dz);
      if (d > 60) continue;
      const dot = (dx * fx + dz * fz) / (d || 1);
      if (dot < 0.55) continue;
      const score = d * (2 - dot);
      if (score < bestScore) { bestScore = score; best = n.idx; }
    }
    if (best !== -1) {
      fireteam.order = { kind: 'order:move', node: best };
      sim.log('radio', `fireteam: advance to ${sim.graph.node(best).name}`);
    }
  }
  el('order').textContent = `FIRETEAM: ${kind.toUpperCase()}`;
}

const _dir = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hit = new THREE.Vector3();
function shotCandidates() {
  // REAL SPACE (user note): every flood body on your deck is a candidate —
  // the wall raycast decides occlusion, not room-graph membership. This is
  // what makes a form ten meters into the hangar shootable the moment you
  // can see it, instead of only after its pathfinder "arrives". Plus the far
  // room of any open vertical shaft whose column you're standing in.
  const out = [];
  const trunk = world.trunkAt(player.deck, player.x, player.z);
  const shaftNode = trunk && trunk.vertical
    ? (player.deck === trunk.lowerDeck ? trunk.upperNode : trunk.lowerNode) : -1;
  // GRAND STAIRWELL (user: PoA stairs): standing in a stairwell room, the
  // other level is fair game — the opening is a real hole, and player shots
  // pass through floors anyway, so the wall raycast decides the rest.
  let stairNode = -1;
  for (const s of sim.graph.stairwells) {
    if (player.agent.node === s.upper) stairNode = s.lower;
    else if (player.agent.node === s.lower) stairNode = s.upper;
  }
  for (const a of sim.agents) {
    if (a.dead) continue;
    if (a.faction !== 3 && a.faction !== 4 && a.faction !== 5) continue;
    if (a.move && (a.move.layer === 'vent' || a.move.layer === 'shaft') && a.move.hidden) continue; // hidden mid-crawl only; a form at the grate IS a target
    if (a.deck === player.deck || (shaftNode !== -1 && a.node === shaftNode) || a.node === stairNode) out.push(a);
  }
  return out;
}

// real physics for shots (user note): a bullet stops at the nearest solid
// wall or CLOSED door before it ever reaches an agent standing behind it —
// no shooting through bulkheads. Doors mid-slide count as solid too.
let _shotSolids = null;
function solidsForShot() {
  // door panels are two InstancedMeshes now — raycast hits any panel
  // (slid-open panels sit inside walls, which stop the ray themselves).
  // Both lists are fixed after world build — concat once, not per ray
  // (this ran per bullet at full-auto rate, per frame per live frag, and
  // per frame while the flamer burned)
  return _shotSolids ??= world.wallMeshes.concat(world.doorPanelMeshes ?? []);
}

// The body spheres the bullet swings at, shared with the butt-stroke so the
// two agree on how big a thing is: an infection form is a half-metre ball, a
// carrier a metre-wide bag, everything else a torso.
const bodyRadius = (a) => a.faction === 3 ? 0.5 : a.faction === 5 ? 1.0 : 0.7;

// The hit sphere rides the arc the EYE sees, not the sim's raw one: the
// renderer eases hoverY (agents3d rpos, ~70ms constant), so on a fast pounce
// the sim value runs ahead of the drawn body and a sphere built from it hangs
// above/below the visible form. Aim tests must agree with the pixels.
const hoverOf = (a) => {
  const rp = agents.rpos.get(a.id);
  return ((rp ? rp.hoverY : a.hoverY) || 0);
};

function traceShot(offAng = 0, offRad = 0, maxDist = 100, dmg = MA5.damage) {
  camera.getWorldDirection(_dir);
  _rt.crossVectors(_dir, camera.up).normalize();
  _up.crossVectors(_rt, _dir).normalize();
  _dir.addScaledVector(_rt, Math.cos(offAng) * offRad)
    .addScaledVector(_up, Math.sin(offAng) * offRad).normalize();
  const origin = camera.position;

  wallRay.set(origin, _dir);
  wallRay.far = maxDist;
  wallRay.near = 0.05;
  const wallHits = wallRay.intersectObjects(solidsForShot(), false);
  const wallT = wallHits.length ? wallHits[0].distance : Infinity;

  let best = null, bestT = Math.min(maxDist, wallT);
  for (const a of shotCandidates()) {
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    // + hoverY: a leaping body's hit sphere rides the arc WITH the body (user
    // report: "their hitbox doesnt seem to track them through the air" — the
    // renderer drew it at elev + hoverY while the bullet swung at the deck)
    const cy = elevOf(a.deck) + (a.faction === 3 ? 0.35 : a.downed ? 0.35 : 0.9) + hoverOf(a);
    _hit.set(wx, cy, wz).sub(origin);
    const t = _hit.dot(_dir);
    if (t < 0.05 || t > bestT) continue;
    const px = origin.x + _dir.x * t - wx, py = origin.y + _dir.y * t - cy, pz = origin.z + _dir.z * t - wz;
    const r = bodyRadius(a);
    if (px * px + py * py + pz * pz < r * r) { best = a; bestT = t; }
  }
  sim.gunfireAt(player.agent.node);
  const hitWallInstead = !best && wallT < maxDist;
  const travel = best ? bestT : (hitWallInstead ? wallT : Math.min(30, maxDist));
  const end = new THREE.Vector3().copy(origin).addScaledVector(_dir, travel);
  // the real muzzle tip (first-strike RIFLE_MUZZLE, carried through the
  // viewmodel's actual world transform) rather than an eyeball offset
  rifleMesh.updateWorldMatrix(true, false);
  const muzzle = RIFLE_MUZZLE.clone().applyMatrix4(rifleMesh.matrixWorld);
  agents.playerShot(muzzle, end);
  gameSync?.shot(muzzle, end);
  muzzleFlash.position.copy(muzzle);
  muzzleFlash.intensity = 8;
  if (best) {
    // parity (user rule): a combat form soaks the same fire from the player
    // as from any marine — its durability lives in the sim's hp, not in a
    // player-only multiplier
    hurtFloodForm(sim, best, dmg, false, player.agent.id);
    gameSync?.hitFlood(best.id, dmg);
    hitFlash = 1;
    audio.play('tick', null, 0.5, 'tick', 40);
  } else if (hitWallInstead) { wallSpark.position.copy(end); wallSpark.intensity = 6; }
  return !!best;
}

// --- melee: a butt-stroke, not a shot -------------------------------------
// This used to run through traceShot(), so every swing fired a tracer out of
// the muzzle, flashed the muzzle light, stamped sim.gunfireAt, and broadcast a
// gunshot to the other players in the mesh — the user's report was that melee
// "does a weird upward gun motion and fires a shot" instead of the barrel
// coming left as you strike with the butt of the gun. None of a rifle's shot
// path belongs here, and the fix is a separate strike rather than another flag
// threaded through the bullet code.
//
// NOISE: nothing at all. The sim has exactly two noise channels — gunfireTick
// (P.sensor.gunfireHops = 3, what marines and civilians move toward) and
// screamTick (hearingHops = 2, the literal scream channel that panics crew).
// A rifle butt is neither, and stamping either one would make the silent way
// to kill something as loud as the loud one. The form you hit still records
// lastHurtBy through hurtFloodForm, so it turns on YOU — one angry body, not
// the whole compartment.
//
// THE ARC (game/melee.js, checked headlessly) is a horizontal cone plus a
// vertical band measured from your FEET — see that file for why the band
// cannot hang off the camera, and for the reach numbers.
const _mdir = new THREE.Vector3(), _mto = new THREE.Vector3(), _mray = new THREE.Vector3();
function meleeStrike() {
  // dead men do not swing. weapon.step emits melee_hit a fifth of a second
  // into the swing, so dying mid-stroke has to be caught HERE and not only at
  // the key: a KIA player's 45 damage would otherwise land after the fact.
  if (player.dead) return false;
  camera.getWorldDirection(_mdir);
  const origin = camera.position;
  // the feet under the eye that the camera IS — during a climb transition
  // poseY() leaves the deck floor behind, and this follows it either way
  const feetY = origin.y - ODST.eyeHeight;
  const fl = Math.hypot(_mdir.x, _mdir.z) || 1; // facing, flattened (pitch removed)
  const fx = _mdir.x / fl, fz = _mdir.z / fl;
  // ONE target — a butt-stroke lands on the nearest thing in the arc. Unlike
  // the bullet path there is no ray-vs-sphere test: the arc is wide enough
  // that a form you are clearly swinging at connects even off the reticle.
  let best = null, bestD = Infinity;
  for (const a of shotCandidates()) {
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    // + hoverY, same as the bullet: a pouncing pod mid-arc is exactly the
    // thing you butt-stroke out of the air
    const cy = elevOf(a.deck) + (a.faction === 3 ? 0.35 : a.downed ? 0.35 : 0.9) + hoverOf(a);
    const d = meleeArcDistance(origin.x, origin.z, feetY, fx, fz,
      wx, cy, wz, bodyRadius(a), MA5.meleeRange);
    if (d < 0 || d >= bestD) continue;
    // same rule the bullet obeys (user note): no striking through a bulkhead
    // or a closed door. Tested per candidate, not once down the view axis, so
    // a form behind a wall cannot shadow the one actually within reach.
    _mto.set(wx, cy, wz).sub(origin);
    const d3 = _mto.length();
    _mray.copy(_mto).divideScalar(d3);
    wallRay.set(origin, _mray);
    wallRay.near = 0.05;
    wallRay.far = d3;
    if (wallRay.intersectObjects(solidsForShot(), false).length) continue;
    best = a; bestD = d;
  }
  if (!best) {
    return false;
  }
  // the ragdoll payload is the whole point of a melee kill — a charging or
  // airborne strike throws a body differently (sim/melee-check.mjs pins the
  // ordering), and hurtFloodForm carries it into the corpse
  const impact = combatMeleeImpulse(strikeAttacker(player.agent, player, ODST.walkSpeed),
    best, sim.P.combat.combatForm.swing);
  hurtFloodForm(sim, best, MA5.meleeDamage, false, player.agent.id, impact);
  // the DAMAGE replicates (peers must see the same body die) but no shot event
  // goes out — gameSync.shot would draw a tracer from your muzzle on three
  // other screens for a swing that never fired a round
  gameSync?.hitFlood(best.id, MA5.meleeDamage);
  hitFlash = 1;
  audio.play('tick', null, 0.5, 'tick', 40);
  return true;
}

// --- the flamethrower in your hands ---------------------------------------
// One frame of live stream. Unlike traceShot this is not a ray: it is a cone
// with a reach, so it bites everything inside it rather than the one thing
// under the reticle. Sequence per frame: find how far the stream actually
// gets (a wall stops it), burn what is inside the cone out to that distance,
// tell the sim the room is on fire and WHERE, and hand the geometry to the
// jet FX.
const _fdir = new THREE.Vector3(), _fto = new THREE.Vector3();
const _fmuzzle = new THREE.Vector3(), _fend = new THREE.Vector3();
let _flameJet = null;      // {ox,oy,oz,dx,dy,dz,len} for this frame, or null
let _flameSeed = 1;
let _flameAimSolution = null;

function solveFlameAim() {
  if (_flameAimSolution) return _flameAimSolution;
  camera.getWorldDirection(_fdir);
  const origin = camera.position;
  wallRay.set(origin, _fdir);
  wallRay.far = FLAME.rangeM;
  wallRay.near = 0.05;
  const hits = wallRay.intersectObjects(solidsForShot(), false);
  const reach = hits.length ? Math.max(0.6, hits[0].distance - 0.35) : FLAME.rangeM;
  const cosLimit = Math.cos(FLAME.coneDeg * Math.PI / 180);
  const victims = [];
  let target = null, targetT = Infinity;
  for (const a of shotCandidates()) {
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const cy = elevOf(a.deck) + (a.faction === 3 ? 0.35 : a.downed ? 0.35 : 0.9) + hoverOf(a);
    _fto.set(wx, cy, wz).sub(origin);
    const d = _fto.length();
    const along = _fto.dot(_fdir);
    if (d < 0.2 || d > reach || along <= 0 || along / d < cosLimit) continue;
    victims.push(a);
    if (along < targetT) { targetT = along; target = a; }
  }
  let impactDeck = player.deck, impactNode, bx, by;
  if (target) {
    impactDeck = target.deck;
    impactNode = target.pnode ?? target.node;
    bx = target.x; by = target.y;
  } else {
    _fend.copy(origin).addScaledVector(_fdir, reach);
    [bx, by] = world.worldToSim(_fend.x, _fend.z, impactDeck);
    impactNode = world.roomAt(impactDeck, bx, by, player.agent.node);
  }
  _flameAimSolution = { reach, cosLimit, victims, target, impactNode, bx, by };
  return _flameAimSolution;
}

function flameTick(dt) {
  const solution = solveFlameAim();
  const { reach } = solution;
  const origin = camera.position;

  // the jet leaves the NOZZLE, carried through the viewmodel's real world
  // transform (same treatment the MA5's muzzle flash gets)
  flamerMesh.updateWorldMatrix(true, false);
  _fmuzzle.set(0, -0.01, 0.50).applyMatrix4(flamerMesh.matrixWorld);
  // COMBUSTION VOLUME: everything inside the cone, out to the reach. A pool
  // split between targets (the way resolveCombat models a marine's flamer) is
  // wrong for an aimed weapon — a cone does not divide itself between the
  // things standing in it. Every body in the fire takes the full rate, and
  // the tank is what stops you: 12.5 s of trigger, total.
  const burn = FLAME.dps * dt;
  let anyHit = false;
  for (const a of solution.victims) {
    hurtFloodForm(sim, a, burn, true, player.agent.id); // `true`: fire kills permanently
    anyHit = true;
  }
  // FIRE DOES NOT CHECK BADGES (user built friendly fire in deliberately). A
  // marine standing in your cone burns exactly like a combat form does, and
  // your own fireteam is the most likely thing to be standing in it.
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0 || a.isPlayer) continue;
    if (a.faction !== 0 && a.faction !== 1 && a.faction !== 2) continue;
    if (a.deck !== player.deck) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    _fto.set(wx, elevOf(a.deck) + 0.9, wz).sub(origin);
    const d = _fto.length();
    if (d < 0.2 || d > reach) continue;
    if (_fto.dot(_fdir) / d < solution.cosLimit) continue;
    sim.hurtHuman(a, burn, player.agent.id); // blamed on you, like any friendly fire
  }
  // BODIES BURN. Corpses are deliberately NOT shotCandidates — bullets must
  // not stop on the dead — but the stream chars them: damage 100 is
  // 'permanently out of the economy', so torching the larder denies the hive
  // its future combat forms. (A body already TURNING is a live combat form
  // agent — the flood loop above burns it like any other form.) Double rate,
  // same as flame vs forms — fire is the anti-conversion tool.
  for (const a of sim.agents) {
    if (a.dead || a.faction !== 6 || a.damage >= 100) continue;
    if (a.deck !== player.deck) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    _fto.set(wx, elevOf(a.deck) + 0.25, wz).sub(origin);
    const d = _fto.length();
    if (d < 0.2 || d > reach) continue;
    if (_fto.dot(_fdir) / d < solution.cosLimit) continue;
    a.damage = Math.min(100, a.damage + burn * 2);
    anyHit = true;
  }

  // The lingering pool uses the actual first contact — target or bulkhead —
  // and resolves which room contains that point. It no longer inherits the
  // shooter's room and then renders somewhere unrelated on a large deck.
  sim.playerFlame(solution.impactNode, solution.bx, solution.by, player.agent.id);
  sim.gunfireAt(player.agent.node); // a flamethrower is not quiet
  if (anyHit) hitFlash = Math.max(hitFlash, 0.35);

  _flameJet = _flameJet ?? {};
  _flameJet.ox = _fmuzzle.x; _flameJet.oy = _fmuzzle.y; _flameJet.oz = _fmuzzle.z;
  _flameJet.dx = _fdir.x; _flameJet.dy = _fdir.y; _flameJet.dz = _fdir.z;
  _flameJet.len = reach;
}

// --- grenades (review P1): a real lofted frag with bounces and a fuse.
// The blast goes through sim.explodeAt — walls contain it, corpses shred,
// the ship hears it, and survivors hold the grudge. ---
const liveFrags = [];
const fragGeo = new THREE.SphereGeometry(0.09, 8, 6);
const fragMat = new THREE.MeshStandardMaterial({ color: 0x39443a, roughness: 0.5, metalness: 0.6 });
const boomLight = { position: new THREE.Vector3(), intensity: 0 }; // virtual — global pool
let shake = 0;
let hitFlash = 0;
let dmgFlash = 0, damageTint = 0, dmgAngle = 0;
let lastPlayerHurtTick = player.agent.lastHurtTick ?? -1;
let lastPlayerArmor = player.agent.armor;
let lastPlayerHp = player.agent.hp;

function throwFrag() {
  if (frags <= 0 || player.dead || !player.locked) return;
  frags--;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const mesh = new THREE.Mesh(fragGeo, fragMat);
  const pose = player.cameraPose();
  mesh.position.set(pose.x + dir.x * 0.45, pose.y - 0.15, pose.z + dir.z * 0.45);
  scene.add(mesh);
  liveFrags.push({
    mesh,
    vx: dir.x * FRAG.throwSpeed, vy: dir.y * FRAG.throwSpeed + FRAG.upBoost, vz: dir.z * FRAG.throwSpeed,
    fuse: FRAG.fuseS, deck: player.deck,
  });
  audio.play('clack', null, 0.6);
}

const fragRay = new THREE.Raycaster();
const _fragMove = new THREE.Vector3();
const _fragNormal = new THREE.Vector3();
const _fragVelocity = new THREE.Vector3();
// NPC GRENADES (marines carry two). The sim owns the throw, the fuse and the
// damage; all the renderer does is give the detonation the same light, shake,
// bang and ragdoll re-fling the player's own frag gets — otherwise a marine's
// frag would kill a pack in total silence.
function drainNpcBlasts() {
  const q = sim.blastFx;
  if (!q || !q.length) return;
  for (const b of q) {
    const [wx, wz] = world.simToWorld(b.x, b.y, b.deck);
    agents.noteExplosion(b.deck, wx, wz, b.r);
    if (Math.abs(b.deck - player.deck) <= 1) {
      boomLight.position.set(wx, elevOf(b.deck) + 1.2, wz);
      boomLight.intensity = 60;
      shake = Math.min(1, shake + 1.0 / (1 + Math.hypot(wx - player.x, wz - player.z) / 6));
      audio.play('boom', { x: wx, z: wz, deck: b.deck }, 1.1);
    }
  }
  q.length = 0;
}

function stepFrags(dt) {
  for (let i = liveFrags.length - 1; i >= 0; i--) {
    const f = liveFrags[i];
    f.vy -= FRAG.gravity * dt;
    const p = f.mesh.position;
    const nx = p.x + f.vx * dt, ny = p.y + f.vy * dt, nz = p.z + f.vz * dt;
    // wall bounce: cast along this frame's motion
    const mv = _fragMove.set(nx - p.x, ny - p.y, nz - p.z);
    const dist = mv.length();
    if (dist > 1e-6) {
      fragRay.set(p, mv.normalize());
      fragRay.far = dist + 0.09;
      const hit = fragRay.intersectObjects(solidsForShot(), false)[0];
      if (hit) {
        const n = _fragNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        const v = _fragVelocity.set(f.vx, f.vy, f.vz);
        v.sub(n.multiplyScalar(2 * v.dot(n))).multiplyScalar(FRAG.bounce);
        f.vx = v.x; f.vy = v.y; f.vz = v.z;
        audio.play('bounce', { x: p.x, z: p.z }, 0.7, 'bounce', 60);
      } else { p.set(nx, ny, nz); }
    }
    // floor bounce — unless the frag is over a REAL opening (a ladder hatch
    // hole or the grand stair well): the holes are genuinely cut through the
    // deck, so a grenade drops through to the deck below (user: toss grenades
    // through them to the next floor)
    const overHatch = f.deck < 5 && world.trunks.some((t) => t.vertical && f.deck === t.upperDeck
      && Math.abs(p.x - t.x) < 0.85 && Math.abs(p.z - t.z) < 0.85);
    if (overHatch && p.y < elevOf(f.deck)) {
      f.deck = world.trunks.find((t) => t.vertical && f.deck === t.upperDeck
        && Math.abs(p.x - t.x) < 0.85 && Math.abs(p.z - t.z) < 0.85).lowerDeck;
    }
    // the stair well descends within its own room — groundHeightAt returns
    // the flight surface under the frag, so it rolls/bounces DOWN the stairs
    const floor = world.groundHeightAt(f.deck, p.x, p.z, p.y - 0.09) + 0.09;
    if (p.y < floor && !overHatch) {
      p.y = floor;
      if (Math.abs(f.vy) > 1.2) audio.play('bounce', { x: p.x, z: p.z }, 0.6, 'bounce', 60);
      f.vy = -f.vy * FRAG.bounce;
      f.vx *= 0.7; f.vz *= 0.7;
    }
    f.fuse -= dt;
    if (f.fuse <= 0) {
      const [sx, sy] = world.worldToSim(p.x, p.z, f.deck);
      sim.explodeAt(f.deck, sx, sy, FRAG.radiusM, FRAG.damage, player.agent.id);
      gameSync?.explosion(f.deck, sx, sy, FRAG.radiusM, FRAG.damage);
      // tell the renderer where the blast landed so bodies it kills get thrown
      // and flail, and bodies already down get re-flung (cosmetic; render-only)
      agents.noteExplosion(f.deck, p.x, p.z, FRAG.radiusM);
      boomLight.position.set(p.x, elevOf(f.deck) + 1.2, p.z);
      boomLight.intensity = 60;
      shake = Math.min(1, shake + 1.2 / (1 + Math.hypot(p.x - player.x, p.z - player.z) / 6));
      audio.play('boom', { x: p.x, z: p.z, deck: f.deck }, 1.2);
      scene.remove(f.mesh);
      liveFrags.splice(i, 1);
    }
  }
}

// --- motion tracker (review P0): the classic 25 m sweep. Moving contacts
// only — hold still and you vanish from it, exactly like the games. ---
// UNRELIABLE (user rule: the radar lies like the comms do). It statics out
// about half the time in ragged windows, and it HALLUCINATES — brief phantom
// blips, friendly-yellow and hostile-red both, where nothing stands. You can
// never fully trust it: a clean sweep might be static, a red blip might be
// nothing, and the thing that kills you might never have painted.
const trk = el('tracker').getContext('2d');
const trkState = { static: false, until: 0, phantoms: [], nextPhantom: 0 };
function trackerUnreliability(now) {
  if (now >= trkState.until) {
    // ~50% duty cycle: ragged clear windows vs ragged static windows
    trkState.static = !trkState.static;
    trkState.until = now + (trkState.static ? 1200 + Math.random() * 3200 : 1400 + Math.random() * 3000);
  }
  // phantom contacts spawn mostly as a window flips (interference artifacts)
  if (now >= trkState.nextPhantom) {
    trkState.nextPhantom = now + 2600 + Math.random() * 5200;
    const n = 1 + (Math.random() < 0.3 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      trkState.phantoms.push({
        ang: Math.random() * Math.PI * 2,          // bearing in tracker space
        dist: 0.25 + Math.random() * 0.7,          // fraction of range
        hostile: Math.random() < 0.55,
        until: now + 400 + Math.random() * 1100,   // brief — then it's just gone
      });
    }
  }
  // a phantom doesn't just vanish — it FLICKERS OUT (user rule): a real
  // contact simply stops painting, but a ghost sputters and dissolves for
  // ~half a second, so only after the fact do you know it was never there
  const FLICKER_MS = 550;
  for (let i = trkState.phantoms.length - 1; i >= 0; i--) {
    if (now >= trkState.phantoms[i].until + FLICKER_MS) trkState.phantoms.splice(i, 1);
  }
}
function drawTracker(now) {
  const R = 75, RANGE = 25;
  trackerUnreliability(now);
  trk.clearRect(0, 0, 150, 150);
  trk.fillStyle = 'rgba(10,16,22,0.75)';
  trk.beginPath(); trk.arc(R, R, 74, 0, Math.PI * 2); trk.fill();
  if (!trkState.static) {
    trk.strokeStyle = 'rgba(110,160,210,0.35)';
    for (const rr of [25, 50, 74]) { trk.beginPath(); trk.arc(R, R, rr, 0, Math.PI * 2); trk.stroke(); }
  }
  if (trkState.static) {
    // the sweep is snow to the ENCLOSURE edge — and the rings themselves
    // glitch: jittered, broken arcs instead of clean circles (user rule)
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 75;
      const v = 120 + (Math.random() * 110) | 0;
      trk.fillStyle = `rgba(${v},${v + 15},${v + 25},${0.12 + Math.random() * 0.3})`;
      trk.fillRect(R + Math.cos(a) * rr, R + Math.sin(a) * rr, 1 + Math.random() * 2.4, 1 + Math.random() * 1.6);
    }
    trk.strokeStyle = 'rgba(110,160,210,0.3)';
    for (const rr of [25, 50, 74]) {
      // each ring becomes 5-8 broken arcs at slightly wrong radii
      const segs = 5 + (Math.random() * 4) | 0;
      for (let s = 0; s < segs; s++) {
        if (Math.random() < 0.35) continue; // dropout
        const a0 = Math.random() * Math.PI * 2;
        const jr = rr + (Math.random() - 0.5) * 5;
        trk.beginPath();
        trk.arc(R + (Math.random() - 0.5) * 2, R + (Math.random() - 0.5) * 2,
          Math.max(4, jr), a0, a0 + 0.3 + Math.random() * 0.9);
        trk.stroke();
      }
    }
    // occasional horizontal tear across the whole face
    if (Math.random() < 0.3) {
      const ty = Math.random() * 150;
      trk.fillStyle = 'rgba(160,190,220,0.18)';
      trk.fillRect(0, ty, 150, 1 + Math.random() * 2);
    }
    trk.fillStyle = '#cfe0ff';
    trk.beginPath(); trk.moveTo(R, R - 5); trk.lineTo(R - 4, R + 4); trk.lineTo(R + 4, R + 4); trk.fill();
    return;
  }
  const pov = player.dead ? deathFocusAgent : player.agent;
  if (!pov) return;
  const [px, pz] = player.dead
    ? world.simToWorld(pov.x, pov.y, pov.deck)
    : [player.x, player.z];
  // tracker basis = the player's ACTUAL forward/right vectors (user report:
  // radar inverted) — rotating the offset by -yaw only agreed with the
  // camera at yaw 0, because forward is (-sin, -cos), not (sin, cos)
  const povYaw = player.dead
    ? Math.atan2(-Math.cos(pov.heading), -Math.sin(pov.heading))
    : player.yaw;
  const fwdX = -Math.sin(povYaw), fwdZ = -Math.cos(povYaw);
  const rightX = Math.cos(povYaw), rightZ = -Math.sin(povYaw);
  const buf = sim.buffer;
  for (let i = 0; i < buf.count; i++) {
    if (buf.id[i] === player.agent.id) continue;
    const fbuf = buf.faction[i];
    if (fbuf === 6) continue;
    // a body mid-transformation convulses violently — that IS motion, and it
    // paints even though its position never changes: a red blip where nothing
    // stands is the warning that a body is turning
    const thrashing = (buf.flags[i] & FLAG.THRASHING) !== 0;
    // MOVING CONTACTS ONLY (user rule): hold still and you vanish, exactly
    // like the real motion tracker. TWO gates now: the sim's own
    // purposeful-motion flag (a committed move leg / an airborne arc — set in
    // writeBuffer) AND a real position delta. The flag is what finally makes
    // standing flood bodies tracker-dark: separation shuffles and park-drift
    // nudge idle bodies a few centimetres a tick, which used to paint an
    // ambush pack as a wall of blips. A pack lying dead still by the door now
    // reads as an empty room — until one form darts out to be seen. That
    // asymmetry IS the layered bait tactic.
    const moved = Math.hypot(buf.posX[i] - buf.prevX[i], buf.posY[i] - buf.prevY[i]);
    // (a thrashing corpse shakes in place — no position delta — so it skips
    // the delta gate on its flag alone)
    if (!thrashing && (buf.animClip[i] === 4 || moved < 0.03 || !(buf.flags[i] & FLAG.MOVING))) continue;
    const deck = buf.posZ[i];
    if (Math.abs(deck - player.deck) > 1) continue;
    const [wx, wz] = world.simToWorld(buf.posX[i], buf.posY[i], deck);
    const dx = wx - px, dz = wz - pz;
    const d = Math.hypot(dx, dz);
    if (d > RANGE) continue;
    // project into tracker space: up = facing, right = your right hand
    const tx = R + ((dx * rightX + dz * rightZ) / RANGE) * 70;
    const ty = R - ((dx * fwdX + dz * fwdZ) / RANGE) * 70;
    const hostile = fbuf === 3 || fbuf === 4 || fbuf === 5;
    trk.fillStyle = hostile ? 'rgba(255,72,56,0.95)' : 'rgba(255,214,64,0.95)';
    if (deck === player.deck) {
      trk.beginPath(); trk.arc(tx, ty, 3.4, 0, Math.PI * 2); trk.fill();
    } else {
      trk.strokeStyle = trk.fillStyle;
      trk.beginPath(); trk.arc(tx, ty, 3.2, 0, Math.PI * 2); trk.stroke();
    }
  }
  // phantoms: drawn EXACTLY like real same-deck contacts while "alive" —
  // then they FLICKER OUT: sputtering alpha, jittering position, shrinking,
  // gone. The dissolve is the tell, and it only comes after the fact.
  for (const ph of trkState.phantoms) {
    let tx = R + Math.cos(ph.ang) * ph.dist * 70;
    let ty = R + Math.sin(ph.ang) * ph.dist * 70;
    let alpha = 0.95, rad = 3.4;
    if (now >= ph.until) {
      const p = (now - ph.until) / 550; // 0..1 through the die-off
      if (Math.sin(now * 0.09 + ph.ang * 7) < p * 1.6 - 0.4) continue; // sputter: skip frames, more as it dies
      alpha = 0.95 * (1 - p * 0.7);
      rad = 3.4 * (1 - p * 0.45);
      tx += (Math.random() - 0.5) * 3 * p; // breaking up
      ty += (Math.random() - 0.5) * 3 * p;
    }
    trk.fillStyle = ph.hostile ? `rgba(255,72,56,${alpha})` : `rgba(255,214,64,${alpha})`;
    trk.beginPath(); trk.arc(tx, ty, rad, 0, Math.PI * 2); trk.fill();
  }
  // faint interference flecks even when "clear" — the unit is never healthy
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 72;
    trk.fillStyle = `rgba(150,170,190,${0.05 + Math.random() * 0.1})`;
    trk.fillRect(R + Math.cos(a) * rr, R + Math.sin(a) * rr, 1.4, 1.2);
  }
  // you
  trk.fillStyle = '#cfe0ff';
  trk.beginPath(); trk.moveTo(R, R - 5); trk.lineTo(R - 4, R + 4); trk.lineTo(R + 4, R + 4); trk.fill();
}

// --- positional sound sweep: voice the sim's own senses ---
// REWORKED (user: constant bumping/banging from clustered NPCs made you mute
// it). The old sweep played a one-shot PER FIRING NODE per tick — a crowded
// fight was a wall of overlapping bangs, and adjacent-deck fire was a raw
// 'thud'. Now: same-deck gunfire is capped at the 3 NEAREST firing rooms,
// other decks use the same attenuation plus deck muffling, and the flood/human
// horror layer (chitter, carrier gurgle) does the storytelling.
let chitterAt = 0, gurgleAt = 0;
const _carrierPos = new Map();  // carrier id -> sim position last sweep (movement test)
let _gunVoiced = null; // per-room gunfire stamp already voiced (edge trigger)
function soundSweep(now) {
  const g = sim.graph;
  // same-deck gunfire: nearest 3 firing rooms only, quieter with distance
  const firing = [];
  const offDeck = [];
  // ONE BANG PER SHOT, EDGE-TRIGGERED (co-op report: "continually makes
  // clicking noise in the room I shot in after shooting"). This used to ask
  // "did this room fire within the last tick?" — fine on the host, where the
  // clock moves 15x a second, but a PEER never advances the sim: its
  // tickCount only jumps when a host snapshot lands, 5x a second. For the
  // ~200 ms in between, the same stamp kept satisfying the window and every
  // frame re-voiced it, so one burst became a stutter of clicks. Voicing the
  // CHANGE in the stamp instead is cadence-independent and simpler.
  const voiced = _gunVoiced ??= new Int32Array(g.n).fill(-9999);
  for (let n = 0; n < g.n; n++) {
    if (sim.gunfireTick[n] === voiced[n] || sim.gunfireTick[n] < 5) continue;
    voiced[n] = sim.gunfireTick[n];
    const nd = g.node(n);
    if (nd.deck === audio.listener.deck) {
      const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
      firing.push({ n, wx, wz, d: Math.hypot(wx - audio.listener.x, wz - audio.listener.z) });
    } else if (Math.abs(nd.deck - audio.listener.deck) <= 2) {
      const [wx, wz] = world.simToWorld(nd.x, nd.y, nd.deck);
      offDeck.push({ n, wx, wz, dd: Math.abs(nd.deck - audio.listener.deck), d: Math.hypot(wx - audio.listener.x, wz - audio.listener.z) });
    }
  }
  firing.sort((a, b) => a.d - b.d);
  for (const f of firing.slice(0, 3)) audio.play('shotFar', { x: f.wx, z: f.wz, node: f.n, deck: g.node(f.n).deck }, 0.7, `gun${f.n}`, 220);
  // battles on other decks come DIRECTIONALLY through the hull now — dull
  // thump-bursts panned to the fight's bearing, muffled harder per deck of
  // steel. There is no additional unpositioned rumble bypassing distance.
  offDeck.sort((a, b) => (a.dd * 100 + a.d) - (b.dd * 100 + b.d));
  for (const f of offDeck.slice(0, 2)) {
    audio.playFar('farFight', { x: f.wx, z: f.wz, node: f.n, deck: g.node(f.n).deck }, f.dd, 0.9, `far${f.n}`, 3400);
  }
  // NO SCREAM CUES (user: "its terrible, just rip it out wholesale"). The sim
  // still tracks screamTick — it is what carries panic between rooms and puts
  // "screams coming from X" on the radio net — but nothing plays a voice for
  // it any more. The chitter and the gunfire carry the horror instead.
  // --- flood proximity (user: flood sounds when they are nearby) ---
  let nearCarrier = null;
  for (const a of sim.agents) {
    if (a.dead || a.deck !== audio.listener.deck) continue;
    if (a.faction !== 3 && a.faction !== 4 && a.faction !== 5) continue;
    if (a.move?.hidden) continue; // in the ducts — heard via duct log, not here
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    const d = Math.hypot(wx - audio.listener.x, wz - audio.listener.z);
    if (a.faction === 3 && d < 18 && now - chitterAt > 1600 + Math.random() * 1200) { audio.play('chitter', { x: wx, z: wz, deck: a.deck, node: a.pnode ?? a.node }, 0.55); chitterAt = now; }
    if (a.faction === 5 && (!nearCarrier || d < nearCarrier.d)) nearCarrier = { wx, wz, d, deck: a.deck, node: a.pnode ?? a.node };
    // CARRIER MOVEMENT (user): the bulk is audible when it WALKS. Position
    // delta between sweeps is the whole movement test — the sim's move/task
    // fields churn too much shape to lean on. Keyed per carrier so each body
    // squelches on its own clock instead of the pack sharing one throttle.
    if (a.faction === 5) {
      const pv = _carrierPos.get(a.id);
      _carrierPos.set(a.id, { x: a.x, y: a.y });
      if (pv && d < 22 && Math.hypot(a.x - pv.x, a.y - pv.y) > 0.02) {
        audio.play('carrier', { x: wx, z: wz, deck: a.deck, node: a.pnode ?? a.node }, 0.85, `car${a.id}`, 2400);
      }
    }

  }
  // NO GROWLS, NO SHRIEKS (user: "remove shrieks and growls wholesale") —
  // the combat-form tracking that fed them went with them. The chitter, the
  // carrier gurgle and the gunfire carry the room now.
  if (nearCarrier && nearCarrier.d < 16 && now - gurgleAt > 3200 + Math.random() * 2500) {
    audio.play('gurgle', { x: nearCarrier.wx, z: nearCarrier.wz, deck: nearCarrier.deck, node: nearCarrier.node }, 0.9);
    gurgleAt = now;
  }
  // (the human-death-scream sweep lived here; removed with the scream cues —
  // it tracked every living human every frame purely to fire that one sound)
  // (the fire crackle was here; removed wholesale with its buffer. fire burns
  // silent now — engine/fx.js still exposes nearest(), which this was its only
  // caller for.)
  // door hisses — ONLY nearby doors, and sparsely (user: random bumping
  // around NPC clusters — this was every door any NPC tripped, ship-wide on
  // your deck, on a 120ms global throttle = constant knocking)
  for (const ev of world.doorEvents) {
    if (ev.deck !== audio.listener.deck) continue;
    if (Math.hypot(ev.x - audio.listener.x, ev.z - audio.listener.z) > 18) continue;
    audio.play('door', { x: ev.x, z: ev.z, deck: ev.deck }, 0.5, 'door', 600);
  }
  world.doorEvents.length = 0;
}

// obstacle set for the player's capsule: live, standing bodies on the player's
// deck (dead/downed/other-deck don't block). Radii mirror the old separation
// pass. Handed to the physics world each fixed step.
// pooled like doorMovers (swarm finding: a fresh array + record per agent at
// 60Hz was measurable GC churn on the physics path)
const _obstacleR = { 3: 0.32, 4: 0.48, 5: 0.75 };
const _obstacleRecs = [];
const _doorsOnDeck = {};
let _obstacleN = 0;
let _obstacleKey = -1;
function playerObstacles() {
  const cy = elevOf(audio.listener.deck) + 0.9;
  // doors on the player's deck — an NPC HOLDING in a door throat (squads
  // pack up at doors before pushing) must not wall the player out of the
  // room (user: "marines stop at a door and block me, just stuck"). You
  // shoulder through people in a doorway; everywhere else they still block.
  // ORIENTED THROAT (user: blocked out of Cargo Hold 2 by a body parked in
  // the doorway). The old test was a 1.3 m sphere on the door's centre point,
  // which is wrong in both directions: it missed a body standing in the far
  // half of a deep throat — still squarely in your way — while freeing anyone
  // loitering BESIDE the door, where they should block you normally. Test the
  // actual opening instead: within the door's width across, and a throat's
  // depth through it.
  const deckDoors = (_doorsOnDeck[audio.listener.deck] ??= world.doors.filter((d) => d.deck === audio.listener.deck)
    .map((d) => ({ x: d.x, z: d.z, c: Math.cos(d.phi), s: Math.sin(d.phi) })));
  const THROAT_HALF_W = DOOR_W / 2 + 0.35, THROAT_DEPTH = 1.7;
  let n = 0;
  for (const a of sim.agents) {
    if (a.dead || a.isPlayer || a.deck !== audio.listener.deck) continue;
    if (a.faction === 6 || a.downed || a.hp <= 0) continue;
    const [wx, wz] = world.simToWorld(a.x, a.y, a.deck);
    let inThroat = false;
    for (let di = 0; di < deckDoors.length; di++) {
      const d = deckDoors[di];
      const ddx = wx - d.x, ddz = wz - d.z;
      const lx = ddx * d.c + ddz * d.s;      // across the opening
      const lz = -ddx * d.s + ddz * d.c;     // through it
      if (lx > -THROAT_HALF_W && lx < THROAT_HALF_W && lz > -THROAT_DEPTH && lz < THROAT_DEPTH) { inThroat = true; break; }
    }
    if (inThroat) continue;
    const r = _obstacleRecs[n] ?? (_obstacleRecs[n] = { id: 0, x: 0, y: 0, z: 0, radius: 0.4, half: 0.5 });
    r.id = a.id; r.x = wx; r.y = cy; r.z = wz; r.radius = _obstacleR[a.faction] ?? 0.4;
    n++;
  }
  _obstacleN = n;
  return _obstacleRecs;
}

// MARINE BARKS (user: "weave in very very very sporadically and rarely to
// earn them and not be repetitive, once per game each at most, needs to come
// from a specific marine. if they die its interrupted").
//
// Four real voice lines, each spent ONCE per run and never repeated. They are
// earned rather than scheduled: a line only fires in the lull AFTER a fight —
// a living marine near you, nothing hostile left in his room, but gunfire in
// that room within the last half minute. On top of that a long enforced gap
// and a coin flip, so two runs never hear them at the same beats.
//
// The line belongs to that marine: it plays from his position, and if he is
// killed part-way through it is cut off mid-word.
const BARK_KEYS = ['bark1', 'bark2', 'bark3', 'bark4'];
const barkState = { unspent: BARK_KEYS.slice(), active: null, lastAt: -1e9, checkAt: 0 };
function updateBarks(now) {
  // interrupt: the man saying it just died
  const a = barkState.active;
  if (a) {
    const sp = sim.byId.get(a.id);
    if (!sp || sp.dead || sp.hp <= 0) {
      try { a.src.stop(); } catch { /* already ended */ }
      barkState.active = null;
    } else if (now >= a.endsAt) barkState.active = null;
  }
  if (now < barkState.checkAt) return;
  barkState.checkAt = now + 3000;
  if (barkState.active || !barkState.unspent.length) return;
  if (sim.t < 90 || now - barkState.lastAt < 240000) return;  // earn the first, and space the rest
  if (Math.random() > 0.35) return;
  // a living marine near you, in a room that is quiet NOW but was loud recently
  const quietSince = sim.tickCount - 30 * sim.P.sim.tickHz;
  let pick = null, bestD = 18 * 18;
  for (const m of sim.agents) {
    if (m.dead || m.hp <= 0 || m.faction !== 2 || m.deck !== player.deck) continue;
    if ((sim.gunfireTick[m.node] ?? -1e9) < quietSince) continue;   // no fight here lately
    if (sim.floodStrengthAt(m.node) > 0) continue;                  // still hot — not a lull
    const [mx, mz] = world.simToWorld(m.x, m.y, m.deck);
    const d2 = (mx - player.x) ** 2 + (mz - player.z) ** 2;
    if (d2 < bestD) { bestD = d2; pick = { m, x: mx, z: mz }; }
  }
  if (!pick) return;
  const key = barkState.unspent.splice((Math.random() * barkState.unspent.length) | 0, 1)[0];
  const buf = audio.buffers[key];
  const src = audio.play(key, { x: pick.x, z: pick.z, deck: pick.m.deck, node: pick.m.pnode ?? pick.m.node }, 0.95);
  if (!src) { barkState.unspent.push(key); return; }              // out of earshot / not loaded
  barkState.lastAt = now;
  barkState.active = { src, id: pick.m.id, endsAt: now + (buf ? buf.duration * 1000 : 3000) };
}
// --- main loop ---
let physAcc = 0;
let _trackerAt = 0, _observeAt = 0, _sweepAt = 0; // subsystem throttle clocks (perf pass 2)
let _lightingAt = 0;
let _smYaw = 0, _smPitch = 0, _bobPhase = 0, _bobAmp = 0; // viewmodel sway/bob (first-strike feel)
let reloadFlashJank = 0;
let _fpsEma = 16.7, _fpsWorst = 0, _fpsShownAt = 0; // top-right perf readout
// sim ticks run OUTSIDE the rAF task (engine/runtime.js TickScheduler):
// the browser executes them in the idle gap between vsyncs
const ticker = new TickScheduler({ stepSec: sim.dt, run: () => sim.tick() });
let shownLost = false;
let deathStartedAt = null;
let deathFocusAgent = null;
const DEATH_REVIEW_MS = 3200;
const deathCamRay = new THREE.Raycaster();
const deathFocus = new THREE.Vector3();
const deathDesired = new THREE.Vector3();
const deathDirection = new THREE.Vector3();

function updateAfterlife(now) {
  const hud = el('spectatorHud');
  document.body.classList.toggle('player-dead', player.dead);
  if (!player.dead) {
    if (deathStartedAt !== null) {
      deathStartedAt = null; deathFocusAgent = null; playerFellAt = null;
      if (!ended) overlay.classList.add('hidden');
    }
    const fallen = mates.find((mate) => mate.agent?.dead && mate.agent.respawnReadyAt >= 0);
    if (!fallen) { hud.style.display = 'none'; return; }
    const remaining = Math.max(0, Math.ceil(fallen.agent.respawnReadyAt - sim.t));
    hud.style.display = 'block';
    hud.querySelector('b').textContent = remaining > 0
      ? `${(gameSync?.peerName(fallen.did) || fallen.label).toUpperCase()} · RESPAWN ${remaining}s`
      : 'TEAMMATE READY TO RESPAWN';
    hud.querySelector('span').textContent = sim.playerRespawnRoomSafe(player.agent)
      ? 'HOLD HERE — THIS ROOM AND ITS ADJACENT ROOMS ARE CLEAR'
      : 'REACH A ROOM WITH NO FLOOD HERE OR IN AN ADJACENT ROOM';
    return;
  }

  if (deathStartedAt === null) {
    deathStartedAt = now;
    playerFellAt ??= sim.t;
    document.exitPointerLock?.();
  }
  const teammate = livingTeammate();
  const reviewing = now - deathStartedAt < DEATH_REVIEW_MS;
  deathFocusAgent = !reviewing && teammate ? teammate.agent : afterlifeBody() ?? player.agent;
  hud.style.display = 'block';
  const name = teammate && deathFocusAgent === teammate.agent
    ? (gameSync?.peerName(teammate.did) || teammate.label).toUpperCase()
    : null;
  hud.querySelector('b').textContent = name ? `SPECTATING ${name}` : 'CASUALTY CAMERA';
  const remaining = Math.max(0, Math.ceil((player.agent.respawnReadyAt ?? -1) - sim.t));
  if (teammate) {
    hud.querySelector('span').textContent = remaining > 0
      ? `RESPAWN IN ${remaining}s · YOUR TEAMMATE MUST SURVIVE`
      : sim.playerRespawnRoomSafe(teammate.agent)
        ? 'CLEAR ROOM CONFIRMED · REDEPLOYING'
        : 'RESPAWN READY · WAITING FOR A ROOM WITH CLEAR ADJACENCIES';
  } else {
    hud.querySelector('span').textContent = reviewing
      ? 'BODY CAMERA LOCKED · SIGNAL TRANSITIONING'
      : 'NO SURVIVING FIRETEAM SIGNAL';
  }
}

function placeDeathCamera(agent) {
  const anchor = agents.cameraAnchor(agent);
  if (!anchor) return null;
  const lift = anchor.prone ? 0.45 : 1.05;
  deathFocus.set(anchor.x, anchor.y + lift, anchor.z);
  deathDesired.set(
    anchor.x - Math.cos(anchor.heading) * 3.6,
    anchor.y + (anchor.prone ? 1.65 : 2.15),
    anchor.z - Math.sin(anchor.heading) * 3.6,
  );
  deathDirection.subVectors(deathDesired, deathFocus);
  const distance = deathDirection.length();
  deathCamRay.set(deathFocus, deathDirection.normalize());
  deathCamRay.near = 0.18; deathCamRay.far = distance;
  const hit = deathCamRay.intersectObjects(solidsForShot(), false)[0];
  if (hit) deathDesired.copy(deathFocus).addScaledVector(deathDirection, Math.max(0.35, hit.distance - 0.28));
  const floor = world.groundHeightAt(anchor.deck, deathDesired.x, deathDesired.z, deathDesired.y);
  const ceiling = elevOf(anchor.deck) + world.ceilHeightAt(anchor.deck, deathDesired.x, deathDesired.z);
  deathDesired.y = Math.max(floor + 0.3, Math.min(ceiling - 0.3, deathDesired.y));
  camera.position.copy(deathDesired);
  camera.lookAt(deathFocus);
  _fillX = deathDesired.x; _fillY = deathDesired.y; _fillZ = deathDesired.z;
  return anchor;
}
let last = performance.now();
function frame(now) {
  // ONE BAD FRAME MUST NOT KILL THE GAME (playtest: a first-ever hard freeze
  // with a black canvas and a live-looking HUD). The re-request used to be the
  // LAST statement, after post.render — so a single exception anywhere in this
  // function skipped it and the loop stopped FOREVER: the DOM keeps whatever it
  // last painted, the 4 Hz dirty-checked perf readout freezes on its last value
  // (which is why it still read "60 FPS"), and the canvas keeps whatever the
  // aborted frame left in the swapchain, which after a clear is black.
  // Requesting FIRST means the loop survives anything downstream.
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  handleGamepad(gamepad.poll(), dtReal);
  syncAudioGate();

  // fixed-timestep player physics: step the Rapier world in whole PHYS_DT
  // increments (deterministic — replay/lockstep depend on it), letting the
  // camera interpolate the remainder. Bodies are re-synced each step so the
  // capsule collides with live NPCs.
  physAcc += dtReal;
  let alpha = 0;
  if (physics) {
    let pSteps = 0;
    while (physAcc >= PHYS_DT && pSteps++ < 6) {
      // obstacle positions come from raw sim state, which only changes on the
      // 15Hz sim tick (or when the player changes decks) — skip the whole
      // JS→wasm re-sync on the other ~45 physics steps a second
      const obsKey = sim.tickCount * 8 + player.deck;
      if (obsKey !== _obstacleKey) {
        _obstacleKey = obsKey;
        physics.syncBodies(playerObstacles(), _obstacleN);
      }
      player.step(PHYS_DT);
      physics.step();
      physAcc -= PHYS_DT;
    }
    if (pSteps >= 6) physAcc = 0; // don't spiral if a frame stalls
    alpha = physAcc / PHYS_DT;
  }

  // MA5 loop (auto fire, bloom, reload, melee) — pure mechanics, events out.
  // The trigger goes to ONE weapon: whichever is up. Reload and melee still
  // reach the rifle with the flamer out, so you can top the MA5 up while the
  // torch is in your hands and butt-stroke something that gets inside the
  // stream's minimum useful range.
  const triggerLive = (fireHeld || gamepadFireHeld) && player.locked && !player.dead;
  // MELEE IS A WEAPON, so it obeys the same liveness the trigger does. It was
  // the only attack that didn't: a KIA player on the death screen — or one
  // converted and spectating as a GHOST, whose camera.position is the ghost's
  // — could press F and put 45 damage and a ragdoll launch into whatever stood
  // near that camera. Now that the swing emits no tracer, no muzzle flash and
  // no gunfireAt, that would be a kill with nothing on screen to explain it.
  const meleeLive = meleePressed && player.locked && !player.dead;
  const wevents = [];
  weapon.step(dtReal, {
    fireHeld: triggerLive && !heldIsFlamer,
    reloadPressed, meleePressed: meleeLive,
  }, wevents);
  reloadPressed = false; meleePressed = false;
  for (const ev of wevents) {
    if (ev.t === 'fire') { traceShot(ev.offAng, ev.offRad); audio.play('shot', null, 0.9); }
    else if (ev.t === 'melee_hit') meleeStrike();
    else if (ev.t === 'reload_start') audio.play('clack', null, 0.7);
    else if (ev.t === 'dry') audio.play('clack', null, 0.4);
  }
  // the flamethrower, on the same trigger. `_flameJet` is cleared every frame
  // and only re-declared while the stream is live, so it goes out the instant
  // you release — the same discipline the light pool and the NPC jets use.
  _flameJet = null;
  _flameAimSolution = null;
  if (hasFlamer) {
    const fevents = [];
    // THE SWING DOES NOT RELEASE THE TRIGGER. Pushing fireHeld:false into the
    // flamer for the 0.52 s of a butt-stroke killed the stream outright —
    // live=false, a flame_off, ignite zeroed — so holding the trigger through
    // a swing replayed the ignition thud and cost a second ignhitS catch, i.e.
    // a full re-light per melee. The trigger stays down; what the swing
    // suppresses is the JET, below.
    flamer.step(dtReal, { fireHeld: triggerLive && heldIsFlamer }, fevents);
    for (const ev of fevents) {
      // no fire out of a nozzle that is sweeping left across your front
      if (ev.t === 'flame') { if (weapon.meleeT <= 0) flameTick(ev.dt); }
      else if (ev.t === 'flame_on') { _flameSeed = (_flameSeed + 1) & 0xffff; }
      else if (ev.t === 'dry') audio.play('clack', null, 0.35);
    }
  }
  // the igniter ring lights while the stream is out
  flamerMesh.userData.setPilot?.(flamer.live ? 1 : (hasFlamer ? 0.10 : 0));
  if (fragPressed) { throwFrag(); fragPressed = false; }
  stepFrags(dtReal);
  drainNpcBlasts();
  boomLight.intensity *= Math.exp(-7 * dtReal);
  muzzleFlash.intensity *= Math.exp(-14 * dtReal);
  wallSpark.intensity *= Math.exp(-10 * dtReal);
  // VIEWMODEL KINEMATICS (ported from first-strike — user: the gun reads
  // better there): aim-lag sway from smoothed yaw/pitch, walk bob sharing
  // the head-bob phase, a real reload TILT (the barrel dips through an
  // arc instead of the whole gun sinking), and the melee swing composed
  // into translation + rotation.
  {
    const sBlend = 1 - Math.exp(-14 * dtReal);
    _smYaw += (player.yaw - _smYaw) * sBlend;
    _smPitch += (player.pitch - _smPitch) * sBlend;
    const swayX = Math.max(-0.06, Math.min(0.06, (_smYaw - player.yaw) * 0.35));
    const swayY = Math.max(-0.05, Math.min(0.05, (_smPitch - player.pitch) * 0.3));
    const groundSpeed = Math.hypot(player.vx, player.vz);
    const speed01 = Math.max(0, Math.min(1, groundSpeed / ODST.sprintSpeed));
    _bobAmp += ((player.onGround ? speed01 : 0) - _bobAmp) * (1 - Math.exp(-8 * dtReal));
    _bobPhase += dtReal * 9 * speed01 * (player.onGround ? 1 : 0);
    const gunBobY = Math.sin(_bobPhase * 2) * 0.012 * _bobAmp;
    let tilt = 0;
    reloadFlashJank = 0;
    if (weapon.reloading) {
      const ph = 1 - weapon.reloadT / weapon.def.reloadS;
      tilt = -0.85 * Math.sin(Math.min(ph * Math.PI, Math.PI));
      reloadFlashJank = Math.sin(Math.min(ph * Math.PI, Math.PI));
    }
    const stroke = buttStroke01(weapon.meleeT, weapon.meleeDuration);
    viewmodel.position.x = GUN_TUNE.x + swayX;
    viewmodel.position.y = GUN_TUNE.y + swayY + gunBobY;
    viewmodel.position.z = -GUN_TUNE.z + weapon.recoil * 1.6;
    viewmodel.rotation.x = GUN_TUNE.rx + weapon.recoil * 2 - tilt;
    viewmodel.rotation.y = GUN_TUNE.ry;
    viewmodel.rotation.z = GUN_TUNE.rz;
    applyButtStroke(viewmodel, stroke);
    // the flamer shares the sway and the bob, and gets a low-frequency shudder
    // of its own while burning — a pressure feed kicks, it does not recoil in
    // discrete jolts the way the rifle does
    const shudder = flamer.live ? Math.sin(_bobPhase * 31 + now * 0.021) * 0.006 : 0;
    flamerModel.position.x = FLAMER_TUNE.x + swayX;
    flamerModel.position.y = FLAMER_TUNE.y + swayY + gunBobY + shudder;
    flamerModel.position.z = -FLAMER_TUNE.z + (flamer.live ? 0.012 : 0);
    flamerModel.rotation.x = FLAMER_TUNE.rx + shudder * 1.6;
    flamerModel.rotation.y = FLAMER_TUNE.ry;
    flamerModel.rotation.z = FLAMER_TUNE.rz;
    // THE FLAMER MELEES TOO (it had no melee motion at all): F swings whatever
    // is in your hands, and the swing belongs to the strike, not to the model
    applyButtStroke(flamerModel, stroke);
  }
  // reticle bloom (first-strike CE reticle): arc radius tracks true spread
  {
    const spreadRad = weapon.spreadDeg * Math.PI / 180;
    const focal = 0.5 * (canvasH || 720) / Math.tan((72 * Math.PI / 180) / 2);
    const sp = `${(Math.tan(spreadRad) * focal).toFixed(1)}px`;
    if (_hudCache['xh:sp'] !== sp) {
      _hudCache['xh:sp'] = sp;
      el('crosshair').style.setProperty('--sp', sp);
    }
    // With the flamethrower up, red means a visible Flood body is inside both
    // the finite fuel reach and the current cone. Blue means close the range
    // or clear the obstruction; it is not a generic enemy-awareness marker.
    // `spectating` is derived later in this frame, after afterlife state has
    // advanced. Reading that later const here put it in the temporal dead zone:
    // the short circuit hid the bug until the first flamethrower came up, then
    // every render frame crashed. Player liveness is the actual requirement.
    const hot = heldIsFlamer && !player.dead && !!solveFlameAim().target;
    const xh = el('crosshair');
    const cls = hot ? 'hud flame-hot' : 'hud';
    if (xh.className !== cls) xh.className = cls;
  }

  if (isSimAuthority()) ticker.add(dtReal); // multiplayer peers render host checkpoints; only the elected host advances the world
  else {
    // A PEER'S BUFFER ONLY REFRESHES ON A CHECKPOINT (5 Hz), so every
    // animation clock arrived in 200 ms steps and the crew walked like a
    // flipbook. Positions were already eased in agents3d; the gait phase was
    // not. animTime is pure presentation — advance it locally between
    // checkpoints and let the next one snap it back to the host's truth.
    const b = sim.buffer;
    for (let i = 0; i < b.count; i++) b.animTime[i] += dtReal;
  }

  gameSync?.update(dtReal, now);
  updateAfterlife(now);
  let renderViewX = player.x, renderViewZ = player.z;
  let renderViewFX = -Math.sin(player.yaw), renderViewFZ = -Math.cos(player.yaw);
  if (deathFocusAgent) {
    [renderViewX, renderViewZ] = world.simToWorld(deathFocusAgent.x, deathFocusAgent.y, deathFocusAgent.deck);
    renderViewFX = Math.cos(deathFocusAgent.heading);
    renderViewFZ = Math.sin(deathFocusAgent.heading);
  }
  agents.viewX = renderViewX; agents.viewZ = renderViewZ; // fog-exact stamp culling
  // ...and which way you are facing, so bodies behind the camera are neither
  // posed nor stamped (the instanced sets are frustumCulled=false, so every
  // stamped body is submitted regardless of where the camera points)
  agents._viewFX = renderViewFX; agents._viewFZ = renderViewFZ;
  agents.update(dtReal);
  // the sweep voices 10-15Hz sim data; every one-shot has a >=220ms throttle
  // window, so scanning at 15Hz instead of every frame is inaudible (swarm)
  if (now - _sweepAt > 66) { _sweepAt = now; soundSweep(now); }
  // subsystem throttles (perf pass 2): a 25m sweep display reads perfectly
  // at 20Hz, and the ops board's intel accumulates fine at 6Hz — neither
  // needs to burn canvas/agent-scan time every frame
  if (now - _trackerAt > 50) { _trackerAt = now; drawTracker(now); }
  if (now - _observeAt > 160) { _observeAt = now; marineMap.observe(); }
  if (mapOpen) {
    if (mates.length) {
      marineMap.mates = mates.map((m) => ({
        agent: m.agent, color: m.color, name: gameSync?.peerName(m.did) || m.label,
      }));
    }
    marineMap.draw(player.agent, player.dead);
  }
  audio.setListener(renderViewX, renderViewZ,
    deathFocusAgent ? Math.atan2(-Math.cos(deathFocusAgent.heading), -Math.sin(deathFocusAgent.heading)) : player.yaw, deathFocusAgent?.deck ?? player.deck);
  audio.alarm(sim.lastStand && !ended);
  if (sim.lastStand && !window._paLastStand) { window._paLastStand = true; audio.play('pa', null, 0.6); }
  audio.startAmbience(); // no-op until the AudioContext exists (first click)
  audio.ambienceTick();

  // ALARM + POWER STATES (review P2 slice): the last stand turns the ship's
  // light red and pulsing; an unpowered compartment flickers your lamp
  const hemiPulse = sim.lastStand ? (Math.sin(now * 0.004) + 1) / 2 : 0;
  hemi.color.setRGB(0.62 + hemiPulse * 0.35, 0.70 - hemiPulse * 0.4, 0.82 - hemiPulse * 0.55);
  // seeded room lighting: your lamp follows the room fixture's state, so a
  // faulty compartment strobes around you and a dead one goes near-black
  // THE CAMERA'S ROOM, NOT YOUR CORPSE'S (user: "the view as an infected is
  // weird"). When the flood takes you, the camera rides the combat form —
  // but every room-visual system below kept keying off the DEAD body's
  // node/deck/position: the darkness pass exempted the corpse's room from
  // its veil instead of the one you are looking out of (so you sat INSIDE a
  // room-sized murk box — the sickly green wash in the report), the fog and
  // light state tracked the wrong compartment, the active render volume and
  // the room sign followed the corpse, and the fixture pool lit rooms around
  // a body that no longer sees. One POV triple drives all of it.
  const _povA = player.dead ? deathFocusAgent : null;
  const povNode = _povA ? _povA.node : player.agent.node;
  const povDeck = _povA ? _povA.deck : player.deck;
  let povX = player.x, povZ = player.z;
  if (_povA) { const [gx, gz] = world.simToWorld(_povA.x, _povA.y, _povA.deck); povX = gx; povZ = gz; }
  if (now - _lightingAt >= 66) {
    const lightingDt = Math.min(0.2, (now - _lightingAt) / 1000);
    _lightingAt = now;
    world.updateLights(now * 0.001);
    world.updateDarkness(sim, povNode, lightingDt);
  }
  // TOTAL DARKNESS (user rule): an unlit room — flood-darkened OR just a dead
  // fixture — has NO ambient wash at all. The only light is what actually
  // emits: your flashlight, the red emergency lamps over the hatches, fire,
  // and gunfire.
  const inDark = sim.darkAt(povNode) || world.lightLevel(povNode) <= 0.1;
  const inFog = sim.fogAt(povNode);
  // FLOOD DARKNESS (user rule): inside a held room the world's light dies —
  // your flashlight is all that works. Spore fog closes the flashlight's
  // throw down to a few meters and stains the air green-brown.
  const dimT = Math.min(1, dtReal * 3);
  // DEAD SHIP (user rule): NO ambient wash at all, ever — a bright visible
  // ceiling kills the horror. A hair of structural floor stops pure-black
  // banding; every visible photon comes from discrete sources: the fixture
  // pool, the red hatch lamps, doorway spill, fires, muzzles, your torch.
  // lit rooms keep a LOW structural floor (~3x darker than the old wash —
  // ceilings stay dark, fixtures carry the light); flood-dark and dead
  // rooms stay at absolute zero, torch-only (user: pitch-black regression
  // after the first darkness pass over-crushed LIT compartments too)
  const ambTarget = inDark ? 0.0 : 0.1;
  const hemiTarget = inDark ? 0.0 : 0.12;
  ambient.intensity += (ambTarget - ambient.intensity) * dimT;
  hemi.intensity += (hemiTarget - hemi.intensity) * dimT;
  _fillI = inDark ? 0.0 : 4.5 * (0.3 + 0.7 * world.lightLevel(povNode));
  // candela, not the old 1.5-decay number: at true inverse-square 430 cd puts
  // a wall at 4 m near clipping and a bulkhead at 20 m at a believable glimmer,
  // which is what a handheld actually does. The spill is a tenth of it, and
  // the viewmodel rig a four-hundredth — both ride the same dial so the whole
  // lamp brightens and dims as one.
  torch.intensity += ((player.dead ? 0 : inDark ? 430 : 260) - torch.intensity) * dimT;
  torchSpill.intensity = torch.intensity * 0.09;
  // 0.0038 put ~40 lux on the receiver — past the ~30-lux white point, so
  // the gun clipped white no matter its albedo (user: white/striped rifle).
  // Keep only a narrow edge read on the near-black receiver. A brighter fill
  // turns even a black albedo into grey at arm's length after exposure.
  gunFill.intensity = torch.intensity * 0.00025;
  torch.distance = inFog ? sim.P.darkness.fogViewM + 2 : 30;
  torchSpill.distance = inFog ? sim.P.darkness.fogViewM + 1 : 14;
  {
    const tp = player.cameraPose();
    const tdir = _torchDir;
    camera.getWorldDirection(tdir);
    if (reloadFlashJank > 0.001) {
      // The lamp is rail-mounted: while the support hand rolls the rifle up
      // for a magazine change, the beam follows the real viewmodel barrel
      // instead of remaining supernaturally fixed at the reticle.
      rifleMesh.updateWorldMatrix(true, false);
      _torchRifleBase.copy(RIFLE_MUZZLE);
      _torchRifleBase.z -= 0.5;
      _torchRifleBase.applyMatrix4(rifleMesh.matrixWorld);
      _torchRifleTip.copy(RIFLE_MUZZLE).applyMatrix4(rifleMesh.matrixWorld);
      _torchRifleDirection.subVectors(_torchRifleTip, _torchRifleBase).normalize();
      tdir.lerp(_torchRifleDirection, reloadFlashJank * 0.94).normalize();
    }
    // BOTH beam apexes sit past the muzzle (user: white rifle) — from the
    // eye, the main cone's penumbra edge grazed the receiver at point-blank
    // range and clipped it white even with the fill dimmed. Behind the apex
    // there is no cone; the room ahead cannot tell the difference.
    torch.position.set(tp.x + tdir.x * 0.85, tp.y - 0.1 + tdir.y * 0.85, tp.z + tdir.z * 0.85);
    // spill apex out past the muzzle — see the note where it is built
    torchSpill.position.set(tp.x + tdir.x * 0.75, tp.y - 0.1 + tdir.y * 0.75, tp.z + tdir.z * 0.75);
    torchTarget.position.set(tp.x + tdir.x * 10, tp.y + tdir.y * 10, tp.z + tdir.z * 10);
    // NO GLARE OVERLAY (user: "get rid of the glare effect on the screen when
    // you reload entirely, it should just be mostly darkness"). The horror of
    // a dark-room reload is carried by the beam swing alone — the rail-mounted
    // lamp genuinely faces away from where you were looking, and the room goes
    // black on its own. The #reloadGlare element is gone from index.html too.
  }
  // fog wall: global exponential-ish fog closes in inside a spore room
  const fogTarget = inFog ? sim.P.darkness.fogViewM + 3 : inDark ? 34 : 60;
  scene.fog.far += (fogTarget - scene.fog.far) * dimT;
  scene.fog.near = inFog ? 1.5 : 18;
  scene.fog.color.setHex(inFog ? 0x1c2410 : 0x05070a);
  scene.background.setHex(inFog ? 0x151b0a : 0x05070a);
  world.setExteriorView(camera.position.x, camera.position.y, camera.position.z, !inFog);
  // volume-scoped rendering (user: don't draw the whole ship): decks beyond
  // ±1 and fore/aft thirds beyond full fog are hidden — both pixel-exact
  world.setActiveVolume(povDeck, povX);
  updateBarks(now);
  lightPool.frame(); // all dynamic sources re-declare below
  syncBurnFires();
  fire.update(dtReal, povX, povZ, elevOf(povDeck));
  updateFlameJets(dtReal);
  sparks.update(dtReal, now / 1000, povX, povZ, elevOf(povDeck));
  updateMotes(dtReal);
  sporeFX.update(dtReal, povNode, povDeck, povX, povZ);
  updateRoomLightPool(inDark, povNode, povDeck, povX, povZ);
  // the player's own fill, declared like any fixture (add() no-ops under
  // 0.02 intensity, so the dark case costs nothing and needs no branch)
  lightPool.add(_fillX, _fillY, _fillZ, 0xcfe0ff, _fillI, 10, 1.8);
  updateDoorSpill(povDeck, povX, povZ);
  updateMuzzleLights();
  lightPool.commit(povX, povZ); // brightest-and-nearest scores around the CAMERA's body
  // EXPOSURE GRADE (user: the fog dimming should be very good): the camera
  // itself stops down in murk — fog crushes the frame, plain darkness dims
  // it, clean compartments read bright. Slow lerp so it feels like eyes
  // adjusting, not a switch.
  {
    const expTarget = inFog ? 0.9 : inDark ? 1.12 : 1.35;
    post.exposure += (expTarget - post.exposure) * Math.min(1, dtReal * 1.6);
    // IBL never lights a black room — it fades with the ambient state
    scene.environmentIntensity = 0.08 * (ambient.intensity / 0.06);
  }

  // hit feedback fades
  if (hitFlash > 0) { hitFlash = Math.max(0, hitFlash - dtReal * 5); el('hitmarker').style.opacity = hitFlash.toFixed(2); }
  // directional damage: the moment armor takes a hit, point at the attacker
  const hurtTick = player.agent.lastHurtTick ?? -1;
  if (hurtTick > lastPlayerHurtTick
    || player.agent.armor < lastPlayerArmor || player.agent.hp < lastPlayerHp) {
    // A brief, light handle pulse makes incoming damage tactile without
    // turning sustained combat into a constant buzz. Unsupported browsers or
    // controllers simply return false; the visual damage feedback remains.
    if (inputMode === 'gamepad') gamepad.rumble();
    const src2 = sim.byId.get(player.agent.lastHurtBy);
    if (src2 && !src2.dead) {
      const [ax, az] = world.simToWorld(src2.x, src2.y, src2.deck);
      const bearing = Math.atan2(ax - player.x, -(az - player.z));
      dmgAngle = bearing + player.yaw;
      dmgFlash = 1;
      damageTint = 1;
      // (the per-hit 'thud' is GONE — user: the constant banging in a brawl
      // made you mute the game. The damage flash carries the hit.)
    } else { dmgFlash = 1; damageTint = 1; }
  }
  lastPlayerHurtTick = hurtTick;
  lastPlayerArmor = player.agent.armor;
  lastPlayerHp = player.agent.hp;
  if (dmgFlash > 0) {
    dmgFlash = Math.max(0, dmgFlash - dtReal * 1.6);
    const dd = el('dmgdir');
    dd.style.opacity = dmgFlash.toFixed(2);
    dd.style.transform = `rotate(${(-dmgAngle * 180 / Math.PI).toFixed(1)}deg)`;
  }
  if (damageTint > 0) {
    damageTint = Math.max(0, damageTint - dtReal); // one second, edge-only
    el('damageVignette').style.opacity = (damageTint * 0.8).toFixed(2);
  }
  if (healFlash > 0) {
    healFlash = Math.max(0, healFlash - dtReal * 1.4);
    el('healflash').style.opacity = healFlash.toFixed(2);
  }
  // med packs vanish when spent — on this client or, in co-op, on any other
  for (const m of medkitMeshes) m.mesh.visible = !m.kit.used;
  for (const m of armorPackMeshes) m.mesh.visible = !m.pack.used;
  syncGrenadeDropMeshes();
  shake = Math.max(0, shake - dtReal * 3);

  // Non-authority peers do not run sim ticks; advance the same pure door clock
  // from their received poses so their panels still track the host's geometry.
  if (!isSimAuthority()) sim._advanceDoors(dtReal);
  world.updateDoors(dtReal, sim.P.door.slideSpeedMps);
  // keep the door colliders on the sim's lock state (setDoorClosed is a
  // dirty-checked no-op when nothing changed — ~60 cheap comparisons)
  if (physics) for (let i = 0; i < world.doors.length; i++) {
    physics.setDoorClosed(i, !!world.doors[i].edge.locked);
  }

  // camera: your eyes — or the eyes of what you became
  const spectating = player.dead ? deathFocusAgent : null;
  if (spectating) {
    placeDeathCamera(spectating);
    viewmodel.visible = false;
    flamerModel.visible = false;
  } else {
    const pose = player.renderPose(alpha);
    // head bob (first-strike feel): shares the viewmodel's bob phase
    camera.position.set(pose.x, pose.y + Math.sin(_bobPhase * 2) * 0.02 * _bobAmp, pose.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(pose.yaw + (shake > 0 ? Math.sin(now * 0.09) * 0.02 * shake : 0));
    camera.rotateX(pose.pitch + (shake > 0 ? Math.sin(now * 0.11) * 0.018 * shake : 0));
    _fillX = pose.x; _fillY = pose.y + 0.2; _fillZ = pose.z;
    // exactly one weapon on screen
    viewmodel.visible = !player.dead && !heldIsFlamer;
    flamerModel.visible = !player.dead && heldIsFlamer;
  }

  // HUD — dirty-checked: unconditional textContent/style writes every frame
  // force style recalc even when nothing changed (part of the M2 stutter)
  setText('clock', fmtTime(sim.t));
  const povAgent = spectating ?? player.agent;
  const room = sim.graph.node(povAgent.node);
  setText('room', room ? room.name : '—');
  setText('deckLabel', `DECK ${povAgent.deck}`);
  const hp = Math.max(0, Math.ceil(povAgent.hp));
  setStyle('healthBar', 'transform', `scaleX(${Math.max(0, Math.min(1,
    hp / (povAgent.maxHp || 1))).toFixed(3)})`);
  setStyle('armorBar', 'transform', `scaleX(${spectating ? 0
    : Math.max(0, Math.min(1, player.armor / sim.P.player.armor)).toFixed(3)})`);
  updateStrengthHud(now);
  // the ammo readout follows whichever weapon is up: rounds for the rifle,
  // a fuel percentage for the flamer (there is nothing to count in a tank)
  setText('ammo', spectating ? ''
    : heldIsFlamer ? (flamer.empty ? 'TANK DRY' : `FUEL ${Math.ceil(flamer.frac * 100)}%`)
      : (weapon.reloading ? 'RELOADING' : `${weapon.mag} / ${weapon.reserve}`));
  setText('frags', spectating ? '' : `FRAGS ${frags}`);
  // ...and the readout above it NAMES the weapon, with BOTH swap inputs as
  // soon as there is something to swap to. The numbers alone never told the
  // user which gun was in their hands, let alone that a second one was on the
  // sling — and naming only Q here while the hint and the briefing say "Q or
  // MOUSE WHEEL" leaves the input they are most likely to try off the one
  // readout that is always on screen.
  setText('weaponName', spectating ? ''
    : `${heldIsFlamer ? 'FLAMETHROWER' : MA5.name}${hasFlamer ? inputPrompt(' · Q / WHEEL SWAP', ' · Y SWAP') : ''}`);
  { // flamer up is the HUD's orange, the same tell #roomState uses for a state change
    const wn = el('weaponName');
    const wc = heldIsFlamer && !spectating ? 'wn-flamer' : '';
    if (wn.className !== wc) wn.className = wc;
  }
  // ROOM LIGHT STATE (user: note-taking between playthroughs) — the sim's
  // authoritative fixture + flood states for the compartment you're in
  {
    const rs = el('roomState');
    const ni = povAgent.node;
    if (ni >= 0) {
      const lm = sim.graph.lightMode[ni];
      const dead = lm === 3 || sim.darkAt(ni);
      const label = sim.darkAt(ni) ? 'FLOOD DARK'
        : ['LIGHTS STEADY', 'SOFT FLICKER', 'HARSH FLICKER', 'LIGHTS DEAD'][lm];
      const extras = [
        sim.fogAt(ni) ? 'SPORE FOG' : null,
        sim.graph.unpowered[ni] ? 'UNPOWERED' : null,
      ].filter(Boolean);
      setText('roomState', extras.length ? `${label} · ${extras.join(' · ')}` : label);
      const rc = dead ? 'rs-dead' : lm === 2 ? 'rs-harsh' : lm === 1 ? 'rs-soft' : 'rs-steady';
      if (rs.className !== rc) rs.className = rc;
    } else setText('roomState', '—');
  }
  rifleMesh.userData.setAmmoDigits?.(weapon.mag);
  // the flamethrower prompt outranks the ammo prompt, matching the order the
  // E key resolves them in (player.js) — the rarer pickup wins the line
  const fsrc = player.dead ? null : player.flamerSource(hasFlamer, flamer.frac);
  const gsrc = fsrc ? null : player.grenadeSource(frags, FRAG.max);
  const src = fsrc || gsrc ? null : (player.dead ? null : player.ammoSource());
  // OUTRANKS EVERY PICKUP PROMPT for its few seconds: you are standing on the
  // rack you just took the flamer off, so the 'E — swap a fuel can' line would
  // otherwise bury the one message that teaches the swap. It also retires the
  // moment you actually swap — the lesson is over once it lands.
  if (swapHintAt && (now - swapHintAt > SWAP_HINT_MS || _swapAt > swapHintAt)) swapHintAt = 0;
  if (!player.dead && swapHintAt) {
    setText('hint', inputPrompt(
      'Q swaps · MOUSE WHEEL: up = MA5, down = flamethrower',
      'Y — swap MA5 / flamethrower',
    ));
    setStyle('hint', 'display', 'block');
  } else if (fsrc) {
    const use = inputPrompt('E', 'RB');
    setText('hint', fsrc === 'armory' ? `${use} — take the flamethrower off the rack`
      : fsrc === 'refuel' ? `${use} — swap a fuel can (${sim.armoryFuelCans} left)`
        : `${use} — take the flamethrower off the operator`);
    setStyle('hint', 'display', 'block');
  } else if (!player.dead && player.medkitSource()) {
    setText('hint', `${inputPrompt('E', 'RB')} — use the med pack`);
    setStyle('hint', 'display', 'block');
  } else if (!player.dead && player.armorSource()) {
    setText('hint', `${inputPrompt('E', 'RB')} — strap on armor plates`);
    setStyle('hint', 'display', 'block');
  } else if (gsrc) {
    setText('hint', `${inputPrompt('E', 'RB')} — pick up ${gsrc.count} frag${gsrc.count === 1 ? '' : 's'}`);
    setStyle('hint', 'display', 'block');
  } else if (src) {
    const use = inputPrompt('E', 'RB');
    setText('hint', src === 'armory'
      ? `${use} — strip mags from the rack (${sim.armoryStock} rifles)` : `${use} — take mags off the dead`);
    setStyle('hint', 'display', 'block');
  } else if (player.climb) {
    setText('hint', player.climb.toDeck < player.climb.fromDeck ? 'climbing up…' : 'climbing down…');
    setStyle('hint', 'display', 'block');
  } else if (!player.dead && weapon.reserve >= 32 && dryEscortName()) {
    setText('hint', `${inputPrompt('T', 'D-PAD ↓')} — hand a mag to ${dryEscortName()}`);
    setStyle('hint', 'display', 'block');
  } else {
    const trunk = player.dead ? null : world.trunkAt(player.deck, player.x, player.z);
    if (trunk) {
      const up = player.deck === trunk.lowerDeck;
      const kind = trunk.vertical ? 'ladder' : 'stairs';
      setText('hint', player.queuedTrunk === trunk
        ? 'in line for the ladder — you go next'
        : trunk.edge?.type === 'ladder' && sim.vertBusy(trunk.edge, player.agent.id)
          ? `${kind} busy — ${inputPrompt('E', 'RB')} to take the next slot`
          : `${inputPrompt('E', 'RB')} — climb ${kind} ${up ? 'up' : 'down'} to deck ${up ? trunk.upperDeck : trunk.lowerDeck}`);
      setStyle('hint', 'display', 'block');
    } else if (!player.dead && !weapon.reloading
      && weapon.mag < weapon.def.mag && weapon.reserve > 0) {
      setText('hint', `${inputPrompt('E', 'RB')} — reload MA5`);
      setStyle('hint', 'display', 'block');
    } else setStyle('hint', 'display', 'none');
  }
  setStyle('pinned', 'display', player.pinned && !player.dead ? 'block' : 'none');
  renderLog();
  updateNameplate();
  updateMates();
  updateComms(now);

  if (player.dead) {
    const teammate = livingTeammate();
    if (!teammate && deathStartedAt !== null && now - deathStartedAt >= DEATH_REVIEW_MS) {
      const body = afterlifeBody();
      defeatScreen(body?.faction === 4 ? 'YOU WERE TAKEN' : 'KIA',
        body?.faction === 4
          ? 'The thing wearing you keeps moving. Your body is still part of the ship now.'
          : 'The ship fights on without you. The last thing you hear is the hive, singing.');
    }
  } else if (sim.outcome === 'contained') {
    victoryScreen();
  } else if (!ended && !shownLost && sim.tickCount % 30 === 0) {
    const othersAlive = sim.agents.some((a) => !a.dead && a.hp > 0 && !a.isPlayer
      && (a.faction === 0 || a.faction === 1 || a.faction === 2));
    if (!othersAlive) {
      shownLost = true;
      endScreen('THE SATURN DEVOURING IS LOST', 'Every other soul aboard is gone. You are alone with it now.', false);
    }
  }

  // quality ladder: resolution walk + rung descend/ascend live in the
  // engine governor now (engine/runtime.js) — per-rung effects still land
  // through this game's apply callback above
  // viewport size from a cached value, not a per-frame read: the governor
  // consults it once every 3 s, and querying the window every frame is a
  // layout touch the frame does not need
  governor.frame(now, dtReal, _vpW, _vpH);

  // PERF READOUT (user: benchmark across hardware) — live FPS + frame ms +
  // a slow-decaying worst spike + resolution/rung/backend, top right under
  // the room state. Refreshed at 4Hz, dirty-checked.
  {
    const ms = dtReal * 1000;
    _fpsEma = _fpsEma * 0.92 + Math.min(200, ms) * 0.08;
    if (ms > _fpsWorst) _fpsWorst = ms;
    if (now - _fpsShownAt > 250) {
      _fpsShownAt = now;
      const fps = Math.round(1000 / _fpsEma);
      const cls = fps >= 55 ? 'fps-good' : fps >= 30 ? 'fps-mid' : 'fps-bad';
      const html = `<b>${fps} FPS</b> · ${_fpsEma.toFixed(1)}ms · spike ${_fpsWorst.toFixed(0)}ms`
        + ` · ${renderer.getPixelRatio().toFixed(2)}x · r${rung}`
        + ` · ${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2'}`;
      const meter = el('fpsMeter');
      if (meter.className !== cls) meter.className = cls;
      if (_hudCache.fpsMeter !== html) { _hudCache.fpsMeter = html; meter.innerHTML = html; }
      _fpsWorst *= 0.55; // spikes linger a couple of seconds, then fade
    }
  }
  // WALL CLOCK, not frame parity: every-other-frame is 30Hz at 60Hz but 120Hz
  // on the Legion's 240Hz panel, and the map is head-locked to the camera pose
  // so two thirds of those passes re-rendered an identical depth buffer.
  // >= 30 reproduces today's cadence exactly at 60Hz (two vsyncs is 33.3ms).
  // gate on the CASTER, not the renderer flag — the flag is pinned on now
  if (now - _shadowAt >= 30 && torchShadows.requestUpdate()) _shadowAt = now;
  renderer.info.reset(); // per-frame accumulation across all post passes
  // ...and the render itself is guarded: a throw is REPAIRED and reported, and
  // the next frame attempted, rather than taking the session down silently.
  if (_renderStopped) return; // banner is up; the sim and HUD stay alive
  try {
    post.render(scene, camera, now / 1000);
    _renderFails = 0;
  } catch (err) {
    // A CAUGHT THROW IS NOT A HANDLED THROW. three's render path is not
    // exception-safe: _renderScene leaks `_callDepth` (which keys the
    // RenderContexts cache, so every subsequent frame allocates a brand-new
    // context with fresh pass descriptors — unbounded growth), and leaves the
    // lighting begin/finish pair unbalanced. Swallowing without repairing
    // converts "one bad frame" into a slow leak behind a black screen, which
    // is strictly worse than the freeze it replaced. Put the renderer back to
    // a known state before the next frame runs.
    try {
      renderer.setRenderTarget(null);
      renderer.setMRT?.(null);
      renderer.autoClear = true;
      renderer.transparent = true;
      renderer.opaque = true;
      renderer._callDepth = -1; // its constructor's value; _renderScene ++s on entry
    } catch { /* the repair itself must never throw */ }
    reportFatal('render failed', err);
    // three consecutive failures is not a glitch — stop rendering rather than
    // spinning a broken renderer, and leave the banner up to be photographed
    if (++_renderFails >= 3) {
      _renderStopped = true;
      reportFatal('render stopped after 3 consecutive failures', err);
    }
  }
}
requestAnimationFrame(frame);

// debug hooks
window.__game = {
  sim, world, player, agents, weapon, camera, scene, renderer, flamer,
  viewmodel, flamerModel, jets, FLAMER_TUNE, marineMap,
  // test/debug hooks for the flamethrower (harnesses can't press E at a body)
  giveFlamer: () => { hasFlamer = true; heldIsFlamer = true; flamer.fuel = FLAME.tankUnits; },
  setTrigger: (v) => { fireHeld = !!v; },
  putRifleUp: () => { heldIsFlamer = false; },
  // one butt-stroke, resolved now, returning whether it connected — the swing
  // is 0.52s of animation and a harness cannot hold a key across frames
  melee: () => meleeStrike(),
  flamerState: () => ({ hasFlamer, heldIsFlamer, fuel: flamer.fuel, live: flamer.live, jet: _flameJet }),
};
window.__audio = audio; // sound-board / audit harness

function gameObservation() {
  const living = {};
  let alive = 0;
  for (const agent of sim.agents) {
    if (agent.dead || agent.hp <= 0) continue;
    alive++;
    const faction = String(agent.faction);
    living[faction] = (living[faction] || 0) + 1;
  }
  const room = sim.graph.node(player.agent.node);
  return {
    screen: introGone ? (ended ? 'result' : 'game') : 'briefing',
    run: {
      seed,
      mode: LAUNCH.mode || 'solo',
      timeSeconds: Number(sim.t.toFixed(2)),
      tick: sim.tickCount,
      outcome: sim.outcome || null,
      authority: isSimAuthority(),
    },
    player: {
      x: Number(player.x.toFixed(2)),
      z: Number(player.z.toFixed(2)),
      deck: player.deck,
      room: room?.name || null,
      yaw: Number(player.yaw.toFixed(3)),
      pitch: Number(player.pitch.toFixed(3)),
      health: Math.max(0, Math.ceil(player.agent.hp)),
      armor: Math.max(0, Math.ceil(player.armor)),
      dead: player.dead,
      pinned: player.pinned,
      weapon: heldIsFlamer ? 'flamethrower' : 'MA5',
      ammo: heldIsFlamer
        ? { fuel: Number(flamer.frac.toFixed(3)) }
        : { magazine: weapon.mag, reserve: weapon.reserve, reloading: weapon.reloading },
      frags,
    },
    world: { alive, livingByFaction: living, fires: sim.fires.length },
    fireteam: {
      order: fireteam.order?.kind || null,
      membersAlive: fireteam.members.filter((id) => {
        const member = sim.byId.get(id);
        return member && !member.dead && member.hp > 0;
      }).length,
    },
    performance: {
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
      frameMs: Number(_fpsEma.toFixed(2)),
      qualityRung: rung,
      renderStopped: _renderStopped,
      surfacedErrors: _fatalShown,
    },
    multiplayer: LAUNCH.session ? {
      self: LAUNCH.session.did,
      members: [...new Set(LAUNCH.members || [])],
      transport: LAUNCH.session.transport,
      scope: LAUNCH.scope,
    } : null,
  };
}

const agentDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pulseAgentKey(code, duration = 120) {
  player.locked = true;
  player.keys.add(code);
  try { await agentDelay(Math.max(50, Math.min(2_000, Number(duration) || 120))); }
  finally { player.keys.delete(code); }
}

globalThis.peerd?.agent?.expose({
  observe: gameObservation,
  act: async ({ action, params = {} } = {}) => {
    if (action === 'deploy') {
      governor.cancelPrewarm();
      briefing.complete();
      introGone = true;
      intro.style.display = 'none';
      overlay.classList.add('hidden');
      player.locked = true;
    } else if (action === 'move') {
      const direction = String(params.direction || 'forward');
      const code = ({ forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD' })[direction];
      if (!code) throw new Error('direction must be forward, back, left, or right');
      if (params.sprint) player.keys.add('ShiftLeft');
      try { await pulseAgentKey(code, params.durationMs || 500); }
      finally { player.keys.delete('ShiftLeft'); }
    } else if (action === 'jump') {
      await pulseAgentKey('Space', params.durationMs || 120);
    } else if (action === 'look') {
      const yawDelta = Math.max(-Math.PI, Math.min(Math.PI, Number(params.yawDelta) || 0));
      const pitchDelta = Math.max(-1, Math.min(1, Number(params.pitchDelta) || 0));
      player.yaw += yawDelta;
      player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch + pitchDelta));
    } else if (action === 'fire') {
      player.locked = true;
      fireHeld = true;
      try { await agentDelay(Math.max(50, Math.min(2_000, Number(params.durationMs) || 250))); }
      finally { fireHeld = false; }
    } else if (action === 'reload') {
      reloadPressed = true;
    } else if (action === 'melee') {
      meleePressed = true;
    } else if (action === 'grenade') {
      player.locked = true;
      fragPressed = true;
    } else if (action === 'interact') {
      await pulseAgentKey('KeyE');
    } else if (action === 'climb') {
      await pulseAgentKey('KeyE');
    } else if (action === 'map') {
      toggleMap(params.open === undefined ? !mapOpen : !!params.open);
    } else if (action === 'order') {
      const order = String(params.order || '');
      if (!['follow', 'hold', 'advance'].includes(order)) throw new Error('unknown fireteam order');
      setOrder(order);
    } else if (action === 'weapon') {
      const weaponName = String(params.weapon || 'swap');
      if (weaponName === 'swap') swapWeapon();
      else if (weaponName === 'rifle') selectWeapon(false);
      else if (weaponName === 'flamethrower') selectWeapon(true);
      else throw new Error('weapon must be rifle, flamethrower, or swap');
    } else if (action === 'restart') {
      setTimeout(() => location.reload(), 0);
    } else {
      throw new Error('unknown game action');
    }
    return gameObservation();
  },
});
