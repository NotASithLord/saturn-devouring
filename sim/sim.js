// Sim orchestrator (§2): fixed 15 Hz movement/sense tick, ~2.5 s strategic
// tick ("infection round"), deterministic from seed, writes the shared
// AgentBuffer every tick (§2.2).

import { RNG } from '../shared/rng.js';
import { cloneParams } from '../shared/params.js';
import { AgentBuffer, FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { shipForceCounts } from '../shared/force-counts.js';
import { clearHeightOf, CLEAR_H, stairWellDims } from '../shared/geometry.js';
import { initRun, STATE, makeAgent } from './init.js';
import { updateHumansTick, strategicSquads, assignFirstSweep, marineThrowFragAt } from './humans.js';
import { Hive, TASK, W_FLOOD, W_HUMAN, isActiveFloodForm, isLivingHuman } from './hive.js';
import { updateFloodTick } from './floodExec.js';
import { resolveCombat, humanDeathToCorpse, hurtFloodForm } from './combat.js';
import { CommandQueue, CMD } from './commands.js';
import { applyCommand } from './commandApply.js';
import { nameFor, rankFromPool, RANK_POOLS } from '../shared/names.js';
import { combatChargeArmsHigh } from './charge-pose.js';

const TINT = {
  [FACTION.CIVILIAN]: 0xf2f2f2, [FACTION.ARMED]: 0xe8c840, [FACTION.MARINE]: 0x4d8ef0,
  [FACTION.INFECTION]: 0x51ff6a, [FACTION.COMBAT]: 0xa8342a, [FACTION.CARRIER]: 0xb15fd9,
  [FACTION.CORPSE]: 0x8a8a8a,
};

export class Sim {
  constructor(seed, paramOverrides = null, runOptions = null) {
    this.seed = String(seed);
    this.P = cloneParams();
    const initialInfectionFormsExplicit = Object.hasOwn(
      paramOverrides?.flood ?? {}, 'initialInfectionForms',
    );
    if (paramOverrides) deepMerge(this.P, paramOverrides);
    this.rng = new RNG(this.seed);
    this.t = 0;
    this.tickCount = 0;
    this.dt = 1 / this.P.sim.tickHz;
    this.strategicEvery = Math.round(this.P.sim.strategicTickSec * this.P.sim.tickHz);

    const { graph, agents, squads } = initRun(this.seed, this.rng, this.P, {
      playerCount: runOptions?.playerCount ?? 1,
      playerSpawnId: runOptions?.playerSpawnId,
      initialInfectionFormsExplicit,
    });
    this.graph = graph;
    for (const edge of graph.edges) {
      if (edge.door) edge.open01 = edge.locked ? this.P.door.ajarFraction : 0;
    }
    this.agents = agents;
    this.squads = squads;
    this.byId = new Map(agents.map((a) => [a.id, a]));
    // CALLSIGNS (user: radio-transcript log + reticle nameplates): every
    // human — including the corpses and everyone the flood will later wear —
    // gets a deterministic rank+name. Pure function of (seed, id) plus a
    // structural pass for the leadership billets: no RNG stream consumed,
    // so replays and divergence are untouched. Conversions mutate the same
    // record, so combat forms keep their host's name.
    for (const a of agents) this._assignCallsign(a);
    this._assignRanks();
    // rooms indexed by deck, for the physical-room lookup (_pnodeOf)
    this._deckRooms = {};
    for (const n of graph.nodes) (this._deckRooms[n.deck] ??= []).push(n);
    this._deckAgents = {};
    for (const deck of Object.keys(this._deckRooms)) this._deckAgents[deck] = [];
    this._losAgentCache = new Map();

    this.buffer = new AgentBuffer(512);
    this.commands = new CommandQueue();
    this.events = [];
    this.calls = [];   // distress calls {id, node, t, faction, rolled:Set, deckSighting?}
    this.callSeq = 0;
    this.grenades = []; // live NPC throws awaiting detonation
    this.grenadeDrops = []; // remaining marine frags, persistent after the body is consumed
    this.floodKnown = false;
    this.firstSweepCleared = false;
    this.burnOrderNode = -1; // last DESIGNATE_BURN target (companion §2.2)
    this.lastStand = false;
    // the ODST reserve doesn't count toward last-stand math — it's a sealed
    // asset, not part of the line the lastStand fraction is measured against
    this.initialSquadMarines = agents.filter((a) => a.faction === FACTION.MARINE && !a.garrison && !a.odst).length;
    this.armoryStock = this.P.armory.stock; // rifles on the rack, first come first served
    // the spare flamethrower params already describe as racked in the armory,
    // plus fuel cans beside it. Only the player can take these — the ODST
    // reserve's operator (init.js) walks out with his own.
    this.armoryFlamer = true;
    this.armoryFuelCans = 3;
    this.armoryLocked = true; // the sealed reserve (init.js locked the blastdoor)
    // A dedicated stream keeps the scheduled release reproducible without
    // moving gameplay RNG draws. Active Flood parity can release it sooner.
    this.armoryReleaseAt = new RNG(`${this.seed}:armory-release`).range(
      this.P.armory.releaseMinSec,
      this.P.armory.releaseMaxSec,
    );
    this.marinesKnowRevive = false; // flips at the first witnessed revive (reviveWitnessed)
    this.outcome = null;
    this.outcomeAt = null; // sim seconds at the moment it was decided
    this.dormantVentReserves = this.P.flood.dormantVentReserves ?? 0;
    this._dormantVentReleaseNodes = new Set();
    this._weakHiveSince = -1;

    this.stats = {
      conversions: 0, conversionsRound: 0, humansConverted: 0,
      carriersSeated: 0, formsMinted: 0, corpsesBurned: 0,
      infectionFormsKilled: 0, combatFormsDowned: 0, humansDead: 0,
      distressCalls: 0, friendlyFireHits: 0,
    };

    this._precomputeSensing();
    this.influence = {
      floodStr: new Float32Array(graph.n),
      humanStr: new Float32Array(graph.n),
      hardness: new Float32Array(graph.n),
    };
    this._floodAt = new Float32Array(graph.n);
    this._humanAt = new Uint16Array(graph.n);
    this.floodHoldSec = new Float64Array(graph.n); // solo-occupancy clock (darkness)
    this.fogLinger = new Float64Array(graph.n).fill(this.P.darkness.fogLingerSec); // burn-off clock per fogged room
    this.gunfireTick = new Int32Array(graph.n).fill(-9999);
    this.screamTick = new Int32Array(graph.n).fill(-9999);
    this.sweptAt = new Float64Array(graph.n).fill(-9999); // last time a marine cleared a room
    this._panicked = new Uint8Array(graph.n);
    // MARINE MOTION RADAR: one aggregate pass over active Flood per sim tick,
    // then every squad reads these fixed-size room arrays. This is deliberately
    // not a marine×enemy proximity query; late-game swarm size barely matters.
    this.marineMotionCount = new Uint16Array(graph.n);
    this.marineMotionLastCount = new Uint16Array(graph.n);
    this.marineMotionTick = new Int32Array(graph.n).fill(-9999);

    // FIRES (user rule): the breach burns, and the ship's BROKEN (jammed)
    // doors are the other fire sites — a broken door IS the damage showing.
    // Each fire is a real sim object: it hurts anyone standing in it, and
    // every NPC steers clear. Locked doors were already impassable, so the
    // door fires add area denial around the jam, not new blockage.
    this.fires = [];
    {
      const br = graph.node(graph.breachNode);
      this.fires.push({
        deck: br.deck, node: br.idx,
        x: br.x + this.rng.range(-br.w / 4, br.w / 4),
        y: br.y + this.rng.range(-br.d / 4, br.d / 4), scale: 1.7,
      });
      const brokenDoors = graph.edges.filter((e) => e.locked && e.door
        && graph.node(e.a).deck === graph.node(e.b).deck);
      const count = Math.min(brokenDoors.length, 2 + this.rng.int(3)); // 2-4 per seed
      for (let i = 0; i < count; i++) {
        const e = brokenDoors.splice(this.rng.int(brokenDoors.length), 1)[0];
        e.burning = true; // the renderer tints the panel; pathing already blocks it (locked)
        e.fireSite = true; // authored damage — the jam/unjam rotation never touches it
        this.fires.push({ deck: graph.node(e.a).deck, node: e.a, x: e.door.x, y: e.door.y, scale: 0.9 });
      }
      // nobody SPAWNS inside a blaze (the initial swarm lands at the breach,
      // right where the biggest fire is): nudge the living out to the rim;
      // corpses caught inside it at the event are already charred husks
      for (const a of this.agents) {
        for (const f of this.fires) {
          if (a.deck !== f.deck) continue;
          const R = this.P.fire.radiusM * f.scale;
          const dx = a.x - f.x, dy = a.y - f.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R) continue;
          if (a.faction === FACTION.CORPSE) { a.damage = 100; continue; }
          const d = Math.sqrt(d2) || 0.001;
          const room = graph.node(a.node);
          const hw = Math.max(0.4, room.w / 2 - 0.3), hd = Math.max(0.4, room.d / 2 - 0.3);
          a.x = Math.max(room.x - hw, Math.min(room.x + hw, f.x + (dx / d) * (R + 0.6)));
          a.y = Math.max(room.y - hd, Math.min(room.y + hd, f.y + (dy / d) * (R + 0.6)));
        }
      }
    }

    // the malfunction population and each door's first flip time — after the
    // fire block so fireSite doors are already marked and stay excluded
    this._seedDoorFaults();

    // MED PACK POOL (user: Halo CE med packs — 2 per player racked in the
    // medbay, 2 per player scattered through the ship "as part of the seed").
    // Placement comes off a DEDICATED RNG stream keyed off the seed, so the
    // pool is seed-stable without moving a single draw of the main stream —
    // the headless replay (which never attaches a player) hashes identically.
    // Kits are only ISSUED when a player attaches: slot i of each pool always
    // becomes the same kit with the same id, so co-op clients that attach the
    // same players in any order end up with the same set.
    {
      const mrng = new RNG(this.seed + ':medkits');
      const inRoom = (n) => [
        n.x + mrng.range(-Math.max(0.4, n.w / 2 - 1.0), Math.max(0.4, n.w / 2 - 1.0)),
        n.y + mrng.range(-Math.max(0.4, n.d / 2 - 1.0), Math.max(0.4, n.d / 2 - 1.0)),
      ];
      const medbay = graph.node(graph.byId.get('medbay'));
      this._medkitPoolMedbay = [];
      for (let i = 0; i < 8; i++) {
        const [x, y] = inRoom(medbay);
        this._medkitPoolMedbay.push({ node: medbay.idx, deck: medbay.deck, x, y });
      }
      // scatter: proper rooms only (no corridors/shafts), never the medbay
      // (covered above) and never the breach — a pack spawned inside the
      // event fire would only ever be scenery
      const rooms = [];
      for (let i = 0; i < graph.n; i++) {
        const n = graph.node(i);
        if (n.type !== 'room' || n.id === 'medbay' || i === graph.breachNode) continue;
        rooms.push(n);
      }
      mrng.shuffle(rooms);
      this._medkitPoolScatter = [];
      for (let i = 0; i < Math.min(8, rooms.length); i++) {
        const [x, y] = inRoom(rooms[i]);
        this._medkitPoolScatter.push({ node: rooms[i].idx, deck: rooms[i].deck, x, y });
      }
    }
    this.medkits = [];
    this._medkitPlayers = 0;

    // ARMOR PACK POOL (user: armor replaces shields — no regen, packs only;
    // 3 per player racked in the armory, 5 per player scattered). Identical
    // machinery to the med packs above: dedicated seed-keyed stream, pools
    // sized for the 4-player cap, issued by slot as players attach.
    {
      const arng = new RNG(this.seed + ':armorpacks');
      const inRoom = (n) => [
        n.x + arng.range(-Math.max(0.4, n.w / 2 - 1.0), Math.max(0.4, n.w / 2 - 1.0)),
        n.y + arng.range(-Math.max(0.4, n.d / 2 - 1.0), Math.max(0.4, n.d / 2 - 1.0)),
      ];
      const armory = graph.node(graph.byId.get('armory'));
      this._armorPoolArmory = [];
      for (let i = 0; i < 12; i++) {
        const [x, y] = inRoom(armory);
        this._armorPoolArmory.push({ node: armory.idx, deck: armory.deck, x, y });
      }
      const rooms = [];
      for (let i = 0; i < graph.n; i++) {
        const n = graph.node(i);
        if (n.type !== 'room' || n.id === 'armory' || i === graph.breachNode) continue;
        rooms.push(n);
      }
      arng.shuffle(rooms);
      this._armorPoolScatter = [];
      for (let i = 0; i < Math.min(20, rooms.length); i++) {
        const [x, y] = inRoom(rooms[i]);
        this._armorPoolScatter.push({ node: rooms[i].idx, deck: rooms[i].deck, x, y });
      }
    }
    this.armorPacks = [];
    this._armorPlayers = 0;

    this.hive = new Hive(this);
    assignFirstSweep(this);
    this._refreshOccupancy();
    this._refreshMarineMotion();
    this._computeInfluence();
    // The opening split must exist before the first actuator tick. Otherwise
    // the reflexive corpse conversion claims every crash-site body before the
    // strategic planner gets its first turn, erasing the vent-dispersion rule.
    // The port capacitor's nearby food is more valuable than an immediate
    // vent departure there; elsewhere, opening runners leave before the
    // corpse reflex can cancel their assigned dispersion.
    this.openingVentFromStart = this.P.hive.openingVentFromStart === 'spawn-aware'
      ? graph.node(graph.breachNode).id !== 'capPort'
      : !!this.P.hive.openingVentFromStart;
    if (this.openingVentFromStart) {
      const initialPods = agents.filter((a) => a.faction === FACTION.INFECTION);
      const initialBodies = agents.filter((a) => a.faction === FACTION.CORPSE);
      const openingPlan = this.hive._openingSpread(initialPods, initialBodies);
      for (const pod of initialPods) {
        const target = openingPlan.get(pod.id);
        if (target !== undefined) this.hive.assign(pod, { kind: TASK.MOVE, node: target, spread: true });
      }
    }
    const marineCount = agents.filter((a) => a.faction === FACTION.MARINE).length;
    const civilianCount = agents.filter((a) => a.faction === FACTION.CIVILIAN).length;
    const armedCount = agents.filter((a) => a.faction === FACTION.ARMED).length;
    const bodyCount = agents.filter((a) => a.faction === FACTION.CORPSE).length;
    this.log('init', `seed "${this.seed}" — breach at ${graph.node(graph.breachNode).name}, ${agents.filter(isLivingHuman).length} souls aboard · flood ${this.P.flood.initialInfectionForms}i/${this.P.flood.initialCombatForms}c/${this.P.flood.initialCarriers}k · ${marineCount} marines in ${this.P.marines.squads} line squads + ${this.P.marines.patrols} patrols · ${civilianCount} civilians / ${armedCount} armed crew · ${bodyCount} bodies`);
    this.writeBuffer();
  }

  // --- sensing precomputation: rebuilt via _doorMutated whenever a lock
  // flips (malfunction rotation, SET_DOOR, armory release, door busts) ---
  _precomputeSensing() {
    const g = this.graph;
    this.visCache = [];
    this.senseCache = [];
    this.hear2 = [];
    this.hear3 = [];
    this.near1 = [];
    for (let i = 0; i < g.n; i++) {
      const vis = [i];
      // FLOOD LIFE-SENSE (user rule): the flood FEELS living bodies in every
      // adjacent compartment, through bulkheads and locked hatches alike —
      // it doesn't need a line of sight the way the crew's eyes do. senseCache
      // is self + EVERY std/vent neighbour regardless of lock/block; visCache
      // is the crew's honest sightline (unlocked doorways only). Same static
      // graph, so both are fixed for the whole run and fully deterministic.
      const sense = [i];
      for (const { to, link } of g.neighbors(i, ['std'], () => true)) {
        if (!link.locked) vis.push(to); // an open/unlocked doorway you can see through
        if (!sense.includes(to)) sense.push(to); // life-sense ignores the lock
      }
      // (the per-pair vent layer is gone — std adjacency already covers every
      // touching compartment, which is exactly the tentacle-sense the flood
      // gets: its own room plus every adjacent room, lock or no lock)
      this.visCache.push(vis);
      this.senseCache.push(sense);
      this.hear2.push(g.nodesWithin(i, this.P.sensor.hearingHops, ['std'], () => true));
      this.hear3.push(g.nodesWithin(i, this.P.sensor.gunfireHops, ['std'], () => true));
      this.near1.push(g.nodesWithin(i, 1, ['std'], (l) => !l.locked));
    }
    // a grand stairwell is one open volume — the two levels see each other
    for (const s of g.stairwells) {
      if (!this.visCache[s.upper].includes(s.lower)) this.visCache[s.upper].push(s.lower);
      if (!this.visCache[s.lower].includes(s.upper)) this.visCache[s.lower].push(s.upper);
      if (!this.senseCache[s.upper].includes(s.lower)) this.senseCache[s.upper].push(s.lower);
      if (!this.senseCache[s.lower].includes(s.upper)) this.senseCache[s.lower].push(s.upper);
    }
  }

  // Same purposeful-motion definition as AgentBuffer.MOVING, evaluated once
  // at room granularity. The one-tick steer grace bridges the ordering seam:
  // Flood steering happens after marine planning, but its movement was real
  // and remains a valid radar paint on the next 15 Hz tick.
  _refreshMarineMotion() {
    const count = this.marineMotionCount;
    count.fill(0);
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.downed) continue;
      if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT
        && a.faction !== FACTION.CARRIER) continue;
      const moving = a.move || a.leaping || (a.steeredTick ?? -9999) >= this.tickCount - 1
        || a.transformingUntil !== undefined
        || (a.state === STATE.GRABBING && a.grabTimer > 0);
      if (!moving) continue;
      const node = a.pnode ?? a.node;
      count[node]++;
    }
    for (let node = 0; node < this.graph.n; node++) {
      if (count[node] === 0) continue;
      this.marineMotionLastCount[node] = count[node];
      this.marineMotionTick[node] = this.tickCount;
    }
  }

  marineMotionAt(node) {
    const memoryTicks = Math.ceil(this.P.marineDoctrine.radarMemorySec * this.P.sim.tickHz);
    const tick = this.marineMotionTick[node];
    return {
      fresh: this.tickCount - tick <= memoryTicks,
      current: this.marineMotionCount[node],
      count: this.marineMotionLastCount[node],
      tick,
    };
  }

  visibleNodes(node) { return this.visCache[node]; }
  // the flood's life-sense reach (self + every adjacent room, lock or no lock).
  // Targeting/belief code uses this; the crew keep visibleNodes.
  floodSenses(node) { return this.senseCache[node]; }

  // GEOMETRIC LINE OF SIGHT (per-room combat retirement — user: "NPCs should
  // be operating on line of sight"). A 2D segment walk from room to room:
  // sight passes only where the segment crosses a doorway's opening span.
  // Openings are precomputed on the graph (edge.losOpen), but a sliding panel
  // contributes one only after the deterministic sim says it is physically
  // clear. Lock state alone is not sight: an unlocked but shut panel is steel.
  //   DOOR_HALF mirrors game/world.js DOOR_W (1.7) / 2.
  losClear(x1, y1, r1, x2, y2, r2) {
    if (r1 === r2) return true;
    const g = this.graph;
    const n1 = g.node(r1), n2 = g.node(r2);
    if (n1.deck !== n2.deck) {
      // the grand stairwell is one open two-storey volume, but the SIGHTLINE
      // between its levels is the well opening, not the whole pair of rooms
      // (user: LOS rules must apply on the stairs). The entry ring's floor
      // hides everything whose sight segment doesn't pass over the hole, so:
      // convert both eyes into the upper room's frame (sim y carries the deck
      // band) and require the 2D segment to CROSS the well rect.
      for (const sw of g.stairwells) {
        if ((r1 === sw.upper && r2 === sw.lower) || (r1 === sw.lower && r2 === sw.upper)) {
          const U = g.node(sw.upper);
          const wp = this._stairWaypoints(U);
          const shift1 = this._bandC(n1.deck) - this._bandC(U.deck);
          const shift2 = this._bandC(n2.deck) - this._bandC(U.deck);
          return this._segCrossesRect(x1, y1 - shift1, x2, y2 - shift2,
            wp.wellX, wp.wellY, wp.wellHx, wp.wellHz);
        }
      }
      return false;
    }
    const dx = x2 - x1, dy = y2 - y1;
    const edgeSlackT = 1.7 / (Math.hypot(dx, dy) || 1);
    let cur = r1, prevT = 1e-9;
    for (let hop = 0; hop < 8; hop++) {
      // A ray must leave the current room through its next wall. Previously
      // the walk could skip that wall and accept a later, aligned doorway,
      // letting a rifle shoot through an intervening bulkhead.
      const room = g.node(cur);
      let exitT = Infinity;
      if (dx > 1e-9) exitT = Math.min(exitT, (room.x + room.w / 2 - x1) / dx);
      else if (dx < -1e-9) exitT = Math.min(exitT, (room.x - room.w / 2 - x1) / dx);
      if (dy > 1e-9) exitT = Math.min(exitT, (room.y + room.d / 2 - y1) / dy);
      else if (dy < -1e-9) exitT = Math.min(exitT, (room.y - room.d / 2 - y1) / dy);
      let bestTo = -1, bestT = Infinity;
      for (const { to, link } of g.adj.std[cur]) {
        const o = link.losOpen;
        if (!o || link.locked || (!link.busted
          && (link.open01 ?? 0) < this.P.door.sightOpenFraction)) continue;
        let t, cross;
        if (o.axis === 'x') {          // wall at x = o.at, opening spans y
          if (Math.abs(dx) < 1e-9) continue;
          t = (o.at - x1) / dx;
          cross = y1 + dy * t;
        } else {                       // wall at y = o.at, opening spans x
          if (Math.abs(dy) < 1e-9) continue;
          t = (o.at - y1) / dy;
          cross = x1 + dx * t;
        }
        if (t <= prevT || t > 1 + 1e-9) continue;
        // Adjacent room footprints overlap slightly around some panels; the
        // doorway may sit up to ~1.6 m inside the room's nominal edge.
        if (t > exitT + edgeSlackT) continue;
        if (Math.abs(cross - o.c) > 0.85) continue;
        if (t < bestT) { bestT = t; bestTo = to; }
      }
      if (bestTo === -1) return false;
      if (bestTo === r2) return true;
      prevT = bestT;
      cur = bestTo;
    }
    return false;
  }

  // A point f (0..1) of the way along a polyline, by ARC LENGTH — the walk
  // covers every leg at one speed, however the corners split it.
  _walkPolyline(pts, f) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let d = Math.max(0, Math.min(1, f)) * L;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (d <= l || i === pts.length - 1) {
        const u = l > 1e-9 ? Math.min(1, d / l) : 1;
        return [pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u];
      }
      d -= l;
    }
    const p = pts[pts.length - 1];
    return [p.x, p.y];
  }

  // Shortest corner detour around an axis-aligned rect (inflated by m) from
  // (sx,sy) to (tx,ty): [] when the straight segment already clears it, else
  // one or two corners of the inflated rect. Runs once at move start; used so
  // a stairwell approach walks AROUND the open well / stair tower instead of
  // cutting across the hole in plan.
  _detourAroundRect(sx, sy, tx, ty, cx, cy, hx, hy, m) {
    const HX = hx + m, HY = hy + m;
    const blocked = (ax, ay, bx, by) => this._segCrossesRect(ax, ay, bx, by, cx, cy, HX - 0.05, HY - 0.05);
    // an endpoint stranded INSIDE the rect (a shove, an old save) first steps
    // out through the nearest face, then routes around like everyone else
    const inside = (x, y) => Math.abs(x - cx) < HX && Math.abs(y - cy) < HY;
    if (inside(sx, sy) || inside(tx, ty)) {
      const esc = (x, y) => {
        const dW = x - (cx - hx), dE = (cx + hx) - x, dN = y - (cy - hy), dS = (cy + hy) - y;
        const min = Math.min(dW, dE, dN, dS);
        // Step just beyond the inflated boundary. A point rounded a fraction
        // inside that boundary recursed forever when a live chaser reached a
        // corner and replanned on the following tick.
        const e = 1e-4;
        if (min === dN) return { x, y: cy - HY - e };
        if (min === dS) return { x, y: cy + HY + e };
        if (min === dW) return { x: cx - HX - e, y };
        return { x: cx + HX + e, y };
      };
      const s2 = inside(sx, sy) ? esc(sx, sy) : null;
      const t2 = inside(tx, ty) ? esc(tx, ty) : null;
      const midPts = this._detourAroundRect(s2?.x ?? sx, s2?.y ?? sy, t2?.x ?? tx, t2?.y ?? ty, cx, cy, hx, hy, m);
      return [...(s2 ? [s2] : []), ...midPts, ...(t2 ? [t2] : [])];
    }
    if (!blocked(sx, sy, tx, ty)) return [];
    const C = [
      { x: cx - HX, y: cy - HY }, { x: cx + HX, y: cy - HY },
      { x: cx - HX, y: cy + HY }, { x: cx + HX, y: cy + HY },
    ];
    let best = null, bestL = Infinity;
    const consider = (pts) => {
      let px = sx, py = sy, L = 0;
      for (const p of pts) {
        if (blocked(px, py, p.x, p.y)) return;
        L += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y;
      }
      if (blocked(px, py, tx, ty)) return;
      L += Math.hypot(tx - px, ty - py);
      if (L < bestL - 1e-9) { bestL = L; best = pts; }
    };
    for (const c of C) consider([c]);
    for (const c1 of C) for (const c2 of C) if (c1 !== c2) consider([c1, c2]);
    return best ?? [];
  }

  // Does the 2D segment (x1,y1)->(x2,y2) pass through the axis-aligned rect
  // centred (cx,cy) half-extents (hx,hy)? Liang–Barsky clip; endpoints inside
  // count (a body standing ON the stairs is in the sightline volume itself).
  _segCrossesRect(x1, y1, x2, y2, cx, cy, hx, hy) {
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-12) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    return clip(-dx, x1 - (cx - hx)) && clip(dx, (cx + hx) - x1)
      && clip(-dy, y1 - (cy - hy)) && clip(dy, (cy + hy) - y1);
  }

  // Real-space perception shared by combat and behavior. Rooms remain the
  // pathfinding mesh, but they no longer decide who can see whom: any live
  // body inside the range and geometric sightline is a candidate, even across
  // several aligned openings or the grand stairwell's open two-storey volume.
  agentDistance(a, b) {
    const dx = b.x - a.x;
    if (a.deck === b.deck) return Math.hypot(dx, b.y - a.y);
    // Sim y includes a separate map band for each deck. Remove that drawing
    // offset before measuring an open stairwell, then include the real storey
    // height; otherwise the map's whitespace makes adjacent stair landings
    // look hundreds of metres apart to sight and targeting.
    const ay = a.y - this._bandC(a.deck);
    const by = b.y - this._bandC(b.deck);
    const dz = Math.abs(a.deck - b.deck) * this.graph.deckHeightM;
    return Math.hypot(dx, by - ay, dz);
  }

  hasLineOfSight(observer, target, rangeM = this.P.combat.sightM) {
    const from = observer.pnode ?? observer.node;
    if (target.move?.hidden || this.agentDistance(observer, target) > rangeM) return false;
    const to = target.pnode ?? target.node;
    return this.losClear(observer.x, observer.y, from, target.x, target.y, to);
  }

  lineOfSightAgents(observer, predicate, rangeM = this.P.combat.sightM) {
    const key = rangeM === this.P.combat.sightM ? observer.id : `${observer.id}:${rangeM}`;
    let visible = this._losAgentCache.get(key);
    if (!visible) {
      visible = [];
      for (const target of this._deckAgents[observer.deck] ?? []) {
        if (target !== observer && this.hasLineOfSight(observer, target, rangeM)) visible.push(target);
      }
      const from = observer.pnode ?? observer.node;
      for (const stair of this.graph.stairwells) {
        const other = from === stair.upper ? stair.lower : from === stair.lower ? stair.upper : -1;
        if (other === -1) continue;
        for (const target of this._occ[other] ?? []) {
          if (target !== observer && this.hasLineOfSight(observer, target, rangeM)) visible.push(target);
        }
      }
      this._losAgentCache.set(key, visible);
    }
    return visible.filter((target) => !target.dead && target.hp > 0 && predicate(target));
  }

  // LOS-filtered visible Flood strength. Detection and rifle acquisition use
  // this same geometric envelope, so a contact can neither freeze a squad
  // outside firing range nor be shootable without triggering a reaction.
  losFloodThreat(h, rangeM = this.P.combat.sightM) {
    let sum = 0;
    for (const target of this.lineOfSightAgents(h,
      (a) => a.faction === FACTION.CARRIER || isActiveFloodForm(a), rangeM)) {
      sum += W_FLOOD[target.faction];
    }
    return sum;
  }
  nodesNear(node, hops) { return hops <= 1 ? this.near1[node] : this.graph.nodesWithin(node, hops, ['std'], (l) => !l.locked); }

  occupants(node) { return this._occ[node]; }
  occupantsNear(node, hops) {
    const out = [];
    for (const n of this.nodesNear(node, hops)) out.push(...this._occ[n]);
    return out;
  }
  floodStrengthAt(node) { return this._floodAt[node]; }
  // live bodies standing in this room, counted by PHYSICAL position. Already
  // maintained for the influence pass; exposed because the hive needs it to
  // refuse to root a carrier in an occupied room.
  humansAt(node) { return this._humanAt[node]; }
  panickedAt(node) { return this._panicked[node] === 1; }
  heardGunfire(node) {
    return this.hear3[node].some((n) => this.tickCount - this.gunfireTick[n] < 30);
  }
  heardScreams(node) {
    return this.hear2[node].some((n) => this.tickCount - this.screamTick[n] < 30);
  }
  gunfireAt(node) { this.gunfireTick[node] = this.tickCount; }

  // Commander entry point (companion spec §0). Stamps the command
  // inputDelayTicks into the future so in multiplayer it reaches every peer
  // before its execution tick; in single-player that's ~1 tick, invisible.
  issue(cmd, peerId = 0) {
    this.commands.enqueue(cmd, this.tickCount + this.P.net.inputDelayTicks, peerId);
  }

  // THE PLAYER (3D slice): a real agent in the sim — the flood can see,
  // hunt, grab and convert them; marines and civilians treat them as crew.
  // Position is driven externally by the game each tick, so strict lockstep
  // determinism pauses while a live player is attached (their movement is an
  // input stream; the multiplayer path feeds it through the command queue).
  attachPlayer(nodeIdx, opts = {}) {
    const a = makeAgent(opts.odst ? FACTION.ARMED : FACTION.CIVILIAN, nodeIdx, this.graph);
    a.hp = a.maxHp = opts.odst ? 45 : this.P.combat.civilian.hp;
    a.armor = this.P.player.armor;
    a.isPlayer = true;
    a.bodyType = opts.bodyType === 'female' ? 'female' : 'male';
    a.hasRadio = true;
    this.spawn(a);
    this._issueMedkits();
    this._issueArmorPacks();
    this.log('radio', opts.odst
      ? 'an ODST hits the deck, MA5 hot (you)'
      : 'a lone survivor is moving through the ship (you)');
    return a;
  }

  // one boarder's med pack allotment, drawn from the seed-stable pools. Ids
  // are the SLOT index (100+ medbay, 200+ scatter), not the issue order, so
  // co-op clients agree on which kit is which no matter who attached first.
  _issueMedkits() {
    const P = this.P.medkits;
    const idx = this._medkitPlayers++;
    for (let i = 0; i < P.perPlayerMedbay; i++) {
      const slot = idx * P.perPlayerMedbay + i;
      const spot = this._medkitPoolMedbay[slot];
      if (spot) this.medkits.push({ id: 100 + slot, ...spot, used: false });
    }
    for (let i = 0; i < P.perPlayerScatter; i++) {
      const slot = idx * P.perPlayerScatter + i;
      const spot = this._medkitPoolScatter[slot];
      if (spot) this.medkits.push({ id: 200 + slot, ...spot, used: false });
    }
  }

  // one boarder's armor pack allotment — same slot-id scheme as med packs
  // (300+ armory, 400+ scatter) so co-op clients agree on pack identity
  _issueArmorPacks() {
    const P = this.P.armorpacks;
    const idx = this._armorPlayers++;
    for (let i = 0; i < P.perPlayerArmory; i++) {
      const slot = idx * P.perPlayerArmory + i;
      const spot = this._armorPoolArmory[slot];
      if (spot) this.armorPacks.push({ id: 300 + slot, ...spot, used: false });
    }
    for (let i = 0; i < P.perPlayerScatter; i++) {
      const slot = idx * P.perPlayerScatter + i;
      const spot = this._armorPoolScatter[slot];
      if (spot) this.armorPacks.push({ id: 400 + slot, ...spot, used: false });
    }
  }

  armorPackNear(a) {
    const R = this.P.armorpacks.useRadiusM;
    for (const k of this.armorPacks) {
      if (k.used || k.deck !== a.deck) continue;
      if (Math.hypot(k.x - a.x, k.y - a.y) <= R) return k;
    }
    return null;
  }

  // E at an armor pack — plates back to full on the spot (user: armor is
  // replenished separately by scattered armor packs, never by waiting)
  playerUseArmorPack(a) {
    if (!a || a.dead || a.hp <= 0 || (a.armor ?? 0) >= this.P.player.armor) return false;
    const k = this.armorPackNear(a);
    if (!k) return false;
    k.used = true;
    a.armor = this.P.player.armor;
    this.log('combat', 'you strap on fresh armor plates (you)', k.node, k.x, k.y);
    return true;
  }

  grenadeDropNear(a, preferredId = null) {
    if (!a || a.dead || a.hp <= 0) return null;
    const radius = this.P.grenade.pickupRadiusM;
    for (const drop of this.grenadeDrops) {
      if (drop.count <= 0 || drop.deck !== a.deck) continue;
      if (preferredId !== null && drop.id !== preferredId) continue;
      if (Math.hypot(drop.x - a.x, drop.y - a.y) <= radius) return drop;
    }
    return null;
  }

  claimGrenadeDrop(a, dropId, maxCount) {
    if (!Number.isSafeInteger(dropId) || !Number.isSafeInteger(maxCount) || maxCount <= 0) return 0;
    const drop = this.grenadeDropNear(a, dropId);
    if (!drop) return 0;
    const taken = Math.min(drop.count, maxCount, this.P.grenade.playerMax);
    drop.count -= taken;
    return taken;
  }

  claimAmmoDrop(a, corpseId, maxRounds) {
    if (!a || a.dead || a.hp <= 0 || !Number.isSafeInteger(corpseId)
      || !Number.isSafeInteger(maxRounds) || maxRounds <= 0) return 0;
    const corpse = this.byId.get(corpseId);
    if (!corpse || corpse.dead || corpse.faction !== FACTION.CORPSE || !corpse.wasArmed
      || corpse.damage >= 100 || corpse.deck !== a.deck
      || Math.hypot(corpse.x - a.x, corpse.y - a.y) > 2.2) return 0;
    const taken = Math.min(corpse.ammoRounds ?? 60, maxRounds);
    if (taken <= 0) return 0;
    corpse.ammoRounds = Math.max(0, (corpse.ammoRounds ?? 60) - taken);
    if (corpse.ammoRounds === 0) corpse.wasArmed = false;
    return taken;
  }

  // the unused kit within arm's reach of this agent, or null
  medkitNear(a) {
    const R = this.P.medkits.useRadiusM;
    for (const k of this.medkits) {
      if (k.used || k.deck !== a.deck) continue;
      if (Math.hypot(k.x - a.x, k.y - a.y) <= R) return k;
    }
    return null;
  }

  // E at a med pack (user: "you cant pick them up and carry, just a button to
  // use on the spot, restores to full health regardless of how low"). Runs on
  // the sim authority; peers reach it through gameSync's medkit event.
  playerUseMedkit(a) {
    if (!a || a.dead || a.hp <= 0 || a.hp >= a.maxHp) return false;
    const k = this.medkitNear(a);
    if (!k) return false;
    k.used = true;
    a.hp = a.maxHp;
    this.log('combat', 'you tear open a med kit — vitals back to green (you)', k.node, k.x, k.y);
    return true;
  }

  // the ODST's squad (game rule): marines who form on the player and follow
  // via the standing escort order — they fight anything on contact, and the
  // usual morale rules apply
  attachPlayerSquad(playerAgent, size = 3) {
    const squad = {
      id: this.squads.length, members: [], objective: null, morale: 1,
      respondingTo: null, phase1: false,
      order: { kind: 'order:escort', entityId: playerAgent.id },
    };
    for (let i = 0; i < size; i++) {
      const m = makeAgent(FACTION.MARINE, playerAgent.node, this.graph);
      m.hp = m.maxHp = this.P.combat.marine.hp;
      m.hasRadio = true;
      m.squad = squad.id;
      m.escort = true; // moves at your pace + close-follows (humans.js)
      // AMMO ECONOMY (user): your fireteam runs on real magazines — they
      // drain in combat.js, call it out as they thin, and go black unless
      // you hand over a mag (G). Only the escort fireteam is tracked.
      m.mags = 4;
      m.rounds = 32;
      squad.members.push(m.id);
      this.spawn(m);
    }
    squad.size0 = size;
    this.squads.push(squad);
    // the fireteam detailed to you is corporal-led
    const lead = this.byId.get(squad.members[0]);
    if (lead?.callsign) lead.callsign.rank = 'Cpl';
    this.log('radio', `your fireteam forms up — ${size} marines on you`);
    return squad;
  }

  // the player hands a magazine to the neediest fireteam escort in reach
  // (G key). Returns the receiving marine, or null if nobody can take one.
  giveMag(playerAgent, maxDistM = 3.5) {
    let best = null, bd = Infinity;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || !a.escort || a.mags === undefined) continue;
      if (a.deck !== playerAgent.deck) continue;
      if (Math.hypot(a.x - playerAgent.x, a.y - playerAgent.y) > maxDistM) continue;
      const total = a.mags * 32 + a.rounds;
      if (total >= 4 * 32) continue; // full — won't take it
      if (total < bd) { bd = total; best = a; }
    }
    if (!best) return null;
    best.mags++;
    best.dryCalled = false;
    if (best.mags > 1) best.lowCalled = false;
    this.log('radio', `fireteam: ${best.callsign ? best.callsign.rank + ' ' + best.callsign.name : 'a marine'} takes your mag — back in the fight`, best.node);
    return best;
  }

  // THE PLAYER'S FLAMETHROWER (user: "make the flamethrower something the
  // player can use"). Two ways to end up holding one, both of them earned:
  // off the body of the operator who was carrying it, or off the armory rack
  // once the seal has released. Nothing is added to the ship to make this
  // work — `armoryFlamer` is the spare that params already says is racked in
  // there, and the corpse route is the line's own flamer coming back into
  // play after he goes down.
  //
  // Note what is NOT set here: the player's agent never gets `.flamer`. The
  // sim would then run it as an NPC flamer in resolveCombat — burning a room
  // by itself, for free, on top of what you aim. Yours is game-side only.
  playerTakeFlamer(a, corpse = null) {
    const cap = this.P.flamethrower.player.tankUnits;
    let fuel;
    if (corpse) {
      fuel = Math.min(cap, corpse.flamerFuel ?? 0);
      corpse.hadFlamer = false; corpse.flamerFuel = 0;
      this.log('combat', 'you pull the flamethrower off the operator and check the tanks (you)', corpse.node, corpse.x, corpse.y);
    } else {
      fuel = cap;
      this.armoryFlamer = false;
      this.log('combat', 'you lift the flamethrower off the armory rack — full tanks (you)', a.node, a.x, a.y);
    }
    return fuel;
  }

  // a spare tank off the rack: tops you up, never past the tank's capacity
  playerRefuel(have) {
    const P = this.P.flamethrower.player;
    if (!this.armoryFuelCans) return have;
    this.armoryFuelCans--;
    return Math.min(P.tankUnits, have + P.armoryRefill);
  }

  // One bounded, physical fuel pool. The graph bit remains the cheap strategic
  // pathing signal; the site is the authoritative contact patch for damage and
  // rendering. A source can leave one patch per room, so sweeping a stream
  // through a doorway does not teleport the old room's fire into the new one.
  igniteFlame(node, x, y, source = 'flame', scale = 1.2) {
    if (node < 0) return;
    const g = this.graph;
    const wasBurning = g.burningUntil[node] > this.t;
    const expiresAt = this.t + this.P.flamethrower.burnNodeSec;
    g.burningUntil[node] = Math.max(g.burningUntil[node], expiresAt);
    g.burnX[node] = x; g.burnY[node] = y;
    g.noteBurn(node);
    if (!wasBurning) g.invalidatePathCache();
    const key = `${source}:${node}`;
    let site = this.fires.find((f) => f.key === key);
    if (!site) {
      site = { key, deck: g.node(node).deck, node, x, y, scale, expiresAt };
      this.fires.push(site);
    } else {
      site.x = x; site.y = y; site.scale = scale; site.expiresAt = expiresAt;
    }
    return site;
  }

  // The player is kept separate from the NPC equipment flag so the sim does
  // not double-fire on top of the aimed game-side stream.
  playerFlame(node, x, y, sourceId = 0) {
    return this.igniteFlame(node, x, y, `player:${sourceId}`);
  }

  // the player takes up a rifle — from the armory rack or from a corpse
  // that died holding one (game rule: the survivor can fight back)
  playerArm(a, corpse = null) {
    if (corpse) corpse.wasArmed = false; // a form raised from it won't get the gun
    else this.armoryStock = Math.max(0, this.armoryStock - 1);
    a.faction = FACTION.ARMED;
    a.hp = a.maxHp = Math.max(a.hp, this.P.combat.armed.hp);
    this.log('combat', corpse
      ? 'the survivor takes a rifle from the dead (you)'
      : `the survivor arms up at the armory (you — ${this.armoryStock} rifles left)`);
  }

  emitCall(agent, { node = agent.node, deckSighting = false } = {}) {
    if (deckSighting) {
      // A sighting is a shared net incident, not six independent radio calls.
      // Coalesce simultaneous reports by the contact's actual compartment so
      // the log stays readable and every sentry responds to the same target.
      for (let i = this.calls.length - 1; i >= 0; i--) {
        const prior = this.calls[i];
        if (this.t - prior.t > this.P.radio.deckSightingDedupeSec) break;
        if (prior.deckSighting && prior.node === node) return prior;
      }
    }
    const call = {
      id: this.callSeq++, node, t: this.t, faction: agent.faction,
      byId: agent.id, rolled: new Set(), deckSighting,
    };
    this.calls.push(call);
    this.stats.distressCalls++;
    this.floodKnown = true;
    this.log('radio', `distress call from ${this.graph.node(node).name}`, node);
    return call;
  }

  // `x`/`y` are the EXACT sim-space spot the event happened at, when the
  // caller knows it. Renderers stamp physical marks (blood) there instead of
  // at the room's geometric centre — a body converted in a corner used to
  // bleed in the middle of the hangar (user report).
  log(type, msg, node = -1, x, y) {
    this.events.push({ t: this.t, type, msg, node, x, y });
    this.eventTotal = (this.eventTotal ?? 0) + 1; // monotonic — never rewinds
    if (this.events.length > 1600) {
      this.events.splice(0, 200);
      // consumers track ABSOLUTE event indices; the splice shifts the array,
      // so publish the offset (user report: the ship-activity log wedged at
      // minute ~12 — the cap hit and the renderer's index overshot the array,
      // silencing it until 200 skipped events re-accumulated)
      this.eventBase = (this.eventBase ?? 0) + 200;
    }
  }

  spawn(a) {
    this._assignCallsign(a);
    this.agents.push(a);
    this.byId.set(a.id, a);
  }

  // Downed combat forms get back up (§7) — but the marines don't KNOW that
  // until they see it happen (user: they learn the hard way). The first
  // revive witnessed by a living marine flips ship-wide doctrine: from then
  // on, squads put confirming rounds into the downed (combat.js).
  reviveWitnessed(node) {
    if (this.marinesKnowRevive) return;
    const seen = this.agents.some((m) => !m.dead && m.hp > 0 && m.faction === FACTION.MARINE
      && (m.node === node || (this.graph.adj.std[node] ?? []).some((e) => e.to === m.node)));
    if (!seen) return;
    this.marinesKnowRevive = true;
    this.log('radio', 'the one we dropped just got back up — CONFIRM YOUR KILLS. make sure of the downed', node);
  }

  _assignCallsign(a) {
    if (a.callsign || a.isPlayer || a.faction === FACTION.INFECTION) return;
    const kind = a.odst ? 'odst'
      : a.faction === FACTION.MARINE ? 'marine'
        : a.faction === FACTION.ARMED ? 'armed' : 'crew';
    a.callsign = {
      rank: rankFromPool(this.seed, a.id, RANK_POOLS[kind]),
      name: nameFor(this.seed, a.id),
    };
  }

  // Leadership billets, proportioned for a ~200-soul frigate (user): the
  // pyramid pick above fills the ranks; this pass seats the structure —
  // exactly one Sgt leading each marine squad (the first line squad carries
  // the platoon's 2ndLt), Cpl-led patrol pairs, a corporal of the guard on
  // the garrison, GySgt/SSgt over the ODST reserve, and the ship's officers
  // (a CDR — small ship, no captain — with an LT and an ENS) on the bridge.
  _assignRanks() {
    let lineSquads = 0;
    for (const squad of this.squads) {
      const members = squad.members.map((id) => this.byId.get(id)).filter((m) => m?.callsign);
      if (!members.length) continue;
      if (members[0].odst) {
        members[0].callsign.rank = 'GySgt';
        if (members[1]) members[1].callsign.rank = 'SSgt';
        continue;
      }
      if (squad.patrol) { members[0].callsign.rank = 'Cpl'; continue; }
      if (squad.deckGuard) continue;
      lineSquads++;
      if (lineSquads === 1) {
        members[0].callsign.rank = '2ndLt';
        if (members[1]) members[1].callsign.rank = 'Sgt';
        if (members[2]) members[2].callsign.rank = 'Cpl';
      } else {
        members[0].callsign.rank = 'Sgt';
        if (members[1]) members[1].callsign.rank = 'Cpl';
      }
    }
    const guard = this.agents.find((a) => a.garrison && a.callsign);
    if (guard) guard.callsign.rank = 'Cpl';
    const bIdx = this.graph.byId.get('bridge'); // byId maps to the node INDEX
    const bDeck = bIdx !== undefined ? this.graph.node(bIdx).deck : 1;
    const civs = this.agents.filter((a) => a.faction === FACTION.CIVILIAN && a.callsign && !a.dead);
    // seat the officers as close to the bridge as the spawn allows: on the
    // bridge itself, else a command-role room, else elsewhere on the command
    // deck — and never in the brig
    const seated = civs.map((a) => {
      const n = this.graph.node(a.node);
      const k = a.node === bIdx ? 0
        : (n.roles ?? []).includes('command') ? 1
          : n.deck === bDeck && !/brig/i.test(n.id ?? '') ? 2 : 3;
      return { a, k };
    }).sort((x, y) => x.k - y.k || x.a.id - y.a.id);
    const officers = ['CDR', 'LT', 'ENS'];
    for (let i = 0; i < officers.length && i < seated.length; i++) {
      seated[i].a.callsign.rank = officers[i];
    }
    // COMMAND LAYER (user): the CO is a real actor on the net — track him
    if (seated.length) this.cdrId = seated[0].a.id;
  }

  // CDR COMMAND LAYER (user: periodic directives over the net + CO-death
  // consequences). Runs on the strategic cadence. While the CO lives, every
  // couple of minutes he re-tasks the idlest line squad onto the freshest
  // squad-reported contact (radio-known intel only — the same blackboard
  // the squads themselves share). When he dies, the command net goes quiet
  // and the last-stand call carries HALF its normal reach (degraded
  // coordination — see _checkLastStand).
  _commandTick() {
    if (this.cdrId === undefined) return;
    if (!this.cdrDead) {
      const c = this.byId.get(this.cdrId);
      if (!c || c.dead || c.hp <= 0 || c.faction > 2) {
        this.cdrDead = true;
        this.log('radio', 'command net silent — the CO is down', c && !c.dead ? c.node : -1);
        return;
      }
    }
    if (this.cdrDead || this.lastStand) return;
    // ~every 2 min on the strategic cadence (elapsed-time check — a modulo
    // window would have to align with strategicEvery and silently never fire)
    if (this.t - (this._lastDirectiveT ?? -60) < 120) return;
    let freshest = null;
    for (const s of this.squads) {
      if (s.contactNode === undefined) continue;
      if (!freshest || s.contactTick > freshest.contactTick) freshest = s;
    }
    if (!freshest || this.tickCount - freshest.contactTick > 60 * 10) return;
    const node = freshest.contactNode;
    for (const s of this.squads) {
      if (s.broken || s.patrol || s.deckGuard || s === freshest || s.order) continue;
      const k = s.objective?.kind;
      if (k !== 'hold' && k !== 'sweep' && s.objective) continue;
      const lead = s.members.map((id) => this.byId.get(id)).find((m) => m && !m.dead && m.hp > 0);
      if (!lead) continue;
      s.objective = { kind: 'order', node };
      this._lastDirectiveT = this.t;
      this.log('radio', `CDR orders squad ${s.id + 1} to ${this.graph.node(node).name} — reported contact`, this.byId.get(this.cdrId).node);
      break;
    }
  }
  removeAgent(a) {
    a.dead = true;
    if (a.inShaftAmbush !== undefined) {
      this.graph.shafts[a.inShaftAmbush]?.ambushers?.delete(a.id);
    }
  }

  hurtHuman(a, dmg, by = -1, impact = null) {
    if (a.hp <= 0 || a.dead) return;
    if (by >= 0 && dmg > 0) { a.lastHurtBy = by; a.lastHurtTick = this.tickCount; }
    // ARMOR FIRST, and on the authority's side of the wire (co-op death
    // desync): ballistic plate soaks the hit before meat does. Applied here
    // so BOTH players get it — a peer used to run this in its own client and
    // heal itself past a death the host had already decided.
    if (a.isPlayer && dmg > 0 && a.armor > 0) {
      const absorbed = Math.min(a.armor, dmg);
      a.armor -= absorbed;
      dmg -= absorbed;
      a.armorHitAt = this.t;
      if (dmg <= 0) return;
    } else if (a.isPlayer && dmg > 0) a.armorHitAt = this.t;
    a.hp -= dmg;
    // A HIT YOU SURVIVE STILL MOVES YOU (user: the flood's melee "should shove
    // you backwards some"). The impulse was computed on every swing and then
    // used ONLY on the death branch below, so anything you walked away from
    // was pure damage with no physicality at all. Recorded here as a velocity
    // the mover spends: the player's controller reads it as knockback, an NPC
    // gets pushed and re-clamped inside its room.
    if (impact && a.hp > 0) {
      const P = this.P.combat.combatForm.swing;
      const mps = a.isPlayer ? P.shovePlayerMps : P.shoveMps;
      a.shoveX = impact.dirX * mps;
      a.shoveY = impact.dirY * mps;
      a.shoveAt = this.t;
    }
    if (a.hp <= 0) {
      if (impact) a.deathImpulse = impact;
      this.stats.humansDead++;
      if (a.faction === FACTION.MARINE) {
        const squad = this.squads[a.squad];
        this.log('combat', `a marine falls in ${this.graph.node(a.node).name}`, a.node, a.x, a.y);
        if (squad) squad.calledContact = false; // survivors will call again
        // THE HIVE COUNTS ITS KILLS (user redesign): a marine who dies to a
        // flood form's claws/latch/rupture ticks the internal marine counter
        // down. A death the hive didn't cause (friendly fire, fire, the
        // player's own rifle out of the flood's sight) isn't its knowledge —
        // unless a form senses the room and watches it happen.
        const killer = by >= 0 ? this.byId.get(by) : null;
        const floodKill = killer && (killer.faction === FACTION.INFECTION
          || killer.faction === FACTION.COMBAT || killer.faction === FACTION.CARRIER);
        const witnessed = !floodKill && this.agents.some((f) => !f.dead && f.hp > 0
          && (f.faction === FACTION.INFECTION || f.faction === FACTION.COMBAT)
          && this.hasLineOfSight(f, a));
        if (floodKill || witnessed) this.hive?.noteMarineKill(a);
      }
      this.screamTick[a.node] = this.tickCount;
      humanDeathToCorpse(this, a);
    }
  }

  // --- pathing helpers used by all AI ---
  setPath(a, steps) {
    // steps: array of node indices or {to, link, layer} records
    const norm = [];
    let cur = a.node;
    for (const s of steps) {
      if (typeof s === 'number') {
        let found = null;
        for (const { to, link } of this.graph.neighbors(cur, ['std'], () => true)) {
          if (to === s) { found = { to, link, layer: 'std' }; break; }
        }
        if (!found) return false;
        norm.push(found); cur = s;
      } else { norm.push(s); cur = s.to; }
    }
    a.path = norm;
    return true;
  }
  pathFor(a, target, layers, passFn) {
    // SPORE-FOG DOCTRINE (user rule: fog tips the balance toward the flood):
    // a LINE marine will not walk into a spore-fogged room — the rank and
    // file have seen what comes out of that murk. ODSTs and the player's own
    // fireteam (escort) still go wherever the mission goes. A line marine
    // already caught inside a connected bank of fog may cross it to reach a
    // clear destination; otherwise the old per-edge gate could trap him in
    // the growth while every clear patrol objective looked unreachable.
    let pf = passFn;
    if (a.faction === FACTION.MARINE && !a.odst && !a.escort) {
      const escapingFog = this.fogAt(a.node) && !this.fogAt(target);
      // graph.path expands backward from the destination, so `from` here is
      // the room a forward-moving marine would ENTER. The previous `to`
      // check inverted the rule: fogged objectives looked safe while a
      // marine already inside fog could not leave.
      pf = (l, from, to) => (!passFn || passFn(l, from, to))
        && (escapingFog || !this.fogAt(from));
    }
    return this.graph.path(a.node, target, layers, pf);
  }

  setPathTo(a, target, layers, passFn) {
    const path = this.pathFor(a, target, layers, passFn);
    if (!path) return false;
    a.path = path;
    return true;
  }

  _interruptMove(a) {
    if (a.move?.link?.occupiedBy === a.id) a.move.link.occupiedBy = undefined;
    const node = a.pnode ?? a.node;
    const room = this.graph.node(node);
    a.move = null;
    a.path = [];
    a.node = node;
    a.deck = room.deck;
  }

  _setCharging(a, charging) {
    if (a.charging === charging) return;
    if (charging && a.faction === FACTION.COMBAT) {
      // A doorway is only a seam in one continuous rush. Reuse the selected
      // posture across its sub-second path legs instead of visibly changing
      // animation variants every time the form crosses a room boundary.
      if (this.t - a.chargeEndedAt > 0.75) {
        a.chargePoseSequence++;
        a.chargeArmsHigh = combatChargeArmsHigh(a.id, a.chargePoseSequence);
      }
    } else if (!charging && a.faction === FACTION.COMBAT) {
      a.chargeEndedAt = this.t;
    }
    a.charging = charging;
  }

  _setRetreatSprint(a, sprint) {
    if (a.faction !== FACTION.COMBAT) return;
    const value = !!sprint;
    a.retreatSprint = value;
    // why: movement legs cache their travel time, so update the active leg
    // directly when fire catches a retreating form instead of rebuilding its
    // route and reintroducing the doorway oscillation this state prevents.
    if (a.move) a.move.retreatSprint = value;
  }

  // One authoritative sliding-door clock serves AI sight, rifle damage, and
  // the renderer. The old renderer-only clock let marines acquire targets
  // through an unlocked panel while the player was visibly watching it shut.
  _advanceDoors(dt) {
    const D = this.P.door;
    const radius2 = D.openRadiusM * D.openRadiusM;
    const byDeck = (this._doorAgentsByDeck ??= [[], [], [], [], [], []]);
    for (const deck of byDeck) deck.length = 0;
    for (const agent of this.agents) {
      if (agent.dead || agent.hp <= 0 || agent.faction === FACTION.CORPSE) continue;
      (byDeck[agent.deck] ??= []).push(agent);
    }
    const rate = D.slideSpeedMps / (CLEAR_H - 0.3);
    let changed = false;
    for (const edge of this.graph.edges) {
      if (!edge.door) continue;
      let want = edge.busted ? 0.62 : edge.locked ? D.ajarFraction : 0;
      if (!edge.busted && !edge.locked) {
        const deck = this.graph.node(edge.a).deck;
        for (const agent of byDeck[deck] ?? []) {
          const dx = agent.x - edge.door.x, dy = agent.y - edge.door.y;
          if (dx * dx + dy * dy < radius2) { want = 1; break; }
        }
      }
      const was = edge.open01 ?? 0;
      edge.open01 = was + Math.sign(want - was) * Math.min(Math.abs(want - was), rate * dt);
      if (edge.open01 !== was) changed = true;
    }
    if (changed) this._losAgentCache.clear();
  }

  // ======================= main tick =======================
  tick() {
    const dt = this.dt;
    this.buffer.beginTick();
    this.tickCount++;
    this.t = this.tickCount * dt;
    // the hops cache is only valid while passability inputs hold still.
    // sim.t just moved and burning-node predicates read it — but the ONLY
    // way time alone flips passability is a burn timer expiring, so sweep
    // the burning set instead of wiping the cache wholesale (perf pass 3:
    // the old unconditional wipe forced every strategic round to rebuild
    // up to ~64 flow fields from scratch). Lock/vent/belief mutators all
    // invalidate at their own write sites.
    this.graph.sweepBurns(this.t);
    // Dynamic fuel pools expire independently of the permanent breach and
    // damaged-door fires. Removing them here keeps both damage and snapshots
    // bounded even after a long flamethrower-heavy game.
    for (let i = this.fires.length - 1; i >= 0; i--) {
      if (this.fires[i].expiresAt !== undefined && this.fires[i].expiresAt <= this.t) {
        this.fires.splice(i, 1);
      }
    }

    this._refreshOccupancy();
    this._refreshMarineMotion();

    // apply commander commands scheduled for this tick, BEFORE any AI runs
    // (companion spec §0). Deterministic order; single producer in the POC.
    for (const entry of this.commands.collect(this.tickCount)) {
      applyCommand(this, entry);
    }

    // Check every simulation tick so a fresh 1:1 Flood advantage releases
    // the reserve within 67 ms. Keep this before the strategic fall-back call
    // so an ODST deployment can still precede the last-stand announcement.
    this._armoryWatch();

    // strategic tick ("infection round", §2.3) — the HIVE's round and the
    // MARINES' round are STAGGERED half an interval apart (perf pass 5): both
    // measured multi-ms late-game, and sharing one 15 Hz tick made that tick
    // a periodic frame-killer (p90 12.9 ms headless — 3-4x that on the 2017
    // playtest machine). Each still runs every strategicEvery ticks; they
    // just never run together. Influence is recomputed on both boundaries
    // (both consumers read it fresh, same as before).
    const halfRound = this.tickCount % this.strategicEvery;
    if (halfRound === 0) {
      this._computeInfluence();
      this.hive.strategicTick();
      // Strategic planning can replace a tactical task after evade observed
      // contact. Let the movement pass broadcast the live response again;
      // pack geometry and LOS remain valid, only the issued order changed.
      this.hive._combatResponseCache?.clear();
      this._commandTick();
      this._checkSelfArming();
      this._checkLastStand();
      this._lastStandStragglers();
      this.stats.conversionsRound = 0;
      this._expireCalls();
    } else if (halfRound === (this.strategicEvery >> 1)) {
      // the marines' half of the round, 19 ticks after the hive's
      this._computeInfluence();
      strategicSquads(this);
    }

    this._doorFlipTick(); // per-tick: each faulty door keeps its own clock
    this._captureHumanWalkStart();
    updateHumansTick(this, dt);
    updateFloodTick(this, dt);
    this._grenadeTick();
    // armor does NOT regenerate (user: shields replaced by armor) — plates
    // come back only from armor packs (playerUseArmorPack)
    this._advanceMovement(dt);
    this._separate(dt);
    this._fireAvoid(dt);
    this._faceWalkingHumans();
    this._fireDamage(dt);
    this._advanceDoors(dt);
    this._refreshOccupancy();
    this._advanceDarkness(dt);
    resolveCombat(this, dt);
    this._respawnPlayers();

    // scream noise from panic + grabs
    for (const a of this.agents) {
      if (a.dead) continue;
      if (a.panicked && a.hp > 0) this.screamTick[a.node] = this.tickCount;
      if (a.state === STATE.GRABBING) this.screamTick[a.node] = this.tickCount;
    }

    this._reap();
    this._checkOutcome();
    this.writeBuffer();
  }

  // Co-op recovery is owned by the authority and therefore arrives through
  // the normal snapshot. A surviving player is the spawn beacon, but only
  // when both their room and every graph-adjacent room contain no active
  // Flood. This is topology-driven: future room layouts need no special cases.
  _respawnPlayers() {
    const players = this.agents.filter((a) => a.isPlayer);
    if (players.length < 2) return;
    for (const fallen of players) {
      if (!fallen.dead || fallen.respawnReadyAt < 0 || this.t < fallen.respawnReadyAt) continue;
      const anchor = players.find((a) => a.id !== fallen.id && !a.dead && a.hp > 0
        && this.playerRespawnRoomSafe(a));
      if (!anchor) continue;
      const room = this.graph.node(anchor.pnode ?? anchor.node);
      const angle = (fallen.id * 2.399963) % (Math.PI * 2);
      const radius = 0.9;
      fallen.node = fallen.pnode = room.idx;
      fallen.deck = room.deck;
      fallen.x = Math.max(room.x - room.w / 2 + 0.55,
        Math.min(room.x + room.w / 2 - 0.55, anchor.x + Math.cos(angle) * radius));
      fallen.y = Math.max(room.y - room.d / 2 + 0.55,
        Math.min(room.y + room.d / 2 - 0.55, anchor.y + Math.sin(angle) * radius));
      fallen.hp = fallen.maxHp;
      fallen.armor = this.P.player.armor;
      fallen.dead = false;
      fallen.state = STATE.IDLE;
      fallen.move = null; fallen.path = []; fallen.task = null;
      fallen.held = 0; fallen.shoveX = 0; fallen.shoveY = 0;
      fallen.afterlifeId = -1; fallen.respawnReadyAt = -1;
      this.log('radio', `an ODST is back on their feet in ${room.name}`, room.idx, fallen.x, fallen.y);
    }
  }

  playerRespawnRoomSafe(anchor) {
    if (!anchor || anchor.dead || anchor.hp <= 0) return false;
    const here = anchor.pnode ?? anchor.node;
    const near = new Set([here]);
    for (const { to } of this.graph.neighbors(here, ['std'], () => true)) near.add(to);
    return !this.agents.some((a) => !a.dead && !a.move?.hidden && near.has(a.pnode ?? a.node)
      && (a.faction === FACTION.INFECTION || a.faction === FACTION.CARRIER
        || (a.faction === FACTION.COMBAT && (!a.downed ? a.hp > 0 : a.damage < 100))));
  }

  // LAST STAND (user note): once most of the squad marines are dead, the word
  // goes out — fall back behind the garrison line on the top deck. Officers
  // step out into the corridor to thicken the line. Radios are damaged and
  // people are scattered, so each survivor only HEARS the call on a roll.
  _checkLastStand() {
    if (this.lastStand || this.initialSquadMarines === 0) return;
    const alive = this.agents.reduce((n, a) => n +
      (!a.dead && a.hp > 0 && a.faction === FACTION.MARINE && !a.garrison ? 1 : 0), 0);
    if (alive > Math.ceil(this.initialSquadMarines * this.P.lastStand.marineFraction)) return;
    this.lastStand = true;
    this.lastStandAt = this.t;
    const g = this.graph;
    const line = g.byId.get('d1corr');
    const shelters = [g.byId.get('officer'), g.byId.get('cic'), g.byId.get('signal'), g.byId.get('bridge')];
    this.log('radio', `FALL BACK — all remaining hands to the command deck (${alive} marines left)`);
    // CO-DEATH CONSEQUENCE (user: command layer): with the CDR gone there
    // is no one running the net — the fall-back call carries half as far
    const hear = this.P.lastStand.hearChance * (this.cdrDead ? 0.55 : 1);
    // marine squads hear on the leader's radio roll and bind to the line;
    // broken/squadless marines roll alone
    for (const squad of this.squads) {
      const members = squad.members.map((id) => this.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (!members.length) continue;
      if (!squad.broken && this.rng.chance(hear)) squad.lastStandBound = true;
      else if (squad.broken) {
        for (const m of members) if (this.rng.chance(hear)) m.fallbackNode = line;
      }
    }
    let heard = 0, missed = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.helpless || a.garrison) continue;
      if (a.faction !== FACTION.CIVILIAN && a.faction !== FACTION.ARMED) continue;
      if (!this.rng.chance(hear)) { missed++; continue; }
      heard++;
      if (a.stayPut) {
        // officers already on the top deck: some step out into the corridor
        // and join the marines' line (they keep holding once there)
        if (this.rng.chance(this.P.lastStand.officerJoinChance)) a.fallbackNode = line;
      } else if (a.faction === FACTION.ARMED) {
        // 80% of the armed crew STAND WITH THE MARINES on the line (user
        // note); the rest shepherd the civilians in the shelter rooms.
        // Line-holders lock in: they fight in place and never rout.
        if (this.rng.chance(this.P.lastStand.armedJoinFraction)) { a.fallbackNode = line; a.stayPut = true; }
        else a.fallbackNode = shelters[a.id % shelters.length];
      } else {
        a.fallbackNode = shelters[a.id % shelters.length];
      }
    }
    this.log('radio', `${heard} souls heard the call; ${missed} are still out there`);
  }

  // A minute after the call, whoever missed it works it out on their own —
  // the ship has gone quiet and everyone left alive heads for the line
  // (user note).
  _lastStandStragglers() {
    if (!this.lastStand || this._stragglersDone) return;
    if (this.t < this.lastStandAt + 60) return;
    this._stragglersDone = true;
    const g = this.graph;
    const line = g.byId.get('d1corr');
    const shelters = [g.byId.get('officer'), g.byId.get('cic'), g.byId.get('signal'), g.byId.get('bridge')];
    let n = 0;
    for (const squad of this.squads) {
      if (!squad.broken && !squad.lastStandBound
        && squad.members.some((id) => { const m = this.byId.get(id); return m && !m.dead && m.hp > 0; })) {
        squad.lastStandBound = true; n++;
      }
    }
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.helpless || a.garrison || a.fallbackNode !== undefined) continue;
      if (a.faction === FACTION.MARINE) {
        if (this.squads[a.squad]?.broken) { a.fallbackNode = line; n++; }
      } else if (a.faction === FACTION.ARMED && !a.stayPut) {
        a.fallbackNode = this.rng.chance(this.P.lastStand.armedJoinFraction) ? line : shelters[a.id % shelters.length];
        if (a.fallbackNode === line) a.stayPut = true;
        n++;
      } else if (a.faction === FACTION.CIVILIAN && !a.stayPut) {
        a.fallbackNode = shelters[a.id % shelters.length]; n++;
      }
    }
    if (n) this.log('radio', `the stragglers get the word — ${n} more fall back on their own`);
  }

  // Once panic breaks out shipwide (before any last stand), some unarmed
  // civilians make a run for the armory and arm themselves — first come,
  // first served on the remaining rifles (user note).
  // The seeded timer is the latest release. If active Flood reaches one form
  // per living ship marine first, release immediately. The same gate opens
  // the ODST reserve and its racks, grenades and flamethrower.
  _armoryWatch() {
    if (!this.armoryLocked) return;
    if (this.t < this.armoryReleaseAt) {
      const { floodAlive, marinesAlive } = shipForceCounts(this.agents);
      if (floodAlive === 0 || floodAlive < marinesAlive) return;
    }
    this.armoryLocked = false;
    const armoryIdx = this.graph.byId.get('armory');
    for (const e of this.graph.edges) {
      if ((e.a === armoryIdx || e.b === armoryIdx) && e.locked) e.locked = false;
    }
    this.graph.invalidatePathCache();
    // the reserve steps out ready to fight — its squad joins the strategic
    // pool (the humans.js locked-gate stops applying the moment this flips)
    this.log('radio', 'ARMORY SEAL RELEASED — ODST reserve deploying. Racks are open.');
    // THE RESERVE FALLS IN ON YOU (user: "those marines should actually join
    // your fire team"). They are hardened plate with a flamethrower between
    // them, and with the line breaking there is nothing left to reinforce but
    // the player. Re-badge them onto the escort squad so humans.js runs them
    // through the same coverage-post follow as the rest of your fireteam, and
    // give them the magazine economy the escort tracks. Only in a game with a
    // player attached — the headless replay has no escort squad to join.
    const escort = this.squads.find((sq) => sq?.order?.kind === 'order:escort');
    if (!escort) return;
    let joined = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || !a.odst) continue;
      const old = this.squads[a.squad];
      if (old?.members) old.members = old.members.filter((id) => id !== a.id);
      a.squad = escort.id;
      a.escort = true;
      a.mags = 4;
      a.rounds = 32;
      a.path = []; a.move = null; a.task = null;
      escort.members.push(a.id);
      joined++;
    }
    if (joined) {
      this.log('radio', `the ODST reserve falls in on you — ${joined} rifles, and a flamethrower`);
    }
  }

  _checkSelfArming() {
    if (this._armingRolled || !this.floodKnown) return;
    if (this.armoryLocked) return; // the crew knows the armory is sealed — no run on a locked door
    this._armingRolled = true;
    const armory = this.graph.byId.get('armory');
    let n = 0;
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.faction !== FACTION.CIVILIAN) continue;
      if (a.helpless || a.stayPut) continue;
      if (!this.rng.chance(this.P.armory.selfArmChance)) continue;
      a.armingUp = armory;
      n++;
    }
    if (n) this.log('radio', `word of the outbreak spreads — ${n} civilians make for the armory`);
  }

  _expireCalls() {
    this.calls = this.calls.filter((c) => this.t - c.t < this.P.radio.callFadeSec * 2);
  }

  // MALFUNCTIONING DOORS ARE ALIVE (user: broken doors should not be static
  // — some get stuck, others open, all game long). Every faulty door runs
  // its OWN deterministic timeline: dwell 1-10 min per state while a way
  // around exists; a door whose closing would CUT the ship (checked at the
  // moment it tries to close, against the ship as it stands right then)
  // reopens in 30-90s and skips half its close opportunities, so a sole
  // route is an inconvenience, never a prison. Deterministic: seeded RNG
  // draws happen at flip time inside the tick, identically on every peer.
  // Excluded: the armory seal (event gate), the authored fire-site doors
  // (they ARE the damage), crew-commanded doors (the override outranks the
  // fault), and busted doors (there is no door left to malfunction).
  _doorMalfCandidate(e) {
    return e.door && e.lockable && !e.armorySeal && !e.fireSite && !e.busted && !e.commanded
      && this.graph.node(e.a).deck === this.graph.node(e.b).deck;
  }

  _seedDoorFaults() {
    const D = this.P.door;
    this._malfDoors = [];
    for (const e of this.graph.edges) {
      if (!this._doorMalfCandidate(e)) continue;
      if (e.locked) {
        // the seed's jammed doors ARE the malfunction population — init
        // guaranteed connectivity around them, so the full closed range
        e.malfunction = true;
        e.flipAt = this.rng.range(D.dwellMinSec, D.dwellMaxSec);
      } else if (this.rng.chance(D.latentFraction)) {
        // ...plus healthy-looking doors that will seize for the first time
        // mid-session (user: "some will get stuck")
        e.malfunction = true;
        e.flipAt = this.rng.range(D.dwellMinSec, D.dwellMaxSec);
      }
      if (e.malfunction) this._malfDoors.push(e);
    }
  }

  _doorFlipTick() {
    const D = this.P.door;
    for (const e of this._malfDoors) {
      if (e.busted || e.commanded || this.t < e.flipAt) continue;
      if (e.locked) {
        e.locked = false;
        e.flipAt = this.t + this.rng.range(D.dwellMinSec, D.dwellMaxSec);
        this._doorMutated();
        this.log('radio', `the jammed door between ${this.graph.node(e.a).name} and ${this.graph.node(e.b).name} grinds free`, e.a);
      } else {
        // about to seize — is there a way around RIGHT NOW?
        e.locked = true;
        const choke = !this._reachableStd(e.a, e.b);
        if (choke && this.rng.chance(D.chokeSkipClose)) {
          e.locked = false; // sole route: skip this close opportunity
          e.flipAt = this.t + this.rng.range(D.dwellMinSec, D.dwellMaxSec);
          continue;
        }
        e.flipAt = this.t + (choke
          ? this.rng.range(D.chokeClosedMinSec, D.chokeClosedMaxSec)
          : this.rng.range(D.dwellMinSec, D.dwellMaxSec));
        this._doorMutated();
        this.log('radio', `a door mechanism seizes between ${this.graph.node(e.a).name} and ${this.graph.node(e.b).name}`, e.a);
      }
    }
  }

  // every lock mutation invalidates the same two things the SET_DOOR command
  // always has: route memos and the lock-dependent sensing caches
  _doorMutated() {
    this.graph.invalidatePathCache();
    this._precomputeSensing();
  }

  // is `to` reachable from `from` over unlocked std edges?
  _reachableStd(from, to) {
    if (from === to) return true;
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const n = q.pop();
      for (const { to: nx, link } of this.graph.adj.std[n] ?? []) {
        if (link.locked || seen.has(nx)) continue;
        if (nx === to) return true;
        seen.add(nx);
        q.push(nx);
      }
    }
    return false;
  }

  // REAL SPACE LOGIC (user note): occupancy — who is IN a room for sensing,
  // reactions and combat — is decided by an agent's physical coordinates,
  // not by the node its pathfinder is bound to. A form ten meters into the
  // hangar IS in the hangar, even if its "move" hasn't completed yet.
  _refreshOccupancy() {
    const g = this.graph;
    this._losAgentCache.clear();
    if (this.hive) this.hive._combatCacheTick = -1;
    for (const agents of Object.values(this._deckAgents)) agents.length = 0;
    // persistent per-node arrays, cleared in place (swarm finding: the old
    // Array.from(...() => []) allocated ~1,900 throwaway arrays a second)
    if (!this._occ || this._occ.length !== g.n) this._occ = Array.from({ length: g.n }, () => []);
    else for (let i = 0; i < g.n; i++) this._occ[i].length = 0;
    this._floodAt.fill(0);
    this._humanAt.fill(0);
    this._panicked.fill(0);
    for (const a of this.agents) {
      if (a.dead) continue;
      (this._deckAgents[a.deck] ??= []).push(a);
      a.pnode = this._pnodeOf(a);
      this._occ[a.pnode].push(a);
      if (isActiveFloodForm(a) || (a.faction === FACTION.CARRIER && a.hp > 0)) {
        this._floodAt[a.pnode] += W_FLOOD[a.faction];
      }
      if (a.hp > 0 && !a.dead && (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE)) {
        this._humanAt[a.pnode]++;
      }
      if (a.panicked && a.hp > 0) this._panicked[a.pnode] = 1;
    }
  }

  // A mover inside ducting or a cross-deck crawlway is physically inside the
  // ship's structure, not in any room — those keep their logical anchor (and
  // combat.js resolves them in their own shaft/vent groups).
  _physAnchored(a) {
    if (!a.move || a.move.layer === 'std') return true;
    if (a.move.layer === 'vent') return false;
    const l = a.move.link;
    return this.graph.node(l.a).deck === this.graph.node(l.b).deck; // same-deck crawl crosses open floor
  }

  // Which room rect actually contains this body. Prefers the current logical
  // node (cheap, and stable at shared-wall boundaries), then scans the deck.
  _pnodeOf(a) {
    if (!this._physAnchored(a)) return a.node;
    // inlined rect test (perf pass 5: the closure here allocated per agent,
    // twice per tick — measured 2.1x slower than the flat form)
    const cur = this.graph.node(a.node);
    // the deck test is load-bearing mid-stair-climb: a.deck flips to the
    // upper deck at the handover while a.node still names the lower room
    if (cur.deck === a.deck
      && Math.abs(a.x - cur.x) <= cur.w / 2 + 0.4 && Math.abs(a.y - cur.y) <= cur.d / 2 + 0.4) return a.node;
    for (const n of this._deckRooms[a.deck] ?? []) {
      if (Math.abs(a.x - n.x) <= n.w / 2 + 0.4 && Math.abs(a.y - n.y) <= n.d / 2 + 0.4) return n.idx;
    }
    return a.node;
  }

  _computeInfluence() {
    const g = this.graph;
    const { floodStr, humanStr, hardness } = this.influence;
    floodStr.fill(0); humanStr.fill(0); hardness.fill(0);
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0) continue;
      const n = a.pnode ?? a.node;
      if (isActiveFloodForm(a) || a.faction === FACTION.CARRIER) floodStr[n] += W_FLOOD[a.faction];
      else if (isLivingHuman(a)) {
        humanStr[n] += W_HUMAN[a.faction];
        if (a.faction === FACTION.MARINE) hardness[n] += 1;
      }
    }
    // diffuse across every real connection (§6.2) — the vent layer is empty
    // now (the duct network is routed, not walked), so influence spreads
    // through doors: the spaces bodies actually fight across
    const pass = (l) => (l.kind === 'std' ? !l.locked : true);
    for (let pass_i = 0; pass_i < 2; pass_i++) {
      for (const arr of [floodStr, humanStr, hardness]) {
        const next = Float32Array.from(arr);
        for (let i = 0; i < g.n; i++) {
          for (const { to } of g.neighbors(i, ['std'], pass)) {
            next[to] += arr[i] * 0.18;
          }
        }
        arr.set(next);
      }
    }
  }

  // REAL-DISTANCE travel (user note): seconds to cross a link = its measured
  // meters over the mover's speed, plus door/lift mechanics. Crawling through
  // shafts and ducting is pace-limited by the space, not the crawler.
  travelSec(link, mult) {
    const M = this.P.movement;
    const run = (link.horizM + link.vertM);
    if (link.kind === 'shaft') return run * M.crawlWindingFactor / M.shaftMps;
    // a network transit pays the crawl (∝ real grate-to-grate distance — the
    // map's own dimensions set the clock) plus prying in and dropping out
    if (link.kind === 'vent') return run * M.crawlWindingFactor / M.ventMps + (M.ventTransferSec ?? 0) * 2;
    const mps = M.baseMps * Math.max(0.2, mult);
    if (link.type === 'lift') return link.horizM / mps + M.liftSec;
    // a ladder transit is MOUNT + CLIMB — the walk to the pad already
    // happened in the room. Folding the link's fore-aft span into the hold
    // time made every one-at-a-time climb a ~12 s ladder monopoly and the
    // queues behind it jammed for minutes (user rule: queued, not jammed).
    if (link.type === 'ladder') return 1.0 + link.vertM / M.ladderClimbMps;
    // the grand stairwell is WALKED tread by tread: the ride pays for the real
    // switchback meters (two sloped flights + the landing, measured by the
    // graph), not the fore-aft room offset the generic branch would use —
    // that 5 s ride covered ~22 m of stairs and read as teleporting
    if (link.type === 'stairwell') return (link.stairRunM ?? run) / mps + 0.5;
    return run / mps + (M.doorDelaySec[link.type] ?? 0);
  }

  // A vent order still begins with a real walk to the grate. Route that short
  // in-room leg around active fire instead of drawing a straight line through
  // it—the crash blaze was silently deleting healthy opening pods before
  // they ever reached the duct network.
  _ventEntryPoints(from, to, room) {
    const points = [{ x: from.x, y: from.y }];
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) {
      const ux = dx / length, uy = dy / length;
      const px = -uy, py = ux;
      const fires = this.fires.filter((fire) => fire.deck === room.deck && fire.node === room.idx)
        .map((fire) => ({ fire, along: (fire.x - from.x) * ux + (fire.y - from.y) * uy }))
        .filter(({ along }) => along > 0 && along < length)
        .sort((a, b) => a.along - b.along);
      for (const { fire, along } of fires) {
        const closestX = from.x + ux * along, closestY = from.y + uy * along;
        const signed = (fire.x - closestX) * px + (fire.y - closestY) * py;
        const radius = this.P.fire.radiusM * fire.scale + 0.65;
        if (Math.abs(signed) >= radius) continue;
        const side = signed >= 0 ? -1 : 1;
        const offset = radius * side;
        const before = Math.max(0, along - radius);
        const after = Math.min(length, along + radius);
        points.push({ x: from.x + ux * before + px * offset, y: from.y + uy * before + py * offset });
        points.push({ x: from.x + ux * after + px * offset, y: from.y + uy * after + py * offset });
      }
    }
    points.push({ x: to.x, y: to.y });
    const hw = Math.max(0.4, room.w / 2 - 0.4), hd = Math.max(0.4, room.d / 2 - 0.4);
    for (const point of points) {
      point.x = Math.max(room.x - hw, Math.min(room.x + hw, point.x));
      point.y = Math.max(room.y - hd, Math.min(room.y + hd, point.y));
    }
    return points;
  }

  _polylinePoint(points, progress) {
    let total = 0;
    const lengths = [];
    for (let index = 1; index < points.length; index++) {
      const length = Math.hypot(points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y);
      lengths.push(length);
      total += length;
    }
    let remaining = total * progress;
    for (let index = 0; index < lengths.length; index++) {
      if (remaining <= lengths[index] || index === lengths.length - 1) {
        const part = lengths[index] > 1e-6 ? remaining / lengths[index] : 1;
        return [points[index].x + (points[index + 1].x - points[index].x) * part,
          points[index].y + (points[index + 1].y - points[index].y) * part];
      }
      remaining -= lengths[index];
    }
    return [points.at(-1).x, points.at(-1).y];
  }

  _speedMult(a) {
    const S = this.P.speed;
    switch (a.faction) {
      case FACTION.CIVILIAN: return a.state === STATE.FLEE || a.panicked ? S.civilianFlee : S.civilian;
      case FACTION.ARMED: return a.state === STATE.FLEE ? S.civilianFlee : S.armed;
      // your fireteam keeps YOUR pace (user: they were terrible at following;
      // then 5.4x read as rocketing) — a brisk 3.2x tactical jog holds your
      // walk and only trails a hard sprint; a posted marine walks normally.
      case FACTION.MARINE: return a.escort ? 3.2 : S.marine;
      case FACTION.INFECTION: return S.infection;
      case FACTION.COMBAT: return a.dragging !== -1 ? S.drag : S.combatForm;
      case FACTION.CARRIER: return S.carrier;
      default: return 1;
    }
  }

  _captureHumanWalkStart() {
    for (const a of this.agents) {
      if (a.dead || a.isPlayer || (a.faction !== FACTION.CIVILIAN
        && a.faction !== FACTION.ARMED && a.faction !== FACTION.MARINE)) continue;
      a.walkStartX = a.x;
      a.walkStartY = a.y;
    }
  }

  // Human facing follows the displacement the player actually sees after
  // doorway funnels, hatch approaches and crowd separation have all acted.
  // Individual movement branches used their intended path bearing instead;
  // at cross-deck hatches that could be nearly perpendicular to the real
  // walk, producing a forward gait sliding sideways across the floor.
  // ATTACK is deliberately excluded: a shooter keeps facing the target.
  _faceWalkingHumans() {
    for (const a of this.agents) {
      if (a.dead || a.isPlayer || a.move?.hidden || (a.faction !== FACTION.CIVILIAN
        && a.faction !== FACTION.ARMED && a.faction !== FACTION.MARINE)) continue;
      const clip = this._clipFor(a);
      if (clip !== CLIP.WALK && clip !== CLIP.RUN) continue;
      const dx = a.x - a.walkStartX, dy = a.y - a.walkStartY;
      if (dx * dx + dy * dy > 1e-6) a.heading = Math.atan2(dy, dx);
    }
  }

  _advanceMovement(dt) {
    const g = this.graph;
    for (const a of this.agents) {
      // KNOCKBACK, spent before anything else this tick. Applied here rather
      // than at the hit so it decays over real time and goes through
      // _clampToRoom — a body shoved at a bulkhead stops against it instead of
      // being punched through the hull. The player is exempt: its position is
      // owned by the physics capsule (see the `continue` below), so its shove
      // is consumed by the controller instead.
      if (a.shoveX || a.shoveY) {
        if (!a.isPlayer && !a.dead) {
          a.x += a.shoveX * dt;
          a.y += a.shoveY * dt;
          const room = g.node(a.pnode ?? a.node);
          if (room) this._clampToRoom(a, room);
        }
        const d = Math.exp(-7 * dt);
        a.shoveX *= d; a.shoveY *= d;
        if (Math.abs(a.shoveX) < 0.02 && Math.abs(a.shoveY) < 0.02) { a.shoveX = 0; a.shoveY = 0; }
      }
      a.hoverY = 0; // reset the leap arc each tick; _spatialSteer re-sets it
      // NOBODY IS FLYING A BODY THIS LOOP SKIPS. _spatialSteer is the only
      // thing that sets a.leaping, so every path out of this loop that never
      // reaches it has to drop the flag. The one below (steer declined it)
      // was covered; these early exits were not, and a combat form SHOT DOWN
      // mid-leap kept a.leaping set for the rest of the run — measured 16,328
      // consecutive ticks on charon-2 — which locked it out of fire avoidance
      // and left a stale committed arc to resume from if it was ever raised.
      if (a.leaping && (a.dead || a.faction === FACTION.CORPSE || a.downed || a.hp <= 0
        || a.isPlayer || a.closeFollow || a.held === this.tickCount)) {
        this._endLeap(a);
      }
      if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) continue;
      // the player's body is moved by the game, not the pathfinder
      if (a.isPlayer) { a.animTime += this._gaitDt(a, dt, a.followSpeed ?? 0); continue; }
      // a fireteam member close-following the player was already positioned by
      // the escort steer this tick — don't park-drift it back off station.
      if (a.closeFollow) { a.animTime += dt; continue; }
      // a human with a form burrowing in (§ grabPins): the latch CANNOT be
      // broken — the host runs screaming in tight frantic circles until
      // someone physically shoots the thing off (user rule). The player's
      // own body stays game-driven (the pinned UX handles them).
      if (a.held === this.tickCount) {
        a.move = null;
        if (!a.isPlayer && (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE)) {
          a.panicked = true;
          a.heading += dt * 4.6; // tight spin — frantic circles
          const mps = this.P.movement.baseMps * 1.15;
          a.x += Math.cos(a.heading) * mps * dt;
          a.y += Math.sin(a.heading) * mps * dt;
          a.steeredTick = this.tickCount; // a pinned host running circles IS motion
          const room = this.graph.node(a.pnode ?? a.node);
          const hw = Math.max(0.4, room.w / 2 - 0.4), hd = Math.max(0.4, room.d / 2 - 0.4);
          a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x));
          a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y));
          a.followSpeed = mps; // frantic circles are legged, not a glide
          a.animTime += this._gaitDt(a, dt, mps);
          // and never stops screaming
          if ((this.tickCount + a.id) % 15 === 0) this.screamTick[a.node] = this.tickCount;
        }
        continue;
      }
      // LINE-OF-SIGHT ENGAGEMENT (user note): a form that physically shares
      // an open space with prey abandons its track and closes on the body
      // itself — see _spatialSteer
      if (this._spatialSteer(a, dt)) continue;
      // ...and if it DIDN'T steer this body, nobody is flying an arc for it,
      // so the flag has to come off here. _spatialSteer bails before its arc
      // block whenever the prey dies, the hive retasks the form, or it starts
      // a move — and a.leaping left set freezes that body out of the crowd
      // separation pass and fire avoidance permanently.
      if (a.leaping) this._endLeap(a);
      if (a.state === STATE.FIGHT || a.state === STATE.GRABBING || a.state === STATE.COWER || a.state === STATE.AMBUSHING) {
        if (!a.move) {
          // fighters/grabbers/ambushers HOLD where they stand — sliding to a
          // parking slot at the room's center mid-fight is exactly the "it
          // all happens at the center" artifact this round removes
          if (a.state === STATE.COWER) this._parkDrift(a, dt);
          else { a.followSpeed = 0; a.animTime += dt; } // holding still — never stuck mid-stride
          continue;
        }
      }
      // a form burrowing into a corpse (CONVERT) or raising a downed form
      // (REANIMATE) is positioned by floodExec — it crawls ONTO the body and
      // stays clamped there. Once it's at the body's node (no path, no move)
      // parkDrift must NOT pull it back to a scatter slot: that pull vs the
      // floodExec clamp was the infect-a-body stutter (user), and it's what
      // split the form off the corpse it's rising from.
      if ((a.task?.kind === TASK.CONVERT || a.task?.kind === TASK.REANIMATE) && !a.move && !a.path.length) {
        a.animTime += dt; continue;
      }
      // DOOR BUSTING (user: a dedicated flood charge breaks a closed door
      // permanently, busting it outwards). The form walks onto the panel and
      // batters it — form-seconds accumulate on the LINK, so a pack shares
      // the work — until the door blows off its track for good. A door that
      // grinds open on its own (malfunction flip) releases the form early.
      if (a.busting) {
        const link = a.busting;
        if (!link.locked || link.busted || a.hp <= 0 || a.dead) { a.busting = null; }
        else {
          const dbx = link.door.x - a.x, dby = link.door.y - a.y;
          const dd = Math.hypot(dbx, dby);
          if (dd > 1.3) {
            const mps = this.P.movement.baseMps * this.P.speed.combatForm;
            const stp = Math.min(dd, mps * dt);
            a.x += (dbx / dd) * stp; a.y += (dby / dd) * stp;
            a.heading = Math.atan2(dby, dbx);
            a.followSpeed = stp / dt;
          } else {
            a.followSpeed = 0;
            a.heading = Math.atan2(dby, dbx);
            a.meleeUntil = this.t + 0.25; // the renderer swings the tentacles
            link.bustAcc += dt;
            // the hammering carries — both rooms hear trouble at the door
            if ((this.tickCount + a.id) % 20 === 0) {
              this.gunfireTick[link.a] = this.tickCount;
              this.gunfireTick[link.b] = this.tickCount;
            }
            const need = link.type === 'blastdoor' ? this.P.door.bustBlastSec : this.P.door.bustHatchSec;
            if (link.bustAcc >= need) {
              link.busted = true;
              link.locked = false;
              link.malfunction = false; // there is no door left to malfunction
              a.busting = null;
              this._doorMutated();
              this.log('radio', `the door between ${this.graph.node(link.a).name} and ${this.graph.node(link.b).name} BLOWS OUTWARD — something came through`, link.a);
            }
          }
          a.animTime += dt;
          continue;
        }
      }
      if (a.move) {
        if (this._holdMarineAtRadarDoor(a, dt) || this._holdMarineAtHotLadder(a, dt)) continue;
        const retreatPace = (a.move.retreatSprint || a.move.dartSprint)
          ? this.P.speed.chargeMult : 1;
        a.move.t += dt * retreatPace / a.move.travelSec;
        const from = g.node(a.move.from), to = g.node(a.move.to);
        const k = Math.min(1, a.move.t);
        const link = a.move.link;
        // HALLWAYS ARE SPACES, NOT LINKS (user note): a standard connection
        // is a doorway on the shared wall. The mover walks center → door →
        // center, and the moment it passes the door it IS in the next space —
        // it stands in that room's occupancy, sightlines and fire lanes for
        // the rest of the crossing. No more being "in" a room you left 15
        // seconds ago while halfway down the corridor.
        if (a.move.layer === 'std' && link.door && from.deck === to.deck) {
          const fwd = a.move.from === link.a;
          const flipT = a.move.flipT2 ?? (fwd ? link.flipT : 1 - link.flipT);
          const d = link.door;
          if (k < flipT) {
            const kk = k / flipT;
            const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
            a.x = sx + (d.x - sx) * kk;
            a.y = sy + (d.y - sy) * kk;
            a.heading = Math.atan2(d.y - sy, d.x - sx);
          } else {
            const kk = (k - flipT) / Math.max(1e-6, 1 - flipT);
            const tx = a.move.tx ?? to.x, ty = a.move.ty ?? to.y;
            a.x = d.x + (tx - d.x) * kk;
            a.y = d.y + (ty - d.y) * kk;
            a.heading = Math.atan2(ty - d.y, tx - d.x);
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
          }
        } else if (a.move.layer === 'std' && from.deck !== to.deck && link.type === 'stairwell') {
          // GRAND STAIRWELL — an OPEN switchback, not an enclosed lift trunk.
          // The generic vertical branch below parks a body at the ROOM WALL for
          // the whole ride (user: flood get stuck on the staircase walls). Walk
          // it down (or up) the VISIBLE well instead: top flight → mid landing →
          // foot flight, staged in the upper room's frame so the renderer drops
          // the feet onto the treads (world X == sim X, so the path lines up).
          const upper = from.deck < to.deck ? from : to;
          const descending = from === upper;
          const wp = this._stairWaypoints(upper);
          // THE FRAME CHANGE IS THE WHOLE BUG (user: NPCs teleport through the
          // stairwell instead of walking the U). Every waypoint above is in the
          // UPPER room's frame, but a room's sim y is offset by its DECK BAND —
          // the same physical point has a different y on each deck. The old code
          // mixed frames: an ascending body walked to its own room's centre line
          // and then jumped onto the stairs, and BOTH directions snapped from the
          // last tread straight to a parking slot anywhere in the destination
          // room. Two teleports per traversal, one of them room-sized.
          // Fix: convert the foot waypoint into the LOWER room's frame — the
          // SAME physical point, so approach → ride → exit is continuous — and
          // walk the exit leg out of the mouth instead of snapping.
          const footLo = { x: wp.foot.x, y: wp.foot.y - this._bandC(upper.deck) + this._bandC(descending ? to.deck : from.deck) };
          const A = descending ? wp.top : wp.foot;   // mouth this traversal enters (upper frame)
          const B = descending ? wp.foot : wp.top;   // mouth it steps off at the far deck (upper frame)
          // the far mouth in the DESTINATION room's own frame: descending you
          // step off the foot (lower deck), ascending off the top (upper deck)
          const Bdest = descending ? footLo : wp.top;
          const appT = a.move.appT ?? 0.15;
          // the exit leg is TIMED BY DISTANCE (set at move start, same as the
          // duct branch): walk to the mouth, ride the switchback, walk off it
          const exitT = a.move.exitT ?? 0.18;
          const handT = Math.max(appT + 1e-3, 1 - exitT);
          const px0 = a.x, py0 = a.y;                // last point, for heading
          if (k < appT) {
            // walk from where you stood to the stair mouth, in the ORIGIN room's
            // own frame — along the move's approach POLYLINE, which detours
            // around the open well / stair tower (a straight line cut across
            // the hole in plan, and the body dipped through the switchback)
            const kk = appT > 1e-6 ? k / appT : 1;
            if (a.move.appPts) {
              const [ax, ay] = this._walkPolyline(a.move.appPts, kk);
              a.x = ax; a.y = ay;
            } else {
              const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
              const mouth = descending ? A : footLo;
              a.x = sx + (mouth.x - sx) * kk; a.y = sy + (mouth.y - sy) * kk;
            }
          } else if (k < handT) {
            // ON THE SWITCHBACK: A → mid landing → B, in the UPPER room's frame.
            // deck = upper for the ride (the well is one two-storey volume) so
            // groundHeightAt walks the feet down the treads.
            if (a.deck !== upper.deck) {
              a.deck = upper.deck;
              a.node = upper.idx;
            }
            const kk = (k - appT) / Math.max(1e-6, handT - appT);
            if (kk < 0.5) { const u = kk / 0.5; a.x = A.x + (wp.mid.x - A.x) * u; a.y = A.y + (wp.mid.y - A.y) * u; }
            else { const u = (kk - 0.5) / 0.5; a.x = wp.mid.x + (B.x - wp.mid.x) * u; a.y = wp.mid.y + (B.y - wp.mid.y) * u; }
          } else {
            // STEP OFF AND WALK IN (no snap): from the far mouth, in the
            // destination room's frame, to this body's own parking slot over
            // what's left of the leg — the same shape the duct exit uses.
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
            const kk = handT < 1 ? Math.min(1, (k - handT) / (1 - handT)) : 1;
            if (a.move.exitPts) {
              const [ax, ay] = this._walkPolyline(a.move.exitPts, kk);
              a.x = ax; a.y = ay;
            } else {
              const [tx, ty] = this._parkSlot(a, to);
              a.x = Bdest.x + (tx - Bdest.x) * kk;
              a.y = Bdest.y + (ty - Bdest.y) * kk;
            }
          }
          a.heading = Math.atan2(a.y - py0, a.x - px0) || a.heading;
        } else if (a.move.layer === 'std' && from.deck !== to.deck) {
          // VERTICAL TRANSIT (user note: no walking off the map): a body in
          // a lift or on a ladder is AT the trunk, not floating in the void
          // between deck plans. Stand on the origin pad until the handover,
          // then on the destination pad. THE PADS ARE THE DRAWN WELLS (user:
          // "NPCs should come right out of those ladder holes exactly"):
          // link.padA/padB are the graph-placed trunk positions the renderer
          // builds its hatches and kiosks at — not a recomputed clamp that
          // could disagree with the visible hole.
          const padFrom = (link.a === from.idx ? link.padA : link.padB)
            ?? { x: Math.max(from.x - from.w / 2 + 1.2, Math.min(from.x + from.w / 2 - 1.2, to.x)), y: from.y };
          const padTo = (link.a === to.idx ? link.padA : link.padB)
            ?? { x: Math.max(to.x - to.w / 2 + 1.2, Math.min(to.x + to.w / 2 - 1.2, from.x)), y: to.y };
          // The leg has three distance-timed phases: walk to the pad, disappear
          // into the trunk, then immediately walk clear of the far hatch. The
          // old flipT handoff exposed a form halfway through the timer and left
          // it motionless on the exit pad for seconds.
          const appT = a.move.appT ?? 0.15;
          const exitT = a.move.exitT ?? 0.15;
          const handT = Math.max(appT + 1e-3, 1 - exitT);
          if (k < appT) {
            const sx = a.move.sx ?? padFrom.x, sy = a.move.sy ?? padFrom.y;
            const kk = k / appT;
            a.x = sx + (padFrom.x - sx) * kk;
            a.y = sy + (padFrom.y - sy) * kk;
            a.heading = Math.atan2(padFrom.y - sy, padFrom.x - sx);
            a.move.hidden = false;
          } else if (k < handT) {
            // IN THE TRUNK (user: "ladders need to spawn them right at the
            // opening only every time"). A climber used to STAND on the top
            // hatch for the whole ride and then blink to the bottom one. It is
            // inside the structure now — same rule the ducts follow: hidden
            // while it climbs, untargetable, and it climbs OUT of the far hole
            // (the renderer's emerge path snaps to that mouth and plays the
            // rise). The player is exempt: you ride your own ladder in view.
            a.x = padFrom.x; a.y = padFrom.y;
            a.move.hidden = !a.isPlayer;
          } else {
            const kk = handT < 1 ? Math.min(1, (k - handT) / (1 - handT)) : 1;
            const tx = a.move.tx ?? to.x, ty = a.move.ty ?? to.y;
            a.x = padTo.x + (tx - padTo.x) * kk;
            a.y = padTo.y + (ty - padTo.y) * kk;
            a.move.hidden = false;
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
            // The next climber can enter once this body has left the rungs;
            // its short walk across the destination room must not hold the
            // ladder reservation or create a visible queueing pause.
            if (link.type === 'ladder' && link.occupiedBy === a.id) link.occupiedBy = undefined;
          }
          a.heading = Math.atan2(to.y - from.y, to.x - from.x);
        } else {
          // VENT / SHAFT (user report: a crawler snapped to the room centre
          // then teleported to the opening). Three legs instead: WALK to the
          // marked duct opening (visible), CRAWL through the structure
          // (hidden), then CLIMB OUT the far opening to a parking slot
          // (visible). Only the middle leg is hidden, so you see them enter
          // and leave at the grates.
          const appT = a.move.appT ?? 0, exitT = a.move.exitT ?? 0;
          const eFromX = a.move.eFromX ?? from.x, eFromY = a.move.eFromY ?? from.y;
          const eToX = a.move.eToX ?? to.x, eToY = a.move.eToY ?? to.y;
          if (k < appT) {
            const kk = appT > 1e-6 ? k / appT : 1;
            const [x, y] = a.move.entryPoints
              ? this._polylinePoint(a.move.entryPoints, kk)
              : [(a.move.sx ?? from.x) + (eFromX - (a.move.sx ?? from.x)) * kk,
                (a.move.sy ?? from.y) + (eFromY - (a.move.sy ?? from.y)) * kk];
            const oldX = a.x, oldY = a.y;
            a.x = x; a.y = y;
            a.heading = Math.atan2(a.y - oldY, a.x - oldX) || a.heading;
            a.move.hidden = false;
          } else if (k > 1 - exitT) {
            const kk = exitT > 1e-6 ? (k - (1 - exitT)) / exitT : 1;
            // why: corpses can still slide while the pod is hidden in the
            // duct. Refresh the committed arrival every exit tick so it
            // follows the body, not the spot where that body used to be.
            const [tx, ty] = this._moveArrivalPoint(a, to);
            a.move.tx = tx; a.move.ty = ty;
            a.x = eToX + (tx - eToX) * kk;
            a.y = eToY + (ty - eToY) * kk;
            a.heading = Math.atan2(ty - eToY, tx - eToX);
            a.move.hidden = false;
            if (a.node !== a.move.to) { a.node = a.move.to; a.deck = to.deck; }
          } else {
            // inside the ductwork — hidden, sitting at the entry opening
            a.x = eFromX; a.y = eFromY;
            a.move.hidden = true;
          }
        }
        // formation lane (user note: no stacked dots): every mover holds a
        // personal lateral offset from the column line, so a squad on the
        // same route reads as a file of soldiers, not one dot
        if (a.move.layer === 'std' && from.deck === to.deck) {
          // SINGLE-FILE THROUGH DOORWAYS (user report: marines wedge shoulder
          // to shoulder in an opening). The lateral formation offset tapers to
          // zero as a body nears the door point, so a column funnels onto the
          // centreline to pass the ~1.7 m opening one at a time, then fans back
          // out into the room beyond. Full offset only in the open.
          const dr = a.move.link.door;
          const laneScale = dr ? Math.min(1, Math.hypot(a.x - dr.x, a.y - dr.y) / 2.2) : 1;
          if (a.faction === FACTION.INFECTION) {
            // pods don't march in file — they SKITTER, weaving side to side
            // as they cross (user note: point-to-point pod movement read as
            // robotic, nothing like the games)
            const w = Math.sin(this.t * 6 + a.id * 2.09) * 0.55 * laneScale;
            a.x += Math.cos(a.heading + Math.PI / 2) * w;
            a.y += Math.sin(a.heading + Math.PI / 2) * w;
          } else {
            const lane = (((a.id * 7919) % 100) / 100 - 0.5) * 1.5 * laneScale;
            a.x += Math.cos(a.heading + Math.PI / 2) * lane;
            a.y += Math.sin(a.heading + Math.PI / 2) * lane;
          }
          // the lane/weave offset must never push a body through the wall of
          // the room it's currently standing in (user report: hallway clip)
          this._clampToRoom(a, this.graph.node(a.node));
        }
        const sm = this._speedMult(a);
        a.animTime += this._gaitDt(a, dt, this.P.movement.baseMps * sm, sm > 1.2);
        if (a.move.t >= 1) {
          if (a.move.link.occupiedBy === a.id) a.move.link.occupiedBy = undefined; // ladder is free
          a.node = a.move.to;
          a.deck = to.deck;
          a.move = null;
          this._setCharging(a, false);
          a.firstStruckIn = undefined;
          if (a.state === STATE.MOVE) a.state = a.path.length ? STATE.MOVE : STATE.IDLE;
        }
        continue;
      }
      if (a.path.length) {
        const step = a.path[0];
        const link = step.link;
        // A queued graph step must begin at the room the previous leg reached.
        // Tactical re-plans can happen mid-doorway; rejecting a disconnected
        // edge here prevents any caller from turning that race into an illegal
        // lift, ladder, or cross-deck traversal. The standing task will re-path
        // from the correct node on its next execution tick.
        const connectedTo = link.a === a.node ? link.b : link.b === a.node ? link.a : -1;
        if (connectedTo !== step.to) {
          a.path = [];
          continue;
        }
        // ground-truth passability check; the hive plans on a stale map (§6.1)
        let passable = true;
        if (link.kind === 'std' && link.locked) passable = false;
        if (link.kind === 'vent' && link.blocked) passable = false;
        const flood = a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER;
        if (flood && this.graph.burningUntil[step.to] > this.t) passable = false;
        if (!passable) {
          if (flood && (link.kind !== 'std' || link.locked)) this.hive.observeBlocked(link);
          // DEDICATED CHARGE (user): a combat form that finds a closed door
          // in its way doesn't shrug and reroute — it throws itself at the
          // panel until the door blows outwards, PERMANENTLY. The armory
          // event gate is the one door the hive cannot have.
          if (a.faction === FACTION.COMBAT && link.kind === 'std' && link.locked
            && !link.armorySeal && !link.fireSite && link.door
            && this.graph.burningUntil[a.node] <= this.t) {
            a.busting = link; // handled at the top of the movement pass
            continue;         // keep the path — it resumes once the door is gone
          }
          a.path = [];
          continue;
        }
        // Recheck the visible fight before crossing an opening. A committed
        // retreat is exempt: one pursuer entering its current room cannot make
        // it reverse into the rest of the squad it is already escaping.
        if (a.faction === FACTION.COMBAT && link.kind === 'std' && a.task?.kind !== TASK.DART) {
          const retreating = this.hive.isRetreating(a);
          const visibleFight = this.hive.combatLineOfSight(a);
          // Enclosed lifts/ladders have no sightline, but they are adjacent in
          // the same topology. Life-sense therefore gets an equal veto: an
          // understrength pack withdraws before entering the trunk instead of
          // discovering the firing squad one body at a time at the far end.
          const sensedCrossing = retreating || this.hive.respondToSensedRoom(a, step.to);
          const retreatBlocked = retreating && visibleFight.defense > 0
            && visibleFight.threatNode === step.to;
          const attackOutmatched = !retreating
            && !this.hive.canPressCombatContact(a, !!a.task?.surge || this.hive.allIn, a.task?.force);
          if (!sensedCrossing || retreatBlocked || attackOutmatched) {
            a.path = [];
            this._setCharging(a, false);
            if (sensedCrossing) {
              this.hive.retreatOrFight(a, visibleFight.threatNode !== -1 ? visibleFight.threatNode : step.to);
            }
            continue;
          }
        }
        // COMMITTED INFECTION (user rule: once a form commits to infecting a
        // body it must NEVER be interrupted). A form whose very next step
        // enters the room holding its own infect target — a corpse to burrow
        // (CONVERT), a downed form to raise (REANIMATE), or a live host to
        // latch (GRAB) — pushes straight through both "don't walk into guns"
        // reflexes below. Without this it balked → re-pathed → balked at the
        // threshold forever whenever humans stood in the target room next door
        // (user report: infection forms looping, never landing the infect).
        const committedInto = a.faction === FACTION.INFECTION
          && this._committedInfectNode(a) === step.to;
        // an infection form can SEE shooters through the next doorway; while
        // the pool is precious it will not skitter into standing fire — but
        // a rich hive spends forms like water (§13.3 RiskAversion). After a
        // few refusals it dashes anyway: balking forever at the only exit
        // pinned whole swarms at the breach (user-reported regression).
        if (a.faction === FACTION.INFECTION && !committedInto && link.kind === 'std' &&
          (this.hive.lastScarcity ?? 3) > 0.8 &&
          (a.doorBalks = (a.doorBalks ?? 0) + 1) <= 12 &&
          this._occ[step.to].some((h) => h.hp > 0 && !h.dead &&
            (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED))) {
          a.path = [];
          continue;
        }
        // POD MUSTER (user report: a single-file conga of infection forms
        // trickling into a defended room and dying one at a time, "infecting
        // nothing"): the FINAL hop into a room with live guns waits at the
        // threshold until the local pack outguns the defenders — then the
        // whole group pours in together and the overwhelm rule takes over.
        // A pod held too long gives the hunt up and goes back to breeding.
        if (a.faction === FACTION.INFECTION && !committedInto && link.kind === 'std' && a.path.length === 1) {
          let guns = 0;
          for (const h of this._occ[step.to]) {
            if (h.hp <= 0 || h.dead) continue;
            if (h.faction === FACTION.MARINE) guns += 1;
            else if (h.faction === FACTION.ARMED) guns += 0.6;
          }
          if (guns > 0 && !this.hive.allIn) {
            const pack = this._floodAt[a.node] + this._floodAt[step.to];
            if (pack < guns * this.P.swarm.attackRatio) {
              a.doorHold = (a.doorHold ?? 0) + 1;
              if (a.doorHold > 45 * this.P.sim.tickHz) { // 45s of waiting — give it up
                a.doorHold = 0; a.path = []; a.task = null;
              }
              continue; // hold at the door; the pack is still building
            }
          }
          a.doorHold = 0;
        }
        // CLIMBING IS QUEUED (user rule): a LADDER takes one body at a time —
        // everyone else waits at the pad until the rungs are clear. Lifts are
        // cars: a whole fireteam rides together, no queue.
        const ladder = link.kind === 'std' && link.type === 'ladder'
          && this.graph.node(step.to).deck !== this.graph.node(a.node).deck;
        const surging = a.faction === FACTION.COMBAT && a.task?.kind === TASK.ATTACK
          && (a.task.surge || this.hive.allIn) && a.dragging === -1 && link.kind === 'std';
        // hold at the pad while the rungs are taken — OR while the player has
        // called "next" on this ladder (a busy ladder queues the emergency,
        // it doesn't deny it; without the reservation NPCs re-claim the rungs
        // every tick and a human pressing a key can never win the race).
        // INFECTION FORMS ARE EXEMPT (user rule): they're small — a swarm
        // pours up the rungs and through lift wells all at once.
        const queues = ladder && a.faction !== FACTION.INFECTION;
        // A COMMITTED HIVE SURGE IS ALSO ONE MOVEMENT: once its lead combat
        // form is on the ladder, packmates in that same surge scramble onto
        // the rungs behind it instead of standing visibly idle for a complete
        // climb. This exception never crosses a player's next-slot reservation
        // and never follows a human, retreating form, or ordinary traveller.
        const holder = ladder ? this.byId.get(link.occupiedBy) : null;
        const joinsSurge = surging && holder?.faction === FACTION.COMBAT
          && holder.move?.link === link && holder.task?.kind === TASK.ATTACK
          && (holder.task.surge || this.hive.allIn);
        if (queues && (this.vertReserved(link, a.id)
          || (this.vertBusy(link, a.id) && !joinsSurge))) continue;
        a.doorBalks = 0;
        a.path.shift();
        let mult = this._speedMult(a);
        // lore: a combat form closing on prey doesn't walk — it CHARGES,
        // sprinting/leaping the last stretch (renderers get FLAG.CHARGING)
        this._setCharging(a, false);
        if (a.faction === FACTION.COMBAT && a.dragging === -1 && link.kind === 'std'
          && !a.task?.retreat && !(a.task?.kind === TASK.DART && a.task.stage === 1)
          && (surging || this._occ[step.to].some((h) => isLivingHuman(h)))) {
          mult *= this.P.speed.chargeMult;
          this._setCharging(a, true);
        }
        // an infection form PURSUING a host keeps its skittering pace through
        // doorways too — at a walk it loses ground on every room the prey
        // flees through and the grab never lands (real-space pursuit)
        if (a.faction === FACTION.INFECTION && a.task?.kind === TASK.GRAB && link.kind === 'std') {
          mult *= this.P.speed.infectionLunge;
          this._setCharging(a, true);
        }
        // per-agent pace variation staggers a column longitudinally so
        // simultaneous movers never sit on the exact same interpolation point.
        // FLOOD FORMS get a MUCH wider spread (±25%) so a travelling pack reads
        // as a POURING STREAM down the corridor — leaders and stragglers — not a
        // tight moving blob (user: the flood clumps up in the corridor). The
        // swarm re-masses at the muster point before it assaults, so the
        // overwhelm is untouched; only the transit silhouette changes. The crew
        // keep their tight ±1% file.
        const paceHash = ((a.id * 2654435761) >>> 0) / 4294967296;
        const pace = a.task?.retreat || (a.task?.kind === TASK.DART && a.task.stage === 1) ? 1
          : surging ? 1
          : (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT)
          ? 1 + (paceHash - 0.5) * 0.5
          : 1 + ((a.id % 7) - 3) * 0.012;
        // sx/sy: the leg starts from where the body ACTUALLY stands (user
        // note: jerky movement) — interpolating from the room's center made
        // every parked/steered/separated agent snap onto the center line the
        // moment a move began
        a.move = { from: a.node, to: step.to, link, layer: link.kind, t: 0,
          sx: a.x, sy: a.y, travelSec: this.travelSec(link, mult) * pace,
          retreatSprint: a.faction === FACTION.COMBAT && a.task?.retreat === true
            ? a.retreatSprint : undefined,
          dartSprint: a.faction === FACTION.COMBAT && a.task?.kind === TASK.DART
            && a.task.stage === 1 };
        a.heldCombatGround = false;
        // DUCT NOISES (user: vents don't show on the map — the crew only
        // HEARS them): a form slipping into the ducting drops an ominous
        // log line, throttled per duct so it stays sparse.
        if ((link.kind === 'vent' || link.kind === 'shaft')
          && this.t - (link._ductLogAt ?? -99) > 12) {
          link._ductLogAt = this.t;
          const A = this.graph.node(link.a), B = this.graph.node(link.b);
          this.log('duct', A.deck === B.deck
            ? `something scuttles through the ducts near ${A.name}`
            : `noises in the ducts between decks ${Math.min(A.deck, B.deck)} and ${Math.max(A.deck, B.deck)}`,
            a.node);
        }
        // NO TELEPORTING TO LIFTS/STAIRS (user rule): a cross-deck leg pays
        // for the walk to the trunk pad at real walking speed BEFORE the
        // climb/ride time starts — appT marks where approach ends
        if (link.kind === 'std') {
          const fromN = this.graph.node(a.node), toN = this.graph.node(step.to);
          if (fromN.deck !== toN.deck) {
            let px, py;
            const mps = Math.max(0.5, this.P.movement.baseMps * mult);
            if (link.type === 'stairwell') {
              // approach the stair MOUTH (well), not a wall pad — see the
              // stairwell render branch and _stairWaypoints. Both mouths are
              // authored in the UPPER room's frame, so the one this body walks
              // to must be converted into ITS OWN room's frame first (a room's
              // sim y carries its deck band; mixing the two frames is what
              // teleported climbers across the map).
              const upper = fromN.deck < toN.deck ? fromN : toN;
              const wp = this._stairWaypoints(upper);
              const shift = this._bandC(fromN.deck) - this._bandC(upper.deck);
              const mouth = fromN === upper ? wp.top : wp.foot;
              px = mouth.x;
              py = mouth.y + shift;
              // BOTH walking legs are POLYLINES that detour around the well
              // rect (the open hole at entry level, the enclosed stair tower
              // at hangar level): a straight line to the mouth cut across the
              // hole in plan and the body dipped through the switchback (the
              // stair-check's floor-height watchdog caught exactly this).
              // Both mouths open onto the well's FORE edge, so each leg goes
              // through a pre-mouth point just outside that edge and enters
              // straight through it.
              const preY = wp.wellY - wp.wellHz - 0.9;
              const pre = { x: px, y: preY + shift };
              const appPts = [{ x: a.x, y: a.y },
                ...this._detourAroundRect(a.x, a.y, pre.x, pre.y,
                  wp.wellX, wp.wellY + shift, wp.wellHx, wp.wellHz, 0.9),
                pre, { x: px, y: py }];
              // ...and pay for the walk OFF the far mouth to this body's own
              // slot in the destination room, at walking pace (the ride used
              // to hand over at a fixed 82% and then cover that ground in the
              // leftover ticks — a 20 m/s skate across the hangar)
              const exitShift = this._bandC(toN.deck) - this._bandC(upper.deck);
              const far = fromN === upper ? wp.foot : wp.top;
              const [sx2, sy2] = this._parkSlot(a, toN);
              const preD = { x: far.x, y: preY + exitShift };
              const exitPts = [{ x: far.x, y: far.y + exitShift }, preD,
                ...this._detourAroundRect(preD.x, preD.y, sx2, sy2,
                  wp.wellX, wp.wellY + exitShift, wp.wellHx, wp.wellHz, 0.9),
                { x: sx2, y: sy2 }];
              const plen = (pts) => {
                let L = 0;
                for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
                return L;
              };
              const appSec2 = plen(appPts) / mps;
              const exitSec = plen(exitPts) / mps;
              a.move.travelSec += appSec2 + exitSec;
              a.move.appT = appSec2 / a.move.travelSec;
              a.move.exitT = exitSec / a.move.travelSec;
              a.move.appPts = appPts;
              a.move.exitPts = exitPts;
            } else {
              // walk to the REAL trunk pad (the drawn well), not a clamp guess
              const pad = (link.a === a.node ? link.padA : link.padB);
              const farPad = (link.a === step.to ? link.padA : link.padB);
              px = pad ? pad.x : Math.max(fromN.x - fromN.w / 2 + 1.2, Math.min(fromN.x + fromN.w / 2 - 1.2, toN.x));
              py = pad ? pad.y : fromN.y;
              const appSec = Math.hypot(px - a.x, py - a.y) / mps;
              const [tx, ty] = this._parkSlot(a, toN);
              const farX = farPad?.x ?? Math.max(toN.x - toN.w / 2 + 1.2, Math.min(toN.x + toN.w / 2 - 1.2, fromN.x));
              const farY = farPad?.y ?? toN.y;
              const exitSec = Math.hypot(tx - farX, ty - farY) / mps;
              a.move.tx = tx; a.move.ty = ty;
              a.move.travelSec += appSec + exitSec;
              a.move.appT = appSec / a.move.travelSec;
              a.move.exitT = exitSec / a.move.travelSec;
            }
          } else if (link.door) {
            // REAL METERS, REAL SPEED (user report: bodies "flying" faster
            // than they walk, and everyone converging on the room's center):
            // the leg is timed from the ACTUAL drawn path — start, through
            // the door, to this body's OWN parking slot in the next room —
            // and it LANDS on the slot, so nobody walks to the center point
            // just to drift back out of it.
            const [tx, ty] = this._parkSlot(a, toN);
            const d1 = Math.hypot(link.door.x - a.x, link.door.y - a.y);
            const d2 = Math.hypot(tx - link.door.x, ty - link.door.y);
            const mps = Math.max(0.5, this.P.movement.baseMps * mult);
            a.move.tx = tx; a.move.ty = ty;
            a.move.travelSec = Math.max(0.2, ((d1 + d2) / mps) * pace);
            a.move.flipT2 = d1 / Math.max(0.1, d1 + d2);
          }
        } else if (link.kind === 'vent' || link.kind === 'shaft') {
          // WALK TO THE DUCT OPENING (user report: crawler snaps to room
          // centre then teleports to the grate). The leg now pays real walk
          // time to the marked opening in this room, crawls hidden, then walks
          // out of the far opening to its own slot — visible at both grates.
          const fromN = this.graph.node(a.node), toN = this.graph.node(step.to);
          const eFrom = (a.node === link.a ? link.doorA : link.doorB) ?? link.door ?? { x: fromN.x, y: fromN.y };
          const eTo = (a.node === link.a ? link.doorB : link.doorA) ?? link.door ?? { x: toN.x, y: toN.y };
          const [tx, ty] = this._moveArrivalPoint(a, toN);
          const mps = Math.max(0.5, this.P.movement.baseMps * mult);
          const entryPoints = this._ventEntryPoints(a, eFrom, fromN);
          let entryLength = 0;
          for (let index = 1; index < entryPoints.length; index++) {
            entryLength += Math.hypot(entryPoints[index].x - entryPoints[index - 1].x,
              entryPoints[index].y - entryPoints[index - 1].y);
          }
          const appSec = entryLength / mps;
          const exitSec = Math.hypot(tx - eTo.x, ty - eTo.y) / mps;
          a.move.eFromX = eFrom.x; a.move.eFromY = eFrom.y;
          a.move.eToX = eTo.x; a.move.eToY = eTo.y;
          a.move.tx = tx; a.move.ty = ty;
          a.move.entryPoints = entryPoints;
          a.move.travelSec += appSec + exitSec;
          a.move.appT = appSec / a.move.travelSec;
          a.move.exitT = exitSec / a.move.travelSec;
        }
        if (queues) link.occupiedBy = a.id; // claim the ladder (pods never do)
        if (a.state === STATE.IDLE) a.state = STATE.MOVE;
      } else {
        // Marines keep the ground they held in a firefight. Recomputing a
        // parking slot after contact made them drift back across the room.
        if (a.faction === FACTION.MARINE && a.heldCombatGround) { a.followSpeed = 0; a.animTime += dt; }
        else this._parkDrift(a, dt);
      }
    }
  }

  // A radar check approaches an ordinary doorway but does not blindly cross
  // it while the paint is live. Stopping just inside the origin room puts the
  // marine on the real sightline, where the normal LOS/fire logic takes over;
  // if nothing appears and the paint fades, the same leg continues through.
  _holdMarineAtRadarDoor(a, dt) {
    if (a.faction !== FACTION.MARINE || !a.move || a.move.layer !== 'std') return false;
    const link = a.move.link;
    const from = this.graph.node(a.move.from), to = this.graph.node(a.move.to);
    if (!link.door || from.deck !== to.deck) return false;
    const squad = this.squads[a.squad];
    if (squad?.objective?.kind !== 'motion' || squad.objective.hold
      || squad.objective.contactNode !== to.idx) return false;
    if (!this.marineMotionAt(to.idx).fresh) return false;

    const fwd = a.move.from === link.a;
    const flipT = a.move.flipT2 ?? (fwd ? link.flipT : 1 - link.flipT);
    const sx = a.move.sx ?? from.x, sy = a.move.sy ?? from.y;
    const approachM = Math.hypot(link.door.x - sx, link.door.y - sy);
    const stopT = flipT * Math.max(0, 1 - 0.45 / Math.max(0.45, approachM));
    if (a.move.t + dt / a.move.travelSec < stopT) return false;

    a.move.t = stopT;
    const k = flipT > 1e-6 ? stopT / flipT : 1;
    a.x = sx + (link.door.x - sx) * k;
    a.y = sy + (link.door.y - sy) * k;
    a.move.hidden = false;
    a.followSpeed = 0;
    a.heading = Math.atan2(link.door.y - sy, link.door.x - sx);
    a.animTime += dt;
    return true;
  }

  // Stop a marine AT the ladder mouth, not back at an abstract room centre.
  // Downward crossings can be opened with one deliberate frag when the paint
  // is dense enough; upward crossings and uncertain/sparse contacts wait.
  // The reservation makes the whole squad queue behind the same decision.
  _holdMarineAtHotLadder(a, dt) {
    if (a.faction !== FACTION.MARINE || !a.move || a.move.layer !== 'std') return false;
    const link = a.move.link;
    const from = this.graph.node(a.move.from), to = this.graph.node(a.move.to);
    if (link.type !== 'ladder' || from.deck === to.deck) return false;
    const appT = a.move.appT ?? 0;
    if (a.move.t + dt / a.move.travelSec < appT) return false;

    const squad = this.squads[a.squad];
    const linkKey = link.i;
    const blastHold = squad?.ladderFragLink === linkKey
      && squad.ladderFragNode === to.idx
      && this.t < (squad.ladderFragUntil ?? -1);
    const contact = this.marineMotionAt(to.idx);
    const risky = contact.fresh && contact.count >= this.P.grenade.minTargets;
    if (!blastHold && !risky) return false;

    // Smaller deck numbers are physically higher. Grenades can be dropped
    // into a lower landing; an upward throw is not invented for convenience.
    const descending = to.deck > from.deck;
    if (!blastHold && descending && contact.current >= this.P.grenade.minTargets) {
      const farPad = (link.a === to.idx ? link.padA : link.padB) ?? { x: to.x, y: to.y };
      if (marineThrowFragAt(this, a, to.idx, farPad.x, farPad.y, 1, true) && squad) {
        squad.ladderFragLink = linkKey;
        squad.ladderFragNode = to.idx;
        squad.ladderFragUntil = this.t + this.P.grenade.fuseSec
          + this.P.marineDoctrine.ladderBlastSettleSec;
      }
    }

    a.move.t = appT;
    const pad = (link.a === from.idx ? link.padA : link.padB) ?? { x: from.x, y: from.y };
    a.x = pad.x; a.y = pad.y;
    a.move.hidden = false;
    a.followSpeed = 0;
    a.heading = Math.atan2(to.y - from.y, to.x - from.x);
    a.animTime += dt;
    return true;
  }

  // Nearest LIVE body sharing this room, inside `range` metres. This is the
  // pounce's own trigger — the user's rule is a DISTANCE ("when they get
  // within 2 meters of a live target"), so it must not depend on what the
  // hive told the form to do. Ties break on id, matching floodExec's
  // point-blank scan, so the choice is replay-stable.
  _preyWithin(a, pn, range) {
    let best = null, bestD = Infinity;
    for (const h of this._occ[pn]) {
      if (h.dead || h.hp <= 0 || h.downed) continue;
      if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
      const d = Math.hypot(h.x - a.x, h.y - a.y);
      if (d > range) continue;
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && h.id < (best?.id ?? Infinity))) { bestD = d; best = h; }
    }
    return best;
  }

  // REAL SPACE COMBAT (user note): an enemy is engaged where it physically
  // IS, the moment both bodies share an open space — inside a room that's
  // immediate (rooms are convex; nothing blocks the sightline), not when a
  // pathfinding "move" happens to complete at the room's center. A combat
  // form abandons its track and runs straight AT its victim's live position;
  // an infection form closes the last meters the same way — order or no order.
  // combat.js gates claws/grabs on these same real distances.
  _spatialSteer(a, dt) {
    const P = this.P;
    if (a.isPlayer || a.state === STATE.GRABBING || a.state === STATE.AMBUSHING) return false;
    if (a.transformingUntil !== undefined) return false; // mid-thrash: rooted, no hunting
    if (!this._physAnchored(a)) return false; // inside ducting/a cross-deck crawl
    const pn = a.pnode ?? a.node;
    let target = null, stopAt = 0, mps = 0;
    if (a.faction === FACTION.COMBAT) {
      if (a.downed || a.hp <= 0 || a.dragging !== -1) return false;
      const k = a.task?.kind;
      const shotAt = this.tickCount - (a.lastHurtTick ?? -999) < 45;
      // Rooted forms stay rooted. Scripted bait keeps its role until somebody
      // actually hits it; incoming fire promotes every other posture to the
      // same surge decision below.
      if (k === TASK.TRANSFORM
        || (k === TASK.DART && a.task.stage === 1)
        || (!shotAt && (k === TASK.DECOY || k === TASK.BAIT || k === TASK.DART))) return false;

      const source = shotAt ? this.byId.get(a.lastHurtBy) : null;
      const locked = this.hive.lockedCombatTarget(a);
      const retreating = this.hive.isRetreating(a);
      if (retreating) {
        const prey = this.hive.retreatPrey(a);
        if (prey) {
          // why: a safe civilian in the room is a live conversion opportunity,
          // not scenery a fleeing appendage should cross several rooms to find
          // again. Drop the stale hurt stimulus so the new target remains a
          // committed local attack instead of immediately re-triggering retreat.
          this.hive.assign(a, { kind: TASK.ATTACK, node: pn, targetId: prey.id,
            opportunistic: true });
          a.lastHurtBy = undefined;
          a.lastHurtTick = -999;
          a.state = STATE.MOVE;
          return false;
        }
      }
      if (k === TASK.DART && a.task.stage === 0 && shotAt && a.task.back !== undefined) {
        // A bait runner that draws a round turns immediately; letting the
        // current outbound leg finish made the trap look like another attack
        // and left the staged pack exposed one body at a time.
        a.task.stage = 1;
        if (a.move) this._interruptMove(a);
        const back = a.task.back;
        if (a.node !== back) {
          const path = this.graph.path(a.node, back, ['std'], (link) => !link.locked);
          if (path) this.setPath(a, path);
        }
        this._setCharging(a, false);
        a.state = STATE.MOVE;
        return false;
      }
      // A long-lived hive assignment prevents room-wide target oscillation,
      // but it cannot make a form ignore a body already inside lunge range.
      // Keep the strategic lock intact and temporarily steer through the
      // immediate threat; once contact breaks, the form resumes its assignment.
      const immediate = this.hive.immediateCombatTarget(a, P.combat.lungeRiskM);
      const provoker = source && !source.dead && source.hp > 0 ? source : null;
      let best = immediate ?? provoker ?? locked ?? this.hive.nearestCombatTarget(a);
      // A landed round reveals its source for the short aggression window even
      // if the shooter has just side-stepped behind the edge of the opening.
      // The shared task carries that revelation to packmates following behind.
      if (retreating) {
        // why: the round that causes the retreat still gets one clean walking
        // tick; only continued fire after the decision turns the withdrawal
        // into a full-speed run.
        if (shotAt && a.retreatStartedTick !== this.tickCount) this._setRetreatSprint(a, true);
        // Keep a clean escape uninterrupted, but never preserve one whose
        // physical approach has become a run past a visible shooter. Re-plan
        // from the body's live position; no other clean first leg means it is
        // cornered and the hive flips it to a forced attack.
        const committed = a.move && (a.move.hidden
          || (a.move.appT !== undefined && a.move.t >= a.move.appT)
          || (a.move.appT === undefined && a.node !== a.move.from));
        const step = committed ? null : a.move
          ? { to: a.move.to, link: a.move.link }
          : a.path[0];
        if (best && step && !this.hive.retreatApproachSafe(a, step)) {
          this.hive.retreatOrFight(a, best.pnode ?? best.node, true, best.id);
          return false;
        }
        if (!shotAt) return false;
      }
      if (!best) {
        a.chargeTargetId = -1;
        if (a.state === STATE.FIGHT) { a.state = STATE.IDLE; this._setCharging(a, false); }
        return false;
      }

      if (provoker) {
        // A real hit is a new shared stimulus even when this appendage already
        // owns a target. Reassess once for the whole pack: losing odds preserve
        // or begin a retreat; viable odds promote the pack to a surge. The
        // wounded form pursues the shooter for the short hurt window without
        // replacing its sticky strategic target, so reaction cannot become
        // target oscillation when the gunfire stops.
        if (!this.hive.respondToCombat(a, provoker, true)) return false;
      } else if (!locked) {
        if (!this.hive.respondToCombat(a, best, !!a.task?.surge)) return false;
        best = this.hive.lockedCombatTarget(a);
      }
      if (!best || best.dead || best.hp <= 0) return false;
      const bestD = this.agentDistance(a, best);
      const targetNode = best.pnode ?? best.node;
      if (targetNode !== pn) {
        // Direct contact invalidates a queued strategic destination. Re-anchor
        // at the room the body physically occupies before plotting the chase;
        // otherwise it finishes walking to an obsolete parking slot while the
        // marine it can see keeps shooting it.
        // Preserve a leg that already leads to this same target. Cancelling it
        // unconditionally recreated the identical doorway move every tick,
        // pinning its progress at zero forever while the form appeared to run
        // in place under fire.
        const moveGoal = a.move ? (a.path.at(-1)?.to ?? a.move.to) : -1;
        if (a.move && moveGoal === targetNode) {
          this._setCharging(a, true);
          a.state = STATE.MOVE;
          return false;
        }
        if (a.move) this._interruptMove(a);
        // Graph pathing only answers how to reach a body already selected by
        // LOS. Locked doors remain breakable; infection-only vents do not.
        if (this.setPathTo(a, targetNode, ['std'], (l) => !l.locked)
          || this.setPathTo(a, targetNode, ['std'], (l) => l.kind === 'std' && !l.armorySeal)) {
          this._setCharging(a, true);
          a.state = STATE.MOVE;
        }
        return false;
      }
      target = best;
      a.chargeTargetId = best.id;
      stopAt = P.combat.meleeRangeM * 0.6;
      this._setCharging(a, bestD > P.combat.meleeRangeM); // the whole approach is a sprint (lore)
      // a leap crosses ~56% faster than a flat charge — the arc was +20% and
      // the user asked for another 30% on top: a committed pounce, not a glide
      // persists from the prior tick's arc block
      mps = P.movement.baseMps * this._speedMult(a) * (a.charging ? P.speed.chargeMult : 1) * (a.leaping ? 1.56 : 1);
      a.state = STATE.FIGHT;
    } else if (a.faction === FACTION.INFECTION) {
      if (a.hp <= 0) return false;
      let t = a.task?.kind === TASK.GRAB ? this.byId.get(a.task.targetId) : null;
      if (t && (t.dead || t.hp <= 0 || t.deck !== a.deck || (t.pnode ?? t.node) !== pn)) t = null;
      // WITHIN 2 METRES OF A LIVE TARGET IS THE WHOLE RULE (user), not "within
      // 2 metres AND the hive happened to hand this pod a grab order". Gating
      // the pounce on TASK.GRAB made it fire exactly as often as the hive
      // issued grabs, which is a seed lottery: over 20-minute headless runs
      // charon-2/charon-3 issue 34/39 grabs and pounce 27/20 times, while
      // charon-1 and charon-4 issue ZERO and never pounced once. The pod's
      // spatial engagement now matches the combat form's above, which has
      // always been task-independent for the same reason — a form that
      // physically shares a space with prey engages it. Measured with a live
      // target walking the ship: pods passed inside 2 m of it on a MOVE or
      // SCOUT errand and skittered straight by, 30 ticks on charon-1 alone.
      // A form already burrowing into a body is COMMITTED and never
      // re-targeted (the same exclusion floodExec's point-blank lunge makes).
      if (!t && a.task?.kind !== TASK.CONVERT && a.task?.kind !== TASK.REANIMATE) {
        // ...and once airborne, ANY live body in the room keeps it flying: the
        // arc re-derives nothing from a target (landing spot, facing, apex and
        // budget were all frozen at launch), so losing the one it launched at
        // must not drop it out of the air half way through the hop.
        t = this._preyWithin(a, pn, a.leaping ? Infinity : P.combat.pounce.rangeM);
      }
      if (!t) return false;
      // a pod already IN THE AIR flies its whole committed hop: bailing out
      // here the moment it crossed the grab gate dropped it after ~0.6 m of a
      // 2 m arc. floodExec's latch waits for it to land (matching !a.leaping
      // gate there), so the pounce still ends in a grab, one tick later.
      if (!a.leaping && Math.hypot(t.x - a.x, t.y - a.y) <= P.combat.grabRangeM) return false; // latched — floodExec runs the grab
      target = t;
      stopAt = P.combat.grabRangeM * 0.6;
      mps = P.movement.baseMps * this._speedMult(a) * P.speed.infectionLunge
        * (a.leaping ? P.speed.infectionPounce : 1); // skittering lunge, then the committed hop
      this._setCharging(a, true);
    } else return false;

    // engaged: the track is abandoned — the fight is HERE, in this room
    a.move = null;
    if (a.path.length) a.path = [];
    const room = this.graph.node(pn);
    if (a.node !== pn) { a.node = pn; a.deck = room.deck; }

    // LEAP decision — BEFORE the advance, so a leap COMMITS to a fixed landing
    // point and flies a ballistic arc to it (user: you can side-step and dodge
    // it) instead of curving through the air to track your live position.
    //
    // TWO rules commit an arc, and they are opposite shapes. Neither is a
    // special case of the other, so they are decided separately:
    //   canLeap   — a CHARGING COMBAT form crossing a LONG gap in a TALL hold.
    //   canPounce — an INFECTION form that has gotten within 2 m of a LIVE
    //               target (user: "when they get within 2 meters of a live
    //               target the infection forms should leap through the air at
    //               him in an arc, locking the arc into the place they were
    //               standing"). Short, low and fast; deliberately NOT gated on
    //               headroom — see combat.pounce.clearM for why.
    // PEAK_FRAC was 0.25 — the user asked the open-area combat-form arc down
    // "by like 20%": a flatter, faster-reading lunge, same committed shape
    const LEAP_MIN = 5, PEAK_FRAC = 0.20;
    const C = P.combat;
    const clearH = clearHeightOf(room);
    const steer = this._stairSteerTarget(a, room, target.x, target.y);
    const canLeap = !steer.detouring && a.faction === FACTION.COMBAT && a.charging && clearH > CLEAR_H + 0.5
      && this.t >= a.nextCombatLeapAt;
    // LIVE, which is the user's own word and the thing that matters here: a
    // form heading for a BODY is on TASK.CONVERT/REANIMATE and never reaches
    // this branch, but a GRAB target can die under it mid-approach — pouncing
    // the husk would sail it clean over the corpse it came to burrow into.
    const canPounce = !steer.detouring && a.faction === FACTION.INFECTION
      && !target.dead && target.hp > 0 && !target.downed && target.faction !== FACTION.CORPSE;
    const gap = Math.hypot(target.x - a.x, target.y - a.y);
    if (!a.leaping && canLeap && gap > LEAP_MIN) {
      // ceiling cap scaled by the same 0.8 as PEAK_FRAC — in a tall hold
      // (hangar) the CAP is what governs, so without this the "-20%" did
      // nothing exactly where the user was looking (measured: max apex
      // 5.70 m before and after the PEAK_FRAC change alone; 4.56 m now)
      this._commitLeap(a, target, room, mps, Math.min(gap * PEAK_FRAC, (clearH - 2.2) * 0.8), 0.35);
    } else if (!a.leaping && canPounce && gap > C.grabRangeM && gap <= C.pounce.rangeM) {
      // apex CLAMPED under the ceiling instead of the hop being gated on it
      this._commitLeap(a, target, room, mps, Math.min(C.pounce.peakM, clearH - C.pounce.clearM), C.pounce.landM);
    } else if (a.leaping && !canLeap && !canPounce) {
      this._endLeap(a);
    }

    // aim at the committed landing spot while airborne, else the live target
    const aimX = a.leaping ? a.leapTX : steer.x;
    const aimY = a.leaping ? a.leapTY : steer.y;
    // Standoff applies to prey, never to an intermediate corner. Stopping a
    // melee radius short of the corner leaves the wall between hunter and prey.
    const hold = a.leaping || steer.detouring ? 0 : stopAt;
    const dx = aimX - a.x, dy = aimY - a.y;
    const dist = Math.hypot(dx, dy);
    a.heading = a.leaping ? a.leapHeading : Math.atan2(dy, dx);
    if (dist > hold) {
      const step = Math.min(dist - hold, mps * dt);
      a.x += (dx / dist) * step;
      a.y += (dy / dist) * step;
      this._clampToRoom(a, room); // stay inside the room's real footprint
      // real displacement with a.move null — the tracker's MOVING flag reads
      // this (review finding: a 6 m/s charge painted nothing on the tracker)
      a.steeredTick = this.tickCount;
    }

    // arc height from progress along the committed leap (0 at launch and land)
    if (a.leaping) {
      const rem = Math.hypot(a.leapTX - a.x, a.leapTY - a.y);
      const p = Math.max(0, Math.min(1, 1 - rem / Math.max(0.5, a.leapDist0)));
      a.hoverY = a.leapPeak * 4 * p * (1 - p);
      a.leapTicks--;
      // THREE WAYS DOWN, and the last two exist because the first one is a
      // DISTANCE test — which a body can be physically unable to satisfy.
      //   rem <= leapLand : the ordinary landing, right on the committed spot.
      //   no progress     : the step was eaten (a clamp, a room boundary) —
      //                     this is as close as this body will ever get, so
      //                     it is down. Without it a form hangs at its apex
      //                     with leaping=true forever, frozen out of crowd
      //                     separation, fire avoidance and the grab latch
      //                     (measured: 16,328 consecutive airborne ticks on
      //                     charon-2, and every seed with a doorway grab).
      //   budget spent    : belt and braces, so no reachable state anywhere
      //                     leaves a body in the air indefinitely.
      if (rem <= a.leapLand || rem >= a.leapRem - 1e-4 || a.leapTicks <= 0) {
        this._endLeap(a);
      } else a.leapRem = rem;
    }
    a.animTime += dt;
    return true;
  }

  // A combat form gets one long leap, then must keep charging on foot for a
  // full cooldown measured FROM touchdown. Centralizing every exit matters:
  // landing, losing a target, being interrupted and getting shot down all end
  // an arc through different branches. Infection-form pounces stay unchanged.
  _endLeap(a) {
    if (!a.leaping) return;
    a.leaping = false;
    a.leapDist0 = 0;
    a.leapTicks = 0;
    a.hoverY = 0;
    if (a.faction === FACTION.COMBAT) {
      a.nextCombatLeapAt = this.t + this.P.combat.combatForm.leapCooldownSec;
    }
  }

  // COMMIT AN ARC. The user has asked twice for this shape ("their body
  // direction and location are both locked until they land"), so EVERY term
  // of the flight is frozen here at launch — landing spot, facing, apex, and
  // the tolerance that counts as landed. Nothing downstream re-derives any of
  // them from the target's live position, which is what lets you side-step a
  // leap; and freezing the apex means a body that crosses into a room with a
  // different ceiling mid-flight doesn't jump height in the air.
  _commitLeap(a, target, room, mps, peak, land) {
    // LAND WHERE THIS BODY IS ALLOWED TO BE. The spot used to be the target's
    // raw position, and "landed" is a distance test against it — but every
    // tick of the flight is clamped to the room inset by the body radius
    // (_clampToRoom), while _pnodeOf still calls a body "in this room" up to
    // 0.4 m OUTSIDE the rect. A player backed into a doorway — exactly what
    // you do when a pod charges — or an NPC interpolating onto a shared
    // wall's door therefore sat up to r + 0.4 m outside the pod's reachable
    // set, so `rem` bottomed out above leapLand and the form never came down.
    // Clamping here also keeps the latch honest: the worst-case gap left at
    // touchdown is r + 0.4 m, well inside grabRangeM.
    const r = this._bodyRadius(a);
    const hw = Math.max(0, room.w / 2 - r), hd = Math.max(0, room.d / 2 - r);
    a.leapTX = Math.max(room.x - hw, Math.min(room.x + hw, target.x));
    a.leapTY = Math.max(room.y - hd, Math.min(room.y + hd, target.y));
    a.leaping = true;
    // measured to the spot it will REACH, not to the target: the arc height is
    // progress along leapDist0, so scaling it by an unreachable gap would put
    // the body down while it was still climbing.
    const dx = a.leapTX - a.x, dy = a.leapTY - a.y;
    a.leapDist0 = Math.hypot(dx, dy);
    a.leapRem = a.leapDist0;
    a.leapHeading = Math.atan2(dy, dx);
    a.leapPeak = Math.max(0, peak);
    a.leapLand = land;
    // Flight budget, in ticks. Sized off the LAUNCH speed, which is the slow
    // one — both arcs accelerate once airborne (speed.infectionPounce, and
    // the combat leap's 1.56x) — so it cannot clip an arc still making
    // progress, while still bounding the flight absolutely.
    a.leapTicks = Math.ceil(a.leapDist0 / Math.max(0.02, mps * this.dt)) + 6;
  }

  // PERSONAL SPACE (user rule): every body is SOLID — two agents can never
  // occupy the same patch of deck. A soft separation pass each tick pushes
  // apart any pair sharing a room that sit closer than their summed body
  // radii. Movers mid-link are excluded (formation lanes + pace jitter
  // already stagger them, and their position is re-derived from the link
  // next tick anyway); a latched grabber and its pinned victim stay put;
  // the player's body is game-driven, so it never gets shoved — everyone
  // else steps around it.
  _bodyRadius(a) {
    switch (a.faction) {
      case FACTION.CARRIER: return 0.75;
      case FACTION.COMBAT: return 0.48;
      case FACTION.INFECTION: return 0.32;
      default: return 0.4;
    }
  }

  // a form seated ON a body to burrow (CONVERT) or raise it (REANIMATE) is
  // clamped to the body by floodExec — the separation pass must leave it there
  // (else it drifts off the corpse it's rising from).
  _rootingBody(a) {
    // a transforming body thrashes where it lies — the crowd flows around it
    if (a.transformingUntil !== undefined) return true;
    return (a.task?.kind === TASK.CONVERT || a.task?.kind === TASK.REANIMATE)
      && !a.move && a.path.length === 0;
  }

  // clamp a body so its whole RADIUS stays inside the room's walls (user
  // report: NPCs clipping through hallway walls when crowded — the old fixed
  // 0.3 m margin was smaller than a body radius, so a shoved body poked
  // through). In a corridor thinner than a body, at least pin to centerline.
  _clampToRoom(a, room) {
    const r = this._bodyRadius(a);
    const hw = Math.max(0, room.w / 2 - r), hd = Math.max(0, room.d / 2 - r);
    a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x));
    a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y));
    // ...and out of the stair well/tower footprint (user: bodies parked over
    // the open hole / inside the enclosed stair tower — the render slid them
    // out visually while the sim swore they stood in the void, and any move
    // that started there began with a plunge). A body legitimately WALKING
    // the switchback is the one exception.
    if (a.move?.link?.type !== 'stairwell') {
      const [wx, wy] = this._slideOutOfWell(room, a.x, a.y);
      a.x = wx; a.y = wy;
    }
  }

  // The well/tower footprint to keep SIM positions out of, in node nd's own
  // frame: the open well cut into the stairwell room, and the enclosed stair
  // tower standing on the same spot on the deck below. null elsewhere.
  _stairAvoid(nd) {
    const cache = (this._stairAvoidCache ??= new Map());
    if (cache.has(nd.idx)) return cache.get(nd.idx);
    let out = null;
    for (const s of this.graph.stairwells) {
      if (nd.idx !== s.upper && nd.idx !== s.lower) continue;
      const U = this.graph.node(s.upper);
      const wp = this._stairWaypoints(U);
      const shift = this._bandC(nd.deck) - this._bandC(U.deck);
      out = { x: wp.wellX, y: wp.wellY + shift, hx: wp.wellHx, hy: wp.wellHz };
    }
    cache.set(nd.idx, out);
    return out;
  }

  // Same-room attacks and corpse approaches bypass graph paths. If the live
  // target is across the stair opening, steer around its edge before charging
  // again; otherwise _clampToRoom slides the form back into the wall forever.
  _stairSteerTarget(a, room, tx, ty) {
    const w = this._stairAvoid(room);
    if (!w) return { x: tx, y: ty, detouring: false };
    const margin = this._bodyRadius(a) + 0.25;
    const pts = this._detourAroundRect(a.x, a.y, tx, ty, w.x, w.y, w.hx, w.hy, margin);
    const next = pts.find((p) => Math.hypot(p.x - a.x, p.y - a.y) > 0.12);
    return next ? { ...next, detouring: true } : { x: tx, y: ty, detouring: false };
  }

  // slide a point out of the room's stair well/tower rect through the
  // nearest face (the same rule the render's clamps use), or return it as-is
  _slideOutOfWell(nd, x, y, m = 0.5) {
    const w = this._stairAvoid(nd);
    if (!w || Math.abs(x - w.x) > w.hx + m - 1e-9 || Math.abs(y - w.y) > w.hy + m - 1e-9) return [x, y];
    const dW = x - (w.x - w.hx), dE = (w.x + w.hx) - x, dN = y - (w.y - w.hy), dS = (w.y + w.hy) - y;
    const min = Math.min(dW, dE, dN, dS);
    if (min === dN) return [x, w.y - w.hy - m];
    if (min === dS) return [x, w.y + w.hy + m];
    if (min === dW) return [w.x - w.hx - m, y];
    return [w.x + w.hx + m, y];
  }

  _separate(dt) {
    const relax = Math.min(1, dt * 10);
    for (let n = 0; n < this.graph.n; n++) {
      const occ = this._occ[n];
      if (!occ || occ.length < 2) continue;
      const room = this.graph.node(n);
      // thin corridors can't absorb a sideways pile-up, so bias the push
      // ALONG the room's long axis when it's much longer than it is wide —
      // crowds spread down the hallway instead of squeezing into the walls
      const along = room.w >= room.d ? 0 : 1; // 0 = x is the long axis
      const narrow = Math.min(room.w, room.d) < 6;
      // HOIST (perf pass 4): eligibility, body radius and the mobility flag
      // were re-evaluated per PAIR — O(k²) redundant predicate work in a
      // packed fight room. All three read ONLY fields the pair loop never
      // writes (it mutates x/y alone; held/leaping/move/task are written
      // earlier in the tick), so filtering once per occupant — preserving
      // _occ order — processes the identical pairs in the identical order
      // with identical pushes. Do NOT sort, bucket, or spatially prune:
      // push order is behavior.
      const E = this._sepE ??= [];
      const R = this._sepR ??= [];
      const M = this._sepM ??= [];
      let k = 0;
      for (let i = 0; i < occ.length; i++) {
        const a = occ[i];
        if (a.dead || a.faction === FACTION.CORPSE || a.downed || a.move || this._rootingBody(a)) continue;
        E[k] = a;
        R[k] = this._bodyRadius(a);
        // staged/ambushing forms are immovable stone: the crowd flows around
        // them (they still PUSH, so bodies don't overlap them)
        M[k] = !a.isPlayer && a.held !== this.tickCount && !a.leaping && !this._holdsDeadStill(a);
        k++;
      }
      for (let i = 0; i < k; i++) {
        const a = E[i];
        for (let j = i + 1; j < k; j++) {
          const b = E[j];
          // Combat forms are broad, irregular bodies and read as a single
          // stacked model when their base capsules merely touch. Give only
          // combat-form PAIRS a little more crowd space; keeping _bodyRadius
          // unchanged preserves doorway, wall, player and attack collision.
          const crowdScale = a.faction === FACTION.COMBAT && b.faction === FACTION.COMBAT
            ? this.P.combat.combatForm.crowdRadiusScale
            : 1;
          const need = (R[i] + R[j]) * crowdScale;
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= need * need) continue;
          const dist = Math.sqrt(d2);
          if (dist < 1e-6) { // exactly stacked: split along a deterministic axis
            const ang = ((a.id * 31 + b.id * 17) % 628) / 100;
            dx = Math.cos(ang); dy = Math.sin(ang);
          } else { dx /= dist; dy /= dist; }
          // in a narrow hallway, redirect a mostly-sideways shove into a
          // fore/aft one so nobody is driven into the bulkhead
          if (narrow) {
            if (along === 0 && Math.abs(dx) < 0.5) { dx = dx < 0 ? -1 : 1; dy = 0; }
            else if (along === 1 && Math.abs(dy) < 0.5) { dy = dy < 0 ? -1 : 1; dx = 0; }
          }
          // an airborne body is ballistic — crowd pressure must not shove it
          // off its committed line (user: locked location until it lands)
          const aMoves = M[i], bMoves = M[j];
          if (!aMoves && !bMoves) continue;
          const push = (need - dist) * relax * (aMoves && bMoves ? 0.5 : 1);
          if (aMoves) { a.x -= dx * push; a.y -= dy * push; this._clampToRoom(a, room); }
          if (bMoves) { b.x += dx * push; b.y += dy * push; this._clampToRoom(b, room); }
        }
      }
      E.length = 0; // don't retain agent refs past the pass
    }
    // a latched grabber may have been shouldered aside — pull it back onto
    // its victim so the burrow never breaks from crowd pressure (two forms
    // fighting over one body now ring the body instead of stacking in it)
    for (const a of this.agents) {
      if (a.dead || a.state !== STATE.GRABBING || a.task?.kind !== TASK.GRAB) continue;
      const v = this.byId.get(a.task.targetId);
      if (!v || v.dead) continue;
      const d = Math.hypot(a.x - v.x, a.y - v.y);
      const max = this.P.combat.grabRangeM * 0.9;
      if (d > max && d > 1e-6) {
        const k = max / d;
        a.x = v.x + (a.x - v.x) * k;
        a.y = v.y + (a.y - v.y) * k;
      }
    }
  }

  // FLOOD DARKNESS (user rule): a room held by the flood ALONE accumulates
  // hold time — 60 s kills the lights (overgrown fixtures), 120 s fills it
  // with spore fog. Contested rooms hold their clock; rooms with no flood
  // recover at double speed (the crew's systems fight back). Deterministic:
  // a pure function of occupancy.
  _advanceDarkness(dt) {
    const D = this.P.darkness;
    // FOG PERSISTENCE (user rule): spore fog does NOT fade under the old
    // 2x-recovery rule — once a room fogs it stays fogged until the last
    // flood inside is dead AND the player or an ODST has HELD the room for
    // fogLingerSec (2 min). Any flood re-entry restarts that clock in full.
    // Only they can burn it off: line marines refuse fogged rooms anyway,
    // and a cowering civilian doesn't clear flood growth.
    const clearCrew = this._fogCrew ?? (this._fogCrew = new Uint8Array(this.graph.n));
    clearCrew.fill(0);
    for (const a of this.agents) {
      if (a.dead || a.hp <= 0 || a.downed) continue;
      if (a.isPlayer || a.odst) clearCrew[a.pnode ?? a.node] = 1;
    }
    for (let n = 0; n < this.graph.n; n++) {
      const was = this.floodHoldSec[n];
      const fogged = was >= D.fogSec;
      if (this._floodAt[n] > 0 && this._humanAt[n] === 0) {
        this.floodHoldSec[n] = Math.min(D.maxHoldSec, was + dt);
      } else if (!fogged && this._floodAt[n] === 0 && this._humanAt[n] > 0) {
        // humans holding a merely-dark room WITHOUT flood beat the growth back
        this.floodHoldSec[n] = Math.max(0, was - dt * 2);
      } // empty or contested: the growth neither spreads nor dies
      if (fogged) {
        if (this._floodAt[n] > 0) {
          this.fogLinger[n] = D.fogLingerSec; // flood inside — the clock restarts
        } else if (clearCrew[n]) {
          this.fogLinger[n] = Math.max(0, this.fogLinger[n] - dt);
          if (this.fogLinger[n] === 0) {
            this.floodHoldSec[n] = D.fogSec - 0.01; // fog lifts; the dark remains
            this.log('radio', `the spore fog finally thins out in ${this.graph.node(n).name}`, n);
          }
        }
      } else this.fogLinger[n] = D.fogLingerSec; // primed for the next bloom
      const now = this.floodHoldSec[n];
      if (was < D.soloDarkSec && now >= D.soloDarkSec) {
        this.log('hive', `the lights die in ${this.graph.node(n).name} — the growth has taken the room`, n);
      } else if (was < D.fogSec && now >= D.fogSec) {
        this.log('hive', `spore fog thickens in ${this.graph.node(n).name}`, n);
      } else if (was >= D.soloDarkSec && now < D.soloDarkSec) {
        this.log('radio', `power flickers back on in ${this.graph.node(n).name}`, n);
      }
    }
  }

  darkAt(node) { return this.floodHoldSec[node] >= this.P.darkness.soloDarkSec; }
  fogAt(node) { return this.floodHoldSec[node] >= this.P.darkness.fogSec; }

  // GRENADES (game layer): a radial blast at a real point. Damage falls off
  // toward the edge, walls contain the burst (same physical room only), the
  // ship hears it, and corpses caught in it are shredded out of the hive's
  // economy. `by` feeds the hit-feedback/retargeting path.
  explodeAt(deck, x, y, radius, dmg, by = -1) {
    let node = -1;
    for (const n of this._deckRooms[deck] ?? []) {
      if (Math.abs(x - n.x) <= n.w / 2 + 0.4 && Math.abs(y - n.y) <= n.d / 2 + 0.4) { node = n.idx; break; }
    }
    if (node === -1) return 0;
    this.gunfireAt(node);
    let hits = 0;
    for (const a of this.agents) {
      if (a.dead || a.deck !== deck) continue;
      if ((a.pnode ?? a.node) !== node) continue; // walls contain the burst
      const d = Math.hypot(a.x - x, a.y - y);
      if (d > radius) continue;
      const k = dmg * (1 - (d / radius) * 0.7);
      if (a.faction === FACTION.CORPSE) { a.damage = Math.min(100, a.damage + k); continue; }
      if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
        hurtFloodForm(this, a, k, false, by);
        hits++;
      } else if (a.hp > 0 && !a.isPlayer) {
        this.hurtHuman(a, k, by);
        hits++;
      } else if (a.isPlayer && a.hp > 0) {
        this.hurtHuman(a, k * 0.5, by); // your own frag still bites through armor
        hits++;
      }
    }
    return hits;
  }

  // ONE BODY ON THE LADDER (user rule): is this cross-deck link held by a
  // live climber other than `selfId`? Stale claims (holder died, or was
  // yanked off the move by combat) self-heal — a claim only counts while
  // the holder is genuinely in transit on this link. APPROACH DOESN'T
  // COUNT (user: the ladder "jams" with nobody visibly on it): a cross-deck
  // leg claims at leg START, but the holder may still be walking across the
  // room to the pad (move.appT marks where the approach ends) — the rungs
  // only read busy once the holder is at the pad about to mount, or on them.
  vertBusy(link, selfId = -1) {
    const id = link.occupiedBy;
    if (id === undefined || id === selfId) return false;
    const h = this.byId.get(id);
    if (!h || h.dead) return false;
    if (h.isPlayer) return h.climbingLink === link;
    if (!h.move || h.move.link !== link) return false;
    return h.move.appT === undefined || h.move.t >= h.move.appT * 0.85;
  }

  // next-in-line reservation (player queueing): while the reserver lives,
  // NPCs yield the next slot on this ladder. Self-heals if they die.
  vertReserved(link, selfId = -1) {
    const id = link.reservedBy;
    if (id === undefined || id === selfId) return false;
    const h = this.byId.get(id);
    return !!(h && !h.dead);
  }

  // Parked agents each claim their OWN patch of floor (user note: no stacked
  // dots): a golden-angle spiral slot ranked by id among the room's living
  // occupants gives ~0.7 m spacing, clamped to the room's real footprint.
  // A form lying in wait is STONE (user tactic: the pack by the door must be
  // invisible to a motion tracker, and a body that shuffles isn't still).
  // Sprung/retasked forms move again the moment their task changes.
  _holdsDeadStill(a) {
    if (a.state === STATE.AMBUSHING) return true;
    if (a.transformingUntil !== undefined) return true; // thrashing where the body lies
    return a.task?.kind === TASK.GUARD && a.task.muster !== undefined
      && a.node === a.task.node && !a.move;
  }

  _parkDrift(a, dt) {
    if (this._holdsDeadStill(a)) { a.followSpeed = 0; return; }
    const nd = this.graph.node(a.node);
    const [tx, ty] = this._parkSlot(a, nd);
    const dx = tx - a.x, dy = ty - a.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      // HUMAN SPEEDS (user: marines "flying" across big holds to reposition
      // after a fight): the old proportional pull moved 20% of the REMAINING
      // distance per tick — ~90 m/s across a hangar. Ease in near the slot,
      // but never cover ground faster than a brisk jog.
      const step = Math.min(d * Math.min(1, dt * 3), 3.6 * dt);
      a.x += (dx / d) * step;
      a.y += (dy / d) * step;
      a.followSpeed = step / dt; // render picks walk/jog clip from real speed
      // a body covering real ground FACES where it is going (user: NPCs
      // sliding sideways/backwards to their slot while looking elsewhere)
      if (d > 0.3) a.heading = Math.atan2(dy, dx);
    } else a.followSpeed = 0;
    a.animTime += this._gaitDt(a, dt, a.followSpeed);
  }

  // GAIT-NORMALIZED TIME (user: bodies floating/skating across the floor):
  // the render's leg cycle runs at a fixed rate per clip, covering 1.40 m/s
  // in a walk and 2.11 m/s in a run (agents3d LEG_AMP). A human moving at any
  // other speed advances its cycle proportionally, so the feet always cover
  // the ground the body actually travels. Standing bodies breathe in real
  // time. Humans only: flood rigs read fine at their tuned rates (pods
  // writhe on a clock, and a charge is deliberately more lunge than stride).
  _gaitDt(a, dt, v, run = v > 3.2) { // default split matches _clipFor's followSpeed branch
    if (a.faction !== FACTION.CIVILIAN && a.faction !== FACTION.ARMED && a.faction !== FACTION.MARINE) return dt;
    if (v <= 0.4) return dt;
    const matched = run ? 2.11 : 1.40;
    return dt * Math.min(2.6, Math.max(0.75, v / matched));
  }

  // STABLE SLOTS (user note: jerky movement): each body's parking spot is
  // a pure hash of its OWN id — ranking against the room's other occupants
  // meant every arrival/death/departure reshuffled the whole room's
  // targets and everyone drifted to new points mid-fight. Collisions are
  // _separate's job. Move legs LAND here too, so arrivals never converge
  // on the room's center point.
  _parkSlot(a, nd) {
    if (a.task?.kind === TASK.GUARD && a.task.protect !== undefined
      && a.task.threatNode !== undefined && a.task.threatNode >= 0) {
      const path = this.graph.path(nd.idx, a.task.threatNode, ['std'], (link) => !link.locked);
      const step = path?.[0];
      if (step) {
        const link = step.link;
        const mouth = link.door ?? (link.a === nd.idx ? link.padA : link.padB);
        if (mouth) {
          let ix = nd.x - mouth.x, iy = nd.y - mouth.y;
          const length = Math.hypot(ix, iy) || 1;
          ix /= length; iy /= length;
          const hash = ((a.id * 2654435761) >>> 0) / 4294967296;
          const depth = 1.35 + (a.id % 3) * 0.55;
          const lateral = (hash - 0.5)
            * Math.min(4, Math.max(1.4, Math.min(nd.w, nd.d) * 0.45));
          const radius = this._bodyRadius(a);
          const hw = Math.max(0, nd.w / 2 - radius), hd = Math.max(0, nd.d / 2 - radius);
          const x = mouth.x + ix * depth - iy * lateral;
          const y = mouth.y + iy * depth + ix * lateral;
          return [Math.max(nd.x - hw, Math.min(nd.x + hw, x)),
            Math.max(nd.y - hd, Math.min(nd.y + hd, y))];
        }
      }
    }
    const h1 = ((a.id * 2654435761) >>> 0) / 4294967296;
    const h2 = (((a.id + 7907) * 1597334677) >>> 0) / 4294967296;
    const hw = Math.max(0.7, nd.w / 2 - 1.0), hd = Math.max(0.7, nd.d / 2 - 1.0);
    const ang = h1 * Math.PI * 2 + nd.idx * 0.7;
    const u = Math.sqrt(h2);
    // full-footprint spread — a 6m cap clustered every big room's slots at
    // its center, so arrivals converged there and the separation pass then
    // shoved them apart (user report: marines "zipping to the middle of the
    // room then randomly deploying outward")
    // ...kept OFF the stair well/tower footprint: a slot over the open hole
    // parked a body in the void and started every stairwell leg with a spine
    // crossing (the stair-check's floor-height watchdog caught it)
    return this._slideOutOfWell(nd,
      nd.x + Math.cos(ang) * u * hw, nd.y + Math.sin(ang) * u * hd, 0.8);
  }

  // A pod already committed to a body emerges toward that body. The grate is
  // still a real waypoint; only the arbitrary post-exit parking detour goes.
  _moveArrivalPoint(a, nd) {
    if (a.faction === FACTION.INFECTION && this._committedInfectNode(a) === nd.idx) {
      const t = a.task;
      const id = t.kind === TASK.CONVERT || t.kind === TASK.DRAG ? t.corpseId : t.targetId;
      const target = this.byId.get(id);
      if (target && !target.dead) return [target.x, target.y];
    }
    return this._parkSlot(a, nd);
  }

  // GRAND STAIRWELL WELL (user: flood get stuck on the staircase walls). The
  // switchback well the 3D renderer cuts into the stairwell room, expressed in
  // this room's own sim coords — MUST mirror world.js _stairGeom so the walked
  // path lands on the visible treads (world X == sim X; the renderer drops the
  // feet with groundHeightAt as the body crosses the well). Returns the three
  // waypoints of the dog-leg: top of the upper flight, the mid landing, and the
  // foot of the lower flight.
  // The deck band's centre line — the offset between a room's sim y and the
  // shared world frame (world z = sim y - bandC(deck)). MUST equal
  // world.bandCenter: the stair traversal converts waypoints between decks
  // with it, and the renderer maps them back.
  _bandC(deck) {
    const b = this.graph.deckBands[deck - 1];
    return (b.y0 + b.y1) / 2;
  }

  _stairWaypoints(U) {
    // shared/geometry.js stairWellDims is the ONE source for the well rect —
    // the renderer's _stairGeom reads the same numbers, so the walked path
    // lands on the visible treads by construction (world X == sim X)
    const { ox, wellHx, wellHz, landD } = stairWellDims(U.w / 2, U.d / 2);
    const wx = U.x + ox, wy = U.y;
    return {
      // the mouths sit near the FRONT edge of each flight (0.92, was 0.82):
      // the closer to the edge, the smaller the floor step when the deck
      // label flips there — the traversal is height-continuous at both ends
      top: { x: wx - wellHx * 0.45, y: wy - wellHz * 0.92 },   // upper flight, front-left
      mid: { x: wx, y: wy + wellHz - landD / 2 },              // centre of the FLAT landing
      foot: { x: wx + wellHx * 0.45, y: wy - wellHz * 0.92 },  // lower flight, front-right
      wellX: wx, wellY: wy, wellHx, wellHz,                    // the well rect (for LOS)
    };
  }

  // COMMITTED INFECTION target (user rule): the physical node of the body a
  // form has committed to infect — a corpse it will burrow (CONVERT/DRAG), a
  // downed form it will raise (REANIMATE), or a live host it will latch
  // (GRAB) — or -1 if the form isn't on such an errand. Used to wave a
  // committed form through the doorway balk + pod muster so it can never be
  // turned back at the threshold of the room its target stands in.
  _committedInfectNode(a) {
    const t = a.task;
    if (!t) return -1;
    let id;
    if (t.kind === TASK.CONVERT || t.kind === TASK.DRAG) id = t.corpseId;
    else if (t.kind === TASK.GRAB || t.kind === TASK.REANIMATE) id = t.targetId;
    else return -1;
    const b = this.byId.get(id);
    if (!b || b.dead) return -1;
    return b.pnode ?? b.node;
  }

  // FIRE IS REAL (user rule): standing in a fire hurts — humans and flood
  // alike, the player included. Flame damage counts as fire for the flood
  // economy (burned husks don't convert).
  _fireDamage(dt) {
    const F = this.P.fire;
    for (const f of this.fires) {
      if (f.expiresAt !== undefined && f.expiresAt <= this.t) continue;
      for (const a of this.agents) {
        if (a.dead || a.deck !== f.deck) continue;
        const dx = a.x - f.x, dy = a.y - f.y;
        const r = F.radiusM * f.scale;
        if (dx * dx + dy * dy > r * r) continue;
        if (a.faction === FACTION.CORPSE) {
          // a body in the flames chars — and a charred husk converts to nothing
          if (a.damage < 100) {
            a.damage = Math.min(100, a.damage + F.dps * dt * 2);
            if (a.damage >= 100) this.stats.corpsesBurned++;
          }
        } else if (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER) {
          hurtFloodForm(this, a, F.dps * dt, true);
        } else if (a.hp > 0) {
          this.hurtHuman(a, F.dps * dt);
        }
      }
    }
  }

  // ...and every NPC gives it a wide berth: a steady push out of the hot
  // zone that overrides parking and steering (movers passing near the
  // breach blaze take their lumps from _fireDamage instead)
  _fireAvoid(dt) {
    const F = this.P.fire;
    for (const f of this.fires) {
      if (f.expiresAt !== undefined && f.expiresAt <= this.t) continue;
      const R = F.radiusM * f.scale + 1.0;
      for (const a of this.agents) {
        if (a.dead || a.isPlayer || a.deck !== f.deck || a.faction === FACTION.CORPSE) continue;
        if (a.held === this.tickCount) continue; // a frantic host isn't steering anything
        if (a.leaping) continue;                 // mid-pounce: committed, no steering
        // A BODY ON A MOVE LEG IS AUTHORED BY THE LEG (same rule _separate
        // already follows). Its x/y are recomputed from the leg every tick, so
        // a push here is discarded next tick anyway — but the clamp below uses
        // `pnode`, which is only refreshed at the TOP of the tick. On the tick
        // a mover changes deck (stairwell handover, ladder, lift) pnode still
        // names the room it LEFT, on the other deck, and clamping a deck-5
        // position into a deck-4 rect threw the body a whole deck band across
        // the map for one frame — the stairwell "teleport" (user report).
        if (a.move) continue;
        const dx = a.x - f.x, dy = a.y - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (R - d) * Math.min(1, dt * 6);
        const room = this.graph.node(a.pnode ?? a.node);
        const hw = Math.max(0.4, room.w / 2 - 0.3), hd = Math.max(0.4, room.d / 2 - 0.3);
        a.x = Math.max(room.x - hw, Math.min(room.x + hw, a.x + (dx / d) * push));
        a.y = Math.max(room.y - hd, Math.min(room.y + hd, a.y + (dy / d) * push));
      }
    }
  }

  // NPC grenades in flight (humans.js maybeThrowFrag). Detonation is the same
  // explodeAt the player's frag calls, so damage, corpse charring and blame
  // all follow one set of rules; blastFx is drained by the renderer for the
  // light, the shake and the ragdoll re-fling.
  _grenadeTick() {
    const q = this.grenades;
    if (!q || !q.length) return;
    const G = this.P.grenade;
    for (let i = q.length - 1; i >= 0; i--) {
      if (this.t < q[i].at) continue;
      const g = q[i];
      q.splice(i, 1);
      this.explodeAt(g.deck, g.x, g.y, G.radiusM, G.damage, g.by);
      (this.blastFx ??= []).push({ deck: g.deck, x: g.x, y: g.y, r: G.radiusM });
    }
  }

  _reap() {
    let changed = false;
    for (const a of this.agents) {
      // A DEAD PLAYER STAYS ON THE ROSTER (co-op: "he died on my end but was
      // still alive on his"). Reap runs at the END of the tick the death
      // happens, before any snapshot is built — so deleting a player agent
      // here meant the encoder's `!agent.dead || agent.isPlayer` clause could
      // never see it, the id went out as a plain `removed`, and the peer's
      // removed handler deliberately skips player agents. The peer was never
      // told, so it kept playing. The retained agent is inert: writeBuffer
      // skips the dead, so it renders nothing, and the harnesses never attach
      // a player, so replay hashes are untouched.
      if (!a.dead || a.isPlayer) continue;
      changed = true;
      // a dead claimant RELEASES its claims — leaked claims left whole rooms
      // of corpses "spoken for" forever, so later forms crossed to them and
      // doubled straight back with nothing to eat (user report)
      const t = a.task;
      if (t) {
        if (t.corpseId !== undefined) {
          const b = this.byId.get(t.corpseId);
          if (b && !b.dead) b.claimed = false;
        }
        if (t.targetId !== undefined) {
          const d = this.byId.get(t.targetId);
          if (d && !d.dead && d.claimed) d.claimed = false;
        }
      }
      this.byId.delete(a.id);
    }
    if (changed) this.agents = this.agents.filter((a) => !a.dead || a.isPlayer);
  }

  _checkOutcome() {
    if (this.outcome) return;
    // A DOWNED FORM ONLY COUNTS IF IT CAN STILL GET UP. Bullets cap damage at
    // 95 (only flame crosses 100), so clearing the ship with rifles alone
    // leaves a scatter of downed forms that are never "safely dead" — and the
    // old test counted every one of them as live Flood, which made a
    // no-flamethrower run unwinnable no matter how completely you cleared it.
    // Two things can raise a downed form: its own self-revive, scheduled at
    // the moment it went down (reviveAt >= 0; -1 means the roll failed and it
    // will never rise on its own), or another form reanimating it. The clauses
    // above already return true for every active form and carrier — i.e. for
    // everything capable of reanimating anything — so by the time we reach a
    // downed form here, its self-revive schedule is the only way back.
    // (a body mid-transformation needs no special clause any more: it IS a
    // combat form agent from the instant the pod burrows in — user rule —
    // so isActiveFloodForm counts it like any other)
    let infection = 0, combat = 0, carriers = 0, reviving = 0;
    for (const a of this.agents) {
      if (a.dead) continue;
      if (a.faction === FACTION.INFECTION && isActiveFloodForm(a)) infection++;
      else if (a.faction === FACTION.COMBAT) {
        if (isActiveFloodForm(a)) combat++;
        else if (a.downed && a.damage < 100 && a.reviveAt >= 0) reviving++;
      } else if (a.faction === FACTION.CARRIER) carriers++;
    }
    const anyFlood = infection + combat + carriers + reviving > 0;
    const anyHuman = this.agents.some((a) => !a.dead && isLivingHuman(a));
    if (!anyFlood) {
      this._weakHiveSince = -1;
      if (anyHuman && this._releaseDormantVentReserve()) return;
      this.outcome = 'contained';
      this.outcomeAt = this.t; // frozen: the clock keeps running, the result does not
      this.log('end', `OUTBREAK CONTAINED at ${fmtTime(this.t)} — the ship survives`);
    } else if (!anyHuman) {
      this.outcome = 'lost';
      this.outcomeAt = this.t;
      this.log('end', `SHIP LOST at ${fmtTime(this.t)} — the Flood owns the Saturn Devouring`);
    } else if (infection > 0 && infection <= 2 && combat === 0 && carriers === 0
      && this.dormantVentReserves > 0) {
      // A lone pod can keep the outbreak technically alive while its entire
      // production line is gone. After a sustained collapse, wake one of the
      // same finite reserves used on extinction instead of leaving the ship
      // quiet for minutes. A healthy colony never reaches this branch.
      if (this._weakHiveSince < 0) this._weakHiveSince = this.t;
      if (this.t - this._weakHiveSince >= this.P.flood.weakHiveReserveDelaySec) {
        this._releaseDormantVentReserve();
        this._weakHiveSince = this.t;
      }
    } else {
      this._weakHiveSince = -1;
    }
  }

  _releaseDormantVentReserve() {
    if (this.dormantVentReserves <= 0) return false;
    const guns = this.agents.filter((agent) => !agent.dead && agent.hp > 0
      && (agent.faction === FACTION.MARINE || agent.faction === FACTION.ARMED));
    let best = null;
    let bestScore = -Infinity;
    for (const room of this.graph.nodes) {
      if (this.graph.burningUntil[room.idx] > this.t) continue;
      if (this._dormantVentReleaseNodes.has(room.idx)) continue;
      const corpses = this.agents.reduce((count, agent) => count
        + (!agent.dead && agent.faction === FACTION.CORPSE && agent.node === room.idx
          && agent.damage < 100 ? 1 : 0), 0);
      if (corpses === 0) continue;
      let nearestGun = this.graph.n;
      for (const gun of guns) {
        const hops = this.graph.hops(room.idx, gun.pnode ?? gun.node, ['std'], () => true);
        if (hops !== -1) nearestGun = Math.min(nearestGun, hops);
      }
      // Distance from rifles dominates food quantity: one safe corpse is a
      // viable carrier seed; four bodies beside a squad are four dead pods.
      const score = Math.min(nearestGun, 8) * 10 + Math.min(corpses, 3) * 2
        + (room.roles.includes('corpse_cache') ? 2 : 0);
      if (score > bestScore || (score === bestScore && room.idx < best?.idx)) {
        best = room;
        bestScore = score;
      }
    }
    if (!best) return false;
    const pod = makeAgent(FACTION.INFECTION, best.idx, this.graph);
    const angle = (pod.id * 2.399963) % (Math.PI * 2);
    const radius = Math.min(best.w, best.d) * 0.12;
    pod.x = best.x + Math.cos(angle) * radius;
    pod.y = best.y + Math.sin(angle) * radius;
    pod.hp = pod.maxHp = 1;
    this.spawn(pod);
    this.dormantVentReserves--;
    this._dormantVentReleaseNodes.add(best.idx);
    this.log('duct', `the dying hive wakes a dormant infection form in the vents of ${best.name}`,
      best.idx, pod.x, pod.y);
    return true;
  }

  // --- the one shared boundary (§2.2) ---
  writeBuffer() {
    const b = this.buffer;
    let i = 0;
    for (const a of this.agents) {
      if (a.dead || i >= b.capacity) continue;
      b.id[i] = a.id;
      b.faction[i] = a.faction;
      b.state[i] = a.state;
      b.nodeId[i] = a.node;
      b.posX[i] = a.x;
      b.posY[i] = a.y;
      b.posZ[i] = a.deck;
      b.hoverY[i] = a.hoverY || 0;
      b.headingR[i] = a.heading;
      b.animClip[i] = this._clipFor(a);
      b.animTime[i] = a.animTime;
      b.integrity[i] = a.hp;
      b.damage[i] = a.damage;
      b.tint[i] = TINT[a.faction];
      let flags = 0;
      if (a.hasRadio) flags |= FLAG.HAS_RADIO;
      if (a.helpless) flags |= FLAG.HELPLESS;
      if (a.downed && a.damage < 100) flags |= FLAG.REANIMATABLE;
      if (a.downed) flags |= FLAG.DOWNED;
      if (a.panicked) flags |= FLAG.PANICKED;
      // hidden ONLY during the mid-crawl through the structure — the body is
      // visible walking to the grate and climbing out the far one (user: no
      // snap-to-center-then-teleport; go to a marked opening and vanish there)
      if (a.move && a.move.layer === 'vent' && a.move.hidden) flags |= FLAG.EXPOSED;
      // PURPOSEFUL MOTION (user: the tracker must read motion, not standing
      // bodies): a committed move leg, an airborne arc, or riding a running
      // host. Separation shuffles and park-drift do NOT set it — a pack lying
      // in ambush is tracker-dark however the crowd math nudges it.
      if (a.move || a.leaping || a.steeredTick === this.tickCount
        || (a.state === STATE.GRABBING && a.grabTimer > 0)) flags |= FLAG.MOVING;
      // HALO-3 conversion phases for the renderer (and the tracker: a
      // convulsing body IS motion — it paints)
      if (a.faction === FACTION.INFECTION && a.task?.kind === TASK.CONVERT && a.taskProgress > 0) flags |= FLAG.BURROWING;
      if (a.faction === FACTION.COMBAT && a.transformingUntil !== undefined) flags |= FLAG.THRASHING | FLAG.MOVING;
      if (a.inShaftAmbush !== undefined) flags |= FLAG.AMBUSH;
      if (a.damage >= 100) flags |= FLAG.BURNED;
      if (a.flamer) flags |= FLAG.FLAMER;
      // TRIGGER DOWN. combat.js refreshes flamingT every tick a stream is
      // running, so a sustained burn holds this continuously; the corpse-cache
      // squirt (humans.js) is one instant, and the half-second tail is what
      // turns it into a visible burst rather than a single-frame flicker.
      if (this.t - (a.flamingT ?? -99) < 0.5) flags |= FLAG.FLAMING;
      if (a.odst) flags |= FLAG.ODST;
      if (a.isPlayer && a.bodyType !== 'female') flags |= FLAG.MALE_PLAYER;
      // hidden = inside the structure: a cross-deck TRUNK climb (ladder/lift)
      // hides the same way a duct crawl does, so the body vanishes into the
      // hatch and climbs out of the far one instead of standing on the collar
      if (a.move && a.move.hidden && (a.move.layer === 'shaft' || a.move.layer === 'std')) flags |= FLAG.IN_SHAFT;
      // armed corpses carry the flag too so the renderer can lay the right
      // body down (and drop a rifle beside it)
      if (a.hostArmed || (a.faction === FACTION.CORPSE && a.wasArmed && a.damage < 100)) flags |= FLAG.ARMED_HOST;
      if (a.charging) flags |= FLAG.CHARGING;
      if (a.faction === FACTION.COMBAT && a.charging && a.chargeArmsHigh) flags |= FLAG.ARMS_HIGH;
      if (a.hoverY > 0.05) flags |= FLAG.LEAPING;
      if (a.lastHurtTick !== undefined && this.tickCount - a.lastHurtTick < 4) flags |= FLAG.FLINCH;
      b.flags[i] = flags;
      i++;
    }
    b.count = i;
  }

  _clipFor(a) {
    if (a.faction === FACTION.CORPSE || a.downed || a.hp <= 0) return CLIP.DEATH;
    // Combat forms only play the violent tentacle swipe when a discrete melee
    // event actually fires. Closing on a victim remains a run, and the
    // recovery window returns to an alert idle instead of looping fake hits.
    if (a.faction === FACTION.COMBAT) {
      if ((a.meleeUntil ?? -1) > this.t) return CLIP.ATTACK;
      if (a.move?.retreatSprint === false
        && (a.task?.retreat === true || (a.task?.kind === TASK.DART && a.task.stage === 1))
        && !a.charging && !a.leaping) return CLIP.WALK;
      if (a.move || a.charging || a.leaping) return CLIP.RUN;
      return CLIP.IDLE;
    }
    if (a.state === STATE.GRABBING || a.state === STATE.FIGHT) return CLIP.ATTACK;
    // A MAN WITH THE TRIGGER DOWN IS NOT AT LOW READY. The corpse-cache burn
    // (humans.js) happens in a room with no flood in it, so the flamer was not
    // in FIGHT and rendered relaxed — weapon across his body at the carry yaw,
    // while a jet came out of it. ATTACK is what drives the renderer's aim
    // blend, which squares the barrel up and brings the yaw to zero, so the
    // stream leaves the nozzle pointing where he is pointing. Render output
    // only: _clipFor is read nowhere but writeBuffer.
    if (this.t - (a.flamingT ?? -99) < 0.5) return CLIP.ATTACK;
    // A POD IN THE AIR IS NOT WRITHING ON A FLOOR. A pouncing form has no
    // a.move (_spatialSteer nulls the track to engage), so it fell through to
    // WRITHE and thrashed against imaginary plating for the whole hop. The
    // combat form's branch above already returns RUN while leaping for the
    // same reason; the pod's arc gets the same treatment.
    if (a.faction === FACTION.INFECTION) return a.move || a.leaping ? CLIP.RUN : CLIP.WRITHE;
    if (a.move) return this._speedMult(a) > 1.2 ? CLIP.RUN : CLIP.WALK;
    // EVERY legged slide picks its cycle from real speed (user: humans
    // floating around with no walking animation). closeFollow escorts,
    // park drift and the pinned-host circle both move in real space
    // with NO a.move — each writes followSpeed, and each zeroes it when it
    // settles, so a standing body cannot get stuck mid-stride.
    const fs = a.followSpeed ?? 0;
    return fs > 3.2 ? CLIP.RUN : fs > 0.4 ? CLIP.WALK : CLIP.IDLE;
  }

  getStats() {
    const alive = { civ: 0, armed: 0, marine: 0, infection: 0, combat: 0, combatDowned: 0, carrier: 0, corpses: 0, burnedHusks: 0 };
    for (const a of this.agents) {
      if (a.dead) continue;
      switch (a.faction) {
        case FACTION.CIVILIAN: if (a.hp > 0) alive.civ++; break;
        case FACTION.ARMED: if (a.hp > 0) alive.armed++; break;
        case FACTION.MARINE: if (a.hp > 0) alive.marine++; break;
        case FACTION.INFECTION: alive.infection++; break;
        case FACTION.COMBAT: a.downed ? alive.combatDowned++ : alive.combat++; break;
        case FACTION.CARRIER: alive.carrier++; break;
        case FACTION.CORPSE: a.damage >= 100 ? alive.burnedHusks++ : alive.corpses++; break;
      }
    }
    let floodNodes = 0;
    for (let n = 0; n < this.graph.n; n++) {
      if (this.influence.floodStr[n] > this.influence.humanStr[n] && this.influence.floodStr[n] > 0.5) floodNodes++;
    }
    const gestating = this.agents.reduce((s, a) =>
      s + (!a.dead && a.faction === FACTION.CARRIER ? (a.held ?? 0) : 0), 0);
    return {
      t: this.t, tick: this.tickCount, outcome: this.outcome,
      scarcity: this.hive.lastScarcity ?? this.hive.scarcity(this.P.flood.initialInfectionForms),
      opening: this.hive.opening,
      floodControlled: floodNodes,
      gestating,
      ...alive, ...this.stats,
    };
  }

  // deterministic fingerprint for the seed-replay check (§2.1)
  hashState() {
    let h = 2166136261 >>> 0;
    const mix = (v) => {
      h ^= v & 0xffff; h = Math.imul(h, 16777619);
      h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 16777619);
    };
    for (const a of this.agents) {
      mix(a.id); mix(a.faction); mix(a.node);
      mix(Math.round(a.x * 16)); mix(Math.round(a.y * 16));
      mix(Math.round(a.hp * 16)); mix(Math.round(a.damage * 16));
    }
    mix(this.tickCount);
    return h >>> 0;
  }
}

export function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k]) deepMerge(dst[k], src[k]);
    else dst[k] = src[k];
  }
}
