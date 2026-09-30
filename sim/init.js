// Run initialization (§4) — seeded, in order:
// 1 load graph, 2 lock doors, 5 power, 6 populate NPCs,
// 7 scatter corpses, 8 seed the outbreak.
// (step 3, vent blocking, was removed with the one-network vent redesign)

import { ShipGraph, humanPass } from './graph.js';
import { SHIP } from './data/ship.js';
import { FACTION } from '../shared/agentBuffer.js';

export const STATE = {
  // shared across factions where meaningful
  IDLE: 0, ALERT: 1, FLEE: 2, HIDE: 3, COWER: 4, FIGHT: 5,
  MOVE: 6, DEAD: 7, DOWNED: 8, GRABBING: 9, AMBUSHING: 10, INCUBATING: 11,
};

let NEXT_ID = 1;

export function makeAgent(kind, node, graph) {
  const nd = graph.node(node);
  return {
    id: NEXT_ID++,
    faction: kind,
    state: STATE.IDLE,
    node,
    x: nd.x, y: nd.y, deck: nd.deck,
    heading: 0,
    // movement along an edge: null when parked in a node
    move: null, // { to, link, layer, t (0..1), travelSec, retreatSprint }
    path: [],   // remaining [{to, link, layer}]
    hp: 1, maxHp: 1, damage: 0,
    hasRadio: false, helpless: false, panicked: false, stayPut: false,
    garrison: false, deckGuard: false,
    worker: false, captain: false, fleeSteps: 0,
    downed: false, reviveAt: -1, // self-revive schedule (sim seconds)
    squad: -1,
    flamer: false, fuel: 0,
    task: null,      // hive task for flood forms
    hideTimer: 0, alertTimer: 0, grabTimer: 0, calledOut: false,
    held: 0,         // infection forms gestating INSIDE a carrier
    mintTimer: 0,
    lastMovedAt: 0,  // for ambush "stationary" checks
    animTime: 0,
    dragging: -1,    // corpse id being dragged
    // Flood leap arc, all committed at launch by sim.js _commitLeap: the
    // landing spot, the facing, the apex and the "landed" tolerance (the long
    // combat charge and the infection form's 2 m pounce fly different arcs).
    hoverY: 0, leaping: false, leapDist0: 0, leapTX: 0, leapTY: 0, leapHeading: 0,
    leapPeak: 0, leapLand: 0,
    // ...plus the two terms that GUARANTEE it comes down: last tick's distance
    // to the landing spot (no progress = it is as landed as it can get) and a
    // flight budget in ticks. A distance test alone can be unsatisfiable.
    leapRem: 0, leapTicks: 0, nextCombatLeapAt: 0,
    chargeTargetId: -1, // sticky spatial-charge target for LOS pursuit (sim.js)
    retreatSprint: false, retreatStartedTick: -1, // walk first; run if engaged after
    chargePoseSequence: 0, chargeArmsHigh: false, chargeEndedAt: -Infinity,
    followNode: -1,     // escort: last node re-pathed toward (humans.js)

    // STABLE HIDDEN CLASS (perf pass 4). Every field ANY later code assigns
    // is pre-declared here, so all agents share ONE V8 shape for their whole
    // life. Before this, ~45 properties were appended at scattered sites
    // (combat reactions, escort kit, hive claims, the player attach...) —
    // each append forks the hidden class, property access in the hot tick
    // loops goes megamorphic, and mean tick CPU roughly doubles. Measured
    // headless: p50 tick ~2.0-2.5ms -> ~0.5-0.7ms with stable shapes.
    //
    // Sentinel discipline: `undefined` for every field whose readers test
    // `!== undefined` / `?? x` or truthy-check before use (explicit
    // undefined is observationally identical to a missing key for every
    // read pattern in this codebase — verified: no `in`, Object.keys,
    // hasOwnProperty, or delete ever touches an agent). Concrete falsy
    // sentinels only where the reader semantics are proven: taskProgress 0
    // is safe because hive.assign() (the only task-granting site) zeroes it
    // before floodExec's `=== 0` branches can run; pnode mirrors node
    // because nothing reassigns .node before the first _refreshOccupancy.
    // Keep this ONE unconditional literal — per-faction conditionals would
    // fork maps at construction and defeat the whole point.
    dead: false, claimed: false, charging: false, isPlayer: false,
    fromPlayer: false, playerSourceId: -1, afterlifeId: -1, respawnReadyAt: -1,
    closeFollow: false, followSpeed: 0, heldCombatGround: false, taskProgress: 0,
    pnode: node, climbingLink: null,
    // combat & reaction timers (sim.js / combat.js / humans.js)
    nextShotAt: undefined, nextSwingAt: undefined, meleeUntil: undefined,
    fireTargetId: undefined,
    nextHostShotAt: undefined, _sawThreatT: undefined, _reactUntil: undefined,
    _ffBlockedSince: undefined,
    firstStruckIn: undefined, lastHurtBy: undefined, lastHurtTick: undefined,
    madeSure: undefined, deathImpulse: undefined,
    // fire & flamer
    flamingT: undefined, burnTimer: undefined, hadFlamer: undefined,
    flamerFuel: undefined, flameAimX: undefined, flameAimY: undefined, flameAimDeck: undefined,
    wasArmed: undefined, ammoRounds: undefined, hostArmed: undefined,
    // escort / marine kit & posts (humans.js)
    callsign: undefined, escort: undefined, mags: undefined, rounds: undefined,
    lowCalled: undefined, dryCalled: undefined, odst: undefined,
    lowerDecks: undefined, armingUp: undefined, fallbackNode: undefined,
    postKey: undefined, postX: undefined, postY: undefined, postFace: undefined,
    // flee / panic bookkeeping
    lastFledFrom: undefined, panicUntil: undefined, desperateSince: undefined,
    steeredTick: undefined, // last tick _spatialSteer/held-spin displaced the body (MOVING flag)
    walkStartX: 0, walkStartY: 0, // real per-tick travel vector for human render facing
    busting: null,          // std link a combat form is battering open (door bust)
    givingGround: false,    // shooter backing away while it fires (morale)
    armor: 0, armorHitAt: -99, // player ballistic armor (sim-owned; see hurtHuman)
    frags: 0, nextFragAt: undefined, // marine grenades
    transformingUntil: undefined, // combat form born from a corpse: rooted + thrashing until this sim second
    _fleeLogAt: undefined, doorBalks: undefined, doorHold: undefined,
    _workNodes: undefined, inShaftAmbush: undefined,
  };
}

