#!/usr/bin/env node
// GRAND STAIRWELL traversal check (user: NPCs teleporting up and down the
// stairs; the stairwell must be WALKED, never a portal). Orders the marine
// squad mustered in the stairwell down to the hangar with every other
// cross-deck route priced out, then watches every body on a stairwell move
// tick by tick in WORLD space (x, z = sim y minus the deck band, ground
// height from the shared switchback):
//   1. no world-position jump          — the walk is continuous in the plane
//   2. no floor-height jump            — the deck-label flips happen exactly
//                                        where the two floors meet
//   3. a traversal takes real time     — switchback meters at walking pace,
//                                        not the old 5 s portal ride
//   4. traversals actually happen      — the stairwell still routes traffic
// Plus the honest-LOS geometry: sight between the two levels passes only
// over the well opening. And the whole scripted run must replay identically.

import { Sim } from './sim.js';
import { FACTION } from '../shared/agentBuffer.js';
import { CMD } from './commands.js';
import { elevOf, stairWellDims, switchbackElev } from '../shared/geometry.js';

const fail = (msg) => { console.error(`stairwell ✗ ${msg}`); process.exit(1); };

function bandC(graph, deck) {
  const b = graph.deckBands[deck - 1];
  return (b.y0 + b.y1) / 2;
}

// world-frame floor height under an agent, mirroring game/world.js
// groundHeightAt: the switchback inside the well, the entry ring around it,
// the plain deck floor everywhere else
function mkGround(sim) {
  const g = sim.graph;
  const s = g.stairwells[0];
  const U = g.node(s.upper);
  const { ox, wellHx, wellHz, landD } = stairWellDims(U.w / 2, U.d / 2);
  const hi = elevOf(U.deck), lo = elevOf(U.deck + 1);
  const wellX = U.x + ox, wellZ = U.y - bandC(g, U.deck);
  const roomZ = U.y - bandC(g, U.deck);
  return {
    s, U, wellX, wellZ, wellHx, wellHz, landD, hi, lo,
    at(deck, wx, wz) {
      if (deck === U.deck
        && wx >= U.x - U.w / 2 && wx <= U.x + U.w / 2
        && wz >= roomZ - U.d / 2 && wz <= roomZ + U.d / 2) {
        const sy = switchbackElev(hi, lo, wellHx, wellHz, landD, wx - wellX, wz - wellZ);
        return sy ?? hi;
      }
      return elevOf(deck);
    },
  };
}

