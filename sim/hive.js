// Flood hive AI (§6) driven by the decision math in §13. One brain; forms
// are dumb actuators executing tasks. No phase flags anywhere: hide/invest/
// snowball/rampage all fall out of the scarcity term.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE } from './init.js';
import { humanPass } from './graph.js';

export const TASK = {
  MOVE: 'move',            // {node}
  GRAB: 'grab',            // {targetId}
  CONVERT: 'convert',      // {corpseId} infection form + body -> combat form (form spent)
  TRANSFORM: 'transform',  // combat form roots into a carrier (the hive's ratio lever)
  GUARD: 'guard',          // {node} defend a carrier
  REANIMATE: 'reanimate',  // {targetId} downed combat form
  DRAG: 'drag',            // {corpseId, node} haul carrier food
  DECOY: 'decoy',          // {show, stage} get seen far from the dens, then evade
  ATTACK: 'attack',        // {node} open aggression (rampage)
  SCOUT: 'scout',          // {node} refresh a lost belief — costs forms to look
  // DOOR BAIT (user tactic, enabled by the motion-only tracker): a staged
  // pack holds dead still — invisible to the tracker — while one form steps
  // through the door, shows itself, and immediately doubles back. Whoever
  // follows it through walks into the whole pack.
  DART: 'dart',            // {into, back, muster, stage}
};

const W_HUMAN = { [FACTION.CIVILIAN]: 0.1, [FACTION.ARMED]: 0.6, [FACTION.MARINE]: 1.0 };
const W_FLOOD = { [FACTION.INFECTION]: 0.25, [FACTION.COMBAT]: 1.0, [FACTION.CARRIER]: 0.5 };
const RETREAT_REASSESS_STRENGTH = 0.75;

