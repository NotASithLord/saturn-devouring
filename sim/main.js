// Sim harness UI wiring: run loop with fixed-step accumulator, decoupled
// render (§2.3), seed replay, live master dials (§10).

import { Sim } from './sim.js';
import { Viz, renderStats, renderLog, squadTag } from './viz.js';
import { CMD } from './commands.js';
import { PARAMS } from '../shared/params.js';
import { SHIP } from './data/ship.js';

const canvas = document.getElementById('canvas');
const statsEl = document.getElementById('stats');
const logEl = document.getElementById('log');

// Scenario defaults come from the same source as the game. The controls then
// provide explicit overrides, so tuning cannot silently drift.
const SCENARIO_IDS = ['startInf', 'startCf', 'startCar', 'inMarines', 'inCivilians',
  'inArmed', 'inMaint', 'inBodies', 'inBreach'];
const DECK_ONE_GUARDS = SHIP.nodes.filter((node) => node.deck === 1 && node.type === 'room').length
  * PARAMS.marines.deckGuardPerRoom;
const CONTROL_DEFAULTS = {
  startInf: PARAMS.flood.initialInfectionForms,
  startCf: PARAMS.flood.initialCombatForms,
  startCar: PARAMS.flood.initialCarriers,
  inMarines: PARAMS.marines.squads * PARAMS.marines.squadSize
    + PARAMS.marines.patrols * PARAMS.marines.patrolSize
    + PARAMS.marines.garrison + DECK_ONE_GUARDS + PARAMS.armory.odstSquadSize,
  inCivilians: PARAMS.crew.civilians + PARAMS.crew.lowerMaintenance
    + PARAMS.crew.brigPrisoners + PARAMS.crew.medbayWounded,
  inArmed: PARAMS.crew.armedCrew + PARAMS.marineDoctrine.officers + PARAMS.marineDoctrine.bridgeOfficers,
  inMaint: PARAMS.crew.lowerMaintenance,
  inBodies: PARAMS.bodies.eventCorpses + Math.round((PARAMS.bodies.breachMin + PARAMS.bodies.breachMax) / 2),
  inBreach: Math.round((PARAMS.bodies.breachMin + PARAMS.bodies.breachMax) / 2),
  dialLambda: Math.round(Math.log(2) / PARAMS.belief.decayRatePerSec),
  dialQ: Math.round(PARAMS.belief.predictionQuality * 100),
  dialRadio: Math.round(PARAMS.radio.marineCallReliability * 100),
};
document.getElementById('inMarines').min = DECK_ONE_GUARDS;
for (const [id, value] of Object.entries(CONTROL_DEFAULTS)) {
  document.getElementById(id).value = value;
}
let infectionFormsExplicit = false;

function swarmOverrides() {
  const num = (id) => {
    const input = document.getElementById(id);
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    return Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : CONTROL_DEFAULTS[id];
  };
  const marineTotal = num('inMarines');
  // Deck 1 coverage is the minimum complement. Remaining Marines fill the
  // reserve, corridor garrison, patrols, then line squads in that order.
  const afterDeckGuard = marineTotal - DECK_ONE_GUARDS;
  const odst = Math.min(PARAMS.armory.odstSquadSize, afterDeckGuard);
  const fieldMarines = afterDeckGuard - odst;
  const garrison = Math.min(fieldMarines, Math.round(fieldMarines * 3 / 14));
  const patrols = Math.min(Math.floor((fieldMarines - garrison) / 2), Math.round(fieldMarines * 3 / 28));
  const lineCount = fieldMarines - garrison - patrols * PARAMS.marines.patrolSize;
  const lineSquads = lineCount ? Math.ceil(lineCount / PARAMS.marines.squadSize) : 0;

  const civilianTotal = num('inCivilians');
  const maintenance = Math.min(num('inMaint'), civilianTotal);
  let civilianRemainder = civilianTotal - maintenance;
  const wounded = Math.min(PARAMS.crew.medbayWounded, civilianRemainder);
  civilianRemainder -= wounded;
  const prisoners = Math.min(PARAMS.crew.brigPrisoners, civilianRemainder);
  civilianRemainder -= prisoners;

  const armedTotal = num('inArmed');
  const bridgeOfficers = Math.min(PARAMS.marineDoctrine.bridgeOfficers, armedTotal);
  const officers = Math.min(PARAMS.marineDoctrine.officers, armedTotal - bridgeOfficers);
  const bodyTotal = num('inBodies');
  const breachBodies = Math.min(num('inBreach'), bodyTotal);
  return {
    flood: {
      ...(infectionFormsExplicit ? { initialInfectionForms: num('startInf') } : {}),
      initialCombatForms: num('startCf'),
      initialCarriers: num('startCar'),
    },
    marines: {
      squads: lineSquads,
      squadSize: PARAMS.marines.squadSize,
      lineCount,
      patrols,
      garrison,
      deckGuardPerRoom: PARAMS.marines.deckGuardPerRoom,
    },
    crew: {
      civilians: civilianRemainder,
      armedCrew: armedTotal - bridgeOfficers - officers,
      lowerMaintenance: maintenance,
      brigPrisoners: prisoners,
      medbayWounded: wounded,
    },
    bodies: {
      eventCorpses: bodyTotal - breachBodies,
      breachMin: breachBodies,
      breachMax: breachBodies,
    },
    armory: { odstSquadSize: odst },
    marineDoctrine: { officers, bridgeOfficers },
  };
}