const directions = new Set();
function scriptedRun(seed, report) {
  const sim = new Sim(seed);
  // Isolate commanded walking from combat interruptions and faster Flood sprints.
  for (const a of sim.agents) if (a.faction !== FACTION.MARINE) a.dead = true;
  sim.fires.length = 0;
  sim.graph.burningUntil.fill(0);
  const G = mkGround(sim);
  const hangar = sim.graph.byId.get('hangar');
  // price every OTHER cross-deck route out so the ordered squad must take the
  // stairs — this is a harness distortion, applied identically in both replays
  for (const l of sim.graph.edges) {
    const a = sim.graph.node(l.a), b = sim.graph.node(l.b);
    if (a.deck !== b.deck && l.type !== 'stairwell') l.horizM += 900;
  }
  const prev = new Map(); // id -> {wx, wz, gh, deck, onStair}
  const rideTicks = new Map(); // id -> ticks spent on the stairwell link
  let completed = 0, ascended = 0, descended = 0, maxJump = 0, maxDrop = 0, minRideSec = Infinity;
  const squad = sim.squads.findIndex((q) => !q.broken
    && q.members.some((id) => sim.byId.get(id)?.node === G.s.upper));
  if (squad < 0) fail('no marine squad musters in the stairwell');
  for (let i = 0; i < Math.round(180 / sim.dt); i++) {
    const sq = sim.squads[squad];
    if (sim.t >= 10 && sim.t < 60 && !sq.broken && !sq.order && sim.tickCount % sim.strategicEvery === 0) {
      sim.issue({ type: CMD.GUARD, squadId: squad, node: hangar });
    }
    if (i === Math.round(80 / sim.dt)) {
      sim.issue({ type: CMD.GUARD, squadId: squad, node: G.s.upper });
    }
    sim.tick();
    for (const a of sim.agents) {
      if (a.dead) { prev.delete(a.id); rideTicks.delete(a.id); continue; }
      const onStair = !!a.move && a.move.link?.type === 'stairwell';
      const wx = a.x, wz = a.y - bandC(sim.graph, a.deck);
      const gh = G.at(a.deck, wx, wz);
      const p = prev.get(a.id);
      // watch a body while it is on the stairwell link and one tick either
      // side of it (the deck flips live at the phase boundaries)
      if (p && (onStair || p.onStair)) {
        const jump = Math.hypot(wx - p.wx, wz - p.wz);
        const drop = Math.abs(gh - p.gh);
        maxJump = Math.max(maxJump, jump);
        maxDrop = Math.max(maxDrop, drop);
        if (jump > 1.0) fail(`agent ${a.id} teleported ${jump.toFixed(2)} m in one tick on the stairs (t=${sim.t.toFixed(1)}s)`);
        if (drop > 0.9) fail(`agent ${a.id} floor height jumped ${drop.toFixed(2)} m in one tick on the stairs (t=${sim.t.toFixed(1)}s, deck ${p.deck}->${a.deck})`);
      }
      if (onStair) rideTicks.set(a.id, (rideTicks.get(a.id) ?? 0) + 1);
      else if (rideTicks.has(a.id)) {
        const sec = rideTicks.get(a.id) * sim.dt;
        rideTicks.delete(a.id);
        if (a.faction === FACTION.MARINE && a.node === p?.to) {
          completed++;
          if (a.node === G.s.upper) { ascended++; directions.add('up'); }
          else { descended++; directions.add('down'); }
          minRideSec = Math.min(minRideSec, sec);
          if (sec < 12) fail(`agent ${a.id} crossed the stairwell in ${sec.toFixed(1)} s — portal speed, not a walked switchback`);
        }
      }
      prev.set(a.id, { wx, wz, gh, deck: a.deck, onStair, to: a.move?.to });
    }

  }
  if (report) {
    console.log(`${seed}: ${completed} stairwell traversals (${ascended} up, ${descended} down), slowest-free ride ${minRideSec === Infinity ? '—' : minRideSec.toFixed(1) + ' s'}, max step ${maxJump.toFixed(2)} m, max floor delta ${maxDrop.toFixed(2)} m`);
  }
  if (!descended) fail(`no completed descent for ${seed}`);
  return sim.hashState();
}

// --- honest LOS geometry over the well ------------------------------------
{
  const sim = new Sim('charon-1');
  const G = mkGround(sim);
  const g = sim.graph;
  const upper = G.s.upper, lower = G.s.lower;
  const L = g.node(lower);
  const shift = bandC(g, L.deck) - bandC(g, G.U.deck); // upper frame -> lower frame
  const wellYU = G.U.y; // well centre y in the upper room's frame
  const wellXC = G.wellX;
  // eye to eye straight across the well opening: SEEN
  if (!sim.losClear(wellXC - 1, wellYU, upper, wellXC + 1, wellYU + shift, lower)) {
    fail('LOS across the well opening should be clear');
  }
  // both bodies well clear of the opening on the same side: the entry-ring
  // floor is between them — HIDDEN
  const offX = wellXC + G.wellHx + 4;
  if (sim.losClear(offX, wellYU, upper, offX, wellYU + shift, lower)) {
    fail('LOS should be blocked when the sight segment never crosses the well');
  }
  // shooter on the ring looking down over the opening at a form near the
  // stair foot: SEEN (the segment crosses the well rect)
  if (!sim.losClear(wellXC - G.wellHx - 2, wellYU, upper, wellXC + 2, wellYU + shift, lower)) {
    fail('LOS over the well rim onto the stairs should be clear');
  }
  console.log('cross-level LOS passes only over the well opening ✓');
}

// --- the walked traversal, twice (replay must be identical) ----------------
for (const seed of ['charon-1', 'charon-4']) {
  const h1 = scriptedRun(seed, true);
  const h2 = scriptedRun(seed, false);
  if (h1 !== h2) fail(`replay diverged for seed ${seed}`);
}
if (directions.size !== 2) fail('fixtures must exercise both ascending and descending');
console.log('grand stairwell walked in both directions, continuous, and deterministic ✓');