export class Hive {
  constructor(sim) {
    this.sim = sim;
    // Stale map (§6.1): the hive knows the ship AS DESIGNED. Locks are
    // discovered only when a form runs into them. (The duct network is the
    // hive's own body — always known, always open.)
    this.knownLocked = new Set();
    // THE MARINE COUNTER (user redesign): the hive holds a running estimate
    // of how many armed marines remain. Seeded from absorbed crew knowledge
    // (the garrison's rough strength is common shipboard fact), decremented
    // every time the hive KILLS one — takes one, or watches one die to its
    // claws. This is what "it knows where they are, therefore where they are
    // not" hangs off: few marines believed left => the rest of the ship is
    // open ground.
    // Fixed Deck 1 coverage remains a local tactical threat, but it is not a
    // roaming force the hive must overpower before ending global caution.
    this.marinesBelieved = sim.agents.filter((a) => a.faction === FACTION.MARINE
      && !a.dead && !(a.garrison && a.deck === 1)).length;
    // Belief per human (§6.1), seeded with absorbed-crew knowledge: it knows
    // the brig/medbay are stocked and where the barracks squads berth. It
    // does NOT know where detached squads happen to be — the sweep ETA it
    // races is a guess (§6.7).
    this.beliefs = new Map(); // humanId -> {node, t, conf, static}
    this.believedHumanStr = new Float32Array(sim.graph.n);
    this.believedHardness = new Float32Array(sim.graph.n);
    this.opening = true;
    this.carrierSite = -1;
    this.sweepEtaSec = Infinity;
    this.baitCooldownUntil = 0;
    this.strongpoints = new Map(); // node -> {w, t}: remembered fortified positions
    // static distance-from-garrison field (absorbed map knowledge): dens and
    // carrier sites want to be far from where armed humans muster
    const garrison = [
      ...sim.graph.nodesWithRole('armory'),
      ...sim.graph.nodesWithRole('marines'),
      ...sim.graph.nodesWithRole('odst'),
    ];
    this.garrisonDist = sim.graph.flowField(garrison, ['std'], () => true).dist;
    const barracks = sim.graph.byId.get('barracks');
    for (const a of sim.agents) {
      if (a.dead) continue;
      if (a.faction === FACTION.CIVILIAN && (a.helpless || a.stayPut)) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.9, static: true });
      else if (a.faction === FACTION.CIVILIAN) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.3 });
      else if (a.faction === FACTION.ARMED) this.beliefs.set(a.id, { node: a.node, t: 0, conf: 0.25 });
      else if (a.faction === FACTION.MARINE) this.beliefs.set(a.id, { node: a.node, t: 0, conf: a.node === barracks ? 0.8 : 0.2 });
    }
  }

  // --- stale-map passability: believed, not actual ---
  // VENTS ARE INFECTION-ONLY now (user redesign), and they are not walked —
  // the duct network is routed explicitly via ventRoute (safeInfectionPath
  // below picks walk vs network by time). The walking predicates here cover
  // std corridors only — stairs, ladders and lifts, like the crew.
  infectionPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    if (link.kind === 'std') return !this.knownLocked.has(link.i) || !link.lockable;
    return link.kind === 'vent'; // synthesized network link — never blocked
  };
  // THE MAINTENANCE SHAFTS ARE DEAD (user: "old vent system should be dead").
  // Cross-deck crawlways were the legacy duct layer; the one-network vents
  // replaced them for pods, and the big forms now climb like the crew do —
  // stairs, ladders and lifts, through real doorways (user: "combat forms
  // should have to use the stairs or ladders").
  bigPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t) return false;
    return link.kind === 'std' && !this.knownLocked.has(link.i);
  };
  combatPass = this.bigPass;
  // A search cannot treat a discovered locked hatch as the edge of the
  // universe. Combat forms may route to any door they can physically batter;
  // the movement layer performs the breach when the path reaches its panel.
  searchPass = (link, from, to) => {
    if (this.sim.graph.burningUntil[to ?? -1] > this.sim.t || link.kind !== 'std') return false;
    if (!this.knownLocked.has(link.i)) return true;
    return !!link.door && !link.armorySeal && !link.fireSite;
  };
  _layersFor(kind) {
    return ['std'];
  }
  _passFor(kind) {
    return kind === 'infection' ? this.infectionPass : kind === 'combat' ? this.combatPass : this.bigPass;
  }

  observeBlocked(link) {
    const g = this.sim.graph;
    if (link.kind === 'std' && !this.knownLocked.has(link.i)) {
      this.knownLocked.add(link.i);
      g.invalidatePathCache(); // hive predicates read knownLocked
      this.sim.log('hive', `hive discovers a locked ${link.type} (${g.node(link.a).name} ↔ ${g.node(link.b).name}) — re-planning`);
    }
  }

  // the hive killed (or took) a marine — the counter is ground truth it earned
  noteMarineKill(marine) {
    // These guards were never included in the global dominance denominator.
    if (marine?.garrison && marine.deck === 1) return;
    this.marinesBelieved = Math.max(0, this.marinesBelieved - 1);
  }

  // A form that is shot shares the shooter's last known room even if that
  // form is destroyed before the next strategic observation. This is a
  // location report, not live tracking: it expires, or a form clears the room.
  noteHumanAttack(attacker, witness) {
    if (!attacker || !isLivingHuman(attacker)) return;
    const seen = new Map([[attacker.id, attacker]]);
    // The dying form reports the rest of the squad it could life-sense in
    // its local cell, not just the one rifle that landed the final round.
    for (const node of this.sim.floodSenses(witness.pnode ?? witness.node)) {
      for (const human of this.sim.occupants(node)) {
        if (isLivingHuman(human)) seen.set(human.id, human);
      }
    }
    for (const human of seen.values()) {
      this.beliefs.set(human.id, {
        node: human.pnode ?? human.node, t: this.sim.t, conf: 1,
        contactUntil: this.sim.t + 120,
      });
    }
  }

  combatDominates(combatForms) {
    const P = this.sim.P.swarm;
    return combatForms >= Math.max(P.dominationMinForms,
      Math.ceil(this.marinesBelieved * P.dominationRatio));
  }

  // seconds through the duct network between two rooms' grates — the closed
  // form the whole redesign leans on: time ∝ real grate-to-grate distance
  ventEtaSec(from, to) {
    if (from === to) return 0;
    return this.sim.travelSec(this.sim.graph.ventLink(from, to), 1);
  }

  // Infection reachability in "hops" that stay comparable with the old
  // BFS numbers: the walk distance, or the duct network expressed as
  // equivalent corridor hops — never -1, because any grate reaches any other.
  infectionHops(from, to) {
    if (from === to) return 0;
    const g = this.sim.graph;
    const walk = g.hops(from, to, ['std'], this.infectionPass);
    const hopSec = g.avgStdLenM / 1.4;
    const ventH = 1 + Math.ceil(this.ventEtaSec(from, to) / hopSec);
    return walk === -1 ? ventH : Math.min(walk, ventH);
  }

  // --- §13.2 scarcity: the engine of emergent phases ---
  scarcity(I) {
    const P = this.sim.P.hive;
    return Math.min(P.scarcityMax, Math.max(P.scarcityMin, Math.pow(P.I_ref / Math.max(I, 1), P.kS)));
  }

  // --- belief maintenance (§6.1, §13.6) ---
  updateBeliefs() {
    const sim = this.sim, dt = sim.P.sim.strategicTickSec;
    const lambda = sim.P.belief.decayRatePerSec;
    for (const [id, b] of this.beliefs) {
      if (!b.static) {
        if (b.contactUntil && b.contactUntil <= sim.t) {
          b.conf = 0;
          b.contactUntil = 0;
        } else if (!b.contactUntil) b.conf *= Math.exp(-lambda * dt);
      }
      // Losing a position is not learning a death. Keep the absorbed crew
      // identity while confidence falls to zero; the location contributes no
      // tactical weight, but an overwhelming hive still knows somebody is
      // unaccounted for and can search. The all-in denominator below counts
      // confident positions only, so these unknown contacts cannot recreate
      // the old fear-inflated muster threshold.
      if (b.conf < 0.05) b.conf = 0;
    }
    // Any form with LOS OR adjacent life-sense resets the record. The latter
    // follows real graph adjacency, so a ladder/lift landing contributes its
    // actual occupants without teaching the hive anything about distant rooms
    // or hard-coding the ship's current deck layout.
    const seen = new Set();
    const visited = new Set();
    const observed = new Map(); // node -> shooter weight actually sensed this round
    for (const f of sim.agents) {
      if (f.dead || !isActiveFloodForm(f)) continue;
      visited.add(f.pnode ?? f.node);
      const shootersByNode = new Map();
      for (const h of this.sensedHumans(f)) {
        const n = h.pnode ?? h.node;
        const weight = h.faction === FACTION.MARINE ? 1 : h.faction === FACTION.ARMED ? 0.6 : 0;
        shootersByNode.set(n, (shootersByNode.get(n) ?? 0) + weight);
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        const old = this.beliefs.get(h.id);
        this.beliefs.set(h.id, { node: n, t: sim.t, conf: 1, static: old?.static && (h.helpless || h.stayPut) });
      }
      for (const [n, shooterW] of shootersByNode) {
        // remember FORTIFIED positions: a mass of guns seen once stays feared
        // for minutes, not seconds — this is what stops the one-at-a-time
        // trickle into the last-stand line (per-contact beliefs decay in ~7s,
        // so the hive kept "forgetting" the line and feeding it another form)
        if (shooterW >= 2) this.strongpoints.set(n, { w: shooterW, t: sim.t });
        const prev = observed.get(n);
        if (prev === undefined || shooterW > prev) observed.set(n, shooterW);
      }
    }
    for (const [id, b] of this.beliefs) {
      if (b.contactUntil && visited.has(b.node) && !seen.has(id)) {
        b.contactUntil = 0;
        b.conf = 0;
      }
    }
    // believed strength fields (§13.6): probability mass spreads over nodes
    // reachable since last seen; q (prediction quality) sharpens it toward
    // the hive's model of where humans run
    const P = sim.P;
    this.believedHumanStr.fill(0);
    this.believedHardness.fill(0);
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0) { this.beliefs.delete(id); continue; }
      if (b.conf < 0.05) continue;
      const w = W_HUMAN[h.faction] * b.conf;
      const dtSeen = sim.t - b.t;
      const spreadHops = b.static ? 0 : Math.min(4, Math.floor(P.belief.humanSpeedHops * dtSeen));
      const q = P.belief.predictionQuality;
      if (spreadHops === 0 || b.conf > 0.95) {
        this.believedHumanStr[b.node] += w;
        if (h.faction === FACTION.MARINE) this.believedHardness[b.node] += w;
      } else {
        const nodes = sim.graph.nodesWithin(b.node, spreadHops, ['std'], humanPass);
        let total = 0;
        const score = nodes.map((n) => {
          const model = 1 / (1 + sim.influence.floodStr[n] * 3);
          const s = (1 - q) + q * model;
          total += s;
          return s;
        });
        nodes.forEach((n, i) => {
          const p = score[i] / total;
          this.believedHumanStr[n] += w * p;
          if (h.faction === FACTION.MARINE) this.believedHardness[n] += w * p;
        });
      }
    }
    // fold remembered strongpoints into the threat picture (slow ~3 min decay)
    for (const [n, sp] of this.strongpoints) {
      // eyes on the position beat the memory: a form looked at it THIS round
      // and the mass of guns is gone (dead or moved on) — drop the fear, or
      // the muster keeps storming an empty room for minutes
      if (observed.has(n) && observed.get(n) < 2) { this.strongpoints.delete(n); continue; }
      const age = sim.t - sp.t;
      if (age > 360) { this.strongpoints.delete(n); continue; }
      // the memory is a FLOOR under the live picture, not an addition — while
      // forms keep eyes on the line, live beliefs already carry its full
      // weight, and summing both doubled the defense estimate (the muster
      // then waited for numbers that couldn't exist)
      const s = sp.w * Math.exp(-age / 180);
      this.believedHardness[n] += Math.max(0, s - this.believedHardness[n]);
      this.believedHumanStr[n] += Math.max(0, s - this.believedHumanStr[n]);
    }
    // every believed* field just moved — memoized routes are stale
    this._beliefEpoch = (this._beliefEpoch ?? 0) + 1;
  }

  // --- per-epoch route memo (perf pass 3) ---
  // The strategic draft loops call safeAssaultPath/stealthPath in forms x
  // candidate-nodes patterns — the measured storm was 300-550 full Dijkstras
  // in ONE 15Hz tick every 2.5s (a metronomic 30-100ms hitch that grew with
  // the flood). The inputs those predicates read are exactly (a) the graph's
  // passability (locks / vents / burning — versioned by pathVersion) and
  // (b) the believed* fields + known* sets (versioned by _beliefEpoch, which
  // observeBlocked also rides via invalidatePathCache). Same inputs => same
  // route, so a memo keyed on both versions is bit-identical; only the CPU
  // time changes. Callers CONSUME paths (setPath aliases then shifts), so
  // hits return a shallow copy — step objects are never mutated.
  _routeMemo(kind) {
    const g = this.sim.graph;
    const v = (g.pathVersion ?? 0);
    const e = (this._beliefEpoch ?? 0);
    if (this._memoV !== v || this._memoE !== e) {
      this._memoV = v; this._memoE = e;
      (this._assaultMemo ??= new Map()).clear();
      (this._stealthMemo ??= new Map()).clear();
      (this._nbhMemo ??= new Map()).clear();
      (this._huntMemo ??= new Map()).clear();
    }
    return kind === 'assault' ? this._assaultMemo
      : kind === 'stealth' ? this._stealthMemo
        : kind === 'nbh' ? this._nbhMemo : this._huntMemo;
  }

  // --- route risk (§13.8) ---
  routeRisk(path) {
    if (!path) return 1;
    const g = this.sim.graph;
    let risk = 0;
    for (const step of path) {
      if (step.layer === 'vent') risk += this.ventWatched(step.link) * 0.5;
      else {
        risk += Math.min(1.0, this.believedHumanStr[step.to] * 1.0);
        // absorbed doctrine: arteries and open bays carry patrol traffic
        // whether or not the hive has a current belief about them
        const nd = g.node(step.to);
        if (nd.roles.includes('artery') || nd.type === 'open') risk += 0.25;
      }
    }
    return Math.min(2.5, risk);
  }

  ventWatched(link) {
    // a vent is only watched from the two rooms it connects — a shooter has
    // to be at the grating to see through it (user note). No adjacency bleed.
    let w = 0;
    for (const end of [link.a, link.b]) {
      w += this.believedHardness[end] + this.believedHumanStr[end] * 0.5;
    }
    return Math.min(1, w);
  }

  // Stealth pathing (§6.3): prefer routes around believed human presence and
  // watched vents; fall back to the direct route when there is no choice.
  stealthPath(from, to, kind) {
    const memo = this._routeMemo('stealth');
    const key = kind + '|' + from + '|' + to;
    const hit = memo.get(key);
    if (hit !== undefined) return hit === null ? null : hit.slice();
    const g = this.sim.graph;
    const layers = this._layersFor(kind);
    const base = this._passFor(kind);
    const quiet = (l, a, b) => {
      if (!base(l, a, b)) return false;
      if (b !== to && this.believedHumanStr[b] > 0.25) return false;
      if (l.kind === 'vent' && this.ventWatched(l) > 0.5) return false;
      return true;
    };
    const path = g.path(from, to, layers, quiet) ?? g.path(from, to, layers, base);
    memo.set(key, path);
    // callers consume paths (setPath aliases, then shift()) — never hand out
    // the stored array, on hit OR miss
    return path === null ? null : path.slice();
  }
  // A vent exit itself must be clear of armed contact. Nearby rooms remain
  // valid: the pod can sense a rifle one doorway away and decides whether its
  // NEXT step would cross into that line, rather than treating the whole
  // neighbourhood as forbidden territory.
  infectionArmedContact(node) {
    if (this.believedHardness[node] > 0.35) return true;
    return this.sim.occupants(node).some((human) => !human.dead && human.hp > 0
      && (human.faction === FACTION.MARINE || human.faction === FACTION.ARMED));
  }

  infectionSurfaceSafe(node) {
    return this.sim.graph.burningUntil[node] <= this.sim.t && !this.infectionArmedContact(node);
  }

  // INFECTION ROUTING (user redesign): pods ALWAYS avoid marines, and the
  // duct network is how. Compare the quiet walk against the direct network
  // transit by time and take the faster — with two hard rules on top:
  //  1. never EMERGE into a room with armed contact;
  //  2. if the only walk crosses believed guns, the network wins outright
  //     (the pod vanishes into the walls instead).
  safeInfectionPath(from, to) {
    if (from === to) return [];
    const walk = this.stealthPath(from, to, 'infection');
    const g = this.sim.graph;
    const ventOk = this.infectionSurfaceSafe(to);
    if (!ventOk) return walk; // never surface beside sensed or believed guns
    const vEta = this.ventEtaSec(from, to);
    if (walk) {
      let walkSec = 0, crossesGuns = false;
      for (const s of walk) {
        walkSec += g.linkCost(s.link);
        if (s.to !== to && (this.believedHardness[s.to] > 0.4 || this.believedHumanStr[s.to] > 0.5)) crossesGuns = true;
      }
      if (!crossesGuns && walkSec <= vEta) return walk;
    }
    return g.ventRoute(from, to);
  }

  // Combat-form route that never cuts THROUGH a remembered gun line: any
  // intermediate node with real believed hardness is off-limits (only the
  // destination itself may be hard — that's the assault). Walking the muster
  // through the last-stand corridor was how forms trickled in one at a time.
  safeAssaultPath(from, to) {
    const memo = this._routeMemo('assault');
    const key = from * 4096 + to; // node counts are far below 4096
    const hit = memo.get(key);
    if (hit !== undefined) return hit === null ? null : hit.slice();
    const pass = (l, a, b) => {
      if (!this.bigPass(l, a, b)) return false;
      if (b !== from && b !== to && this.believedHardness[b] > 0.7) return false;
      return true;
    };
    const path = this.sim.graph.path(from, to, ['std'], pass);
    memo.set(key, path);
    // callers consume paths (setPath aliases, then shift()) — never hand out
    // the stored array, on hit OR miss
    return path === null ? null : path.slice();
  }

  // --- sweep ETA (§6.7/§13.5): a belief, not ground truth ---
  estimateSweepEta() {
    const sim = this.sim;
    let bestHops = Infinity;
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.faction !== FACTION.MARINE || b.conf < 0.15) continue;
      const d = sim.graph.hops(b.node, sim.graph.breachNode, ['std'], humanPass);
      if (d !== -1 && d < bestHops) bestHops = d;
    }
    if (bestHops === Infinity) return Infinity;
    // seconds from NOW at a marine's pace over average real hop distance
    return bestHops * (sim.graph.avgStdLenM / (sim.P.movement.baseMps * sim.P.speed.marine));
  }

  // arteries carry marine traffic; denning beside them is asking to be found
  trafficPenalty(node) {
    let p = 0;
    if (this.sim.graph.hasRole(node, 'artery')) p += 2;
    for (const { to } of this.sim.graph.neighbors(node, ['std'], () => true)) {
      if (this.sim.graph.hasRole(to, 'artery')) p += 0.4;
    }
    return p;
  }

  // escape options from a node across all layers the hive can use — a
  // carrier site or fallback point with one exit is a trap, not a refuge.
  // Every room's grate counts as one exit (infection-only, but a bolt-hole
  // for the pool is still a bolt-hole).
  exitCount(node) {
    let n = 1; // the room's own vent grate
    for (const _ of this.sim.graph.neighbors(node, ['std'], (l) => !this.knownLocked.has(l.i))) n++;
    return n;
  }

  // absorbed map knowledge (§6.1): garrison compartments are dangerous
  // whether or not the hive currently sees anyone in them
  staticGarrison(node) {
    const roles = this.sim.graph.node(node).roles;
    if (roles.includes('marines') || roles.includes('odst')) return 1.2;
    if (roles.includes('armory') || roles.includes('armed')) return 0.8;
    return 0;
  }

  // hardness the hive believes is at/near a node (for evade + siting)
  localThreat(node) {
    let h = this.believedHardness[node] + this.believedHumanStr[node] * 0.4 + this.staticGarrison(node);
    for (const { to } of this.sim.graph.neighbors(node, ['std'], () => true)) {
      h += this.believedHardness[to] * 0.6 + this.staticGarrison(to) * 0.5;
    }
    return h;
  }

  _combatResponder(form) {
    return form.faction === FACTION.COMBAT && !form.dead && !form.downed
      && form.hp > 0 && !form.isPlayer && form.dragging === -1
      && form.transformingUntil === undefined && form.task?.kind !== TASK.TRANSFORM;
  }

  // Flood perception is the union of geometric sight and the living bodies in
  // its own/adjacent graph nodes. Using floodSenses keeps sealed doors and
  // vertical trunks opaque to guns but not to the hive's life-sense, and makes
  // the behavior follow any future room graph without tactical room lists.
  sensedHumans(form) {
    const humans = new Map();
    for (const human of this.sim.lineOfSightAgents(form, isLivingHuman)) humans.set(human.id, human);
    const from = form.pnode ?? form.node;
    for (const node of this.sim.floodSenses(from)) {
      for (const human of this.sim.occupants(node)) {
        if (isLivingHuman(human)) humans.set(human.id, human);
      }
    }
    return [...humans.values()];
  }

  // A local pack is the forms sharing the same flood-sensed tactical cell:
  // their room plus its directly adjacent rooms. The hive's perception is
  // shared across that cell, so a doorway crossing cannot split one response
  // into "run" and "advance" halves. It stays one hop wide rather than
  // traversing the whole ship as one graph component.
  combatPack(form) {
    if (this._combatCacheTick !== this.sim.tickCount) {
      this._combatCacheTick = this.sim.tickCount;
      this._combatPackCache = new Map();
      this._combatSituationCache = new Map();
      this._combatResponseCache = new Set();
      this._combatVisibleCache = new Map();
    }
    const cached = this._combatPackCache.get(form.id);
    if (cached) return cached;
    if (!this._combatResponder(form)) return [form];
    const origin = form.pnode ?? form.node;
    const localNodes = new Set(this.sim.floodSenses(origin));
    const pack = this.sim.agents.filter((candidate) =>
      localNodes.has(candidate.pnode ?? candidate.node)
      && this._combatResponder(candidate));
    if (!pack.some((member) => member.id === form.id)) pack.push(form);
    pack.sort((a, b) => a.id - b.id);
    for (const member of pack) {
      const visible = this.sim.lineOfSightAgents(member,
        (candidate) => isLivingHuman(candidate) || isActiveFloodForm(candidate)
          || candidate.faction === FACTION.CARRIER);
      this._combatVisibleCache.set(member.id, visible);
      this._combatPackCache.set(member.id, pack);
    }
    return pack;
  }

  // Real-space combat balance belongs to the connected pack, not the one
  // appendage that happened to cross the threshold first. Visible bodies are
  // deduplicated across every member so the whole pack reaches one decision.
  combatLineOfSight(form) {
    const pack = this.combatPack(form);
    const cached = this._combatSituationCache.get(form.id);
    if (cached) return cached;
    const flood = new Map(pack.map((a) => [a.id, a]));
    const humans = new Map();
    for (const member of pack) {
      const visible = this._combatVisibleCache.get(member.id)
        ?? this.sim.lineOfSightAgents(member,
          (candidate) => isLivingHuman(candidate) || isActiveFloodForm(candidate)
            || candidate.faction === FACTION.CARRIER);
      for (const a of visible) {
        if (isLivingHuman(a)) humans.set(a.id, a);
        else if (a.faction !== FACTION.COMBAT || this._combatResponder(a)) flood.set(a.id, a);
      }
      // why: every appendage in the local cell receives the same life-sense
      // report, including a marine just beyond a closed doorway or on the
      // neighboring landing. Without this union, the first threshold crosser
      // could make a private decision and immediately split the pack.
      for (const human of this.sensedHumans(member)) humans.set(human.id, human);
    }
    let strength = 0, defense = 0, threat = null, nearestThreat = Infinity;
    for (const ally of flood.values()) strength += W_FLOOD[ally.faction] ?? 0;
    for (const human of humans.values()) {
      defense += W_HUMAN[human.faction] ?? 0;
      if (human.faction !== FACTION.MARINE && human.faction !== FACTION.ARMED) continue;
      for (const member of pack) {
        const distance = this.sim.agentDistance(member, human);
        if (distance < nearestThreat - 1e-9
          || (Math.abs(distance - nearestThreat) <= 1e-9 && human.id < (threat?.id ?? Infinity))) {
          nearestThreat = distance;
          threat = human;
        }
      }
    }
    const situation = { pack, humans: [...humans.values()], strength, defense,
      threat, threatNode: threat ? (threat.pnode ?? threat.node) : -1 };
    for (const member of pack) this._combatSituationCache.set(member.id, situation);
    return situation;
  }

  // Exact odds in one life-sensed adjacent room. Allies already fighting on
  // the far landing count with the approaching pack: they are appendages of
  // one hive even though an enclosed ladder/lift prevents geometric LOS.
  sensedRoomCombat(form, node) {
    const from = form.pnode ?? form.node;
    if (!this.sim.floodSenses(from).includes(node)) return null;
    const pack = this.combatPack(form);
    const flood = new Map(pack.map((ally) => [ally.id, ally]));
    const humans = [];
    for (const occupant of this.sim.occupants(node)) {
      if (isLivingHuman(occupant)) humans.push(occupant);
      else if (isActiveFloodForm(occupant) || occupant.faction === FACTION.CARRIER) {
        flood.set(occupant.id, occupant);
      }
    }
    let strength = 0, defense = 0;
    for (const ally of flood.values()) strength += W_FLOOD[ally.faction] ?? 0;
    for (const human of humans) defense += W_HUMAN[human.faction] ?? 0;
    return { pack, humans, strength, defense };
  }

  // A losing sensed crossing gives the whole connected pack the same binary
  // response as visible combat: withdraw, or fight only if no escape exists.
  // Returns whether the crossing may proceed.
  respondToSensedRoom(form, node) {
    const situation = this.sensedRoomCombat(form, node);
    if (!situation || situation.defense === 0 || this.allIn || form.task?.force) return true;
    const surging = situation.pack.some((member) => member.task?.surge
      || member.state === STATE.FIGHT
      || this.sim.tickCount - (member.lastHurtTick ?? -999) < 45);
    const forced = situation.pack.some((member) => member.task?.force);
    const formCommitted = form.task?.kind === TASK.ATTACK
      && (form.task.surge || form.task.force || form.state === STATE.FIGHT);
    // A guard or carrier seed sharing sight with an engaged pack may not drag
    // the whole charge into retreat merely because its unrelated route meets
    // the same doorway. Block only that crossing; the shared fight continues.
    if ((surging || forced) && !formCommitted) return false;
    if (forced || situation.strength >= situation.defense
      * (surging ? 1 : this.sim.P.swarm.attackRatio)) return true;
    const responseKey = situation.pack[0]?.id ?? form.id;
    if (this._combatResponseCache.has(responseKey)) return false;
    if (this.retreatCommitmentHolds(situation.pack, situation.strength)) return false;
    for (const member of situation.pack) {
      if (!this.isRetreating(member)) {
        this.retreatOrFight(member, node, false, undefined, situation.strength);
      }
    }
    this._combatResponseCache.add(responseKey);
    return false;
  }

  visibleHumanTarget(form, preferredId = -1) {
    let best = null, bestScore = Infinity;
    for (const human of this.sim.lineOfSightAgents(form, isLivingHuman)) {
      const distance = this.sim.agentDistance(form, human);
      const score = distance - (human.id === preferredId ? 8 : 0);
      if (score < bestScore - 1e-9
        || (Math.abs(score - bestScore) <= 1e-9 && human.id < (best?.id ?? Infinity))) {
        best = human;
        bestScore = score;
      }
    }
    return best;
  }

  lockedCombatTarget(form) {
    if (form.task?.kind !== TASK.ATTACK || form.task.targetId === undefined) return null;
    const target = this.sim.byId.get(form.task.targetId);
    return target && isLivingHuman(target) ? target : null;
  }

  immediateCombatTarget(form, rangeM = this.sim.P.combat.meleeRangeM) {
    let best = null, bestDistance = Infinity;
    for (const human of this.sim.lineOfSightAgents(form, isLivingHuman, rangeM)) {
      const distance = this.sim.agentDistance(form, human);
      if (distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && human.id < (best?.id ?? Infinity))) {
        best = human;
        bestDistance = distance;
      }
    }
    return best;
  }

  combatTargetLoad(targetId, excludeId = -1) {
    let load = 0;
    for (const attacker of this.sim.agents) {
      if (attacker.id === excludeId || attacker.dead || attacker.downed || attacker.hp <= 0
        || attacker.faction !== FACTION.COMBAT) continue;
      if (this.lockedCombatTarget(attacker)?.id === targetId) load++;
    }
    return load;
  }

  nearestCombatTarget(form, candidates = null, targetLoads = null) {
    const humans = candidates ?? this.sim.lineOfSightAgents(form, isLivingHuman);
    const cap = this.sim.P.combat.combatForm.attackersPerTarget;
    let best = null, bestDistance = Infinity;
    for (const human of humans) {
      if (!isLivingHuman(human)) continue;
      if (targetLoads && (targetLoads.get(human.id) ?? 0) >= cap) continue;
      const distance = this.sim.agentDistance(form, human);
      if (distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && human.id < (best?.id ?? Infinity))) {
        best = human;
        bestDistance = distance;
      }
    }
    return best;
  }

  isRetreating(form) {
    return !!(form.task?.retreat && (form.move || form.path.length));
  }

  retreatCommitmentHolds(pack, strength) {
    let baseline = -Infinity;
    for (const member of pack) {
      if (!this.isRetreating(member)) continue;
      baseline = Math.max(baseline, member.task.retreatStrength ?? strength);
    }
    return baseline > -Infinity && strength < baseline + RETREAT_REASSESS_STRENGTH;
  }

  // A retreat is not blind flight. Once a form reaches a room with a soft
  // body and no armed contact in its shared sense cell, that body is the best
  // way to turn distance into new mass. Restricting this to the current room
  // keeps the opportunistic stop safe and prevents a lone form from crossing
  // another doorway just to chase an old civilian belief.
  retreatPrey(form) {
    const sim = this.sim;
    const node = form.pnode ?? form.node;
    const sensed = this.sensedHumans(form);
    if (sensed.some((human) => human.faction === FACTION.MARINE
      || human.faction === FACTION.ARMED)) return null;
    let best = null, bestDistance = Infinity;
    for (const human of sim.occupants(node)) {
      if (!isLivingHuman(human) || human.faction !== FACTION.CIVILIAN) continue;
      const distance = Math.hypot(human.x - form.x, human.y - form.y);
      if (distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && human.id < (best?.id ?? Infinity))) {
        best = human;
        bestDistance = distance;
      }
    }
    return best;
  }

  isCombatCommitted(form) {
    return form.state === STATE.FIGHT || (form.task?.kind === TASK.ATTACK
      && (form.task.surge || form.task.force));
  }

  // A planned assault keeps the conservative doctrine. Being fired on starts
  // a surge at even odds, but it cannot reverse a retreat already in motion.
  canPressCombatContact(form, provoked = false, forced = false) {
    if (forced || this.allIn) return true;
    const { strength, defense } = this.combatLineOfSight(form);
    if (defense === 0) return true;
    return strength >= defense * (provoked ? 1 : this.sim.P.swarm.attackRatio);
  }

  respondToCombat(form, target, provoked = false) {
    const situation = this.combatLineOfSight(form);
    const pack = situation.pack;
    const responseKey = pack[0]?.id ?? form.id;
    if (this._combatResponseCache.has(responseKey)) {
      return form.task?.kind === TASK.ATTACK && !form.task.retreat;
    }
    const stimulus = typeof target === 'number' ? null : target;
    const knownHumans = situation.humans.slice();
    if (stimulus && isLivingHuman(stimulus)
      && !knownHumans.some((human) => human.id === stimulus.id)) knownHumans.push(stimulus);
    for (const member of pack) {
      if (this.sim.tickCount - (member.lastHurtTick ?? -999) >= 45) continue;
      const source = this.sim.byId.get(member.lastHurtBy);
      if (source && isLivingHuman(source)
        && !knownHumans.some((human) => human.id === source.id)) knownHumans.push(source);
    }
    const fallbackNode = typeof target === 'number' ? target
      : (stimulus?.pnode ?? stimulus?.node ?? situation.threatNode);
    const threatNode = situation.threatNode !== -1 ? situation.threatNode : fallbackNode;
    // Use the same adjacent-room life-sense here that the doorway veto uses.
    // Otherwise a pack attacks the one silhouette visible in an opening, then
    // learns about the rest of that room a frame later and reverses course.
    const sensed = fallbackNode >= 0 ? this.sensedRoomCombat(form, fallbackNode) : null;
    if (sensed) for (const human of sensed.humans) {
      if (!knownHumans.some((known) => known.id === human.id)) knownHumans.push(human);
    }
    const decisionStrength = Math.max(situation.strength, sensed?.strength ?? 0);
    const decisionDefense = knownHumans.reduce((sum, human) =>
      sum + (W_HUMAN[human.faction] ?? 0), 0);
    // A doorway contact is decided first by the room the pack is actually
    // entering. The wider sense cell is useful for caution, but letting a
    // distant squad outweigh a locally superior pack made forms reverse at
    // the threshold even while they had the numbers to finish the contact.
    const localAdvantage = sensed?.defense > 0 && decisionStrength > sensed.defense;
    const surge = provoked || pack.some((member) => member.task?.surge
      || this.sim.tickCount - (member.lastHurtTick ?? -999) < 45);
    const forced = pack.some((member) => member.task?.force);
    // Once a pack has actually crossed the attack decision, keep that
    // commitment stable until its locked prey dies. Re-running the ratio
    // check as formations move made the same group charge, retreat, and
    // charge again whenever one body briefly left the shared sense cell.
    const committedAttack = pack.some((member) => member.task?.kind === TASK.ATTACK
      && member.task.commit && this.lockedCombatTarget(member));
    // Once the hive has chosen a viable escape, ordinary incoming fire does
    // not make it reconsider every tick. A newly connected combat form does:
    // that is a real change in the shared odds, not doorway jitter.
    const stillOutmatched = decisionDefense > 0 && !localAdvantage
      && decisionStrength < decisionDefense * this.sim.P.swarm.attackRatio;
    if (!forced && !committedAttack && stillOutmatched
      && this.retreatCommitmentHolds(pack, decisionStrength)) {
      // A form that joins the cell after the retreat began must inherit the
      // same withdrawal. Returning only from this function left the newcomer
      // on its old attack order, producing the exact doorway split this pack
      // model is meant to prevent.
      if (threatNode >= 0) for (const member of pack) {
        if (!this.isRetreating(member)) {
          this.retreatOrFight(member, threatNode, false, undefined, decisionStrength);
        }
      }
      this._combatResponseCache.add(responseKey);
      return false;
    }
    const canPress = forced || committedAttack || localAdvantage || this.allIn || decisionDefense === 0
      || decisionStrength >= decisionDefense * (surge ? 1 : this.sim.P.swarm.attackRatio);
    if (canPress) {
      // Target locks are individual and sticky. Count every live combat form,
      // not just this visible pack, so two waves entering through different
      // doors cannot each dogpile the same marine. New commitments fill the
      // nearest target to three, then spill onto the next. Existing locks are
      // never rebalanced when another trio dies; assign() preserves them until
      // either the form or its target is dead.
      const targetLoads = new Map();
      for (const attacker of this.sim.agents) {
        if (attacker.dead || attacker.downed || attacker.hp <= 0
          || attacker.faction !== FACTION.COMBAT) continue;
        const locked = this.lockedCombatTarget(attacker);
        if (locked) targetLoads.set(locked.id, (targetLoads.get(locked.id) ?? 0) + 1);
      }
      for (const member of pack) {
        const locked = this.lockedCombatTarget(member);
        const prey = locked ?? this.nearestCombatTarget(member, knownHumans, targetLoads);
        if (!locked && prey) targetLoads.set(prey.id, (targetLoads.get(prey.id) ?? 0) + 1);
        const node = prey ? (prey.pnode ?? prey.node) : fallbackNode;
        if (node === undefined || node < 0) continue;
        this.assign(member, { kind: TASK.ATTACK, node, targetId: prey?.id,
          surge: !!surge, force: forced, commit: true });
      }
      this._combatResponseCache.add(responseKey);
      return form.task?.kind === TASK.ATTACK;
    }
    if (threatNode === undefined || threatNode < 0) return false;
    for (const member of pack) {
      if (!this.isRetreating(member)) {
        this.retreatOrFight(member, threatNode, false, undefined, decisionStrength);
      }
    }
    this._combatResponseCache.add(responseKey);
    return form.task?.kind === TASK.ATTACK && !form.task.retreat;
  }

  // A retreat is only real if its FIRST physical leg moves away from every
  // visible gun. Graph distance alone cannot express a shooter standing
  // between a form and a ladder/door: topologically the hatch is an escape,
  // but in the room it requires running straight past the threat.
  retreatApproachSafe(form, step, threats = null) {
    if (!step?.link) return false;
    const sim = this.sim, g = sim.graph;
    const from = form.pnode ?? form.node;
    const room = g.node(from);
    const link = step.link;
    let mouth = link.door ?? (link.a === from ? link.padA : link.padB);
    if (!mouth && link.type === 'stairwell') {
      const to = g.node(step.to);
      const upper = room.deck < to.deck ? room : to;
      const points = sim._stairWaypoints(upper);
      const point = room === upper ? points.top : points.foot;
      mouth = { x: point.x, y: point.y + sim._bandC(room.deck) - sim._bandC(upper.deck) };
    }
    mouth ??= { x: g.node(step.to).x, y: g.node(step.to).y };

    const armed = threats ?? sim.lineOfSightAgents(form,
      (human) => isLivingHuman(human)
        && (human.faction === FACTION.ARMED || human.faction === FACTION.MARINE));
    const vx = mouth.x - form.x, vy = mouth.y - form.y;
    const lengthSq = vx * vx + vy * vy;
    for (const human of armed) {
      if (human.deck !== form.deck) continue;
      const hx = human.x - form.x, hy = human.y - form.y;
      const startDistance = Math.hypot(hx, hy);
      const endDistance = Math.hypot(human.x - mouth.x, human.y - mouth.y);
      // Even without a near miss, an exit behind the shooter is not an escape:
      // the whole approach closes distance under fire.
      if (endDistance < startDistance - 0.25) return false;
      if (lengthSq <= 1e-6) continue;
      const t = Math.max(0, Math.min(1, (hx * vx + hy * vy) / lengthSq));
      if (t <= 0.02 || t >= 0.98) continue;
      const closest = Math.hypot(hx - vx * t, hy - vy * t);
      if (closest < Math.max(3, sim.P.combat.meleeRangeM * 1.25)
        && closest < startDistance - 0.25) return false;
    }
    return true;
  }

  // Pick the carrier-side screen against the nearest known gun line. A safe
  // first hop buys another room of time; once that approach becomes hot, the
  // screen collapses behind the carrier room's own entrance. Nothing names a
  // room: changing the ship graph changes the position automatically.
  _carrierScreenPlan(carrier, fixedThreat = -1) {
    const g = this.sim.graph;
    let threatNode = fixedThreat, threatPath = null, bestScore = Infinity;
    if (threatNode >= 0) threatPath = g.path(carrier.node, threatNode, ['std'], this.bigPass);
    else {
      for (let node = 0; node < g.n; node++) {
        const pressure = this.believedHardness[node] + this.believedHumanStr[node] * 0.35;
        if (pressure < 0.2) continue;
        const path = g.path(carrier.node, node, ['std'], this.bigPass);
        if (!path) continue;
        const score = path.length - Math.min(4, pressure) * 0.12;
        if (score < bestScore - 1e-9
          || (Math.abs(score - bestScore) <= 1e-9 && node < threatNode)) {
          bestScore = score;
          threatNode = node;
          threatPath = path;
        }
      }
    }
    let screen = carrier.node;
    if (threatPath?.length > 1 && (fixedThreat < 0 || threatPath.length > 2)) {
      const forward = threatPath[0].to;
      // A light contact can be delayed one room forward. Reinforcement raises
      // localThreat through the same adjacent life-sense field and pulls the
      // line back without a scenario-specific room list.
      if (this.localThreat(forward) < 0.75 && this.believedHardness[forward] < 0.5) screen = forward;
    }
    return { carrier, threatNode, screen, distance: threatPath?.length ?? Infinity };
  }

  // One carrier plus a thin pool is the hive's future, not just another unit.
  // Both opening and steady state call this planner so the successfully seated
  // carrier—not a now-empty original den—owns the defense. Scarcity controls
  // the size of a small guard detail, never a percentage of the whole army:
  // surplus bodies are the hive's second bet, free to seed or make noise.
  protectCarriers(combat, carriers, S) {
    const liveCarrierIds = new Set(carriers.map((carrier) => carrier.id));
    for (const form of combat) {
      if (form.task?.protect !== undefined && !liveCarrierIds.has(form.task.protect)) form.task = null;
    }
    if (!carriers.length || !combat.length) return;
    const g = this.sim.graph;
    const plans = carriers.map((carrier) => this._carrierScreenPlan(carrier))
      .sort((a, b) => (a.distance - b.distance)
        || ((b.carrier.held ?? 0) - (a.carrier.held ?? 0)) || (a.carrier.id - b.carrier.id));
    const scarce = S >= 1.5;
    const detailCap = carriers.length * (scarce ? 2 : 1);
    // Preserve at least one mobile appendage whenever the pocket has a choice.
    // Transforming/raiding forms are excluded below as well, so those bets can
    // never be pulled off their jobs merely because a carrier is vulnerable.
    const mobileReserve = combat.length > 1 ? 1 : 0;
    const wanted = Math.min(detailCap, Math.max(1, combat.length - mobileReserve));
    const eligible = combat.filter((form) => {
      const task = form.task;
      if (form.downed || form.fromPlayer || form.taskProgress > 0) return false;
      if (!task) return true;
      if (task.kind === TASK.TRANSFORM || task.kind === TASK.DECOY || task.kind === TASK.DART) return false;
      if (task.muster !== undefined || task.seed || task.screen !== undefined || task.raid) return false;
      if (task.retreat && task.protect === undefined) return false;
      if (task.kind === TASK.ATTACK && (task.force || task.surge || form.state === STATE.FIGHT)) return false;
      return true;
    });
    const chosen = new Map();
    for (let slot = 0; slot < wanted && eligible.length; slot++) {
      const plan = plans[slot % plans.length];
      let bestIndex = -1, bestScore = Infinity;
      for (let index = 0; index < eligible.length; index++) {
        const form = eligible[index];
        const hops = g.hops(form.pnode ?? form.node, plan.screen, ['std'], this.bigPass);
        if (hops === -1) continue;
        const keep = form.task?.protect === plan.carrier.id ? -20 : 0;
        const score = hops + keep + form.id * 1e-6;
        if (score < bestScore) { bestScore = score; bestIndex = index; }
      }
      if (bestIndex === -1) continue;
      const form = eligible.splice(bestIndex, 1)[0];
      const keepRetreat = form.task?.retreat && (form.move || form.path.length);
      if (form.move && (form.task?.node !== plan.screen || form.task?.protect !== plan.carrier.id)) {
        this.sim._interruptMove(form);
      }
      this.assign(form, { kind: TASK.GUARD, node: plan.screen,
        protect: plan.carrier.id, threatNode: plan.threatNode,
        retreat: keepRetreat ? true : undefined });
      chosen.set(form.id, plan.carrier.id);
    }
    // A recovered production line releases surplus defenders back to hunting;
    // a dead carrier cannot leave permanent guards on an empty compartment.
    for (const form of combat) {
      if (form.task?.protect === undefined || chosen.has(form.id)) continue;
      if (form.move) this.sim._interruptMove(form);
      form.task = null;
    }
    if (scarce && chosen.size && this.sim.t >= (this._carrierDefenseLogAt ?? 0)) {
      this._carrierDefenseLogAt = this.sim.t + 30;
      this.sim.log('hive', `the thin hive pulls ${chosen.size} combat form${chosen.size === 1 ? '' : 's'} back around its carrier line`);
    }
  }

  // Losing doorway odds have only two outcomes: withdraw or, if every open
  // route is cut off, fight. The retreat is ground-truth pathing because a
  // form deciding under visible guns cannot afford a stale-belief shortcut
  // through the very room it is escaping. Distance from the threat dominates
  // the score; remembered danger and dead-end rooms break ties.
  retreatCombatForm(form, threatNode, observedStrength = undefined) {
    const sim = this.sim, g = sim.graph;
    const wasRetreating = this.isRetreating(form);
    const retreatStrength = form.task?.retreatStrength
      ?? observedStrength
      ?? this.combatLineOfSight(form).strength;
    // A retreat replaces the current leg, not merely the queued steps after
    // it. Keeping an old doorway leg while installing a route from its origin
    // lets that leg finish on the far side, where the new first edge is no
    // longer connected; the form then appears to jump onto a lift or ladder.
    if (form.move) sim._interruptMove(form);
    if (!wasRetreating) {
      sim._setRetreatSprint(form, false);
      form.retreatStartedTick = sim.tickCount;
    }
    const from = form.node;
    const openEscape = (link, a, b) => {
      if (link.kind !== 'std' || link.locked) return false;
      if (g.burningUntil[b] > sim.t) return false;
      if (threatNode !== from && (a === threatNode || b === threatNode)) return false;
      return true;
    };
    // Under scarcity, a clean carrier-side fallback outranks an unrelated far
    // corner. This is the reactive half of protectCarriers: the proactive
    // screen does not dissolve the instant its guards come under fire.
    const carriers = sim.agents.filter((a) => !a.dead && a.hp > 0
      && a.faction === FACTION.CARRIER);
    const infection = sim.agents.reduce((count, a) => count
      + (!a.dead && a.hp > 0 && a.faction === FACTION.INFECTION ? 1 : 0), 0);
    if (carriers.length && this.scarcity(infection + carriers.length * 2) >= 1.5) {
      let refuge = null, refugeScore = Infinity;
      const fromAway = g.hops(threatNode, from, ['std'], () => true);
      for (const carrier of carriers) {
        const plan = this._carrierScreenPlan(carrier, threatNode);
        // Once the fallback has reached the carrier itself there is nowhere
        // more valuable to run. Returning false below makes retreatOrFight
        // force the guard to turn and buy the womb its last seconds.
        if (carrier.node === from) {
          refuge = { cornered: true };
          refugeScore = -Infinity;
          continue;
        }
        const screen = plan.screen === from ? carrier.node : plan.screen;
        const path = g.path(from, screen, ['std'], openEscape);
        if (!path?.length || !this.retreatApproachSafe(form, path[0])) continue;
        const toAway = g.hops(threatNode, screen, ['std'], () => true);
        if (fromAway !== -1 && toAway !== -1 && toAway < fromAway) continue;
        const score = path.length + this.localThreat(screen) * 2 - (carrier.held ?? 0) * 0.15;
        if (score < refugeScore - 1e-9
          || (Math.abs(score - refugeScore) <= 1e-9 && carrier.id < (refuge?.carrier.id ?? Infinity))) {
          refuge = { carrier, plan: { ...plan, screen }, path };
          refugeScore = score;
        }
      }
      if (refuge?.cornered) return false;
      if (refuge) {
        this.assign(form, { kind: TASK.GUARD, node: refuge.plan.screen,
          protect: refuge.carrier.id, threatNode, retreat: true, retreatStrength });
        sim.setPath(form, refuge.path);
        sim._setCharging(form, false);
        form.state = STATE.MOVE;
        return true;
      }
    }
    let best = null, bestScore = -Infinity;
    for (const node of g.nodes) {
      if (node.idx === from) continue;
      const path = g.path(from, node.idx, ['std'], openEscape);
      if (!path?.length) continue;
      if (!this.retreatApproachSafe(form, path[0])) continue;
      const away = g.hops(threatNode, node.idx, ['std'], () => true);
      const exits = [...g.neighbors(node.idx, ['std'], (link) => !link.locked)].length;
      const score = (away === -1 ? g.n : away) * 100
        - this.localThreat(node.idx) * 20
        + exits * 2
        - this.trafficPenalty(node.idx)
        - path.length * 0.25;
      if (score > bestScore + 1e-9
        || (Math.abs(score - bestScore) <= 1e-9 && node.idx < (best?.node ?? Infinity))) {
        best = { node: node.idx, path };
        bestScore = score;
      }
    }
    if (!best) return false;
    this.assign(form, { kind: TASK.MOVE, node: best.node, retreat: true,
      threatNode, retreatStrength });
    sim.setPath(form, best.path);
    sim._setCharging(form, false);
    form.state = STATE.MOVE;
    return true;
  }

  // Returns true only when escape is impossible and the form must attack.
  retreatOrFight(form, threatNode, replan = false, targetId = undefined,
    retreatStrength = undefined) {
    if (!replan && form.task?.retreat && form.task.threatNode === threatNode
      && (form.move || form.path.length)) return false;
    if (this.retreatCombatForm(form, threatNode, retreatStrength)) return false;
    if (targetId !== undefined && this.combatTargetLoad(targetId, form.id)
      >= this.sim.P.combat.combatForm.attackersPerTarget) targetId = undefined;
    this.assign(form, { kind: TASK.ATTACK, node: threatNode, targetId,
      force: true, cornered: true, commit: true });
    return true;
  }

  // ======================= strategic tick =======================
  strategicTick() {
    const sim = this.sim;
    this.updateBeliefs();

    // release claims whose claiming task no longer exists (the claimer died
    // or was re-tasked) so bodies/downed forms return to the economy
    const claimedNow = new Set();
    for (const a of sim.agents) {
      if (a.dead || !a.task) continue;
      if (a.task.corpseId !== undefined) claimedNow.add(a.task.corpseId);
      if (a.task.targetId !== undefined) claimedNow.add(a.task.targetId);
    }
    for (const a of sim.agents) {
      if (a.claimed && !claimedNow.has(a.id)) a.claimed = false;
    }

    const forms = sim.agents.filter((a) => !a.dead && isActiveFloodForm(a));
    const infection = forms.filter((a) => a.faction === FACTION.INFECTION);
    const combat = forms.filter((a) => a.faction === FACTION.COMBAT);
    const carriers = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER && a.hp > 0);

    const bodies = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
    const I = infection.length;
    const C = combat.length;
    const K = carriers.length;
    const S = this.scarcity(I + K * 2); // carriers embody future forms
    this.lastScarcity = S;

    // ALL IN (endgame closure): when the hive's mass dwarfs the few
    // believed survivors, it stops counting and rises as one — muster
    // thresholds and door-holds drop, every form converges. Without this a
    // 150-form hive besieged 6 rifles forever (probe timeouts).
    const mass = I + C * 2 + K * 2;
    const wasAllIn = this.allIn;
    const wasSearchingAll = this.searchingAll;
    const wasDominant = this.combatDominant;
    this.combatDominant = this.combatDominates(C);
    // mass-ratio trigger against CONFIDENT beliefs only (a raw count kept
    // every human ever seen; a count cap never fired — hiding civilians
    // kept the believed-survivor count high while 150 forms besieged 6
    // rifles)
    let believedAlive = 0;
    for (const b of this.beliefs.values()) if (b.static || b.conf > 0.15) believedAlive++;
    // THE COUNTER CLOSES THE GAME (user redesign): when the hive's own kill
    // ledger says the garrison is nearly spent, it stops tip-toeing — the
    // armed resistance is what stood between it and the ship.
    // No confident position does not mean no prey. Once every contact is lost,
    // free appendages search the topology whether or not the hive is strong
    // enough for an all-in assault. Production and carrier guards remain
    // committed; dominance still ends caution even before prey is reacquired.
    const searchAll = believedAlive === 0 && this.beliefs.size > 0;
    this.searchingAll = searchAll;
    this.allIn = (believedAlive > 0 && this.combatDominant)
      || (believedAlive > 0 && mass >= 50 && mass >= believedAlive * 3)
      || (this.marinesBelieved <= 3 && mass >= 25 && believedAlive > 0);
    if (this.searchingAll && !wasSearchingAll) sim.log('hive',
      'the hive has lost contact with the last prey — free forms sweep every compartment');
    if (this.allIn && !wasAllIn) sim.log('hive',
      'the hive rises as one — every form converges for the end');
    if (this.combatDominant && !wasDominant) sim.log('hive',
      `${C} combat forms overwhelm the hive's estimate of ${this.marinesBelieved} marines — caution ends`);

    // POSTURE (user: evasive hit-and-run early, aggressive once strong). Early —
    // few carriers or a small pool — the hive RUNS: it slips off to hit soft
    // targets and disperses, but does NOT gang up on the marines. Once carriers
    // are seated and the pool has grown (scarcity crosses ~1.0) it flips
    // AGGRESSIVE and the rampage/muster hunt comes online. Modeled on allIn.
    // A garrison the counter says is broken flips it aggressive outright.
    const wasAggro = this.posture === 'AGGRESSIVE';
    this.posture = ((K >= 2 && S <= 1.05) || this.combatDominant
      || this.allIn || this.marinesBelieved <= 2) ? 'AGGRESSIVE' : 'EVASIVE';
    // DEBUG READOUT (user: a flood strength/number indicator). Every one of
    // these already drives a decision above — mass gates allIn, S gates the
    // posture flip, believedAlive is the denominator of the mass ratio, and
    // marinesLeft is the hive's own kill ledger — so the panel shows the
    // hive's reasoning rather than a parallel metric that could disagree
    // with it. Refreshed on the 2.5 s strategic tick, not per frame.
    this.stats = { I, C, K, bodies: bodies.length, mass, S, believedAlive,
      marinesLeft: this.marinesBelieved, combatDominant: this.combatDominant,
      allIn: this.allIn, searchingAll: this.searchingAll,
      posture: this.posture, opening: this.opening };
    if (this.posture === 'AGGRESSIVE' && !wasAggro) sim.log('hive', 'the hive turns from hit-and-run to open aggression');

    // re-validate queued paths against current beliefs: a route planned two
    // rounds ago may now run through a manned corridor. COMMITTED INFECTS are
    // exempt (user: infect-a-body cycles stuttering) — a form already en route
    // to burrow a specific corpse / raise a downed form kept having its path
    // dropped here every 2.5 s when the body lay near believed humans, so it
    // re-pathed forever and never arrived. Once committed to a body it goes.
    for (const f of forms) {
      if (f.task?.kind === TASK.CONVERT || f.task?.kind === TASK.REANIMATE || f.task?.retreat) continue;
      // An assault is expected to end in defended ground. Revalidate only its
      // intermediate route; treating the destination itself as a newly unsafe
      // surprise erased every breach path on the next strategic tick.
      const checkThrough = f.task?.kind === TASK.ATTACK ? f.path.length - 1 : f.path.length;
      if (f.path.length && f.path.some((s, i) => i < checkThrough
        && (this.believedHumanStr[s.to] > 0.5 || this.believedHardness[s.to] > 0.4))) {
        f.path = [];
      }
    }

    // §6.4 EVADE runs in every mode: pull forms out of nodes the marines own.
    this.evade(forms, carriers);

    if (this.opening && !this.combatDominant) {
      this.openingMove(infection, combat, bodies);
      this.protectCarriers(combat, carriers, S);
      if (sim.firstSweepCleared) {
        this.opening = false;
        sim.log('hive', 'hive hands off to steady-state economy (first sweep has passed)');
      }
      return;
    }
    if (this.opening) {
      this.opening = false;
      sim.log('hive', 'overwhelming combat strength ends the opening — every surviving marine is hunted');
    }
    this.steadyState(infection, combat, carriers, bodies, I, C, K, S);
  }

  // §6.4 evade: any form standing where believed hardness beats local flood
  // strength runs for the quietest reachable node. Overrides economy tasks
  // (but not a sprung ambush — those forms are the trap).
  evade(forms, carriers) {
    const sim = this.sim;
    for (const f of forms) {
      // A combat form that can see live guns must choose now: attack when its
      // local pack clears the odds, otherwise withdraw. This deliberately
      // outranks staged muster holds — waiting on the other side of an open
      // door is still volunteering to be shot. No escape means it is cornered
      // and retreatOrFight marks the attack forced.
      if (f.faction === FACTION.COMBAT) {
        const { defense, threatNode } = this.combatLineOfSight(f);
        if (defense > 0 && threatNode !== -1) {
          if (!this.isRetreating(f)) {
            this.respondToCombat(f, threatNode, !!f.task?.surge);
          }
        }
        continue;
      }
      // never interrupt a rooting carrier — losing the 4s transform to an
      // evade/rampage yank was why the hive stopped producing carriers
      if (f.task?.kind === TASK.ATTACK
        || f.task?.kind === TASK.TRANSFORM) continue;
      // a form staged for a muster holds its ground — the gathering point is
      // deliberately near the target, and evade would bleed the muster dry
      if (f.task?.kind === TASK.GUARD && f.task.muster !== undefined) continue;
      // a form LATCHED ONTO a victim finishes or dies — evade was yanking it
      // off every round, the reflex re-grabbed instantly, and the 7s
      // conversion timer restarted forever (victim pinned, never taken)
      if (f.state === STATE.GRABBING) continue;
      const threat = this.localThreat(f.node);
      const own = sim.influence.floodStr[f.node];
      if (threat > Math.max(own, 0.8)) {
        // Infection forms may take the duct network; combat forms still use
        // the ordinary ship graph through doors, ladders, lifts, and stairs.
        const safe = this.quietNodeNear(f.node, f.faction === FACTION.INFECTION ? 'infection' : 'combat');
        if (safe !== -1 && safe !== f.node) {
          this.assign(f, { kind: TASK.MOVE, node: safe, evade: true });
        }
      }
    }
    for (const c of carriers) {
      const threat = this.localThreat(c.node);
      // A carrier is the flood's WOMB — slow, precious, helpless in a fight, and
      // it must HIDE, never wander toward guns. localThreat folds in the
      // adjacent rooms, and the flood now senses life through the bulkheads.
      // (1) NEVER WALK TOWARD THE GUNS (user: carriers trundle toward marines
      //     next door even sitting idle, no one coming at them). Drop any route
      //     whose NEXT step or FAR end is no safer than standing put — a womb
      //     holds still and hides rather than march into a gun line.
      if (c.path.length) {
        const next = this.localThreat(c.path[0].to);
        const dest = this.localThreat(c.path[c.path.length - 1].to);
        if (next > threat || dest >= Math.max(0.35, threat)) c.path = [];
      }
      // (2) actively relocate away only when the guns get close, and only along
      //     a route that never steps toward them (else HOLD — hiding beats
      //     walking past a marine). Skip if already slipping somewhere quiet.
      if (threat > 0.7) {
        const dest = c.path.length ? c.path[c.path.length - 1].to : c.node;
        const headingSomewhereSafe = c.path.length && this.localThreat(dest) <= 0.6;
        if (!headingSomewhereSafe) {
          const safe = this.quietNodeNear(c.node, 'big');
          if (safe !== -1 && safe !== c.node && this.localThreat(safe) < threat) {
            const path = this.stealthPath(c.node, safe, 'big');
            if (path && !path.some((s) => this.localThreat(s.to) > threat)) {
              sim.setPath(c, path);
              if (sim.t - (c._fleeLogAt ?? -99) > 25) {
                c._fleeLogAt = sim.t;
                sim.log('hive', `a carrier slips away from the guns toward ${sim.graph.node(safe).name}`);
              }
            }
          }
        }
      }
    }
  }

  quietNodeNear(from, kind) {
    const g = this.sim.graph;
    const reach = g.nodesWithin(from, 4, this._layersFor(kind), this._passFor(kind));
    let best = -1, bestScore = -Infinity;
    for (const n of reach) {
      if (g.burningUntil[n] > this.sim.t) continue;
      let score = -this.localThreat(n) * 3 + this.sim.influence.floodStr[n] * 0.5;
      const nd = g.node(n);
      if (nd.roles.includes('maintenance') || nd.roles.includes('cargo')) score += 0.7;
      score -= this.trafficPenalty(n) * 0.4;
      if (this.exitCount(n) < 2) score -= 1.5;
      if (n === from) score -= 0.5;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // Where a pod diving into the grate should surface: the quietest room the
  // hive senses empty of guns, biased toward its own mass and toward decks
  // the counter says are unmarined. O(n) scan, only run when a pod is
  // actually bolting for its life. Deterministic (score, then lowest index).
  ventBoltTarget(from) {
    const g = this.sim.graph;
    let best = -1, bestScore = -Infinity;
    for (let n = 0; n < g.n; n++) {
      if (n === from) continue;
      if (!this.infectionSurfaceSafe(n)) continue;
      const score = -this.localThreat(n) * 2
        + this.sim.influence.floodStr[n] * 0.5
        + this.radioDark(g.node(n).deck)
        - this.trafficPenalty(n) * 0.3;
      if (score > bestScore + 1e-9) { bestScore = score; best = n; }
    }
    return best;
  }

  // RADIO-DARK DECKS (user): the marines' distress net only lands reliably
  // on their own deck, and the hive "knows" it — a deck with no marines
  // hears nothing and answers slowly, so it's prime growth space. When the
  // squads cluster onto one deck, every other deck gets darker. Returns a
  // 0..2 bonus for how safe a deck is to operate on. Cached per tick.
  radioDark(deck) {
    // the radio-dark growth incentive STANDS DOWN at the end (user report:
    // during the last stand every other deck reads dark, and the bonus was
    // actively pulling the hive AWAY from the line it should be storming)
    if (this.allIn) return 0;
    if (this._darkTick !== this.sim.tickCount) {
      this._darkTick = this.sim.tickCount;
      const byDeck = {};
      let alive = 0;
      for (const a of this.sim.agents) {
        if (a.dead || a.hp <= 0 || a.faction !== FACTION.MARINE) continue;
        alive++;
        const dk = this.sim.graph.node(a.node).deck;
        byDeck[dk] = (byDeck[dk] ?? 0) + 1;
      }
      const maxD = Math.max(0, ...Object.values(byDeck));
      this._darkCluster = alive ? maxD / alive : 1; // no marines left: everywhere is dark
      this._darkByDeck = byDeck;
    }
    const m = this._darkByDeck[deck] ?? 0;
    return m === 0 ? 1 + this._darkCluster : m <= 2 ? 0.5 * this._darkCluster : 0;
  }

  // Score every plausible den node near the breach (out of the sweep's
  // sightline, quiet, defensible, ideally sitting on carrier food).
  denCandidates(maxHops = 3) {
    const sim = this.sim, g = sim.graph;
    const bodies0 = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CORPSE && a.damage < 100);
    const bodyAt = new Set(bodies0.map((b) => b.node));
    const sweepLOS = new Set(sim.visibleNodes(g.breachNode));
    const out = [];
    for (const n of g.nodes) {
      const d = g.hops(g.breachNode, n.idx, ['std'], this.bigPass);
      if (d === -1 || d < 1 || d > maxHops || sweepLOS.has(n.idx)) continue;
      const route = this.stealthPath(g.breachNode, n.idx, 'big');
      if (!route) continue;
      let score = -this.localThreat(n.idx) * 3 - this.routeRisk(route) * 2.5;
      if (n.roles.includes('maintenance')) score += 1;
      if (n.roles.includes('cargo') || n.roles.includes('corpse_cache')) score += 1;
      if (bodyAt.has(n.idx)) score += 1.2; // carrier food already on site
      if (n.type === 'corridor' && !n.roles.includes('maintenance')) score -= 2;
      if (n.type === 'open') score -= 2;
      score -= this.trafficPenalty(n.idx);
      score += Math.min(this.garrisonDist[n.idx] === -1 ? 4 : this.garrisonDist[n.idx], 4) * 0.5;
      if (this.exitCount(n.idx) < 2) score -= 3;
      score -= d * 0.2;
      // radio-dark bonus: an unmarined deck is worth claiming, and the more
      // the marines bunch up on one deck, the more the dark decks pay
      score += this.radioDark(n.deck) * 1.8;
      out.push({ node: n.idx, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // Pick up to `count` den sites that are spread apart (>=2 hops), so the
  // hive hedges its opening across several hiding spots instead of stacking
  // everything in one room (user note: it over-concentrates early).
  pickDenSites(count) {
    const g = this.sim.graph;
    const cand = this.denCandidates(3);
    const chosen = [];
    for (const c of cand) {
      if (chosen.length >= count) break;
      if (chosen.every((s) => g.hops(s, c.node, ['std'], this.bigPass) >= 2)) chosen.push(c.node);
    }
    if (!chosen.length && cand.length) chosen.push(cand[0].node);
    return chosen;
  }

  // THE OPENING SPREAD (user redesign): count the crash room's larder; that
  // many forms stay to eat. Every spare rides the ducts out and disperses —
  // one to the medbay when its grate is safe, otherwise to the nearest quiet
  // soft room; the rest spread out. Never choose a marine muster post or a
  // room beside one. On the lower decks at least one pod leaves even when
  // the crash room has more corpses than pods. Computed once (the
  // assignment map is remembered), so the plan survives re-planning ticks.
  _openingSpread(infection, bodies) {
    if (this._spreadPlan) return this._spreadPlan;
    const sim = this.sim, g = sim.graph;
    const plan = new Map();
    const larder = bodies.filter((b) => b.node === g.breachNode
      && (!sim.P.hive.openingCountUsableBodies || (!b.dead && b.damage < 100))).length;
    // A fixed fraction is available for paired seed experiments. The normal
    // rule keeps one form per crash-site body, so no opening food is stranded.
    const configured = sim.P.hive.openingVentFraction;
    const fraction = configured === 'deck-adaptive'
      ? (g.node(g.breachNode).deck >= 5 ? null : 0)
      : configured;
    const ventCount = fraction === null
      ? Math.max(g.node(g.breachNode).deck >= 4 && infection.length > 1 ? 1 : 0,
        infection.length - larder)
      : Math.max(0, Math.min(infection.length,
        Math.round(infection.length * Math.max(0, Math.min(1, fraction)))));
    // forms sorted by id: the first group stays to eat, the rest spreads
    const sorted = [...infection].sort((a, b) => a.id - b.id);
    const spares = sorted.slice(sorted.length - ventCount);
    if (!spares.length) { this._spreadPlan = plan; return plan; }
    // candidate soft spots: living/soft/medical/storage spaces, no marine
    // posts, nothing beside a marine post, never the breach itself
    const posts = new Set();
    for (const n of g.nodes) {
      if (this.staticGarrison(n.idx) > 0) {
        posts.add(n.idx);
        for (const { to } of g.neighbors(n.idx, ['std'], () => true)) posts.add(to);
      }
    }
    const cands = g.nodes.filter((n) =>
      n.idx !== g.breachNode && !posts.has(n.idx) && this.infectionSurfaceSafe(n.idx)
      && (n.roles.includes('soft') || n.roles.includes('quarters') || n.roles.includes('medbay')
        || n.roles.includes('cargo') || n.roles.includes('maintenance') || n.roles.includes('corpse_cache')));
    // spread metric in real meters: fore-aft + same-deck beam + a heavy deck
    // term, so the fan crosses decks instead of lining up one corridor
    const dist = (a, b) => Math.abs(a.x - b.x)
      + (a.deck === b.deck ? Math.abs(a.y - b.y) : 0)
      + Math.abs(a.deck - b.deck) * 30;
    const chosen = [];
    const medbay = g.byId.get('medbay');
    if (medbay !== undefined && !posts.has(medbay) && this.infectionSurfaceSafe(medbay)) {
      chosen.push(medbay);
    } else if (medbay !== undefined && cands.length) {
      // Armed crew make a lone pod's medbay landing a trap. Give its
      // opening slot to the nearest quiet soft room instead of sending it
      // across guarded corridors to a grate it already has in this room.
      chosen.push(cands.reduce((best, node) =>
        dist(node, g.node(medbay)) < dist(best, g.node(medbay)) ? node : best).idx);
    }
    while (chosen.length < spares.length && cands.length) {
      let best = -1, bestScore = -Infinity;
      for (const n of cands) {
        if (chosen.includes(n.idx)) continue;
        let minD = Infinity;
        for (const c of chosen) minD = Math.min(minD, dist(n, g.node(c)));
        if (chosen.length === 0) minD = dist(n, g.node(g.breachNode));
        const score = Math.min(minD, 120)
          + Math.min(this.garrisonDist[n.idx] === -1 ? 6 : this.garrisonDist[n.idx], 6) * 4;
        if (score > bestScore + 1e-9) { bestScore = score; best = n.idx; }
      }
      if (best === -1) break;
      chosen.push(best);
    }
    if (!chosen.length) { this._spreadPlan = plan; return plan; }
    spares.forEach((f, i) => plan.set(f.id, chosen[i % chosen.length]));
    this._spreadPlan = plan;
    sim.log('hive', `the spare forms slip into the ducts — fanning out to ${chosen.slice(0, 4).map((n) => g.node(n).name).join(', ')}${chosen.length > 4 ? '…' : ''}`);
    return plan;
  }

  // Visible pressure plus a broken production line creates its own rear guard:
  // root the safest one or two bodies and screen the approaches. This is phase
  // independent — a cornered opening pocket has the same reproductive need as
  // a steady-state one — and depends only on live geometry and scarcity.
  pressureCarrierSeeds(combat, I, K, S, wantK) {
    const sim = this.sim, g = sim.graph, C = combat.length;
    const pressureHumans = new Map();
    for (const c of combat) {
      for (const human of sim.lineOfSightAgents(c, (a) => a.faction === FACTION.MARINE
        || a.faction === FACTION.ARMED)) pressureHumans.set(human.id, human);
    }
    const pressured = K === 0 && I < 3 && S >= 2 && C >= 5 && pressureHumans.size > 0;
    if (!pressured) {
      this._pressureSeedLogged = false;
      for (const c of combat) if (c.task?.screen !== undefined) c.task = null;
      return;
    }
    const threatNodes = [...new Set([...pressureHumans.values()].map((a) => a.pnode ?? a.node))];
    const threatDist = g.flowField(threatNodes, ['std'], this.bigPass).dist;
    const rooting = combat.filter((c) => c.task?.kind === TASK.TRANSFORM);
    const desiredRoots = Math.min(2, wantK, Math.max(1, Math.floor(C / 3)));
    const candidates = combat.filter((c) => !c.fromPlayer && !c.downed
      && c.task?.kind !== TASK.TRANSFORM && c.taskProgress === 0 && !c.move
      && sim.humansAt(c.pnode ?? c.node) === 0 && !this.isCombatCommitted(c))
      .sort((a, b) => {
        const visibleA = sim.lineOfSightAgents(a, (h) => h.faction === FACTION.MARINE
          || h.faction === FACTION.ARMED).length;
        const visibleB = sim.lineOfSightAgents(b, (h) => h.faction === FACTION.MARINE
          || h.faction === FACTION.ARMED).length;
        if (visibleA !== visibleB) return visibleA - visibleB;
        const da = threatDist[a.pnode ?? a.node], db = threatDist[b.pnode ?? b.node];
        if (da !== db) return (db === -1 ? g.n : db) - (da === -1 ? g.n : da);
        return (this.localThreat(a.pnode ?? a.node) - this.localThreat(b.pnode ?? b.node))
          || (a.id - b.id);
      });
    const occupiedRoots = new Set(rooting.map((c) => c.pnode ?? c.node));
    for (const candidate of candidates) {
      if (rooting.length >= desiredRoots) break;
      const node = candidate.pnode ?? candidate.node;
      if (occupiedRoots.has(node)) continue;
      this.assign(candidate, { kind: TASK.TRANSFORM, pressured: true });
      rooting.push(candidate);
      occupiedRoots.add(node);
    }
    if (!rooting.length) return;
    const screens = rooting.map((seed) => {
      let bestPath = null;
      for (const threatNode of threatNodes) {
        const path = g.path(seed.pnode ?? seed.node, threatNode, ['std'], this.bigPass);
        if (path && (!bestPath || path.length < bestPath.length)) bestPath = path;
      }
      return { seed, node: bestPath?.[0]?.to ?? (seed.pnode ?? seed.node) };
    });
    const availableGuards = combat.filter((guard) => {
      const task = guard.task;
      if (guard.fromPlayer || guard.taskProgress > 0 || task?.kind === TASK.TRANSFORM) return false;
      if (!task) return true;
      if (task.retreat || task.seed || task.raid || task.muster !== undefined) return false;
      if (task.kind === TASK.DECOY || task.kind === TASK.DART) return false;
      if (task.kind === TASK.ATTACK && (task.force || task.surge || guard.state === STATE.FIGHT)) return false;
      return true;
    });
    // Two bodies per seed can delay an approach without turning every combat
    // form into a sentry. Keep roughly a third of the pocket mobile so it can
    // raid, provoke pursuit, or become the next carrier if this seed fails.
    const mobileReserve = Math.max(1, Math.floor(C / 3));
    const guardBudget = Math.min(rooting.length * 2,
      Math.max(0, C - rooting.length - mobileReserve));
    const chosenGuards = new Set();
    for (let slot = 0; slot < guardBudget && availableGuards.length; slot++) {
      let chosenIndex = -1, chosenScreen = screens[0], bestHops = Infinity;
      for (let index = 0; index < availableGuards.length; index++) {
        const guard = availableGuards[index];
        for (const screen of screens) {
          const hops = g.hops(guard.pnode ?? guard.node, screen.node, ['std'], this.bigPass);
          if (hops !== -1 && (hops < bestHops
            || (hops === bestHops && (guard.id < (availableGuards[chosenIndex]?.id ?? Infinity)
              || (guard.id === availableGuards[chosenIndex]?.id && screen.seed.id < chosenScreen.seed.id))))) {
            chosenIndex = index;
            chosenScreen = screen;
            bestHops = hops;
          }
        }
      }
      if (chosenIndex === -1) break;
      const guard = availableGuards.splice(chosenIndex, 1)[0];
      this.assign(guard, { kind: TASK.GUARD, node: chosenScreen.node, screen: chosenScreen.seed.id });
      chosenGuards.add(guard.id);
    }
    // The reserve is not a passive third line. Send it toward quiet ground
    // beside the nearest gun line so it draws eyes and radio traffic away
    // from the rooting carriers, then lets the ordinary decoy executor evade.
    // This stays graph-derived: no room names or scenario coordinates.
    const disruptors = [];
    for (let index = 0; index < Math.min(mobileReserve, availableGuards.length); index++) {
      const form = availableGuards[index];
      const threatNode = threatNodes[index % threatNodes.length];
      const staging = this.stagingNodeNear(threatNode);
      const show = staging !== -1 ? staging : (form.pnode ?? form.node);
      if (form.move) sim._interruptMove(form);
      this.assign(form, { kind: TASK.DECOY, show, stage: 0, pressured: true });
      disruptors.push(form.id);
    }
    for (const guard of combat) {
      if (guard.task?.screen === undefined || chosenGuards.has(guard.id)) continue;
      if (guard.move) sim._interruptMove(guard);
      guard.task = null;
    }
    if (!this._pressureSeedLogged) {
      this._pressureSeedLogged = true;
      sim.log('hive', `the cornered hive roots ${rooting.length} rear carrier seed${rooting.length === 1 ? '' : 's'} behind a ${chosenGuards.size}-form screen while ${disruptors.length} disruptor${disruptors.length === 1 ? '' : 's'} draw the guns`);
    }
  }

  // Shared coverage planner for every mobile appendage. The target ordering
  // comes from current Flood occupancy and the live graph; ids distribute the
  // work, while each form's own movement layer decides how to get there.
  sweepTarget(form, targets, kind) {
    const g = this.sim.graph;
    for (let i = 0; i < targets.length; i++) {
      const node = targets[(form.id + i) % targets.length].idx;
      if (node === form.node) continue;
      if (kind === 'infection' && (this.localThreat(node) > 1
        || g.burningUntil[node] > this.sim.t)) continue;
      if (kind === 'combat' && !this.searchPath(form.node, node)) continue;
      return node;
    }
    return -1;
  }

  searchPath(from, to) {
    return this.sim.graph.path(from, to, ['std'], this.searchPass);
  }

  // --- §6.7/§13.5 the opening: a timed smash-and-grab ---
  openingMove(infection, combat, bodies) {
    const sim = this.sim, g = sim.graph;
    this.sweepEtaSec = this.estimateSweepEta();
    const margin = sim.P.hive.openingSweepMargin;
    const timeLeft = this.sweepEtaSec === Infinity ? 999 : this.sweepEtaSec;
    const mustRun = timeLeft < margin;

    if (!this.denSites) {
      this.denSites = this.pickDenSites(3);
      this.carrierSite = this.denSites[0] ?? -1;
      sim.log('hive', `hive splits toward ${this.denSites.map((n) => g.node(n).name).join(', ')} (est. sweep in ${timeLeft === 999 ? '?' : Math.round(timeLeft)}s)`);
    }
    const dens = this.denSites;
    const homeFor = (id) => dens[id % dens.length];
    const breachBodies = bodies.filter((b) => b.node === g.breachNode && !b.claimed);
    const coverageTargets = g.nodes.slice().sort((a, b) =>
      (sim.influence.floodStr[a.idx] - sim.influence.floodStr[b.idx]) || (a.idx - b.idx));

    // combat forms: haul breach bodies out to the dens as carrier food (one
    // per den), the rest screen their assigned den
    let draggers = combat.filter((c) => c.task?.kind === TASK.DRAG).length;
    for (const c of combat) {
      if (c.task && c.task.kind !== TASK.GUARD) continue;
      const home = homeFor(c.id);
      const homeHasBody = bodies.some((b) => b.node === home);
      if (timeLeft > 20 && draggers < dens.length && !homeHasBody && breachBodies.length) {
        const body = breachBodies.shift();
        body.claimed = true;
        this.assign(c, { kind: TASK.DRAG, corpseId: body.id, node: home });
        draggers++;
      } else if (!c.task) {
        this.assign(c, { kind: TASK.GUARD, node: this.scatterNode(home, c.id, 'big') });
      }
    }

    // infection forms (user redesign): the bodies in the crash room get eaten
    // by as many forms as there are bodies (floodExec's arrive-and-eat rule
    // claims them the same tick), and every SPARE form makes straight for the
    // room's grate and rides the duct network out — one toward the medbay
    // when that exit is quiet, the rest fanned as wide across the ship as
    // the soft spots allow, never into a marine muster post or its neighbor.
    const plan = this._openingSpread(infection, bodies);
    for (const f of infection) {
      if (f.task && f.task.kind !== TASK.MOVE) continue;
      const target = plan.get(f.id);
      if (target !== undefined) {
        if (f.node !== target || f.move || f.path.length) {
          if (f.task?.node !== target) this.assign(f, { kind: TASK.MOVE, node: target, spread: true });
          continue;
        }
        // Reaching the frozen opening destination completes that assignment.
        // Reissuing MOVE to the room already underfoot made the pod a permanent
        // sentry there; clear it so the coverage fallback chooses another room.
        if (f.task?.kind === TASK.MOVE) f.task = null;
      }
      // a form staying for the larder: grab anything completable in time
      if (!f.task) {
        const grab = this.bestGrab(f, 0.6, timeLeft);
        if (grab) this.assign(f, grab);
        else {
          // The opening spread is intentionally frozen, but carriers create
          // new ids after it is built. Those newborn pods still need orders;
          // nearby bodies override SCOUT in floodExec, while every spare fans
          // out through a quiet grate instead of circling the nursery.
          const sweep = this.sweepTarget(f, coverageTargets, 'infection');
          if (sweep !== -1) this.assign(f, { kind: TASK.SCOUT, node: sweep, sweep: true });
        }
      }
    }

    // DECOY (user note): during the opening, one combat form runs AWAY from
    // the den sites to get itself seen — luring the sweep and triggering
    // radio calls somewhere the carriers aren't, then slipping into evade.
    // Buying time is worth one form's risk.
    if (!this.decoySent && combat.length >= 3) {
      this.decoySent = true;
      const decoy = combat.find((c) => !c.task || c.task.kind === TASK.GUARD);
      if (decoy) {
        // show node: reachable, far from every den, toward believed humans
        let show = -1, bestScore = -Infinity;
        for (const n of g.nodes) {
          if (this.staticGarrison(n.idx) > 0) continue; // show yourself NEAR them, never IN their room
          const d = g.hops(decoy.node, n.idx, ['std'], this.bigPass);
          if (d === -1 || d < 2 || d > 5) continue;
          let minDen = Infinity;
          for (const den of dens) {
            const dd = g.hops(n.idx, den, ['std'], this.bigPass);
            if (dd !== -1) minDen = Math.min(minDen, dd);
          }
          const score = Math.min(minDen, 6) * 1.0 + this.believedHumanStr[n.idx] * 1.5 - d * 0.2;
          if (score > bestScore) { bestScore = score; show = n.idx; }
        }
        if (show !== -1) {
          this.assign(decoy, { kind: TASK.DECOY, show, stage: 0 });
          sim.log('bait', `a combat form breaks cover toward ${g.node(show).name} — drawing the sweep off the dens`);
        }
      }
    }

    // START PRODUCTION: root the initial combat forms across the available
    // carriers at quiet dens (carriers are converted combat forms — user
    // economy). It's a carrier rush (§13.4), and a carrier mints its first
    // form within seconds, so this stands up production immediately while the
    // rest of the combat forms guard.
    const carriersNow = sim.agents.filter((a) => !a.dead && a.faction === FACTION.CARRIER).length;
    let transforming = combat.filter((c) => c.task?.kind === TASK.TRANSFORM).length;
    const wantCarriers = Math.min(dens.length, 3);
    for (const den of dens) {
      if (carriersNow + transforming >= wantCarriers) break;
      if (this.localThreat(den) >= 0.6) continue;
      if (sim.agents.some((a) => !a.dead && a.faction === FACTION.CARRIER && a.node === den)) continue;
      const cf = combat.find((c) => c.node === den && !c.move && !c.fromPlayer
        && (!c.task || c.task.kind === TASK.GUARD || c.task.kind === TASK.DRAG));
      if (cf) { this.assign(cf, { kind: TASK.TRANSFORM }); transforming++; }
    }
    // and keep the military up: an infection form sitting on a den body turns
    // it into a fresh combat form to replace the ones that just rooted
    for (const den of dens) {
      if (this.localThreat(den) >= 0.6) continue;
      const feed = bodies.find((b) => b.node === den && !b.claimed);
      const former = infection.find((f) => f.node === den && !f.move && !f.path.length
        && (!f.task || f.task.kind === TASK.MOVE));
      if (feed && former && combat.length < 4) { feed.claimed = true; this.assign(former, { kind: TASK.CONVERT, corpseId: feed.id }); }
    }

    // The opening plan can fail before its scattered den forms arrive. If
    // visible guns have already cornered the colony and production is empty,
    // use the same geometry-driven rear seed/screen response as steady state.
    this.pressureCarrierSeeds(
      combat,
      infection.length,
      carriersNow,
      this.scarcity(infection.length + carriersNow * 2),
      wantCarriers,
    );
  }

  // spread forms among a site and its quiet neighbors (no deathballs), but
  // never out onto an artery — the main corridors are where the forms were
  // getting mown down in transit
  scatterNode(site, salt, kind) {
    const g = this.sim.graph;
    const opts = [site];
    for (const { to } of g.neighbors(site, this._layersFor(kind), this._passFor(kind))) {
      if (this.localThreat(to) < 0.6 && !g.hasRole(to, 'artery') && g.node(to).type !== 'open') opts.push(to);
    }
    return opts[salt % opts.length];
  }

  // --- steady state: §13.3 utility over candidate actions ---
  steadyState(infection, combat, carriers, bodies, I, C, K, S) {
    const sim = this.sim, g = sim.graph, P = sim.P;
    const riskAversion = P.hive.riskBase * S;
    // Sorted once per strategic round. If all confident contacts disappear,
    // form ids fan the combat mass across the least occupied live graph nodes;
    // no room names or authored search route are involved.
    const coverageTargets = g.nodes.slice().sort((a, b) =>
      (sim.influence.floodStr[a.idx] - sim.influence.floodStr[b.idx]) || (a.idx - b.idx));
    const shouldSweep = this.searchingAll || this.allIn;
    const sweepTargets = shouldSweep ? coverageTargets : [];

    // 1. AGGRESSION IS LOCAL (user note): each region decides hide-vs-rampage
    //    on its OWN situation, independent of the global pool. A pocket of
    //    forms standing over undefended civilians goes loud even while the
    //    hive is scarce elsewhere; a pocket with marines in it hides even
    //    while the hive is rich. A region rampages iff it has local
    //    superiority over the humans there, enough local mass to matter, and
    //    no real marine presence to punish it (that's an evade zone instead).
    const rampaging = new Set();
    // EVASIVE hit-and-run (user): pockets stay quiet — no going loud, no muster —
    // until the hive is strong (posture flips AGGRESSIVE). Early forms disperse
    // and hit soft targets instead of ganging up on the marines.
    if (this.posture === 'AGGRESSIVE') for (const n of g.nodes) {
      const region = g.nodesWithin(n.idx, 1, ['std'], () => true);
      let fs = 0, hs = 0, hard = 0;
      for (const r of region) {
        fs += sim.influence.floodStr[r];
        hs += this.believedHumanStr[r];
        hard += this.believedHardness[r];
      }
      if (fs >= P.swarm.attackRatio * Math.max(hs, 0.3)
        && fs >= P.rampage.localReserve
        && hard < P.rampage.marineCap) rampaging.add(n.idx);
    }
    if (rampaging.size > 0 && !this.rampageLogged) {
      this.rampageLogged = true;
      sim.log('rampage', `flood pockets go loud where the crew is undefended (${rampaging.size} region(s))`);
    }

    // 2. carrier production is the RATIO LEVER (user economy): a spare combat
    //    form roots into a carrier. Target enough carriers to snowball
    //    (§13.4 needs K>=2), scaling with the force; only spend a combat form
    //    on it when there's a genuine surplus (still >=1 combat per carrier),
    //    and only in a safe, defensible node spread from the other carriers.
    // REPRODUCTION IS THE FIRST INSTINCT (user note): with no carriers the
    // hive roots one NOW, whatever else is happening — production precedes
    // defense, hunting, everything.
    // MAX BREEDING while a muster is banned for lack of numbers (user rule):
    // the hive wants more carriers than usual until the force catches up
    const earlyFloor = sim.t < 240 ? 3 : 2;
    let wantK = Math.min(5, earlyFloor + Math.floor((I + C) / 22));
    if (sim.t < (this._breedUntil ?? 0)) wantK = Math.min(6, wantK + 2);
    const seedingK = combat.reduce((count, form) => count
      + (form.task?.kind === TASK.TRANSFORM || form.task?.seed ? 1 : 0), 0);
    const plannedK = K + seedingK;
    // Unclaimed bodies are stored growth. While food remains, scale the
    // production line with the combat population: one carrier can replenish
    // roughly its own full rupture of fighters. Body count caps that extra
    // investment, and walking/rooting seeds count so the planner drafts only
    // one replacement at a time instead of stripping the search wave.
    const freeBodies = bodies.reduce((count, body) => count + (!body.claimed ? 1 : 0), 0);
    if (freeBodies > 0) {
      const bodyBackedK = Math.min(Math.ceil(C / P.carrier.maxInfectionForms), K + freeBodies);
      wantK = Math.max(wantK, bodyBackedK);
    }
    if (seedingK === 0 && plannedK < wantK && (C > K || K === 0)) {
      // a form raised from the PLAYER never roots into a carrier (game rule);
      // a form staged in a LIVE MUSTER is normally off-limits too: drafting
      // the army repeatedly would eat its own soldiers. The exception is a
      // completely empty production line: reserve one seed to restart it.
      const spares = combat.filter((c) => !c.fromPlayer && !c.downed && c.hp > 0
        && !this.isCombatCommitted(c)
        && (!c.task || (c.task.kind === TASK.GUARD
          && (c.task.muster === undefined || (I === 0 && K === 0)))
          || c.task.kind === TASK.MOVE || c.task.kind === TASK.ATTACK || c.task.kind === TASK.SCOUT));
      // A safe isolated form is already a viable carrier site. Root it in
      // place before asking it to cross the ship: this closes the failure mode
      // where the last combat form keeps walking toward an ideal den and dies
      // before reproduction starts (user report: Charon-9 lone survivor).
      const localSeed = spares.filter((c) => !c.move && this.localThreat(c.node) < 0.5)
        .sort((a, b) => (this.localThreat(a.node) - this.localThreat(b.node)) || (a.id - b.id))[0];
      if (localSeed) this.assign(localSeed, { kind: TASK.TRANSFORM });
      else {
        const target = this.bestCarrierNode();
        if (target !== -1) {
          const c = this.nearest(spares, target, ['std'], this.bigPass);
          if (c) {
            // seed: true protects the walk from the rampage muster — production
            // precedes war, and re-drafting the seed form every round starved
            // the hive of carriers entirely (deadlock: no carriers -> no
            // infection forms -> no conversions -> the muster can never fill)
            if (c.node === target && !c.move && this.localThreat(target) < 0.5) this.assign(c, { kind: TASK.TRANSFORM });
            else this.assign(c, { kind: TASK.GUARD, node: target, seed: true });
          }
        }
      }
    }

    // 2a. Visible pressure can force a rear-seed response in every phase.
    this.pressureCarrierSeeds(combat, I, K, S, wantK);

    // 2b. DESPERATION (user note): reduced to a handful of combat forms with no
    //     carriers and no pool, a rational hive rebuilds — it does NOT just
    //     hide and wait to be shot. The safest-positioned form roots into a
    //     carrier to restart production; the rest pull back to the quietest
    //     ground they can reach. This is the last-ditch survival play.
    // When it's down to a few combat forms and nothing else, EVERY one of
    // them hides and roots into a carrier (user note) — the last soldiers
    // become the seed stock, full stop. No hunting, no guarding, no waiting.
    const desperate = K === 0 && I < 6 && combat.length <= 4;
    if (desperate) {
      for (const c of combat) {
        if (c.downed || c.task?.kind === TASK.TRANSFORM) continue;
        // a form that has been hunting quiet ground for half a minute roots
        // WHEREVER it is — the perfect den it kept walking toward left the
        // last survivor wandering for a quarter hour instead of seeding
        c.desperateSince ??= sim.t;
        const overdue = sim.t - c.desperateSince > 30;
        if ((this.localThreat(c.node) < 0.9 || overdue) && !c.move && !c.fromPlayer) {
          this.assign(c, { kind: TASK.TRANSFORM });
        } else {
          const quiet = this.quietNodeNear(c.node, 'big');
          if (quiet !== -1 && quiet !== c.node) this.assign(c, { kind: TASK.GUARD, node: quiet });
          else if (!c.move) this.assign(c, { kind: TASK.TRANSFORM }); // nowhere safer — root here
        }
      }
      if (!this._desperateLogged) {
        this._desperateLogged = true;
        this.sim.log('hive', 'the last combat forms go to ground to seed new carriers');
      }
    } else {
      for (const c of combat) c.desperateSince = undefined;
    }
    this._desperate = desperate;

    // 2c. SOFT-TARGET RAID (user note): the hive KNOWS the medbay and the
    //     other soft rooms are likely unguarded — the same shared map that
    //     pins the marines' believed positions marks everywhere else safe.
    //     Once the opening carrier base is met (3+ seated or seeding,
    //     dispersed), one spare combat form slips off early to massacre,
    //     distract, and MAKE BODIES: the screaming pulls squads across the
    //     ship while the dens keep breeding, and the dead feed conversion.
    {
      const seeding = combat.reduce((n, c) => n + (c.task?.kind === TASK.TRANSFORM || c.task?.seed ? 1 : 0), 0);
      const raider = this._raiderId !== undefined ? sim.byId.get(this._raiderId) : null;
      const raiderLive = raider && !raider.dead && !raider.downed && raider.hp > 0;
      if (!raiderLive) this._raiderId = undefined;
      if (!this.allIn && (this.posture === 'EVASIVE' || K + seeding >= 3) && !raiderLive && sim.t >= (this._raidCooldownUntil ?? 0)) {
        let bestT = -1, bestS = 0.5;
        for (const n of g.nodes) {
          if (!n.roles.includes('soft') && !n.roles.includes('medbay')) continue;
          if (this.believedHardness[n.idx] > 0.3) continue; // believed guarded — not this one
          // radio-dark decks make better hunting: the screaming brings help
          // late or not at all
          const s = this.believedHumanStr[n.idx] - this.believedHardness[n.idx] * 2
            + this.radioDark(n.deck) * 1.2;
          if (s > bestS) { bestS = s; bestT = n.idx; }
        }
        if (bestT !== -1) {
          const spares = combat.filter((c) => !c.fromPlayer && !c.downed
            && (!c.task || (c.task.kind === TASK.GUARD && c.task.muster === undefined
              && !c.task.seed && c.task.screen === undefined && c.task.protect === undefined)));
          const r = this.nearest(spares, bestT, ['std'], this.combatPass);
          if (r) {
            this._raiderId = r.id;
            this._raidCooldownUntil = sim.t + 60;
            this.assign(r, { kind: TASK.ATTACK, node: bestT, raid: true });
            sim.log('rampage', `a combat form slips off to raid ${g.node(bestT).name} — soft target, likely unguarded`);
          }
        }
      }
    }

    // 3. dynamic carrier defense—the same scarcity-driven planner used during
    //    the opening, so successfully seating the first carrier immediately
    //    turns the surrounding combat forms into a real fallback screen.
    this.protectCarriers(combat, carriers, S);

    // 4. rampage: combat forms in hot regions attack believed humans openly
    //    (infection forms swarm through the grab scoring below — rampage
    //    scarcity makes those grabs near-free). MUSTER DOCTRINE (user rule):
    //    the flood never assaults a position it doesn't outnumber ~2:1 — it
    //    stages nearby and gathers mass first, then everyone goes in.
    for (const f of combat) {
      // ALL-IN drafts GLOBALLY (user report: forms with free reign of the
      // ship never joined the endgame push): the rampage-pocket gate only
      // conscripted forms already standing near the fight — everyone
      // breeding three decks away sat the assault out forever
      if (!this.allIn && !this.searchingAll && !rampaging.has(f.node)) continue;
      if (f.task?.retreat) {
        if (!this.combatDominant) continue;
        if (f.move) sim._interruptMove(f);
        f.path = [];
        f.task = null;
      }
      // When all confident contacts have decayed, an old room-level ATTACK is
      // no longer an objective. Clear its physical leg so the graph sweep can
      // redistribute the army; otherwise dozens of forms can keep charging an
      // empty compartment forever while the last survivors sit elsewhere.
      if (f.task?.kind === TASK.ATTACK) {
        if (this.lockedCombatTarget(f)) continue;
        if (!this.searchingAll) continue;
        if (f.move) sim._interruptMove(f);
        f.path = [];
        f.task = null;
        sim._setCharging(f, false);
      }
      if (f.task?.kind === TASK.TRANSFORM) continue; // a rooting carrier is not a soldier
      if (!this.combatDominant
        && (f.task?.seed || f.task?.screen !== undefined || f.task?.protect !== undefined)) continue; // production detail is off-limits until dominance makes every fighter expendable
      // Once the counter calls all-in, a gun line is an objective rather than
      // a reason to report every survivor beyond it as unreachable.
      const target = this.allIn ? this.nearestAllInHuman(f.node) : this.nearestBelievedHuman(f.node);
      if (target === -1) {
        if (shouldSweep) {
          // Keep a live topology sweep stable only while there is genuinely
          // no prey to pursue. A newly refreshed human belief must interrupt
          // scouting immediately instead of leaving the army walking past it.
          if (f.task?.kind === TASK.SCOUT && f.task.sweep
            && (f.move || f.path.length || f.node !== f.task.node)) continue;
          const sweep = this.sweepTarget(f, sweepTargets, 'combat');
          if (sweep !== -1) this.assign(f, { kind: TASK.SCOUT, node: sweep, sweep: true });
        }
        continue;
      }
      const ban = this._musterBan?.get(target);
      if (ban && sim.t < ban.until && combat.length < ban.needed) continue; // breeding until the numbers exist
      const defense = this.believedHumanStr[target] + this.believedHardness[target];
      if (defense > 0.8) {
        // a defended position is NEVER attacked piecemeal: every form stages
        // first, and step 4b launches the whole muster together once the
        // gathered mass clears the ratio. THE STAGE IS PINNED per target
        // (60 s): recomputing it per form per round made it flap with every
        // belief shift — forms walked forever toward a moving rally point
        // and the muster never actually massed (measured: 96 staged rounds,
        // zero with two arrivals standing together).
        const stage = this.pinnedStage(target);
        if (stage !== -1) {
          const until = (f.task?.kind === TASK.GUARD && f.task.muster === target)
            ? f.task.until : sim.t + 90;
          this.assign(f, { kind: TASK.GUARD, node: stage, muster: target, until });
          if (sim.t >= (this._musterLogAt ?? 0)) {
            this._musterLogAt = sim.t + 30;
            sim.log('hive', `the hive masses outside ${g.node(target).name} — waiting for the numbers`);
          }
        }
        continue;
      }
      this.assign(f, { kind: TASK.ATTACK, node: target });
    }

    // 4b. LAUNCH THE MUSTER (user rule): staged forms go in TOGETHER once
    //     the mass that has actually ARRIVED at the staging ground clears
    //     attackRatio against the believed defense — never one at a time. A
    //     muster that can't fill in 90s gives its forms back to the economy.
    {
      const staged = new Map(); // target -> staged combat forms
      for (const f of combat) {
        const t = f.task;
        if (t?.kind !== TASK.GUARD || t.muster === undefined) continue;
        if (sim.t > t.until) { f.task = null; continue; }
        if (!staged.has(t.muster)) staged.set(t.muster, []);
        staged.get(t.muster).push(f);
      }
      this._musterStart ??= new Map();
      this._musterBan ??= new Map();
      for (const [target, forms] of staged) {
        const defense = this.believedHumanStr[target] + this.believedHardness[target];
        // a wave past maxMusterForms overwhelms ANY line — never keep waiting
        // for 2x a fear-inflated estimate of the defense.
        // ALL-IN IS A WAVE, NOT A GREEN LIGHT (user report: the last stand
        // was trickled): needed=1 under allIn launched every staged form the
        // moment it arrived — solo, in single file, into the guns. The
        // zerg rush gathers MOST of the living force and goes in together
        // (the 75s patience valve below still breaks any stall).
        const needed = this.combatDominant
          ? Math.min(P.swarm.maxMusterForms, Math.max(4,
            Math.ceil(this.believedHumanStr[target] * P.swarm.dominationRatio)))
          : this.allIn
          ? Math.min(P.swarm.maxMusterForms, Math.max(4, Math.ceil(combat.length * 0.6)))
          : Math.min(defense * P.swarm.attackRatio, P.swarm.maxMusterForms);
        const arrived = forms.filter((f) => !f.move && f.node === f.task.node).length;
        if (defense <= 0.8 || arrived >= needed) {
          this._musterStart.delete(target);
          for (const f of forms) this.assign(f, { kind: TASK.ATTACK, node: target });
          sim.log('rampage', `the muster is up — ${forms.length} forms storm ${g.node(target).name} together`);
          // BACKUP OPTIONS (user rule): a hive with no carrier seated when it
          // commits an assault peels ONE spare form to go root somewhere
          // quiet — if the attack breaks, the future is already growing.
          if (!sim.agents.some((a) => !a.dead && a.faction === FACTION.CARRIER && a.hp > 0)) {
            const spare = combat.find((c) => !c.fromPlayer && !c.downed
              && (!c.task || (c.task.kind === TASK.GUARD && c.task.muster === undefined
                && !c.task.seed && c.task.screen === undefined && c.task.protect === undefined)));
            if (spare) {
              const den = this.quietNodeNear(spare.node, 'big');
              if (den !== -1) this.assign(spare, { kind: TASK.GUARD, node: den, seed: true });
            }
          }
          continue;
        }
        // DOOR BAIT (user tactic): the pack is staged near the target, short
        // of the attack ratio, holding DEAD STILL — invisible to a motion
        // tracker. One
        // form runs to the defended room, shows itself, and doubles straight
        // back to the motionless pack. A defender who follows the blip walks
        // into everyone (the spring in floodExec fires the tick a human
        // enters the stage room). From any stage within two doors — the
        // runner pays the walk; the trap is the stillness.
        {
          const stage = forms[0].task.node;
          const dartLive = forms.some((f) => f.task?.kind === TASK.DART);
          if (!dartLive && arrived >= 2 && sim.t >= (this._dartAt?.get(target) ?? 0)) {
            // humanPass, not an inline closure: hops() keys its flow-field
            // cache on the predicate's identity — a fresh closure per call
            // minted a fresh BFS + a dead cache entry every dart check
            const hopsIn = g.hops(stage, target, ['std'], humanPass);
            if (hopsIn !== -1 && hopsIn <= 2) {
              const darter = forms.filter((f) => !f.move && f.node === stage)
                .sort((a, b) => a.id - b.id)[0];
              if (darter) {
                (this._dartAt ??= new Map()).set(target, sim.t + 45);
                this.assign(darter, { kind: TASK.DART, into: target, back: stage, muster: target, stage: 0 });
                sim.log('bait', `a form shows itself at ${g.node(target).name} and slips back — the pack lies dead still`);
              }
            }
          }
        }
        // PATIENCE HAS LIMITS (user report: standoffs where the hive
        // "musters and sits or trickles in"): a wave staged for over a
        // minute at 60%+ of the target number goes anyway — a fear-inflated
        // defense estimate must never hold a real army in place forever
        const stagedSince = this._musterStart.get(target);
        if (stagedSince !== undefined && sim.t - stagedSince > 75
          && arrived >= Math.max(3, needed * 0.6)) {
          this._musterStart.delete(target);
          for (const f of forms) this.assign(f, { kind: TASK.ATTACK, node: target, force: true });
          sim.log('rampage', `the hive tires of waiting — ${forms.length} forms storm ${g.node(target).name}`);
          continue;
        }
        // NUMBERS FIRST (user rule): if every combat form the hive owns
        // still couldn't meet the ratio, waiting is pointless. But before
        // giving up: RAISE THE DEAD. Every wave that broke on this line left
        // its downed in front of it — reanimating that pile (1 infection form
        // each) is far cheaper than breeding a new army. Only when the pile
        // plus every living form still can't make the number does the hive
        // turn to pure breeding.
        if (combat.length < needed) {
          const raisable = sim.agents.filter((d) => !d.dead && d.faction === FACTION.COMBAT
            && d.downed && d.damage < 100 && !d.claimed
            && !sim.occupants(d.pnode ?? d.node).some((h) => h.hp > 0 && !h.dead
              && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)));
          const medics = infection.filter((f) => !f.move && !f.path.length
            && (!f.task || f.task.kind === TASK.MOVE || f.task.kind === TASK.SCOUT));
          if (raisable.length > 0) {
            // the numbers ARE within reach (they're lying on the deck) — this
            // is not a breeding emergency, it's a recovery operation
            this._breedUntil = 0;
            // raise as many as this round's free forms allow — progress every
            // round beats an all-or-nothing check that throws the pile away
            // whenever the medics happen to be busy converting elsewhere
            let k = 0;
            while (k < raisable.length && k < medics.length && combat.length + k < needed + 2) {
              const d = raisable[k];
              d.claimed = true;
              this.assign(medics[k], { kind: TASK.REANIMATE, targetId: d.id });
              k++;
            }
            if (k) sim.log('hive', `the hive raises its dead — ${k} downed forms reclaimed for the ${g.node(target).name} muster`);
            // hold the muster together while the dead stand up
            for (const f of forms) f.task.until = Math.max(f.task.until ?? 0, sim.t + 60);
            continue;
          }
          this._musterStart.delete(target);
          this._musterBan.set(target, { until: sim.t + 300, needed });
          this._breedUntil = sim.t + 300;
          for (const f of forms) f.task = null;
          sim.log('hive', `the hive cannot make the numbers for ${g.node(target).name} — everything turns to breeding`);
          continue;
        }
        // force exists but is tied up elsewhere: give recruitment a couple of
        // minutes, then release this muster too
        if (!this._musterStart.has(target)) this._musterStart.set(target, sim.t);
        const spareCount = combat.filter((c) => !c.task
          || (c.task.kind === TASK.GUARD && c.task.muster === undefined
            && !c.task.seed && c.task.screen === undefined && c.task.protect === undefined)).length;
        if (sim.t - this._musterStart.get(target) > 120 && forms.length + spareCount < needed) {
          this._musterStart.delete(target);
          this._musterBan.set(target, { until: sim.t + 180, needed });
          for (const f of forms) f.task = null;
          sim.log('hive', `the hive breaks off the muster at ${g.node(target).name} — not enough mass; it turns back to breeding`);
          continue;
        }
        // RECRUIT (user rule: "they muster first"): a muster that is short
        // actively pulls spare combat forms in from across the ship —
        // waiting for whoever happened to drift into a rampage pocket
        // deadlocked a 100-form hive outside a 6-marine line forever
        if (forms.length < needed + 2) {
          const stage = forms[0].task.node;
          const spares = combat.filter((c) => !c.task
            || (c.task.kind === TASK.GUARD && c.task.muster === undefined
              && !c.task.seed && c.task.screen === undefined && c.task.protect === undefined));
          const ranked = spares
            .map((c) => ({ c, d: g.hops(c.node, stage, ['std'], this.bigPass) }))
            .filter((x) => x.d !== -1)
            .sort((x, y) => (x.d - y.d) || (x.c.id - y.c.id));
          let strength = forms.length;
          for (const { c } of ranked) {
            if (strength >= needed + 2) break;
            this.assign(c, { kind: TASK.GUARD, node: stage, muster: target, until: sim.t + 90 });
            strength++;
          }
        }
        // while the muster is genuinely filling, the early arrivals wait for
        // the walkers instead of timing out one by one
        if (forms.length >= needed) {
          for (const f of forms) f.task.until = Math.max(f.task.until, sim.t + 30);
        }
      }
    }

    // 5. idle infection forms turn bodies into combat forms and hunt the crew
    //    (§6.5 priority). Conversion is UNCAPPED (user rule): every safe
    //    corpse on the ship is a guaranteed combat form, and the combat force
    //    is what fills the musters and roots into carriers.
    for (const f of infection) {
      // why: a task can become invalid mid-crawl while its old vent move is
      // still finishing. Claiming a new body then makes the pod emerge from
      // the wrong grate before doubling back; finish the physical leg first.
      if (f.task || f.move || f.path.length) continue;
      // LOW-HANGING CORPSES FIRST (user rule): the ship is littered with
      // bodies and every SAFE one is a guaranteed combat form — multiplying
      // always beats hunting or marching on guns. The muster is built from
      // corpses; nearestBody refuses bodies inside a remembered gun line.
      // a downed form within a couple of rooms is the LOWEST-hanging body of
      // all (user rule generalized): raising it is a 2 s conversion that
      // stands up right where the fighting is, vs a 7 s conversion after a
      // walk across the ship
      // the 2-hop neighborhood is identical for every candidate — hoisted out
      // of the find() predicate (perf pass 3: it used to re-run a fresh BFS
      // per scanned agent, thousands of times per strategic tick late game)
      const nearSet = new Set(sim.nodesNear(f.node, 2));
      const closeDowned = sim.agents.find((d) => !d.dead && d.faction === FACTION.COMBAT
        && d.downed && d.damage < 100 && !d.claimed
        && nearSet.has(d.pnode ?? d.node)
        && !sim.occupants(d.pnode ?? d.node).some((h) => h.hp > 0 && !h.dead
          && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)));
      if (closeDowned) {
        closeDowned.claimed = true;
        this.assign(f, { kind: TASK.REANIMATE, targetId: closeDowned.id });
        continue;
      }
      const body = this.nearestBody(f, bodies);
      if (body) { body.claimed = true; this.assign(f, { kind: TASK.CONVERT, corpseId: body.id }); continue; }
      const grab = this.bestGrab(f, riskAversion, null, S);
      if (grab) { this.assign(f, grab); continue; }
      // reanimate a downed form: cheaper than a fresh conversion (§13.3) —
      // but not one lying under a shooter's boots. "Kill zone" is judged in
      // REAL SPACE: a body in a room no living shooter physically occupies is
      // fair game even right outside a hard line — that pile of downed forms
      // in front of a last stand is the hive's cheapest army.
      const downed = sim.agents.find((d) => !d.dead && d.faction === FACTION.COMBAT && d.downed && d.damage < 100 && !d.claimed
        && (this.believedHardness[d.node] <= 0.5
          || !sim.occupants(d.pnode ?? d.node).some((h) => h.hp > 0 && !h.dead
            && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED))));
      if (downed && 2.0 - S * 1.0 > 0) {
        downed.claimed = true;
        this.assign(f, { kind: TASK.REANIMATE, targetId: downed.id });
        continue;
      }
      // When the shared mind knows prey remains but has lost every position,
      // every free pod joins the same graph-wide coverage plan as the combat
      // forms. Nurseries remain production bases, never parking lots.
      if (this.searchingAll) {
        const sweep = this.sweepTarget(f, sweepTargets, 'infection');
        if (sweep !== -1) this.assign(f, { kind: TASK.SCOUT, node: sweep, sweep: true });
        continue;
      }
      // A rich pool searches aggressively. Smaller nurseries still send every
      // spare pod through the safe vent network: holding a ring of idle forms
      // beside a carrier neither protects it nor finds another host.
      if (I >= P.hive.searchMinPool && sim.rng.chance(0.3)) {
        // sweep everywhere, command deck included — the survivors hide in
        // rooms (§13.7: only a rich hive can afford to look)
        this.assign(f, { kind: TASK.SCOUT, node: sim.rng.int(g.n) });
        continue;
      }
      // NO IDLING (user note): an infection form with nothing better to do is
      // wasted currency. It speeds toward the closest known corpse or believed
      // civilian and stages there as a pack — the swarm forms where the food is.
      const rally = this.nearestFoodNode(f);
      if (rally !== -1 && f.node !== rally) {
        this.assign(f, { kind: TASK.MOVE, node: rally, rally: true });
      } else {
        const sweep = this.sweepTarget(f, coverageTargets, 'infection');
        if (sweep !== -1) this.assign(f, { kind: TASK.SCOUT, node: sweep, sweep: true });
      }
    }

    // 5b. pack escorts (user note): infection forms travel in packs, and a
    //     pack moving with combat forms converts more reliably. For every ~3
    //     forms rallying on a node, peel one spare combat form to escort it.
    {
      const rallyCounts = new Map();
      for (const f of infection) {
        if (f.task?.kind === TASK.MOVE && f.task.rally) {
          rallyCounts.set(f.task.node, (rallyCounts.get(f.task.node) || 0) + 1);
        }
      }
      for (const [node, count] of rallyCounts) {
        const want = Math.floor(count / P.swarm.escortPer);
        if (want < 1) continue;
        const escorts = combat.filter((c) => c.task?.kind === TASK.GUARD && c.task.node === node).length;
        if (escorts >= want) continue;
        const free = combat.filter((c) => !c.task);
        const e = this.nearest(free, node, ['std'], this.bigPass);
        if (e) this.assign(e, { kind: TASK.GUARD, node });
      }
    }


    // 6b. squad-wipe (user note): an isolated squad the hive can hit 2:1
    //     gets hit NOW, losses accepted, while a reserve exists elsewhere.
    this.trySquadWipe(infection, combat, carriers, I);

    // 7. spare combat forms HUNT civilians for bodies while steering clear of
    //    marines (user note): they are the hive's body-harvesters. A combat
    //    form kills a spotted civilian in ~1s, so a civilian that radios is
    //    just a free corpse — the marines are coming anyway, rack up the body
    //    and slip away; an infection form converts it later. Static, known
    //    targets (the wounded, the officers who won't move) come first because
    //    the hive always knows exactly where they are.
    // This is a LOCAL decision, not a global one (user note): carriers get
    // their guards first (step 3), and every SPARE form then hunts whatever
    // safe, undefended prey is near it — nearestHuntNode already refuses to
    // walk into marines, so a form only goes loud where its own surroundings
    // are safe, whatever the global pool is doing elsewhere.
    for (const c of combat) {
      // Plain guard orders were also used as idle parking. Once arrived,
      // release them for real work; retain live production/defense orders.
      const t = c.task;
      if (t?.kind === TASK.GUARD && !c.move && c.node === t.node
        && !t.seed && !t.retreat && t.muster === undefined
        && t.screen === undefined && t.protect === undefined) c.task = null;
      if (c.task) continue;
      // when desperate the survivors rebuild and hide (handled in 2b) — they
      // don't go hunting into the guns
      const prey = this._desperate ? -1 : this.nearestHuntNode(c.node);
      if (prey !== -1 && (prey !== c.node || sim.humansAt(c.pnode ?? c.node) > 0)) {
        this.assign(c, { kind: TASK.ATTACK, node: prey }); continue;
      }
      // With no reachable prey, search the live topology instead of parking
      // at an obsolete carrier site. Dedicated carrier guards were assigned
      // above; a surplus fighter must keep gathering information.
      const sweep = this.sweepTarget(c, coverageTargets, 'combat');
      if (sweep !== -1) this.assign(c, { kind: TASK.SCOUT, node: sweep, sweep: true });
    }
  }

  // score grab candidates per §13.3; returns a task or null.
  // openingTimeLeft non-null => opening gate (§13.5). S taxes the form cost.
  bestGrab(form, riskAversion, openingTimeLeft = null, S = 1) {
    const sim = this.sim, P = sim.P;
    let best = null, bestU = 0;
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || b.conf < 0.25) continue;
      if (h.faction === FACTION.MARINE) continue; // only via bait/ambush (§6.5)
      const path = this.safeInfectionPath(form.node, b.node);
      if (!path) continue;
      // REAL SECONDS, NOT STEP COUNT (review finding): a duct transit is ONE
      // step whatever the distance — path.length priced a 90 s cross-ship
      // crawl as a corridor hop, voiding the §13.5 "completable before the
      // sweep" gate and making steady-state target choice distance-blind.
      // Sum the route's actual time and convert to equivalent corridor hops
      // for the cap and the utility penalty (same conversion infectionHops uses).
      let etaSec = 0;
      for (const s of path) etaSec += s.layer === 'vent' ? sim.travelSec(s.link, 1) : sim.graph.linkCost(s.link);
      const hops = Math.max(path.length, Math.ceil(etaSec / (sim.graph.avgStdLenM / 1.4)));
      if (openingTimeLeft !== null) {
        if (etaSec + P.combat.infectionGrabSec > openingTimeLeft - P.hive.openingSweepMargin) continue;
        if (hops > 3) continue;
      }
      let value;
      if (h.helpless) value = P.hive.values.helpless;
      else if (h.faction === FACTION.CIVILIAN) {
        value = h.hasRadio ? P.hive.values.civilianRadio : P.hive.values.civilianNoRadio;
        // only weigh the distress cost if the alarm HASN'T been raised yet.
        // Once a target has already called, the sweep is coming regardless —
        // grabbing it is pure upside now, no penalty (user note).
        if (!h.calledOut) {
          if (this.believedHumanStr[b.node] > 0.4) value -= P.hive.values.distressPenalty * 0.5;
          if (h.hasRadio) value -= P.hive.values.distressPenalty * 0.3;
        }
      } else value = P.hive.values.armed - (this.believedHumanStr[b.node] > 0.6 ? 1.0 : 0);
      // static, always-known targets (the wounded, the officers) are the
      // surest conversions — the hive never loses their position (user note)
      if (h.helpless || h.stayPut) value += 1.0;
      const risk = this.routeRisk(path);
      // U = value·conf − scarcity·formCost − riskAversion·risk − timeCost (§13.3)
      const U = value * b.conf - S * 0.35 - riskAversion * 0.25 * risk - hops * 0.06;
      if (U > bestU) { bestU = U; best = { kind: TASK.GRAB, targetId: id } }
    }
    return best;
  }

  // Best node to root a new carrier: quiet, defensible, near our own mass,
  // and spread from existing carriers so production isn't one clearable cluster.
  bestCarrierNode() {
    const g = this.sim.graph;
    const carrierNodes = this.sim.agents
      .filter((a) => !a.dead && a.faction === FACTION.CARRIER).map((a) => a.node);
    // bodies per node (+ spillover to neighbors): a carrier rooted on food
    // means every minted form converts within seconds of being born
    const bodyAt = new Float32Array(g.n);
    for (const b of this.sim.agents) {
      if (b.dead || b.faction !== FACTION.CORPSE || b.damage >= 100) continue;
      bodyAt[b.node] += 1;
      for (const { to } of g.neighbors(b.node, ['std'], () => true)) bodyAt[to] += 0.3;
    }
    // SURVIVAL DOCTRINE (user note): the opening goal is to survive and
    // sustain — production must be DISPERSED (enough carriers in enough
    // different spots that no single sweep ends the hive) and sited where
    // the hive believes marines AREN'T. One form's sighting is the whole
    // hive's map: a known marine position implies everywhere else is safer.
    const marineNodes = [];
    for (const [id, b] of this.beliefs) {
      const h = this.sim.byId.get(id);
      if (h && !h.dead && h.hp > 0 && h.faction === FACTION.MARINE && b.conf >= 0.4) marineNodes.push(b.node);
    }
    const marineDist = marineNodes.length
      ? g.flowField(marineNodes, ['std'], () => true).dist : null;
    let best = -1, bestScore = 0.2; // need a genuinely good spot
    for (const n of g.nodes) {
      const idx = n.idx;
      if (g.burningUntil[idx] > this.sim.t) continue;
      if (this.localThreat(idx) > 0.4) continue;
      if (this.exitCount(idx) < 2) continue;
      let score = this.sim.influence.floodStr[idx] * 0.6;   // near our own forms
      // ROOT WHERE THE BODIES ARE (user rule) — but never in a spot cut off
      // from the swarm: an isolated carrier is a free kill
      score += Math.min(bodyAt[idx], 8) * 0.35;
      if (this.sim.influence.floodStr[idx] < 0.05) score -= 1.2; // known isolation
      if (n.roles.includes('maintenance') || n.roles.includes('cargo') || n.roles.includes('corpse_cache')) score += 1;
      if (n.type === 'corridor' || n.type === 'open') score -= 1.5;
      score -= this.trafficPenalty(idx) * 0.5;
      score += Math.min(this.garrisonDist[idx] === -1 ? 4 : this.garrisonDist[idx], 4) * 0.25;
      if (marineDist) {
        const d = marineDist[idx];
        score += Math.min(d === -1 ? 6 : d, 6) * 0.3; // far from every believed marine
      }
      if (carrierNodes.length) {
        let near = Infinity;
        for (const cn of carrierNodes) { const d = g.hops(idx, cn, ['std'], this.bigPass); if (d !== -1) near = Math.min(near, d); }
        if (near === 0) continue;                 // already a carrier here
        if (near === 1) score -= 2.5;             // next door = one sweep kills both
        if (near !== Infinity) score += Math.min(near, 5) * 0.5;
      }
      if (score > bestScore) { bestScore = score; best = idx; }
    }
    return best;
  }


  staleBeliefs() {
    for (const [id, b] of this.beliefs) {
      const h = this.sim.byId.get(id);
      if (h && h.faction === FACTION.MARINE && b.conf > 0.5) return false;
    }
    return true;
  }

  nearest(list, node, layers, pass) {
    let best = null, bestD = Infinity;
    for (const a of list) {
      const d = this.sim.graph.hops(a.node, node, layers, pass);
      if (d !== -1 && d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  nearestBody(form, bodies) {
    let best = null, bestD = Infinity;
    for (const b of bodies) {
      if (b.claimed) continue;
      // a corpse inside a remembered gun line isn't food, it's bait: eating
      // it would stand a fresh combat form up straight into the kill zone.
      // Tightened (user: infection forms ALWAYS avoid marines) — any real
      // believed marine presence rules the room out, not just a strong line.
      if (this.believedHardness[b.node] > 0.15 || this.localThreat(b.node) > 1.2) continue;
      // duct-aware distance: every body on the ship is reachable now
      const d = this.infectionHops(form.node, b.node);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  // Where a combat form goes to make bodies. Combines live belief with the
  // hive's standing knowledge of where the crew lives (absorbed crew memory):
  // quarters, mess, medbay and cryo are always worth checking even with no
  // current contact — that's how it "seeks out civilians as soon as able."
  // Marine-held nodes are avoided (hide from the guns, hunt the soft).
  nearestHuntNode(from) {
    const memo = this._routeMemo('hunt');
    const hit = memo.get(from);
    if (hit !== undefined) return hit;
    const r = this._nearestHuntNode(from);
    memo.set(from, r);
    return r;
  }
  _nearestHuntNode(from) {
    const sim = this.sim, g = sim.graph;
    // population prior per node from live beliefs...
    const prior = new Float32Array(g.n);
    for (const [id, b] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || h.faction === FACTION.MARINE) continue;
      let w = b.conf * (h.helpless || h.stayPut ? 3 : 1); // static = surest bodies
      prior[b.node] += w;
    }
    // ...plus a standing prior on crew spaces, so it hunts population centers
    // even when every contact has gone cold
    for (const n of g.nodes) {
      if (n.roles.includes('quarters') || n.roles.includes('soft')) prior[n.idx] += 0.6;
      if (n.roles.includes('helpless') || n.roles.includes('medbay') || n.roles.includes('brig')) prior[n.idx] += 1.2;
    }
    let best = -1, bestScore = 0.4; // need a real reason to move out
    for (const n of g.nodes) {
      if (prior[n.idx] <= 0) continue;
      if (this.believedHardness[n.idx] > 0.5) continue;   // marines here — skip
      if (this.localThreat(n.idx) > 1.0) continue;        // garrison/armory area
      // prey you can only reach by walking through a gun line isn't prey
      const p = this.safeAssaultPath(from, n.idx);
      if (!p || p.length > 7) continue;
      const score = prior[n.idx] - p.length * 0.3;
      if (score > bestScore) { bestScore = score; best = n.idx; }
    }
    return best;
  }

  // Closest thing an infection form can eat or convert: a corpse, or a
  // believed civilian position. Skips marine-held ground.
  nearestFoodNode(form) {
    const sim = this.sim;
    let best = -1, bestD = Infinity;
    for (const b of sim.agents) {
      if (b.dead || b.faction !== FACTION.CORPSE || b.damage >= 100) continue;
      if (b.claimed) continue;
      if (this.believedHardness[b.node] > 0.15 || this.localThreat(b.node) > 1.2) continue;
      const d = this.infectionHops(form.node, b.node);
      if (d < bestD) { bestD = d; best = b.node; }
    }
    for (const [id, bel] of this.beliefs) {
      const h = sim.byId.get(id);
      if (!h || h.dead || h.hp <= 0 || h.faction === FACTION.MARINE || bel.conf < 0.3) continue;
      if (this.believedHardness[bel.node] > 0.15) continue;
      // why: arriving at an old contact's room already disproved that belief;
      // returning the current node here strands the pod until the memory fades.
      if (bel.node === form.node && (h.pnode ?? h.node) !== form.node) continue;
      const d = this.infectionHops(form.node, bel.node);
      if (d < bestD) { bestD = d; best = bel.node; }
    }
    return best;
  }

  // §swarm-kill (user note): an ISOLATED squad the hive can muster 2:1 on
  // gets hit immediately, losses accepted, as long as the hive keeps a
  // reserve (forms or a carrier) elsewhere. Eliminating the main threat is
  // worth trading currency for.
  trySquadWipe(infection, combat, carriers, I) {
    const sim = this.sim, g = sim.graph, P = sim.P.swarm;
    if (sim.t < 60) return; // no set-piece attacks in the first minute (user rule)
    if (sim.t < (this.squadWipeCooldownUntil ?? 0)) return;
    for (const squad of sim.squads) {
      if (squad.broken) continue;
      const members = squad.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (!members.length) continue;
      const leader = members[0];
      const bel = this.beliefs.get(leader.id);
      if (!bel || bel.conf < 0.6) continue; // must have a solid fix
      // isolated: no OTHER squad believed within isolationHops
      let isolated = true;
      for (const other of sim.squads) {
        if (other === squad || other.broken) continue;
        const oLeader = sim.byId.get(other.members[0]);
        if (!oLeader || oLeader.dead) continue;
        const ob = this.beliefs.get(oLeader.id);
        if (!ob || ob.conf < 0.3) continue;
        const d = g.hops(bel.node, ob.node, ['std'], humanPass);
        if (d !== -1 && d <= P.isolationHops) { isolated = false; break; }
      }
      if (!isolated) continue;
      // muster: every form within musterHops. Odds are sized against EVERYONE
      // believed to be holding that ground — a "squad" standing on a last-
      // stand line with three dozen armed crew is not an 8-gun target, and
      // sizing against the squad alone fed wave after wave into the grinder.
      const squadW = Math.max(members.length,
        this.believedHumanStr[bel.node] + this.believedHardness[bel.node]);
      const muster = [];
      let musterW = 0;
      for (const f of [...combat, ...infection]) {
        if (f.task?.kind === TASK.TRANSFORM) continue;
        if (f.task?.retreat) continue;
        if (f.task?.protect !== undefined) continue;
        const d = f.faction === FACTION.INFECTION
          ? this.infectionHops(f.node, bel.node)
          : g.hops(f.node, bel.node, ['std'], this.bigPass);
        if (d !== -1 && d <= P.musterHops) { muster.push(f); musterW += f.faction === FACTION.COMBAT ? 1 : 0.25; }
      }
      // reserve rule: only trade the swarm for marines if the hive keeps a
      // future (a carrier or a pool) somewhere else
      const reserveOk = carriers.length > 0 || I - muster.filter((m) => m.faction === FACTION.INFECTION).length >= 0
        ? (carriers.length > 0 || I >= P.reserveForms) : false;
      if (musterW >= squadW * P.attackRatio && reserveOk && muster.length) {
        for (const f of muster) this.assign(f, { kind: TASK.ATTACK, node: bel.node });
        this.squadWipeCooldownUntil = sim.t + 45;
        sim.log('rampage', `the hive springs on isolated squad ${squad.id + 1} in ${g.node(bel.node).name} (${muster.length} forms, ${musterW.toFixed(1)}:${squadW} odds)`);
        return;
      }
    }
  }

  // weighted flood mass within `hops` of a node — what the hive could bring
  // to an assault there
  musterStrength(node, hops = 2) {
    const near = new Set(this.sim.graph.nodesWithin(node, hops, ['std'], () => true));
    let s = 0;
    for (const a of this.sim.agents) {
      if (a.dead || a.hp <= 0 || a.downed) continue;
      if (a.faction === FACTION.COMBAT && near.has(a.node)) s += 1;
      else if (a.faction === FACTION.INFECTION && near.has(a.node)) s += 0.25;
    }
    return s;
  }

  // a quiet gathering point 1-2 hops from a defended target. ADJACENCY IS
  // WORTH REAL POINTS (user tactic): a pack staged one door away can spring
  // the moment a defender steps in, and it is the only place the door-bait
  // dart can run from — a stage two rooms back can do neither.
  stagingNodeNear(target) {
    const g = this.sim.graph;
    const adj = new Set((g.adj.std[target] ?? []).filter((e) => !e.link.locked).map((e) => e.to));
    let best = -1, bestScore = -Infinity;
    for (const n of g.nodesWithin(target, 2, ['std'], this.bigPass)) {
      if (n === target) continue;
      const score = -this.localThreat(n) * 2 - (g.hasRole(n, 'artery') ? 0.5 : 0)
        + (adj.has(n) ? 0.8 : 0);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // the pinned stage for a muster target — held for 60 s so arrivals stack
  // up on ONE node instead of chasing every belief shift
  pinnedStage(target) {
    const cur = (this._stageFor ??= new Map()).get(target);
    if (cur && this.sim.t < cur.until) return cur.node;
    const n = this.stagingNodeNear(target);
    if (n !== -1) this._stageFor.set(target, { node: n, until: this.sim.t + 60 });
    return n;
  }

  nearestBelievedHuman(from) {
    const memo = this._routeMemo('nbh');
    const hit = memo.get(from);
    if (hit !== undefined) return hit;
    const r = this._nearestBelievedHuman(from);
    memo.set(from, r);
    return r;
  }

  // Endgame target selection uses the live topology but deliberately stops
  // routing around remembered gun lines. This is still belief-driven—the hive
  // attacks only places where it thinks humans remain—but a defended corridor
  // can no longer hide every room behind it from an overwhelming force.
  nearestAllInHuman(from) {
    const memo = this._routeMemo('nbh');
    const key = `all:${from}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = -1, bestScore = -Infinity;
    for (let n = 0; n < this.sim.graph.n; n++) {
      if (this.believedHumanStr[n] <= 0.05) continue;
      const path = this.sim.graph.path(from, n, ['std'], this.bigPass);
      if (!path) continue;
      const score = this.believedHumanStr[n] - path.length * 0.2;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    memo.set(key, best);
    return best;
  }
  _nearestBelievedHuman(from) {
    let best = -1, bestScore = -Infinity;
    for (let n = 0; n < this.sim.graph.n; n++) {
      if (this.believedHumanStr[n] <= 0.05) continue;
      // rushing the garrison rooms in the first minute is suicide (user rule)
      if (this.sim.t < 60 && this.staticGarrison(n) > 0) continue;
      // only targets reachable without marching through ANOTHER gun line
      const p = this.safeAssaultPath(from, n);
      if (!p) continue;
      const s = this.believedHumanStr[n] - p.length * 0.2;
      if (s > bestScore) { bestScore = s; best = n; }
    }
    return best;
  }

  assign(form, task) {
    // CLEAR THE ROOM BEFORE YOU ROOT (user: "before they are carriers, the
    // combat forms should by default kill everyone in the room at the very
    // least to prevent them from running, before they turn into carriers").
    //
    // Every transform site gated on localThreat, which is a BELIEF about guns:
    // it counts marines heavily and unarmed crew at 0.4x of a decayed estimate,
    // so a room holding nothing but civilians scored under the 0.5/0.6 bar and
    // a form rooted with people still standing in it. Measured over 25 min:
    // 4-8% of transforms started in an occupied room (worst: Medbay, 4 alive).
    //
    // Gating HERE rather than at the six call sites because assign() is the
    // one funnel they all pass through, including the desperation path — a
    // last-ditch form rooting beside a live human is the worst case of all.
    // The form is turned onto the room instead: kill first, root after.
    if (task.kind === TASK.TRANSFORM && this.sim.humansAt(form.pnode ?? form.node) > 0) {
      task = { kind: TASK.ATTACK, node: form.pnode ?? form.node };
    }
    // COMMITTED BURROWER (user rule: once a form starts burrowing a body it
    // CANNOT be pulled off). A form seated and burrowing a corpse/downed form
    // (or a combat form rooting into a carrier) ignores every new order until
    // it finishes or the body is gone — floodExec clears the task itself when
    // the body becomes invalid. Without this, the strategic tick and the
    // attack/muster drafts kept re-tasking a mid-conversion form (CONVERT ->
    // ATTACK / MOVE) and zeroing its timer — the "infect stutter when human
    // NPCs are nearby" (the nearby life is exactly what triggers the draft).
    if (form.task && form.taskProgress > 0
      && (form.task.kind === TASK.CONVERT || form.task.kind === TASK.REANIMATE
        || form.task.kind === TASK.TRANSFORM)) {
      const ct = form.task;
      const body = this.sim.byId.get(ct.corpseId ?? ct.targetId);
      const alive = ct.kind === TASK.TRANSFORM
        ? (!form.downed && form.hp > 0)
        : (body && !body.dead && body.damage < 100);
      if (alive) return; // committed — the order is ignored
    }
    // A combat form is an appendage with one job once a live body is chosen.
    // Do not rebalance it when another target becomes nearer or an adjacent
    // trio is killed; that produces visible target oscillation. Death on
    // either side naturally releases the lock because lockedCombatTarget()
    // then returns null and the next response may allocate a replacement.
    const lockedTarget = form.faction === FACTION.COMBAT
      ? this.lockedCombatTarget(form) : null;
    // A lock prevents target churn only while the hive is still attacking.
    // It must never veto the binary combat decision above: when the shared
    // odds say withdraw, retaining ATTACK while retreatCombatForm installs an
    // escape path gives movement two opposite authorities and they overwrite
    // each other every tick, leaving the body stationary under fire.
    if (lockedTarget && !task.retreat && !task.opportunistic
      && (task.kind !== TASK.ATTACK || task.targetId !== lockedTarget.id)) return;
    // re-issuing the SAME task must not wipe the path or restart progress —
    // the strategic round re-assigns standing orders every 2.5 s, and the
    // clear-repath cycle read as agents stuttering mid-corridor (user note:
    // jerky movement); rooting/conversion timers also kept resetting
    const t = form.task;
    const same = t && t.kind === task.kind && t.node === task.node
      && t.targetId === task.targetId && t.corpseId === task.corpseId
      && t.muster === task.muster;
    // a REPLACED task releases its claims (same leak as death: a corpse
    // "spoken for" by a form that got retasked was locked away forever)
    if (!same && t) {
      if (t.corpseId !== undefined) {
        const b = this.sim.byId.get(t.corpseId);
        if (b && !b.dead) b.claimed = false;
      }
      if (t.kind === TASK.REANIMATE && t.targetId !== undefined) {
        const d = this.sim.byId.get(t.targetId);
        if (d && d.claimed) d.claimed = false;
      }
    }
    if ((t?.kind === TASK.TRANSFORM) !== (task.kind === TASK.TRANSFORM)) {
      this._combatCacheTick = -1;
    }
    if (form.faction === FACTION.COMBAT && !task.retreat) {
      form.retreatSprint = false;
      form.retreatStartedTick = -1;
      if (form.move) form.move.retreatSprint = false;
    }
    // A new destination cannot inherit a physical leg aimed somewhere else.
    // Preserve movement whose complete queued route already ends at the new
    // objective (the anti-stutter case), but interrupt an opposite ladder,
    // lift, or doorway leg before the replacement order is installed.
    if (!same && form.move && task.node !== undefined) {
      const moveGoal = form.path.at(-1)?.to ?? form.move.to;
      if (moveGoal !== task.node) this.sim._interruptMove(form);
    }
    // Charging is an attack state, not a permanent animation bit. Strategic
    // reassignment to search, guard, or production must drop it immediately,
    // including when the old attack had already reached its room.
    if (form.faction === FACTION.COMBAT && task.kind !== TASK.ATTACK) {
      this.sim._setCharging(form, false);
    }
    form.task = task;
    if (!same) {
      form.path = [];
      form.taskProgress = 0;
    }
    // a form yanked out of a grab must not stay frozen in GRABBING — that
    // state parks movement AND blocks eating (the breach-freeze regression)
    if (form.state === STATE.GRABBING) { form.state = STATE.IDLE; form.grabTimer = 0; }
  }
}

export function isActiveFloodForm(a) {
  return (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT) && !a.downed && a.hp > 0;
}
export function isLivingHuman(a) {
  return (a.faction === FACTION.CIVILIAN || a.faction === FACTION.ARMED || a.faction === FACTION.MARINE) && a.hp > 0 && !a.dead;
}
export { W_HUMAN, W_FLOOD };