export function resetIds() { NEXT_ID = 1; }

export function openingInfectionFormCount(floodParams, breachDeck, playerCount = 1) {
  const requestedPlayers = Number(playerCount);
  const players = Number.isFinite(requestedPlayers) ? Math.max(1, Math.floor(requestedPlayers)) : 1;
  const soloCount = breachDeck >= 4
    ? floodParams.lowerDeckInitialInfectionForms
    : floodParams.initialInfectionForms;
  return soloCount + (players - 1) * floodParams.initialInfectionFormsPerAdditionalPlayer;
}

export function initRun(seed, rng, P, runOptions = {}) {
  resetIds();
  const graph = new ShipGraph(SHIP);

  // --- 2. lock doors, keep the human graph connected ---
  for (const e of graph.edges) {
    if (e.lockable && rng.chance(P.door.lockedFraction)) e.locked = true;
  }
  repairHumanConnectivity(graph);
  assertDeckConnectivity(graph);

  // --- 3. (gone) vents never collapse any more: the duct network is ONE
  // ship-wide system with a grate in every room, and it is always open — the
  // flood's guaranteed topology (user redesign). The corpse-cache
  // reachability guarantee went with it: every room is duct-reachable.

  // --- 5. power ---
  for (const n of graph.nodes) {
    if (rng.chance(P.power.unstableFraction)) graph.unpowered[n.idx] = 1;
  }

  // pick the breach NOW, before the crew are placed (the forms + fresh dead
  // still spill out at step 8). why: the crash site must open as flood + bodies
  // with NO living crew standing on the portal — the deck-5 holds got that for
  // free (excluded from crew spawns by role), but the new deck-3/4 flank crash
  // sites (batteries, capacitor banks) are manned/habitable, so we now exclude
  // whichever one is THE breach from every live-crew pool below.
  const breach = rng.pick(graph.nodesWithRole('crash_candidate'));
  graph.breachNode = breach;
  graph.unpowered[breach] = 1;
  // The higher deck-3 breaches open closer to more armed defenders, so they
  // get two extra forms. Co-op scales from the same seeded breach on every
  // client; an explicit simulator override remains literal.
  if (!runOptions.initialInfectionFormsExplicit) {
    P.flood.initialInfectionForms = openingInfectionFormCount(
      P.flood, graph.node(breach).deck, runOptions.playerCount,
    );
  }

  // fixture states, per room (moved from the renderer into the SIM — user
  // rule: shooting in the dark is a MECHANIC now, not just a look). An
  // unpowered room runs dead or on a harsh strobe; a powered one is usually
  // steady with a tail of soft flicker / harsh strobe / dead fixtures.
  for (const n of graph.nodes) {
    const roll = rng.next();
    graph.lightMode[n.idx] = graph.unpowered[n.idx]
      ? (roll < 0.45 ? 3 : 2)
      : roll < 0.6 ? 0 : roll < 0.78 ? 1 : roll < 0.9 ? 2 : 3;
  }
  // why: the player must be able to read the room on arrival. Preserve the
  // seeded power failure, but turn a dead starting fixture into the matching
  // powered/unpowered flicker state before the renderer consumes the graph.
  const playerSpawn = graph.byId.get(runOptions.playerSpawnId);
  if (playerSpawn !== undefined && graph.lightMode[playerSpawn] === 3) {
    graph.lightMode[playerSpawn] = graph.unpowered[playerSpawn] ? 2 : 1;
  }
  // no marine starts on the crash site OR in a room right next to it (user
  // rule) — the danger set is the breach plus its immediate walkable neighbours
  const breachDanger = new Set([breach]);
  for (const { to } of graph.neighbors(breach, ['std'], null)) breachDanger.add(to);

  // --- 6. populate NPCs. EXPLICIT COUNTS (user note): squads, squad sizes,
  // civilians and bodies are exactly what the inputs say — the only thing
  // that rolls fresh each run is WHERE everyone starts. ---
  const agents = [];
  const M = P.marines;

  // marine line squads: M.squads squads of M.squadSize each. FIXED MUSTER
  // POSTS (user rule: marines always start in the same sensible areas of each
  // deck) — line squads berth at the ship's standing marine stations, never
  // scattered into random compartments, so every run opens with the garrison
  // holding the same recognizable ground. The order fills the deck-3 marine
  // spaces first (barracks → security), then posts a squad on the decks above
  // and below; squads past the list wrap back through it. Deck 1 is held by
  // the garrison, deck 5 (the crash deck) by the roaming patrols.
  const squads = [];
  {
    const marinePostIds = [
      'barracks',   // deck 3 — the barracks (squad 0 musters here; holds the flamethrower)
      'security',   // deck 3 — the security office
      'grandStair', // deck 4 — holding the engineering stairwell down to the hangar
      'crewB',      // deck 2 — a squad berthed forward with the crew
      'fireCtl',    // deck 3 — the fire-control watch
      'launchStbd', // deck 5 — a posting on the flight deck
      // (the armory is NOT a line post — it starts SEALED with the ODST
      // reserve inside; see the sealed-reserve block below)
    ];
    const marinePosts = marinePostIds.map((id) => graph.byId.get(id));
    const lineCount = Number.isFinite(M.lineCount) ? M.lineCount : M.squads * M.squadSize;
    const baseSquadSize = M.squads ? Math.floor(lineCount / M.squads) : 0;
    const largerSquads = M.squads ? lineCount % M.squads : 0;
    for (let si = 0; si < M.squads; si++) {
      // if a standing post is the breach or a room next to it (e.g. the
      // flight-deck posting when the hangar is the crash), slide to the next
      // safe post so no squad opens the game in the flood's lap (user rule)
      let pi = si % marinePosts.length;
      for (let g = 0; g < marinePosts.length && breachDanger.has(marinePosts[pi]); g++) pi = (pi + 1) % marinePosts.length;
      const node = marinePosts[pi];
      const squad = { id: si, members: [], objective: null, morale: 1, respondingTo: null, phase1: false };
      const squadSize = baseSquadSize + (si < largerSquads ? 1 : 0);
      for (let m = 0; m < squadSize; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = rng.chance(P.crew.radio.marine);
        a.frags = P.grenade.perMarine;
        a.squad = si;
        scatterInRoom(a, graph.node(node), rng); // spread within the post, not stacked on the center
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    }
    // the line's flamethrower goes to a member of the first squad (barracks)
    const flamerSquad = squads[0];
    if (flamerSquad) {
      const holder = agents.find((a) => a.id === flamerSquad.members[0]);
      holder.flamer = true;
      holder.fuel = P.flamethrower.fuelUnits;
    }
  }

  // THE SEALED RESERVE (user rule): the armory's blastdoor is LOCKED from
  // tick zero. Racked rifles, grenade crates, one flamethrower — and an ODST
  // squad standing by inside, harder than any line marine. The seal releases
  // only when the ship is genuinely losing (sim.js _armoryWatch): the hive
  // fielding 20+ combat forms with 10 or fewer line marines still standing.
  {
    const armoryIdx = graph.byId.get('armory');
    const door = graph.edges.find((e) => (e.a === armoryIdx || e.b === armoryIdx) && e.lockable);
    if (door) { door.locked = true; door.armorySeal = true; } // the seal is an EVENT gate — never jam/unjam rotation
    const squad = {
      id: squads.length, members: [], objective: null, morale: 1,
      respondingTo: null, phase1: true, odst: true, // phase1 done — no opening sweep
    };
    for (let m = 0; m < P.armory.odstSquadSize; m++) {
      const a = makeAgent(FACTION.MARINE, armoryIdx, graph);
      a.hp = a.maxHp = P.armory.odstHp;
      a.hasRadio = true;
      a.frags = P.grenade.perMarine;
      a.squad = squad.id;
      a.odst = true;
      scatterInRoom(a, graph.node(armoryIdx), rng);
      squad.members.push(a.id);
      agents.push(a);
    }
    // the reserve's flamethrower waits in the racks with its operator
    const lead = agents.find((x) => x.id === squad.members[0]);
    lead.flamer = true;
    lead.fuel = P.flamethrower.fuelUnits;
    squads.push(squad);
  }

  // permanent top-deck garrison (user note): marines standing guard on the
  // Command Corridor — the one way into the command deck — at all times.
  // They never sweep, never answer calls, never take orders; they just hold
  // the chokepoint. Not part of any squad, exempt from all squad logic.
  {
    const post = graph.byId.get('d1corr');
    for (let i = 0; i < M.garrison; i++) {
      const a = makeAgent(FACTION.MARINE, post, graph);
      a.hp = a.maxHp = P.combat.marine.hp;
      a.hasRadio = true;
      a.frags = P.grenade.perMarine;
      a.squad = -1;
      a.garrison = true;
      agents.push(a);
    }
  }

  // roaming pair patrols (user note): marine details, in ADDITION to the
  // squads, walking a fixed circuit of the whole ship. They answer distress
  // calls like any squad, then pick the round back up. Staggered around the
  // loop so the ship always has coverage somewhere.
  {
    // ship-wide circuit down the new deck stack (command -> hangar) and back
    const route = ['d1corr', 'd2corrF', 'mess', 'd2corrA', 'corrM', 'corrA',
      'engCorrF', 'eng', 'engCorrA', 'hangarA', 'hangar', 'vehicle', 'cargo1',
      'hangarA', 'engCorrA', 'corrM'].map((id) => graph.byId.get(id));
    for (let p = 0; p < M.patrols; p++) {
      let leg = Math.floor((p * route.length) / Math.max(1, M.patrols));
      // never START a patrol standing on the crash site (its route runs through
      // the hangar/holds, which can be the breach) — walk it to the next leg so
      // no live crew opens the game on the breach (consistent with every other
      // spawn pool). why: the crash site opens as flood + corpses only.
      for (let guard = 0; guard < route.length && breachDanger.has(route[leg]); guard++) {
        leg = (leg + 1) % route.length;
      }
      const node = route[leg];
      const squad = {
        id: squads.length, members: [], objective: null, morale: 1,
        respondingTo: null, phase1: false, patrol: true, patrolNo: p + 1, route, leg,
      };
      for (let m = 0; m < M.patrolSize; m++) {
        const a = makeAgent(FACTION.MARINE, node, graph);
        a.hp = a.maxHp = P.combat.marine.hp;
        a.hasRadio = true;
        a.frags = P.grenade.perMarine;
        a.squad = squad.id;
        squad.members.push(a.id);
        agents.push(a);
      }
      squads.push(squad);
    }
  }

  // armed crew: armory + the flank gun batteries + corridors + living spaces.
  // NEVER on the breach (a battery can be the crash site now) — that flank's
  // watch died in the crash; they're among the breach corpses instead.
  {
    const corridors = graph.nodes.filter((n) => n.type === 'corridor' && n.idx !== breach).map((n) => n.idx);
    const softRooms = graph.nodes.filter((n) => n.roles.includes('soft') && n.idx !== breach).map((n) => n.idx);
    // the flank weapon stations are manned (user: side areas shouldn't read
    // empty) — the 50mm batteries and fire control hold a watch of armed crew.
    // NOBODY spawns in the armory: it's sealed with the ODST reserve inside.
    const battleStations = graph.nodes.filter((n) =>
      (n.roles.includes('battery') || (n.roles.includes('marines') && n.roles.includes('systems')))
      && n.idx !== breach)
      .map((n) => n.idx);
    const armedCount = P.crew.armedCrew;
    for (let i = 0; i < armedCount; i++) {
      const r = i / armedCount;
      const node = (r < 0.55 && battleStations.length) ? rng.pick(battleStations)
        : r < 0.75 ? rng.pick(corridors) : rng.pick(softRooms);
      const a = makeAgent(FACTION.ARMED, node, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.hasRadio = rng.chance(P.crew.radio.armed);
      scatterInRoom(a, graph.node(node), rng); // spread within the room, not stacked
      agents.push(a);
    }
  }

  // civilians: quarters/soft/mess; prisoners and wounded are explicit counts
  // on top, as are the stay-put officers
  {
    // EVEN SPREAD (user note: crew shouldn't clump in a few rooms) — the
    // sheltering crew fills living spaces first but overflows across the
    // whole habitable ship (any room that isn't command/hazard/hangar or the
    // crash site), weighted by each room's capacity so big spaces hold more.
    const softIdx = graph.nodes
      .filter((n) => n.roles.includes('soft') || n.roles.includes('quarters'))
      .map((n) => n.idx);
    const habitable = graph.nodes.filter((n) =>
      n.type !== 'corridor' && n.idx !== graph.breachNode
      && !n.roles.includes('command') && !n.roles.includes('hazard')
      && !n.roles.includes('power') && !n.roles.includes('hangar')
      && !n.roles.includes('vehicles')
      // crew shelter in living/work spaces, not the weapon rooms (those are
      // manned by the armed watch, not huddling civilians)
      && !n.roles.includes('armory') && !n.roles.includes('battery')
      && !n.roles.includes('magazine'));
    // SPREAD BY SPACE (user: bodies — alive or dead — should be roughly even
    // across the ship BY AREA, so a big hall always holds more than a small
    // compartment). A room's weight is its FLOOR AREA (w×d), so the crew reads
    // as filling the whole deck plan proportionally rather than clumping.
    const spreadPool = [];
    for (const n of habitable) {
      const copies = Math.max(1, Math.round((n.w * n.d) / 12)); // ~1 per 12 m²
      for (let k = 0; k < copies; k++) spreadPool.push(n.idx);
    }
    const soft = softIdx;
    const brig = graph.byId.get('brig');
    const medbay = graph.byId.get('medbay');
    const officerPost = graph.byId.get('officer');
    for (let i = 0; i < P.crew.brigPrisoners; i++) {
      const a = makeAgent(FACTION.CIVILIAN, brig, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = true;
      agents.push(a);
    }
    for (let i = 0; i < P.crew.medbayWounded; i++) {
      const a = makeAgent(FACTION.CIVILIAN, medbay, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.helpless = true;
      agents.push(a);
    }
    // officers hold Officer Country, armed, and do not evacuate (user note)
    for (let i = 0; i < P.marineDoctrine.officers; i++) {
      const a = makeAgent(FACTION.ARMED, officerPost, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.stayPut = true;
      a.hasRadio = true;
      agents.push(a);
    }
    for (let i = 0; i < P.crew.civilians; i++) {
      // 55% shelter in the living spaces, 45% are spread across the wider
      // ship (so the crew reads as a whole complement at stations, not a
      // pile in the mess) — then scattered within whatever room they land in
      const node = rng.chance(0.55) ? rng.pick(soft) : rng.pick(spreadPool);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      // ~20% are still working the ship (engineers, medics, techs) and move
      // with purpose; the rest shelter in place (user note)
      a.worker = rng.chance(P.civilian.workerFraction);
      a.hasRadio = a.worker || rng.chance(P.crew.radio.civilian);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }

    // the captain and a few officers command from the bridge and never leave
    // it (user note). All of them are armed and fight in place if reached.
    const bridge = graph.byId.get('bridge');
    for (let i = 0; i < P.marineDoctrine.bridgeOfficers; i++) {
      const a = makeAgent(FACTION.ARMED, bridge, graph);
      a.hp = a.maxHp = P.combat.armed.hp;
      a.stayPut = true;
      a.captain = i === 0;
      a.hasRadio = true;
      agents.push(a);
    }

    // unarmed maintenance crew working the LOWER decks (user note): they roam
    // decks 4-5 fixing systems — moving bodies right where the outbreak lives
    // REPAIR DETAILS (user rule): the lower-deck crew spawn ALIVE and AT
    // WORK — distributed across the machinery spaces they're trying to keep
    // running (engineering, reactor, life support, workshops), not scattered
    // through random compartments. worker=true keeps them making purposeful
    // trips between systems until the outbreak reaches them.
    const repairRooms = graph.nodes.filter((n) => n.deck >= 4 && n.idx !== breach
      && ['power', 'engineering', 'systems', 'maintenance'].some((r) => n.roles.includes(r)))
      .map((n) => n.idx);
    const lowerNodes = graph.nodes.filter((n) => n.deck >= 4 && n.idx !== breach).map((n) => n.idx);
    for (let i = 0; i < P.crew.lowerMaintenance; i++) {
      const node = repairRooms.length ? repairRooms[i % repairRooms.length] : rng.pick(lowerNodes);
      const a = makeAgent(FACTION.CIVILIAN, node, graph);
      a.hp = a.maxHp = P.combat.civilian.hp;
      a.worker = true;
      a.lowerDecks = true; // their work orders keep them on decks 4-5
      a.hasRadio = rng.chance(P.crew.radio.civilian);
      scatterInRoom(a, graph.node(node), rng);
      agents.push(a);
    }
  }

  // --- 7. scatter corpses: EVERY room gets its own share, weighted by size so
  // the dead read as EVENLY spread across the whole ship (user note: more
  // bodies, evenly spread) — a gentle per-run jitter still moves them around
  // run to run, but the wide old lottery (some rooms 12x others) is gone, so
  // no room reads empty and none becomes a graveyard. Corpse caches
  // (medbay/cryo) still lean heavy.
  const corpses = [];
  {
    const weights = graph.nodes.map((n) => {
      // the dead lie in proportion to FLOOR AREA (user: more bodies in the
      // hangar than the armory, always). A gentle ±20% per-run jitter keeps
      // each run's scatter unique without ever letting a small room outdraw a
      // big one; corpse caches (medbay/cryo) still lean heavy, corridors light.
      let w = (n.w * n.d) * rng.range(0.8, 1.2);
      if (n.roles.includes('corpse_cache')) w *= 1.8;
      if (n.type === 'corridor') w *= 0.45;
      return w;
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < P.bodies.eventCorpses; i++) {
      let r = rng.next() * totalW, node = graph.n - 1;
      for (let k = 0; k < weights.length; k++) { r -= weights[k]; if (r <= 0) { node = k; break; } }
      const c = makeAgent(FACTION.CORPSE, node, graph);
      c.state = STATE.DEAD;
      c.hp = 0; c.damage = 0; // fully convertible
      c.wasArmed = rng.chance(P.bodies.armedFraction); // the vast majority died unarmed (user rule)
      scatterInRoom(c, graph.node(node), rng);
      corpses.push(c);
    }
  }

  // --- 8. seed the outbreak at the breach chosen above ---
  // every form spills out of the crash at its OWN spot (user rule: solid
  // bodies, no stacking on the room's center point)
  const flood = [];
  for (let i = 0; i < P.flood.initialInfectionForms; i++) {
    const a = makeAgent(FACTION.INFECTION, breach, graph);
    a.hp = a.maxHp = 1;
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCarriers; i++) {
    const a = makeAgent(FACTION.CARRIER, breach, graph);
    a.hp = a.maxHp = P.combat.carrierHp;
    a.state = STATE.INCUBATING;
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  for (let i = 0; i < P.flood.initialCombatForms; i++) {
    const a = makeAgent(FACTION.COMBAT, breach, graph);
    a.hp = a.maxHp = P.combat.combatForm.hp * (1 + rng.range(-P.combat.combatForm.hpJitter, P.combat.combatForm.hpJitter));
    scatterInRoom(a, graph.node(breach), rng);
    flood.push(a);
  }
  // the crash site's fresh dead: uniform 5-7 (user tuning, A/B-tested against
  // the old 5-16 roll: a smaller larder slows the opening snowball and runs
  // longer, grindier games — median +88s over 10 seeds — while a BIG larder
  // masses the flood in one sweepable room, which is a containment gift).
  const freshDead = P.bodies.breachMin + Math.floor(rng.range(0, P.bodies.breachMax - P.bodies.breachMin + 1));
  for (let i = 0; i < freshDead; i++) {
    const c = makeAgent(FACTION.CORPSE, breach, graph);
    c.state = STATE.DEAD; c.hp = 0; c.damage = 0;
    c.wasArmed = rng.chance(P.bodies.armedFraction);
    scatterInRoom(c, graph.node(breach), rng);
    corpses.push(c);
  }

  // Append dynamic command-deck coverage after the original population so
  // adding sentries never perturbs a seed's existing crew, bodies, or Flood.
  // Fixed room-relative posts likewise consume no shared random rolls.
  const deckOneRooms = graph.nodes.filter((node) => node.deck === 1 && node.type === 'room');
  for (const room of deckOneRooms) {
    for (let i = 0; i < M.deckGuardPerRoom; i++) {
      const squad = {
        id: squads.length, members: [], objective: { kind: 'guard', node: room.idx },
        morale: 1, respondingTo: null, phase1: false,
        deckGuard: true, postNode: room.idx, size0: 1,
      };
      const a = makeAgent(FACTION.MARINE, room.idx, graph);
      const angle = (room.idx * 2.399963 + i * 3.883222) % (Math.PI * 2);
      const radius = Math.min(room.w, room.d) * 0.12;
      a.x = room.x + Math.cos(angle) * radius;
      a.y = room.y + Math.sin(angle) * radius;
      a.hp = a.maxHp = P.combat.marine.hp;
      a.hasRadio = true;
      a.frags = P.grenade.perMarine;
      a.squad = squad.id;
      a.garrison = true;
      a.deckGuard = true;
      squad.members.push(a.id);
      agents.push(a);
      squads.push(squad);
    }
  }

  return { graph, agents: [...agents, ...corpses, ...flood], squads, breach };
}

// bodies lie where they fell — a fixed, seeded spot inside the room's real
// footprint, not a stack on the room's center point
function scatterInRoom(a, nd, rng) {
  a.x = nd.x + rng.range(-0.5, 0.5) * Math.max(2, nd.w - 2.5);
  a.y = nd.y + rng.range(-0.5, 0.5) * Math.max(2, nd.d - 2.5);
}

// Unlock a minimal set of locked doors so every node stays human-reachable
// from the bridge (the "path spine" guarantee in §4.2).
function repairHumanConnectivity(graph) {
  const start = graph.byId.get('bridge');
  for (let guard = 0; guard < 64; guard++) {
    const ff = graph.flowField([start], ['std'], humanPass);
    const stranded = [];
    for (let i = 0; i < graph.n; i++) if (ff.dist[i] === -1) stranded.push(i);
    if (!stranded.length) return;
    // unlock one locked edge that bridges reached <-> stranded
    let fixed = false;
    for (const e of graph.edges) {
      if (!e.locked) continue;
      const aIn = ff.dist[e.a] !== -1, bIn = ff.dist[e.b] !== -1;
      if (aIn !== bIn) { e.locked = false; fixed = true; break; }
    }
    if (!fixed) return; // graph itself is disconnected (shouldn't happen)
  }
}

// NO BLOCKAGE EVER between any two decks (user rule): every cross-deck
// connection is a lift or ladder, and lift/ladder edges are authored
// lockable:false in ship.js — the door-lock roll and the SET_DOOR command
// both refuse to touch a non-lockable edge, and the graph's maintenance-
// shaft layer has no lock flag at all. This assertion is the enforced
// guarantee, not just an accident of the current data: it fails loudly in
// dev if a future edit ever adds a lockable cross-deck edge that could
// seal every path between two decks.
function assertDeckConnectivity(graph) {
  const start = graph.byId.get('bridge');
  const ff = graph.flowField([start], ['std'], humanPass);
  const decksSeen = new Set();
  for (let i = 0; i < graph.n; i++) if (ff.dist[i] !== -1) decksSeen.add(graph.node(i).deck);
  if (decksSeen.size < 5) {
    console.warn(`[saturn-devouring] deck connectivity broken: only decks {${[...decksSeen].sort().join(',')}} reachable from the bridge — check for a lockable cross-deck edge`);
  }
}