let sim = new Sim(document.getElementById('seed').value, swarmOverrides());
function syncOpeningInfectionForms() {
  if (!infectionFormsExplicit) document.getElementById('startInf').value = sim.P.flood.initialInfectionForms;
}
syncOpeningInfectionForms();
let viz = new Viz(canvas, sim);
let paused = false;
let speed = 1;
let acc = 0;
let last = performance.now();

function applyDials() {
  const memorySec = Math.max(1, Number(document.getElementById('dialLambda').value));
  const predictionPercent = Number(document.getElementById('dialQ').value);
  const radioPercent = Number(document.getElementById('dialRadio').value);
  sim.P.belief.decayRatePerSec = Math.log(2) / memorySec;
  sim.P.belief.predictionQuality = predictionPercent / 100;
  sim.P.radio.marineCallReliability = radioPercent / 100;
}

function restart() {
  sim = new Sim(document.getElementById('seed').value.trim() || 'saturn-1', swarmOverrides());
  syncOpeningInfectionForms();
  applyDials();
  viz.setSim(sim);
  syncDeckUI();
  acc = 0;
  populateCommandUI();
}

// --- tactical command console (companion spec §0/§2) ---
function populateCommandUI() {
  const nodeSel = document.getElementById('cmdNode');
  const doorSel = document.getElementById('cmdDoor');
  nodeSel.innerHTML = sim.graph.nodes.map((n) => `<option value="${n.idx}">${n.name}</option>`).join('');
  doorSel.innerHTML = sim.graph.edges
    .map((e, i) => e.lockable ? `<option value="${i}">${sim.graph.node(e.a).name}↔${sim.graph.node(e.b).name}</option>` : '')
    .join('');
  updateSquadSelector(true);
}

let squadSelectorStamp = '';
function updateSquadSelector(force = false) {
  const squadSel = document.getElementById('cmdSquad');
  const selected = squadSel.value;
  const rows = sim.squads.filter((s) => !s.deckGuard).map((s) => {
    const living = s.members.map((id) => sim.byId.get(id)).filter((a) => a && !a.dead && a.hp > 0);
    const room = living.length ? sim.graph.node(living[0].node).name : 'wiped out';
    return { s, living, room };
  });
  const stamp = rows.flatMap(({ s, living, room }) => [s.id, living.length, room]).join(':');
  if (!force && stamp === squadSelectorStamp) return;
  squadSelectorStamp = stamp;
  squadSel.innerHTML = rows.map(({ s, living, room }) => {
    return `<option value="${s.id}">${squadTag(s)} · ${living.length}/${s.members.length} · ${room}</option>`;
  }).join('');
  if ([...squadSel.options].some((option) => option.value === selected)) squadSel.value = selected;
}

function wireCommandUI() {
  document.getElementById('cmdIssue').addEventListener('click', () => {
    const squadId = Number(document.getElementById('cmdSquad').value);
    const node = Number(document.getElementById('cmdNode').value);
    const type = document.getElementById('cmdType').value;
    if (type === 'RELEASE') sim.issue({ type: CMD.RELEASE, squadId });
    else if (type === 'SET_CALL_POLICY') sim.issue({ type: CMD.SET_CALL_POLICY, squadId, policy: 'ignore' });
    else if (type === 'PATROL') {
      const deck = sim.graph.node(node).deck;
      const route = sim.graph.nodes.filter((n) => n.deck === deck).map((n) => n.idx);
      sim.issue({ type: CMD.PATROL, squadId, route });
    } else sim.issue({ type: CMD[type], squadId, node });
  });
  document.getElementById('cmdSeal').addEventListener('click', () =>
    sim.issue({ type: CMD.SET_DOOR, edgeIdx: Number(document.getElementById('cmdDoor').value), locked: true }));
  document.getElementById('cmdOpen').addEventListener('click', () =>
    sim.issue({ type: CMD.SET_DOOR, edgeIdx: Number(document.getElementById('cmdDoor').value), locked: false }));
  document.getElementById('cmdBurn').addEventListener('click', () =>
    sim.issue({ type: CMD.DESIGNATE_BURN, node: Number(document.getElementById('cmdNode').value) }));
}

function resize() {
  const wrap = document.getElementById('canvasWrap');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
}
window.addEventListener('resize', resize);
resize();

// --- camera: scroll = zoom (to cursor), drag = pan, double-click = fit ---
{
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    viz.zoomAt((e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr(), Math.exp(-e.deltaY * 0.0014));
  }, { passive: false });
  let drag = null;
  canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    viz.pan((e.clientX - drag.x) * dpr(), (e.clientY - drag.y) * dpr());
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mouseup', () => { drag = null; });
  canvas.addEventListener('dblclick', () => viz.fitShip());
}

document.getElementById('restart').addEventListener('click', restart);
document.getElementById('randomSeed').addEventListener('click', () => {
  // UI-side randomness only (not sim code) — picks a fresh seed then restarts
  document.getElementById('seed').value = 'run-' + Math.random().toString(36).slice(2, 8);
  restart();
});
document.getElementById('pause').addEventListener('click', (e) => {
  paused = !paused;
  e.target.textContent = paused ? 'run ▶' : 'pause ⏸';
});
document.getElementById('step').addEventListener('click', () => {
  paused = true;
  document.getElementById('pause').textContent = 'run ▶';
  const target = sim.tickCount + sim.strategicEvery; // one full infection round
  while (sim.tickCount < target) sim.tick();
});
document.getElementById('speed').addEventListener('input', (e) => {
  speed = Math.pow(2, Number(e.target.value)); // 0.25x .. 8x
  document.getElementById('speedVal').textContent = speed >= 1 ? `${speed}×` : `${speed.toFixed(2)}×`;
});
document.getElementById('seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') restart(); });
for (const id of SCENARIO_IDS) {
  const el = document.getElementById(id);
  el.addEventListener('focus', () => el.select()); // typing REPLACES the value
  if (id === 'startInf') el.addEventListener('input', () => { infectionFormsExplicit = true; });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') restart(); });
}
document.getElementById('legendToggle').addEventListener('click', (e) => {
  const hidden = document.getElementById('legend').classList.toggle('hidden');
  e.target.classList.toggle('active', !hidden);
});

for (const d of document.querySelectorAll('#deckBtns button')) {
  d.addEventListener('click', () => {
    document.querySelectorAll('#deckBtns button').forEach((b) => b.classList.remove('active'));
    d.classList.add('active');
    viz.deckFilter = Number(d.dataset.deck);
    if (viz.deckFilter === 0) viz.fitShip();
  });
}
function syncDeckUI() {
  document.querySelectorAll('#deckBtns button').forEach((button) =>
    button.classList.toggle('active', Number(button.dataset.deck) === viz.deckFilter));
}
syncDeckUI();
const ov = (id, key) => document.getElementById(id).addEventListener('change', (e) => { viz.overlays[key] = e.target.checked; });
ov('ovInfluence', 'influence'); ov('ovShafts', 'shafts'); ov('ovVents', 'vents');
ov('ovCalls', 'calls'); ov('ovTracker', 'tracker'); ov('ovBeliefs', 'beliefs'); ov('ovLabels', 'labels'); ov('ovConns', 'conns');
ov('ovFire', 'fire');
for (const id of ['dialLambda', 'dialQ', 'dialRadio']) {
  document.getElementById(id).addEventListener('input', applyDials);
}
applyDials();
populateCommandUI();
wireCommandUI();
statsEl.addEventListener('click', (event) => {
  const row = event.target.closest('[data-squad]');
  if (!row) return;
  document.getElementById('cmdSquad').value = row.dataset.squad;
  document.getElementById('cmdSquad').focus();
});

// debug/test hooks (harmless in normal use)
window.__viz = () => viz;
window.__sim = () => sim;

function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += dtReal * speed;
    const tickDt = sim.dt;
    let guard = 0;
    while (acc >= tickDt && guard++ < 240) {
      sim.tick();
      acc -= tickDt;
    }
    if (guard >= 240) acc = 0; // fell behind; drop time rather than spiral
  }
  // pass real frame time; the viz smooths agent positions by id (see Viz)
  viz.draw(dtReal * (paused ? 0.4 : Math.max(1, speed)));
  renderStats(sim, statsEl);
  updateSquadSelector();
  renderLog(sim, logEl);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
