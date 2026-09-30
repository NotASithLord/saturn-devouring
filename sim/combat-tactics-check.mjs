import assert from 'node:assert/strict';
import { FACTION, CLIP } from '../shared/agentBuffer.js';
import { makeAgent, STATE } from './init.js';
import { TASK } from './hive.js';
import { updateHumansTick } from './humans.js';
import { updateFloodTick } from './floodExec.js';
import { resolveCombat } from './combat.js';
import { Sim } from './sim.js';
import { CLEAR_H, clearHeightOf } from '../shared/geometry.js';

function openEscapeDoor(sim) {
  // These tactics fixtures exercise cross-room behavior, not door timing.
  // Make their available passages explicitly open before looking for one.
  for (const candidate of sim.graph.edges) {
    if (candidate.door && !candidate.locked) candidate.open01 = 1;
  }
  const edge = sim.graph.edges.find((edge) => {
    if (edge.kind !== 'std' || edge.locked) return false;
    const a = sim.graph.node(edge.a), b = sim.graph.node(edge.b);
    return a.deck === b.deck
      && Math.hypot(b.x - a.x, b.y - a.y) < sim.P.combat.sightM
      && sim.losClear(a.x, a.y, edge.a, b.x, b.y, edge.b)
      && [...sim.graph.neighbors(edge.a, ['std'], (candidate) => !candidate.locked)]
        .some(({ to }) => to !== edge.b);
  });
  return edge;
}

const sim = new Sim('combat-tactics-check');
for (const agent of sim.agents) agent.dead = true;
const link = openEscapeDoor(sim);
assert.ok(link, 'combat fixture needs a visible doorway with a graph-derived escape');

const forms = [0, 1, 2].map(() => makeAgent(FACTION.COMBAT, link.a, sim.graph));
const marine = makeAgent(FACTION.MARINE, link.b, sim.graph);
for (const form of forms) { form.hp = form.maxHp = 90; sim.spawn(form); }
marine.hp = marine.maxHp = 100;
sim.spawn(marine);
forms[1].dead = true;
forms[2].dead = true;
sim.hive.allIn = false;
sim.tickCount = 1;
sim.t = sim.dt;
sim._refreshOccupancy();

const attacker = forms[0];
attacker.task = { kind: TASK.ATTACK, node: link.b };
sim.setPathTo(attacker, link.b, ['std'], (edge) => !edge.locked);
sim._advanceMovement(sim.dt);
assert.equal(attacker.task.kind, TASK.MOVE, 'an under-strength planned attack must become a retreat');
assert.equal(attacker.task.retreat, true, 'the retreat must be protected from strategic re-tasking');
assert.ok(attacker.move || attacker.path.length, 'a retreating form must immediately use an escape route');
assert.notEqual(attacker.move?.to ?? attacker.path[0]?.to, link.b,
  'the escape route must not cross the defended doorway');

attacker.path = [];
attacker.move = null;
const originalLocks = new Map(sim.graph.edges.map((edge) => [edge, edge.locked]));
for (const edge of sim.graph.edges) {
  if ((edge.a === link.a || edge.b === link.a) && edge !== link) edge.locked = true;
}
assert.equal(sim.hive.retreatOrFight(attacker, link.b), true,
  'a form with no open escape must turn and fight');
assert.equal(attacker.task.kind, TASK.ATTACK, 'a cornered form must attack');
assert.equal(attacker.task.force, true, 'the cornered attack must bypass the odds gate');
for (const [edge, locked] of originalLocks) edge.locked = locked;

// Room topology is not enough to call a ladder an escape. If reaching its
// mouth means running through a visible shooter, the form must find another
// first leg or accept that it is cornered and attack.
const blockedRetreatSim = new Sim('blocked-retreat-approach-check');
for (const agent of blockedRetreatSim.agents) agent.dead = true;
let blockedLadder = null;
for (const edge of blockedRetreatSim.graph.edges) {
  if (edge.kind !== 'std' || edge.type !== 'ladder' || edge.locked) continue;
  for (const [from, to, mouth] of [[edge.a, edge.b, edge.padA], [edge.b, edge.a, edge.padB]]) {
    const room = blockedRetreatSim.graph.node(from);
    const distance = mouth ? Math.hypot(mouth.x - room.x, mouth.y - room.y) : 0;
    if (distance > 6 && distance * 0.55 < blockedRetreatSim.P.combat.sightM) {
      blockedLadder = { edge, from, to, mouth, room };
      break;
    }
  }
  if (blockedLadder) break;
}
assert.ok(blockedLadder, 'blocked retreat fixture needs a ladder mouth well inside a room');
const trappedForm = makeAgent(FACTION.COMBAT, blockedLadder.from, blockedRetreatSim.graph);
const blockingPlayer = makeAgent(FACTION.ARMED, blockedLadder.from, blockedRetreatSim.graph);
trappedForm.x = blockedLadder.room.x;
trappedForm.y = blockedLadder.room.y;
blockingPlayer.isPlayer = true;
blockingPlayer.x = trappedForm.x + (blockedLadder.mouth.x - trappedForm.x) * 0.45;
blockingPlayer.y = trappedForm.y + (blockedLadder.mouth.y - trappedForm.y) * 0.45;
blockedRetreatSim.spawn(trappedForm);
blockedRetreatSim.spawn(blockingPlayer);
blockedRetreatSim.tickCount = 1;
blockedRetreatSim.t = blockedRetreatSim.dt;
blockedRetreatSim._refreshOccupancy();
const blockedStep = { to: blockedLadder.to, link: blockedLadder.edge, layer: 'std' };
assert.equal(blockedRetreatSim.hive.retreatApproachSafe(trappedForm, blockedStep), false,
  'a ladder behind the player must not count as a safe retreat approach');

const blockedLocks = new Map(blockedRetreatSim.graph.edges.map((edge) => [edge, edge.locked]));
for (const edge of blockedRetreatSim.graph.edges) {
  if ((edge.a === blockedLadder.from || edge.b === blockedLadder.from)
    && edge !== blockedLadder.edge) edge.locked = true;
}
trappedForm.task = { kind: TASK.MOVE, node: blockedLadder.to, retreat: true,
  threatNode: blockedLadder.from };
trappedForm.state = STATE.MOVE;
trappedForm.move = {
  from: blockedLadder.from,
  to: blockedLadder.to,
  link: blockedLadder.edge,
  layer: 'std',
  t: 0,
  appT: 0.5,
  hidden: false,
};
blockedLadder.edge.occupiedBy = trappedForm.id;
blockedRetreatSim._spatialSteer(trappedForm, blockedRetreatSim.dt);
assert.equal(trappedForm.move, null, 'a newly blocked ladder approach must be cancelled');
assert.equal(trappedForm.task.kind, TASK.ATTACK, 'a form with no clean retreat must attack the blocker');
assert.equal(trappedForm.task.targetId, blockingPlayer.id,
  'the cornered attack must target the player blocking the escape');
assert.equal(trappedForm.task.cornered, true, 'the attack must carry the cornered override');
for (const [edge, locked] of blockedLocks) edge.locked = locked;

// Life-sense must carry exact room makeup through enclosed vertical trunks.
// A lone form should withdraw before climbing into a firing squad, while a
// pack that satisfies the same shared odds rule may commit. The fixture finds
// the connection from graph structure so future ship layouts need no updates.
const verticalSim = new Sim('vertical-life-sense-check');
for (const agent of verticalSim.agents) agent.dead = true;
let vertical = null;
for (const edge of verticalSim.graph.edges) {
  if (edge.kind !== 'std' || (edge.type !== 'ladder' && edge.type !== 'lift')) continue;
  if (verticalSim.graph.node(edge.a).deck === verticalSim.graph.node(edge.b).deck) continue;
  for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
    const escape = [...verticalSim.graph.neighbors(from, ['std'], (candidate) => !candidate.locked)]
      .find(({ to: other }) => other !== to);
    if (escape) { vertical = { edge, from, to }; break; }
  }
  if (vertical) break;
}
assert.ok(vertical, 'vertical sensing fixture needs a ladder/lift with an alternate escape');
const loneClimber = makeAgent(FACTION.COMBAT, vertical.from, verticalSim.graph);
const landingSquad = [0, 1, 2].map(() => makeAgent(FACTION.MARINE, vertical.to, verticalSim.graph));
verticalSim.spawn(loneClimber);
for (const defender of landingSquad) verticalSim.spawn(defender);
verticalSim.tickCount = 1;
verticalSim.t = verticalSim.dt;
verticalSim._refreshOccupancy();
assert.equal(verticalSim.lineOfSightAgents(loneClimber, (agent) => landingSquad.includes(agent)).length, 0,
  'an enclosed vertical trunk must remain opaque to ordinary LOS');
verticalSim.hive.updateBeliefs();
assert.ok(landingSquad.every((defender) => verticalSim.hive.beliefs.get(defender.id)?.conf === 1),
  'life-sense must learn every living occupant on the adjacent landing');
assert.ok(verticalSim.hive.believedHardness[vertical.to] >= landingSquad.length,
  'the sensed landing must contribute its full firing-squad strength');
loneClimber.task = { kind: TASK.ATTACK, node: vertical.to };
verticalSim.setPath(loneClimber, [{ to: vertical.to, link: vertical.edge, layer: 'std' }]);
verticalSim._advanceMovement(verticalSim.dt);
assert.equal(loneClimber.task.retreat, true,
  'a lone form must retreat before climbing into a sensed firing squad');
assert.notEqual(loneClimber.move?.to ?? loneClimber.path[0]?.to, vertical.to,
  'the retreat must not enter the defended vertical trunk');

const enoughClimbers = Array.from({ length: 9 }, () => makeAgent(FACTION.COMBAT, vertical.from, verticalSim.graph));
loneClimber.dead = true;
for (const form of enoughClimbers) {
  verticalSim.spawn(form);
  form.task = { kind: TASK.ATTACK, node: vertical.to };
  verticalSim.setPath(form, [{ to: vertical.to, link: vertical.edge, layer: 'std' }]);
}
verticalSim.tickCount++;
verticalSim.t += verticalSim.dt;
verticalSim._refreshOccupancy();
verticalSim._advanceMovement(verticalSim.dt);
assert.ok(enoughClimbers.some((form) => form.move?.to === vertical.to),
  'a pack with sufficient sensed odds must be allowed to start the crossing');

// A retreat issued during a doorway leg must replace that leg. Otherwise the
// old crossing lands first and the new path begins with an edge connected to
// the room left behind, which lets the form traverse an unrelated lift.
attacker.task = { kind: TASK.ATTACK, node: link.b };
attacker.node = attacker.pnode = link.a;
attacker.deck = sim.graph.node(link.a).deck;
attacker.x = sim.graph.node(link.a).x;
attacker.y = sim.graph.node(link.a).y;
attacker.path = [];
attacker.move = { from: link.a, to: link.b, link, layer: 'std', t: 0.25, travelSec: 1 };
assert.equal(sim.hive.retreatCombatForm(attacker, link.b), true,
  'a mid-doorway form must still find its connected escape');
assert.equal(attacker.move, null, 'retreat must cancel the superseded doorway leg');
let routeNode = attacker.node;
for (const step of attacker.path) {
  const next = step.link.a === routeNode ? step.link.b : step.link.b === routeNode ? step.link.a : -1;
  assert.equal(next, step.to, 'every retreat edge must connect to the preceding room');
  routeNode = step.to;
}

forms[1].dead = false;
forms[2].dead = false;
sim._refreshOccupancy();
assert.equal(sim.hive.canPressCombatContact(attacker), true,
  'three visible combat forms must satisfy the planned attack ratio against one marine');

// The exact standoff regression: a pack already withdrawing from the squad
// must not reverse when its leading marine steps through alone.
forms[1].dead = true;
forms[2].dead = true;
const rearMarines = [0, 1].map(() => makeAgent(FACTION.MARINE, link.b, sim.graph));
for (const rear of rearMarines) { rear.hp = rear.maxHp = 100; sim.spawn(rear); }
marine.node = marine.pnode = link.a;
marine.x = attacker.x + 2;
marine.y = attacker.y;
attacker.path = [];
attacker.move = null;
sim._refreshOccupancy();
assert.equal(sim.hive.retreatCombatForm(attacker, link.b), true, 'the outnumbered form must find an escape');
const retreatNode = attacker.task.node;
for (const rear of rearMarines) rear.dead = true;
attacker.lastHurtBy = marine.id;
attacker.lastHurtTick = sim.tickCount;
sim._refreshOccupancy();
sim._spatialSteer(attacker, sim.dt);
assert.equal(attacker.task.retreat, true,
  'ordinary fire at the threshold must not flip a committed retreat back to aggression');
assert.equal(attacker.task.node, retreatNode, 'the retreat destination must remain stable');
const marineHp = marine.hp;
resolveCombat(sim, sim.dt);
assert.equal(marine.hp, marineHp, 'a fleeing form must not stop to pounce the marine crossing behind it');

// Incoming fire starts a persistent surge at even visible odds, but not when
// the shooter group actually outnumbers the form.
const surgeSim = new Sim('provoked-surge-check');
for (const agent of surgeSim.agents) agent.dead = true;
const surgeDoor = openEscapeDoor(surgeSim);
assert.ok(surgeDoor, 'surge fixture needs a visible doorway');
const surgeForm = makeAgent(FACTION.COMBAT, surgeDoor.a, surgeSim.graph);
const shooter = makeAgent(FACTION.MARINE, surgeDoor.b, surgeSim.graph);
surgeSim.spawn(surgeForm);
surgeSim.spawn(shooter);
surgeSim.tickCount = 1;
surgeSim.t = surgeSim.dt;
surgeSim._refreshOccupancy();
surgeForm.lastHurtBy = shooter.id;
surgeForm.lastHurtTick = surgeSim.tickCount;
surgeSim._spatialSteer(surgeForm, surgeSim.dt);
assert.equal(surgeForm.task.kind, TASK.ATTACK, 'a form fired on at even odds must attack');
assert.equal(surgeForm.task.surge, true, 'the provoked attack must persist as a surge');
assert.equal(surgeSim.hive.respondToSensedRoom(surgeForm, surgeDoor.b), true,
  'a fire-triggered surge must keep the same even-odds rule while crossing the threshold');
assert.equal(surgeForm.task.kind, TASK.ATTACK,
  'the doorway safety check must not reverse a live surge');

const secondShooter = makeAgent(FACTION.MARINE, surgeDoor.b, surgeSim.graph);
surgeSim.spawn(secondShooter);
surgeForm.task = null;
surgeForm.path = [];
surgeForm.move = null;
surgeSim._refreshOccupancy();
surgeSim._spatialSteer(surgeForm, surgeSim.dt);
assert.equal(surgeForm.task.retreat, true, 'a form fired on by superior visible numbers must flee');
const reinforcements = [0, 1].map(() => makeAgent(FACTION.COMBAT, surgeDoor.a, surgeSim.graph));
for (const ally of reinforcements) surgeSim.spawn(ally);
surgeSim._refreshOccupancy();
surgeSim._spatialSteer(surgeForm, surgeSim.dt);
for (const form of [surgeForm, ...reinforcements]) {
  assert.equal(form.task.kind, TASK.ATTACK, 'reinforcements changing the odds must reverse the whole pack into attack');
  assert.equal(form.task.surge, true, 'the renewed response must remain one shared surge');
}

// A prior target allocation cannot swallow a later, real hit. The wounded
// form temporarily pursues the shooter across the opening while retaining its
// stable assignment for after the aggression window.
const lockedShotSim = new Sim('locked-doorway-provocation-check');
for (const agent of lockedShotSim.agents) agent.dead = true;
const lockedShotDoor = openEscapeDoor(lockedShotSim);
assert.ok(lockedShotDoor, 'locked-shot fixture needs a visible doorway');
const oldTargetRoom = [...lockedShotSim.graph.neighbors(lockedShotDoor.a, ['std'], (edge) => !edge.locked)]
  .find(({ to }) => to !== lockedShotDoor.b)?.to;
assert.notEqual(oldTargetRoom, undefined, 'locked-shot fixture needs a distinct prior target room');
const lockedShotForm = makeAgent(FACTION.COMBAT, lockedShotDoor.a, lockedShotSim.graph);
const doorwayPlayer = makeAgent(FACTION.ARMED, lockedShotDoor.b, lockedShotSim.graph);
const oldTarget = makeAgent(FACTION.MARINE, oldTargetRoom, lockedShotSim.graph);
doorwayPlayer.isPlayer = true;
lockedShotSim.spawn(lockedShotForm);
lockedShotSim.spawn(doorwayPlayer);
lockedShotSim.spawn(oldTarget);
lockedShotForm.task = { kind: TASK.ATTACK, node: oldTargetRoom, targetId: oldTarget.id };
lockedShotSim.hive.allIn = true;
lockedShotSim.tickCount = 1;
lockedShotSim.t = lockedShotSim.dt;
lockedShotSim._refreshOccupancy();
lockedShotForm.lastHurtBy = doorwayPlayer.id;
lockedShotForm.lastHurtTick = lockedShotSim.tickCount;
lockedShotSim._spatialSteer(lockedShotForm, lockedShotSim.dt);
assert.equal(lockedShotForm.task.targetId, oldTarget.id,
  'doorway provocation must not destroy the stable long-term target allocation');
assert.equal(lockedShotForm.task.surge, true,
  'a viable pack must visibly surge when its appendage is shot');
assert.equal(lockedShotForm.path.at(-1)?.to, lockedShotDoor.b,
  'the wounded form must immediately route through the doorway toward its shooter');

// A sticky attack target stabilizes pursuit, but cannot overrule the hive's
// explicit decision to withdraw from superior fire. Previously assign()
// rejected the retreat while retreatCombatForm still installed its route;
// spatial combat then replaced that route with a charge every frame and the
// form stood motionless under sustained fire.
const lockedRetreatSim = new Sim('locked-target-retreat-check');
for (const agent of lockedRetreatSim.agents) agent.dead = true;
const lockedRetreatDoor = openEscapeDoor(lockedRetreatSim);
assert.ok(lockedRetreatDoor, 'locked-retreat fixture needs a visible doorway and an escape');
const distantTargetRoom = lockedRetreatSim.graph.nodes.find((node) =>
  lockedRetreatSim.graph.hops(lockedRetreatDoor.a, node.idx, ['std'], (edge) => !edge.locked) >= 2)?.idx;
assert.notEqual(distantTargetRoom, undefined, 'locked-retreat fixture needs a prior target beyond the contact');
const lockedRetreatForm = makeAgent(FACTION.COMBAT, lockedRetreatDoor.a, lockedRetreatSim.graph);
const lockedRetreatTarget = makeAgent(FACTION.MARINE, distantTargetRoom, lockedRetreatSim.graph);
const retreatShooters = [0, 1].map(() =>
  makeAgent(FACTION.MARINE, lockedRetreatDoor.b, lockedRetreatSim.graph));
lockedRetreatSim.spawn(lockedRetreatForm);
lockedRetreatSim.spawn(lockedRetreatTarget);
for (const shooter of retreatShooters) lockedRetreatSim.spawn(shooter);
lockedRetreatForm.task = { kind: TASK.ATTACK, node: distantTargetRoom,
  targetId: lockedRetreatTarget.id, surge: true };
lockedRetreatSim.tickCount = 1;
lockedRetreatSim.t = lockedRetreatSim.dt;
lockedRetreatSim._refreshOccupancy();
lockedRetreatForm.lastHurtBy = retreatShooters[0].id;
lockedRetreatForm.lastHurtTick = lockedRetreatSim.tickCount;
lockedRetreatSim._spatialSteer(lockedRetreatForm, lockedRetreatSim.dt);
assert.equal(lockedRetreatForm.task.retreat, true,
  'a sticky target must release when the shared combat decision is retreat');
assert.ok(lockedRetreatForm.path.length,
  'the retreat decision must retain one coherent escape route');
assert.notEqual(lockedRetreatForm.path[0].to, lockedRetreatDoor.b,
  'the escape route must lead away from the shooters');
lockedRetreatSim._advanceMovement(lockedRetreatSim.dt);
assert.ok(lockedRetreatForm.move,
  'a locked form that withdraws must begin moving instead of oscillating in place');
const retreatLeg = lockedRetreatForm.move;
assert.equal(retreatLeg.retreatSprint, false,
  'a newly chosen retreat must begin at walking pace');
assert.equal(lockedRetreatSim._clipFor(lockedRetreatForm), CLIP.WALK,
  'a walking retreat must use the walk animation');
const walkingProgress = lockedRetreatSim.dt / retreatLeg.travelSec;
lockedRetreatSim.tickCount++;
lockedRetreatSim.t += lockedRetreatSim.dt;
lockedRetreatSim._refreshOccupancy();
lockedRetreatSim._spatialSteer(lockedRetreatForm, lockedRetreatSim.dt);
assert.equal(lockedRetreatForm.retreatSprint, true,
  'incoming fire must accelerate a retreating form');
assert.equal(retreatLeg.retreatSprint, true,
  'the active retreat leg must adopt the run pace');
assert.equal(lockedRetreatSim._clipFor(lockedRetreatForm), CLIP.RUN,
  'an engaged retreat must use the run animation');
lockedRetreatSim._advanceMovement(lockedRetreatSim.dt);
assert.equal(lockedRetreatForm.move, retreatLeg,
  'incoming fire must not replace an already viable retreat leg');
assert.ok(lockedRetreatForm.move.t > 0,
  'the retreat leg must continue making physical progress under fire');
assert.ok(lockedRetreatForm.move.t > walkingProgress * 2,
  'an engaged retreat must advance materially faster than its walking pace');
const retreatRouteLength = Math.hypot(retreatLeg.link.door.x - retreatLeg.sx,
  retreatLeg.link.door.y - retreatLeg.sy)
  + Math.hypot(retreatLeg.tx - retreatLeg.link.door.x,
    retreatLeg.ty - retreatLeg.link.door.y);
const retreatMaxMps = lockedRetreatSim.P.movement.baseMps
  * lockedRetreatSim._speedMult(lockedRetreatForm)
  * lockedRetreatSim.P.speed.chargeMult;
assert.ok(retreatLeg.travelSec >= retreatRouteLength / retreatMaxMps - 1e-9,
  'an engaged retreat must never exceed the established combat run speed');

// Forms on opposite sides of one doorway share the same tactical cell. A
// single outmatched response must therefore move both appendages to retreat,
// rather than leaving the second half walking into the firing line.
const cohesionSim = new Sim('cohesive-retreat-check');
for (const agent of cohesionSim.agents) agent.dead = true;
const cohesionDoor = openEscapeDoor(cohesionSim);
assert.ok(cohesionDoor, 'cohesion fixture needs a visible doorway');
const cohesionA = makeAgent(FACTION.COMBAT, cohesionDoor.a, cohesionSim.graph);
const cohesionB = makeAgent(FACTION.COMBAT, cohesionDoor.b, cohesionSim.graph);
const cohesionShooters = [0, 1, 2].map(() => makeAgent(FACTION.MARINE, cohesionDoor.b, cohesionSim.graph));
cohesionSim.spawn(cohesionA); cohesionSim.spawn(cohesionB);
for (const shooter of cohesionShooters) cohesionSim.spawn(shooter);
cohesionSim.tickCount = 1;
cohesionSim.t = cohesionSim.dt;
cohesionSim._refreshOccupancy();
assert.equal(cohesionSim.hive.combatPack(cohesionA).length, 2,
  'forms sharing adjacent rooms must share one local tactical cell');
cohesionSim.hive.respondToCombat(cohesionA, cohesionShooters[0], true);
assert.ok(cohesionA.task?.retreat && cohesionB.task?.retreat,
  'one losing contact must send the whole adjacent pack into retreat');

// A retreating appendage that reaches a quiet room with a civilian should
// take the safe body instead of continuing a blind route across the ship.
const preySim = new Sim('retreat-prey-check');
for (const agent of preySim.agents) agent.dead = true;
const preyRoom = preySim.graph.nodes.find((node) => node.w >= 8 && node.d >= 5);
assert.ok(preyRoom, 'retreat-prey fixture needs a usable room');
const preyForm = makeAgent(FACTION.COMBAT, preyRoom.idx, preySim.graph);
const prey = makeAgent(FACTION.CIVILIAN, preyRoom.idx, preySim.graph);
const staleTargetRoom = preySim.graph.nodes.find((node) =>
  preySim.graph.hops(preyRoom.idx, node.idx, ['std'], (edge) => !edge.locked) >= 3);
assert.ok(staleTargetRoom, 'retreat-prey fixture needs a stale target beyond the sense cell');
const staleTarget = makeAgent(FACTION.MARINE, staleTargetRoom.idx, preySim.graph);
preyForm.x = preyRoom.x - 1; prey.x = preyRoom.x + 1;
preySim.spawn(preyForm); preySim.spawn(prey); preySim.spawn(staleTarget);
const preyStepLink = preySim.graph.edges.find((edge) =>
  edge.kind === 'std' && (edge.a === preyRoom.idx || edge.b === preyRoom.idx));
assert.ok(preyStepLink, 'retreat-prey fixture needs an exit');
const preyDestination = preyStepLink.a === preyRoom.idx ? preyStepLink.b : preyStepLink.a;
preyForm.task = { kind: TASK.ATTACK, node: staleTargetRoom.idx, targetId: staleTarget.id, retreat: true };
preySim.setPath(preyForm, [{ to: preyDestination, link: preyStepLink, layer: 'std' }]);
preySim._refreshOccupancy();
preySim._spatialSteer(preyForm, preySim.dt);
assert.equal(preyForm.task.kind, TASK.ATTACK,
  'a quiet-room retreat must switch to a safe civilian target');
assert.equal(preyForm.task.targetId, prey.id,
  'the opportunistic retreat target must be the local civilian body');

// A bait runner turns once when it is hit, then keeps its return leg instead
// of re-triggering the same turn every frame and getting stuck at the door.
const dartSim = new Sim('dart-return-check');
for (const agent of dartSim.agents) agent.dead = true;
const dartDoor = openEscapeDoor(dartSim);
assert.ok(dartDoor, 'dart fixture needs a visible doorway');
const dartForm = makeAgent(FACTION.COMBAT, dartDoor.b, dartSim.graph);
const dartShooter = makeAgent(FACTION.MARINE, dartDoor.b, dartSim.graph);
dartSim.spawn(dartForm); dartSim.spawn(dartShooter);
dartForm.task = { kind: TASK.DART, into: dartDoor.b, back: dartDoor.a, stage: 0 };
dartForm.lastHurtBy = dartShooter.id;
dartForm.lastHurtTick = dartSim.tickCount;
dartSim.tickCount = 1;
dartSim.t = dartSim.dt;
dartSim._refreshOccupancy();
dartSim._spatialSteer(dartForm, dartSim.dt);
assert.equal(dartForm.task.stage, 1, 'a bait runner must turn on the first incoming round');
assert.equal(dartForm.task.kind, TASK.DART, 'turning a bait runner must preserve its bait role');
assert.equal(dartForm.path.at(-1)?.to, dartDoor.a,
  'the bait runner must return to its staged pack');
dartSim._advanceMovement(dartSim.dt);
const dartLeg = dartForm.move;
assert.ok(dartLeg, 'the bait runner must start its return leg');
dartSim.tickCount++;
dartSim.t += dartSim.dt;
dartSim._refreshOccupancy();
dartSim._spatialSteer(dartForm, dartSim.dt);
dartSim._advanceMovement(dartSim.dt);
assert.equal(dartForm.move, dartLeg,
  'continued incoming fire must not restart the bait runner return leg');
assert.ok(dartLeg.t > 0, 'the bait runner must make progress while under fire');

// One appendage being shot gives the whole visible pack one response. Every
// member abandons its stale destination, pursues the shared nearest marine,
// and keeps the charge multiplier through the intervening doorway.
const packSim = new Sim('shared-pack-response-check');
for (const agent of packSim.agents) agent.dead = true;
const packDoor = openEscapeDoor(packSim);
assert.ok(packDoor, 'pack fixture needs a visible doorway and alternate route');
const escape = [...packSim.graph.neighbors(packDoor.a, ['std'], (edge) => !edge.locked)]
  .find(({ to }) => to !== packDoor.b);
assert.ok(escape, 'pack fixture needs a stale destination away from the shooter');
const packForms = [0, 1, 2].map(() => makeAgent(FACTION.COMBAT, packDoor.a, packSim.graph));
const packShooter = makeAgent(FACTION.MARINE, packDoor.b, packSim.graph);
for (const form of packForms) {
  form.hp = form.maxHp = 90;
  packSim.spawn(form);
  form.task = { kind: TASK.GUARD, node: escape.to };
  packSim.setPathTo(form, escape.to, ['std'], (edge) => !edge.locked);
}
packSim.spawn(packShooter);
packShooter.dead = true;
packSim.tickCount = 1;
packSim.t = packSim.dt;
packSim._refreshOccupancy();
packSim._advanceMovement(packSim.dt);
assert.ok(packForms.every((form) => form.move), 'pack fixture must begin on stale move legs');
packShooter.dead = false;
packSim._refreshOccupancy();
packForms[0].lastHurtBy = packShooter.id;
packForms[0].lastHurtTick = packSim.tickCount;
packSim._spatialSteer(packForms[0], packSim.dt);
for (const form of packForms) {
  assert.equal(form.task.kind, TASK.ATTACK, 'one incoming round must turn every pack member onto combat');
  assert.equal(form.task.surge, true, 'the entire responding pack must share the surge');
  assert.equal(form.task.targetId, packShooter.id, 'each appendage must pursue the shared nearest marine');
}
for (const form of packForms.slice(1)) packSim._spatialSteer(form, packSim.dt);
assert.ok(packForms.every((form) => !form.move), 'live contact must cancel every stale move leg');
packSim._advanceMovement(packSim.dt);
for (const form of packForms) {
  assert.equal(form.charging, true, 'a cross-room surge must begin at charge speed');
  assert.ok(form.move, 'each pack member must immediately start through the doorway');
  const move = form.move;
  const d1 = Math.hypot(move.link.door.x - move.sx, move.link.door.y - move.sy);
  const d2 = Math.hypot(move.tx - move.link.door.x, move.ty - move.link.door.y);
  const walking = (d1 + d2) / (packSim.P.movement.baseMps * packSim._speedMult(form));
  assert.ok(Math.abs(move.travelSec - walking / packSim.P.speed.chargeMult) < 1e-6,
    'a surge leg must use the full charge multiplier without per-form slowdown');
}
const firstLegs = packForms.map((form) => form.move);
packSim.tickCount++;
packSim.t += packSim.dt;
packSim._refreshOccupancy();
for (const form of packForms) packSim._spatialSteer(form, packSim.dt);
assert.ok(packForms.every((form, i) => form.move === firstLegs[i]),
  'a live cross-room chase must preserve its in-progress doorway leg');
packSim._advanceMovement(packSim.dt);
assert.ok(packForms.every((form) => form.move.t > 0),
  'a preserved doorway charge must gain progress on the following tick');

// Even when several forms begin at the same pixel, the shared charge remains
// a crowd of solid bodies rather than one stacked glyph.
const stackSim = new Sim('stacked-pack-check');
for (const agent of stackSim.agents) agent.dead = true;
const stackRoom = stackSim.graph.nodes.find((node) => node.w >= 10 && node.d >= 6);
assert.ok(stackRoom, 'stack fixture needs open floor');
const stacked = [0, 1, 2].map(() => makeAgent(FACTION.COMBAT, stackRoom.idx, stackSim.graph));
const loneMarine = makeAgent(FACTION.MARINE, stackRoom.idx, stackSim.graph);
for (const form of stacked) {
  form.x = stackRoom.x - 2;
  form.y = stackRoom.y;
  stackSim.spawn(form);
}
loneMarine.x = stackRoom.x + 2;
loneMarine.y = stackRoom.y;
stackSim.spawn(loneMarine);
stackSim.tickCount = 1;
stackSim.t = stackSim.dt;
stackSim._refreshOccupancy();
stacked[0].lastHurtBy = loneMarine.id;
stacked[0].lastHurtTick = stackSim.tickCount;
stackSim._spatialSteer(stacked[0], stackSim.dt);
for (const form of stacked.slice(1)) stackSim._spatialSteer(form, stackSim.dt);
stackSim._separate(stackSim.dt);
for (let i = 0; i < stacked.length; i++) for (let j = i + 1; j < stacked.length; j++) {
  assert.ok(Math.hypot(stacked[i].x - stacked[j].x, stacked[i].y - stacked[j].y) > 0.1,
    'responding combat forms must separate instead of stacking');
}

// The extra space is combat-form-to-combat-form only: it should loosen a
// rush visually without making the forms wider at doors, walls or targets.
stacked[2].dead = loneMarine.dead = true;
const baseCombatPair = stackSim._bodyRadius(stacked[0]) + stackSim._bodyRadius(stacked[1]);
stacked[0].x = stackRoom.x - baseCombatPair / 2;
stacked[0].y = stackRoom.y;
stacked[1].x = stackRoom.x + baseCombatPair / 2;
stacked[1].y = stackRoom.y;
stackSim._refreshOccupancy();
stackSim._separate(1);
assert.ok(Math.abs(Math.hypot(stacked[0].x - stacked[1].x, stacked[0].y - stacked[1].y)
    - baseCombatPair * stackSim.P.combat.combatForm.crowdRadiusScale) < 1e-9,
  'combat-form pairs must keep the configured extra crowd spacing');

// A long combat-form leap in an open volume starts its five-second cooldown
// at touchdown, not launch. The form keeps charging on foot during the wait.
const leapSim = new Sim('combat-leap-cooldown-check');
for (const agent of leapSim.agents) agent.dead = true;
const leapRoom = leapSim.graph.nodes.find((node) =>
  node.w >= 12 && node.d >= 8 && clearHeightOf(node) > CLEAR_H + 0.5);
assert.ok(leapRoom, 'leap cooldown fixture needs a large room with headroom');
const leaper = makeAgent(FACTION.COMBAT, leapRoom.idx, leapSim.graph);
const leapTarget = makeAgent(FACTION.MARINE, leapRoom.idx, leapSim.graph);
leaper.hp = leaper.maxHp = 90;
leapTarget.hp = leapTarget.maxHp = 100;
leaper.x = leapRoom.x - 5;
leaper.y = leapTarget.y = leapRoom.y;
leapTarget.x = leapRoom.x + 5;
leapSim.spawn(leaper);
leapSim.spawn(leapTarget);
leapSim.tickCount = 1;
leapSim.t = leapSim.dt;
leapSim._refreshOccupancy();
leaper.lastHurtBy = leapTarget.id;
leaper.lastHurtTick = leapSim.tickCount;
leapSim._spatialSteer(leaper, leapSim.dt);
assert.equal(leaper.leaping, true, 'a fresh combat form may leap across a large room');
let leapGuard = 0;
while (leaper.leaping && leapGuard++ < 100) {
  leapSim.tickCount++;
  leapSim.t += leapSim.dt;
  leapSim._spatialSteer(leaper, leapSim.dt);
}
assert.ok(leapGuard < 100, 'the cooldown fixture leap must land');
const landedAt = leapSim.t;
assert.equal(leaper.nextCombatLeapAt, landedAt + leapSim.P.combat.combatForm.leapCooldownSec,
  'the five-second cooldown must begin when the previous leap ends');

const resetLeapRun = (time) => {
  leapSim.t = time;
  leapSim.tickCount = Math.round(time / leapSim.dt);
  leaper.x = leapRoom.x - 5;
  leaper.y = leapRoom.y;
  leapTarget.x = leapRoom.x + 5;
  leapTarget.y = leapRoom.y;
  leaper.lastHurtBy = leapTarget.id;
  leaper.lastHurtTick = leapSim.tickCount;
  leapSim._spatialSteer(leaper, leapSim.dt);
};
resetLeapRun(leaper.nextCombatLeapAt - leapSim.dt);
assert.equal(leaper.leaping, false, 'the form must keep charging on foot before five seconds pass');
resetLeapRun(leaper.nextCombatLeapAt);
assert.equal(leaper.leaping, true, 'the form may leap again once five seconds have elapsed');

// Under live pressure with no infection economy, scarcity roots one or two
// rearmost carrier seeds, assigns a bounded screen, and keeps disruptors free.
const seedSim = new Sim('pressured-carrier-seed-check');
for (const agent of seedSim.agents) agent.dead = true;
const seedDoor = openEscapeDoor(seedSim);
assert.ok(seedDoor, 'carrier seed fixture needs a defended front and rear route');
const rear = [...seedSim.graph.neighbors(seedDoor.a, ['std'], (edge) => !edge.locked)]
  .find(({ to }) => to !== seedDoor.b);
assert.ok(rear, 'carrier seed fixture needs rearmost ground');
const seedForms = [0, 1, 2, 3, 4, 5].map((_, i) =>
  makeAgent(FACTION.COMBAT, i < 3 ? seedDoor.a : rear.to, seedSim.graph));
const seedMarine = makeAgent(FACTION.MARINE, seedDoor.b, seedSim.graph);
for (const form of seedForms) seedSim.spawn(form);
seedSim.spawn(seedMarine);
seedSim.t = 100;
seedSim.tickCount = Math.round(seedSim.t / seedSim.dt);
seedSim.hive.opening = true;
seedSim.hive.posture = 'EVASIVE';
seedSim.hive.allIn = false;
seedSim._refreshOccupancy();
seedSim._computeInfluence();
seedSim.hive.openingMove([], seedForms, []);
const roots = seedForms.filter((form) => form.task?.kind === TASK.TRANSFORM);
assert.ok(roots.length >= 1 && roots.length <= 2, 'a cornered pocket must root one or two carrier seeds');
assert.ok(roots.some((form) => (form.pnode ?? form.node) === rear.to),
  'the pressured carrier plan must choose the rearmost available ground');
assert.equal(seedForms.filter((form) => form.task?.screen !== undefined).length, 2,
  'the carrier seeds must receive a bounded two-form screen');
assert.equal(seedForms.filter((form) => form.task?.kind === TASK.DECOY
  && form.task.pressured).length, 2,
  'the carrier portfolio must send two bodies to disrupt the gun line');

// The screenshot regression: a roomful of forms outside four rifles is one
// connected hive response. The appendage with the sightline commits the whole
// attack-ratio-plus mass instead of repeatedly probing the doorway alone.
const breachSim = new Sim('overwhelming-door-breach-check');
for (const agent of breachSim.agents) agent.dead = true;
const breachDoor = openEscapeDoor(breachSim);
assert.ok(breachDoor, 'overwhelming breach fixture needs a visible doorway');
const breachForms = Array.from({ length: 15 }, () => makeAgent(FACTION.COMBAT, breachDoor.a, breachSim.graph));
const breachMarines = Array.from({ length: 4 }, () => makeAgent(FACTION.MARINE, breachDoor.b, breachSim.graph));
for (const form of breachForms) breachSim.spawn(form);
for (const defender of breachMarines) breachSim.spawn(defender);
breachSim.tickCount = 1;
breachSim.t = breachSim.dt;
breachSim._refreshOccupancy();
breachForms[0].lastHurtBy = breachMarines[0].id;
breachForms[0].lastHurtTick = breachSim.tickCount;
breachSim._spatialSteer(breachForms[0], breachSim.dt);
assert.ok(breachForms.every((form) => form.task?.kind === TASK.ATTACK && form.task.surge),
  'an overwhelming pack must surge through the doorway as one response');
const targetLoads = new Map();
for (const form of breachForms) {
  if (form.task.targetId === undefined) continue;
  targetLoads.set(form.task.targetId, (targetLoads.get(form.task.targetId) ?? 0) + 1);
}
assert.equal([...targetLoads.values()].reduce((sum, count) => sum + count, 0), 12,
  'four marines must receive three concrete attackers each');
assert.ok([...targetLoads.values()].every((count) => count === 3),
  'no marine may receive more than its three-form attack team');

const firstTarget = breachMarines[0];
const secondTarget = breachMarines[1];
const firstTeam = breachForms.filter((form) => form.task.targetId === firstTarget.id);
const secondTeam = breachForms.filter((form) => form.task.targetId === secondTarget.id);
assert.equal(firstTeam.length, 3, 'the nearest marine must receive the first trio');
assert.equal(secondTeam.length, 3, 'the next marine must receive the second trio');
for (const form of firstTeam) form.dead = true;
breachSim.tickCount++;
breachSim.t += breachSim.dt;
breachSim._refreshOccupancy();
breachSim.hive.respondToCombat(secondTeam[0], firstTarget, true);
assert.ok(secondTeam.every((form) => form.task.targetId === secondTarget.id),
  'losing the first trio must not retask a surviving trio onto the newly open target');
const replacementFirstTeam = breachForms.filter((form) => !form.dead
  && form.task.targetId === firstTarget.id);
assert.equal(replacementFirstTeam.length, 3,
  'previously unassigned forms may fill the newly open attack slots');
for (const form of replacementFirstTeam) form.dead = true;
secondTarget.dead = true;
breachSim.tickCount++;
breachSim.t += breachSim.dt;
breachSim._refreshOccupancy();
breachSim.hive.respondToCombat(secondTeam[0], firstTarget, true);
assert.ok(secondTeam.every((form) => form.task.targetId === firstTarget.id),
  'a target death must release its trio onto the nearest available marine');

// Global combat dominance ends the conservative opening and cancels existing
// retreats at exactly two active forms per believed marine. A small remnant
// still cannot infer victory merely because its marine counter reached zero.
const dominanceSim = new Sim('global-combat-dominance-check');
const fixedDeckOne = dominanceSim.agents.filter((agent) => agent.faction === FACTION.MARINE
  && agent.garrison && agent.deck === 1);
const mobileMarines = dominanceSim.agents.filter((agent) => agent.faction === FACTION.MARINE
  && !agent.garrison);
assert.equal(dominanceSim.hive.marinesBelieved, mobileMarines.length,
  'global dominance must exclude fixed Deck 1 Marines from its denominator');
const believedBeforeGuardKill = dominanceSim.hive.marinesBelieved;
dominanceSim.hive.noteMarineKill(fixedDeckOne[0]);
assert.equal(dominanceSim.hive.marinesBelieved, believedBeforeGuardKill,
  'killing an excluded Deck 1 guard must not decrement the mobile-force ledger');
dominanceSim.hive.noteMarineKill(mobileMarines[0]);
assert.equal(dominanceSim.hive.marinesBelieved, believedBeforeGuardKill - 1,
  'killing a counted field Marine must decrement the mobile-force ledger');
for (const agent of dominanceSim.agents) {
  if (agent.faction === FACTION.INFECTION || agent.faction === FACTION.COMBAT
    || agent.faction === FACTION.CARRIER) agent.dead = true;
}
dominanceSim.hive.marinesBelieved = 4;
assert.equal(dominanceSim.hive.combatDominates(7), false,
  'seven forms must not claim dominance over four believed marines');
assert.equal(dominanceSim.hive.combatDominates(8), true,
  'the 2:1 global combat threshold must trigger exactly');
dominanceSim.hive.marinesBelieved = 0;
assert.equal(dominanceSim.hive.combatDominates(7), false,
  'a tiny remnant must not claim an empty marine ledger as certain victory');
assert.equal(dominanceSim.hive.combatDominates(8), true,
  'the minimum fighting mass must close a zero-marine endgame');
dominanceSim.hive.marinesBelieved = 4;
const dominanceForms = Array.from({ length: 8 }, () =>
  makeAgent(FACTION.COMBAT, dominanceSim.graph.breachNode, dominanceSim.graph));
for (const form of dominanceForms) dominanceSim.spawn(form);
dominanceForms[0].task = { kind: TASK.MOVE, node: dominanceForms[0].node,
  retreat: true, threatNode: dominanceForms[0].node, retreatStrength: 1 };
dominanceForms[0].path = [{ to: dominanceForms[0].node, link: null, layer: 'std' }];
dominanceSim._refreshOccupancy();
dominanceSim._computeInfluence();
dominanceSim.hive.strategicTick();
assert.equal(dominanceSim.hive.combatDominant, true,
  'the strategic posture must expose global combat dominance');
assert.equal(dominanceSim.hive.allIn, true,
  'global combat dominance must activate all-in routing and contact rules');
assert.equal(dominanceSim.hive.opening, false,
  'global combat dominance must not remain trapped in opening doctrine');
assert.ok(dominanceForms.every((form) => !form.task?.retreat),
  'global combat dominance must cancel every surviving retreat');
assert.ok(dominanceForms.every((form) => form.task?.kind === TASK.ATTACK
  || form.task?.kind === TASK.SCOUT
  || form.task?.kind === TASK.TRANSFORM
  || (form.task?.kind === TASK.GUARD && form.task.muster !== undefined)),
  'dominant combat forms must attack or preserve only the hive production bet');
assert.ok(dominanceForms.filter((form) => form.task?.kind === TASK.TRANSFORM).length <= 1,
  'dominance must preserve at most one immediate carrier investment');

// A stale all-in attack must be replaced by topology search. This is the
// late-game failure mode where a whole army kept charging an empty room after
// its last confident contact decayed, leaving isolated survivors untouched.
const staleAttack = dominanceForms[0];
dominanceSim.hive.searchingAll = true;
dominanceSim.hive.allIn = false;
dominanceSim.hive.believedHumanStr.fill(0);
dominanceSim.hive.believedHardness.fill(0);
staleAttack.task = { kind: TASK.ATTACK, node: staleAttack.node };
staleAttack.path = [];
staleAttack.charging = true;
dominanceSim.hive.steadyState([], dominanceForms, [], [], 0,
  dominanceForms.length, 0, dominanceSim.hive.lastScarcity);
assert.notEqual(staleAttack.task?.kind, TASK.ATTACK,
  'search-all must discard an attack whose human contact has gone stale');
assert.equal(staleAttack.charging, false,
  'discarding a stale attack must also clear its orphaned charge pose');

// Strategic retasking must not leave a form physically travelling away from
// its new objective. Matching destinations preserve the leg (no stutter);
// an opposite order interrupts and re-anchors it before the next path solve.
const retaskSim = new Sim('strategic-opposite-leg-check');
for (const agent of retaskSim.agents) agent.dead = true;
const retaskDoor = openEscapeDoor(retaskSim);
assert.ok(retaskDoor, 'strategic retask fixture needs an open standard edge');
const retaskedForm = makeAgent(FACTION.COMBAT, retaskDoor.a, retaskSim.graph);
retaskSim.spawn(retaskedForm);
retaskSim.tickCount = 1;
retaskSim.t = retaskSim.dt;
retaskedForm.task = { kind: TASK.GUARD, node: retaskDoor.b };
retaskSim.setPathTo(retaskedForm, retaskDoor.b, ['std'], (edge) => !edge.locked);
retaskSim._refreshOccupancy();
retaskSim._advanceMovement(retaskSim.dt);
assert.ok(retaskedForm.move, 'strategic retask fixture must begin a physical leg');
const retainedLeg = retaskedForm.move;
retaskSim.hive.assign(retaskedForm, { kind: TASK.ATTACK, node: retaskDoor.b });
assert.equal(retaskedForm.move, retainedLeg,
  'a replacement order with the same destination must preserve movement');
retaskSim.hive.assign(retaskedForm, { kind: TASK.ATTACK, node: retaskDoor.a });
assert.equal(retaskedForm.move, null,
  'a replacement order aimed behind the mover must cancel the opposite leg');
assert.equal(retaskedForm.node, retaskDoor.a,
  'the interrupted mover must re-anchor where it physically stands');

// An all-in hive must be able to see and route to survivors behind another
// remembered gun line. Previously nearestBelievedHuman returned no target and
// the entire rear mass idled at its carrier node.
const allInSim = new Sim('all-in-routing-check');
for (const agent of allInSim.agents) agent.dead = true;
const allInFrom = allInSim.graph.nodes.find((node) =>
  allInSim.graph.nodesWithin(node.idx, 2, ['std'], allInSim.hive.bigPass).length > 2);
assert.ok(allInFrom, 'all-in fixture needs a route at least two rooms long');
const allInTarget = allInSim.graph.nodesWithin(allInFrom.idx, 2, ['std'], allInSim.hive.bigPass)
  .find((node) => allInSim.graph.hops(allInFrom.idx, node, ['std'], allInSim.hive.bigPass) === 2);
assert.notEqual(allInTarget, undefined, 'all-in fixture needs a target behind an intermediate room');
allInSim.hive.believedHumanStr.fill(0);
allInSim.hive.believedHardness.fill(0);
allInSim.hive.believedHumanStr[allInTarget] = 1;
for (const { to } of allInSim.graph.neighbors(allInFrom.idx, ['std'], allInSim.hive.bigPass)) {
  allInSim.hive.believedHardness[to] = 1;
}
assert.equal(allInSim.hive.nearestBelievedHuman(allInFrom.idx), -1,
  'measured routing should still reject an intervening gun line');
assert.equal(allInSim.hive.nearestAllInHuman(allInFrom.idx), allInTarget,
  'all-in routing must retain the survivor behind that line as an objective');
const allInForm = makeAgent(FACTION.COMBAT, allInFrom.idx, allInSim.graph);
allInSim.spawn(allInForm);
allInSim.hive.allIn = true;
allInForm.task = { kind: TASK.ATTACK, node: allInTarget };
updateFloodTick(allInSim, allInSim.dt);
assert.ok(allInForm.path.length > 0,
  'an all-in attack must take the direct breach route instead of idling');

// Searching for unlocated survivors is not itself an all-in attack. Free
// appendages fan across the graph while production commitments remain intact.
const sweepSim = new Sim('unknown-contact-sweep-check');
for (const agent of sweepSim.agents) agent.dead = true;
const sweepForms = Array.from({ length: 10 }, () => makeAgent(FACTION.COMBAT, sweepSim.graph.breachNode, sweepSim.graph));
const sweepPods = Array.from({ length: 6 }, () => makeAgent(FACTION.INFECTION, sweepSim.graph.breachNode, sweepSim.graph));
for (const form of sweepForms) sweepSim.spawn(form);
for (const form of sweepPods) sweepSim.spawn(form);
sweepSim.hive.opening = false;
sweepSim.hive.allIn = false;
sweepSim.hive.searchingAll = true;
sweepSim.hive.posture = 'EVASIVE';
sweepSim.hive.believedHumanStr.fill(0);
sweepSim.hive.believedHardness.fill(0);
sweepSim._refreshOccupancy();
sweepSim._computeInfluence();
sweepSim.hive.steadyState(sweepPods, sweepForms, [], [], sweepPods.length, sweepForms.length, 5, 1);
const sweeps = sweepForms.filter((form) => form.task?.kind === TASK.SCOUT && form.task.sweep);
assert.equal(sweeps.length, sweepForms.length,
  'an uncertain hive must send every free combat form searching without requiring all-in');
assert.ok(new Set(sweeps.map((form) => form.task.node)).size > 1,
  'the endgame search must fan out across the live graph instead of forming another pile');
assert.ok(sweepPods.every((form) => form.task?.kind === TASK.SCOUT && form.task.sweep),
  'free infection forms must join the shared coverage sweep instead of parking at a carrier');
assert.ok(new Set(sweepPods.map((form) => form.task.node)).size > 1,
  'infection-form coverage must distribute across the topology');

// A hatch the hive has already found locked is still searchable territory:
// combat forms route to the panel and let the ordinary door-busting actuator
// open it instead of treating everything beyond it as nonexistent.
const breachSearchSim = new Sim('locked-door-search-check');
for (const agent of breachSearchSim.agents) agent.dead = true;
const searchDoor = breachSearchSim.graph.edges.find((edge) => edge.kind === 'std'
  && edge.door && !edge.armorySeal && !edge.fireSite);
assert.ok(searchDoor, 'search fixture needs a breachable door');
searchDoor.locked = true;
breachSearchSim.hive.knownLocked.add(searchDoor.i);
breachSearchSim.graph.invalidatePathCache();
const breachSearcher = makeAgent(FACTION.COMBAT, searchDoor.a, breachSearchSim.graph);
breachSearchSim.spawn(breachSearcher);
breachSearcher.task = { kind: TASK.SCOUT, node: searchDoor.b, sweep: true };
breachSearchSim.tickCount = 1;
breachSearchSim.t = breachSearchSim.dt;
breachSearchSim._refreshOccupancy();
updateFloodTick(breachSearchSim, breachSearchSim.dt);
assert.ok(breachSearcher.path.some((step) => step.link === searchDoor),
  'a combat search path must include a known locked but breachable hatch');
breachSearchSim._advanceMovement(breachSearchSim.dt);
assert.equal(breachSearcher.busting, searchDoor,
  'the searcher must begin battering the locked hatch instead of dropping its task');

// A stale manifest entry must activate that search through the real strategic
// posture even when the hive is too small to claim combat dominance.
const uncertainSim = new Sim('uncertain-survivor-search-check');
for (const agent of uncertainSim.agents) agent.dead = true;
const hiddenSurvivor = makeAgent(FACTION.CIVILIAN,
  uncertainSim.graph.nodes.at(-1).idx, uncertainSim.graph);
const uncertainForms = Array.from({ length: 8 }, () =>
  makeAgent(FACTION.COMBAT, uncertainSim.graph.breachNode, uncertainSim.graph));
uncertainSim.spawn(hiddenSurvivor);
for (const form of uncertainForms) uncertainSim.spawn(form);
uncertainSim.hive.beliefs = new Map([[hiddenSurvivor.id,
  { node: hiddenSurvivor.node, t: 0, conf: 0 }]]);
uncertainSim.hive.opening = false;
uncertainSim.hive.marinesBelieved = 20;
uncertainSim.t = 300;
uncertainSim._refreshOccupancy();
uncertainSim._computeInfluence();
uncertainSim.hive.strategicTick();
assert.equal(uncertainSim.hive.searchingAll, true,
  'known living survivors with no location must activate topology search');
assert.equal(uncertainSim.hive.allIn, false,
  'topology search must not manufacture combat dominance');
assert.ok(uncertainForms.some((form) => form.task?.kind === TASK.SCOUT && form.task.sweep),
  'free combat forms must receive distributed search work from the strategic tick');
uncertainSim.hive.marinesBelieved = 4;
uncertainSim.hive.strategicTick();
assert.equal(uncertainSim.hive.searchingAll, true,
  'combat dominance must preserve the lost-contact topology search');
assert.equal(uncertainSim.hive.allIn, false,
  'unknown survivor positions must remain search objectives rather than fake attack targets');
assert.equal(uncertainSim.hive.posture, 'AGGRESSIVE',
  'a combat-dominant search must end evasive behavior before contact is reacquired');

// Bodies scale the reproductive pipeline beyond the ordinary carrier cap.
// Searchers remain eligible for that investment, but only one seed is drafted
// at a time while the prior one is still walking or rooting.
const bodyCarrierSim = new Sim('body-backed-carrier-check');
for (const agent of bodyCarrierSim.agents) agent.dead = true;
const carrierNode = bodyCarrierSim.graph.nodes.find((node) => node.idx !== bodyCarrierSim.graph.breachNode);
assert.ok(carrierNode, 'body-backed carrier fixture needs a second room');
const bodyCombat = Array.from({ length: 74 }, () =>
  makeAgent(FACTION.COMBAT, bodyCarrierSim.graph.breachNode, bodyCarrierSim.graph));
const bodyCarriers = Array.from({ length: 5 }, () =>
  makeAgent(FACTION.CARRIER, carrierNode.idx, bodyCarrierSim.graph));
const freeBodies = Array.from({ length: 20 }, () =>
  makeAgent(FACTION.CORPSE, bodyCarrierSim.graph.breachNode, bodyCarrierSim.graph));
for (const form of [...bodyCombat, ...bodyCarriers, ...freeBodies]) bodyCarrierSim.spawn(form);
for (const form of bodyCombat) form.task = { kind: TASK.SCOUT, node: carrierNode.idx, sweep: true };
bodyCarrierSim.hive.bestCarrierNode = () => bodyCarrierSim.graph.breachNode;
bodyCarrierSim.hive.opening = false;
bodyCarrierSim.hive.searchingAll = true;
bodyCarrierSim.hive.allIn = false;
bodyCarrierSim._refreshOccupancy();
bodyCarrierSim._computeInfluence();
const runBodyCarrierPlan = () => bodyCarrierSim.hive.steadyState([], bodyCombat,
  bodyCarriers, freeBodies, 0, bodyCombat.length, bodyCarriers.length,
  bodyCarrierSim.hive.scarcity(bodyCarriers.length * 2));
runBodyCarrierPlan();
assert.equal(bodyCombat.filter((form) => form.task?.kind === TASK.TRANSFORM || form.task?.seed).length, 1,
  'a body-rich combat population must grow carriers beyond the old fixed cap');
runBodyCarrierPlan();
assert.equal(bodyCombat.filter((form) => form.task?.kind === TASK.TRANSFORM || form.task?.seed).length, 1,
  'an unfinished carrier seed must prevent repeated drafting for the same free body');

// Contact decay erases a location, not the shared hive's knowledge that the
// person remains unaccounted for. Deleting the whole record made hidden last
// survivors cease to exist in the hive's decision model.
const memorySim = new Sim('contact-memory-check');
for (const agent of memorySim.agents) agent.dead = true;
const hiddenMarine = makeAgent(FACTION.MARINE, memorySim.graph.nodes.at(-1).idx, memorySim.graph);
memorySim.spawn(hiddenMarine);
memorySim.hive.beliefs = new Map([[hiddenMarine.id,
  { node: hiddenMarine.node, t: 0, conf: 0.051 }]]);
memorySim.t = memorySim.P.sim.strategicTickSec;
memorySim.hive.updateBeliefs();
assert.equal(memorySim.hive.beliefs.has(hiddenMarine.id), true,
  'a faded contact must retain the survivor identity');
assert.equal(memorySim.hive.beliefs.get(hiddenMarine.id).conf, 0,
  'a faded contact must stop contributing a guessed position');
assert.equal(memorySim.hive.believedHumanStr.reduce((sum, value) => sum + value, 0), 0,
  'an unknown survivor must not leak ground-truth location into tactical beliefs');

// The player is an armed-crew agent while their fireteam uses the marine
// faction. Faction priority must never make a form run past the closer player
// to reach a farther squadmate; both pursuit and the actual swipe use distance.
const playerTargetSim = new Sim('nearest-player-target-check');
for (const agent of playerTargetSim.agents) agent.dead = true;
const playerRoom = playerTargetSim.graph.nodes.find((node) => node.w >= 10 && node.d >= 6);
assert.ok(playerRoom, 'player target fixture needs an open room');
const playerHunter = makeAgent(FACTION.COMBAT, playerRoom.idx, playerTargetSim.graph);
playerHunter.hostArmed = true;
const closePlayer = makeAgent(FACTION.ARMED, playerRoom.idx, playerTargetSim.graph);
const farMarine = makeAgent(FACTION.MARINE, playerRoom.idx, playerTargetSim.graph);
playerHunter.x = playerRoom.x - 1;
playerHunter.y = playerRoom.y;
closePlayer.x = playerRoom.x;
closePlayer.y = playerRoom.y;
closePlayer.hp = closePlayer.maxHp = 45;
closePlayer.isPlayer = true;
farMarine.x = playerRoom.x + 1;
farMarine.y = playerRoom.y;
farMarine.hp = farMarine.maxHp = 45;
playerTargetSim.spawn(playerHunter);
playerTargetSim.spawn(closePlayer);
playerTargetSim.spawn(farMarine);
playerTargetSim.tickCount = 1;
playerTargetSim.t = playerTargetSim.dt;
playerTargetSim.hive.allIn = true;
playerTargetSim._refreshOccupancy();
assert.equal(playerTargetSim.hive.nearestCombatTarget(playerHunter), closePlayer,
  'a combat form must target the closer player instead of a farther marine');
assert.equal(playerTargetSim.hive.respondToCombat(playerHunter, closePlayer), true,
  'the shared hive response must commit the hunter to the closer player');
assert.equal(playerHunter.task.targetId, closePlayer.id,
  'the live pursuit task must stay on the closer player');
const playerHp = closePlayer.hp;
const marineHpBefore = farMarine.hp;
resolveCombat(playerTargetSim, playerTargetSim.dt);
assert.ok(closePlayer.hp < playerHp, 'the nearest player must receive the combat-form swipe');
assert.equal(farMarine.hp, marineHpBefore, 'the farther marine must not absorb the player\'s attack');
assert.equal(playerHunter.hostShotTick, playerTargetSim.tickCount,
  'a hosted weapon must stamp the exact form that fired');
assert.equal(playerHunter.hostShotTargetId, closePlayer.id,
  'a hosted weapon must stamp the target combat actually resolved');

// A strategic target remains sticky at range, but cannot create a point-blank
// immunity bubble around a player who crosses its path. The physical contact
// is handled now; the original assignment survives and resumes afterward.
const lockedTargetSim = new Sim('point-blank-lock-override-check');
for (const agent of lockedTargetSim.agents) agent.dead = true;
const lockedRoom = lockedTargetSim.graph.nodes.find((node) => node.w >= 10 && node.d >= 6);
const lockedHunter = makeAgent(FACTION.COMBAT, lockedRoom.idx, lockedTargetSim.graph);
const crossingPlayer = makeAgent(FACTION.ARMED, lockedRoom.idx, lockedTargetSim.graph);
const assignedMarine = makeAgent(FACTION.MARINE, lockedRoom.idx, lockedTargetSim.graph);
lockedHunter.x = lockedRoom.x - 2;
lockedHunter.y = lockedRoom.y;
crossingPlayer.x = lockedHunter.x + lockedTargetSim.P.combat.meleeRangeM * 0.7;
crossingPlayer.y = lockedHunter.y;
crossingPlayer.hp = crossingPlayer.maxHp = 45;
crossingPlayer.isPlayer = true;
assignedMarine.x = lockedRoom.x + 3;
assignedMarine.y = lockedRoom.y;
assignedMarine.hp = assignedMarine.maxHp = 45;
lockedTargetSim.spawn(lockedHunter);
lockedTargetSim.spawn(crossingPlayer);
lockedTargetSim.spawn(assignedMarine);
lockedHunter.task = { kind: TASK.ATTACK, targetId: assignedMarine.id, node: lockedRoom.idx };
lockedTargetSim.tickCount = 1;
lockedTargetSim.t = lockedTargetSim.dt;
lockedTargetSim._refreshOccupancy();
const crossingHp = crossingPlayer.hp;
const assignedHp = assignedMarine.hp;
resolveCombat(lockedTargetSim, lockedTargetSim.dt);
assert.ok(crossingPlayer.hp < crossingHp,
  'a combat form must swipe a player already inside reach despite a farther sticky assignment');
assert.equal(assignedMarine.hp, assignedHp,
  'the farther assignment must not absorb a point-blank player swipe');
assert.equal(lockedHunter.task.targetId, assignedMarine.id,
  'the contact override must preserve the strategic assignment instead of restarting target oscillation');

// A grand stair is one open volume. Its combat sightline works in both
// directions, and traversal never gives an agent coordinates from one deck
// while its logical room still belongs to another.
const stairSim = new Sim('grand-stair-frame-check');
for (const agent of stairSim.agents) agent.dead = true;
assert.ok(stairSim.graph.stairwells.length, 'stair fixture needs a grand stairwell');
const stair = stairSim.graph.stairwells[0];
const upperMarine = makeAgent(FACTION.MARINE, stair.upper, stairSim.graph);
const lowerForm = makeAgent(FACTION.COMBAT, stair.lower, stairSim.graph);
stairSim.tickCount = 1;
stairSim.t = stairSim.dt;
stairSim.spawn(upperMarine);
stairSim.spawn(lowerForm);
stairSim._refreshOccupancy();
assert.equal(stairSim.hasLineOfSight(upperMarine, lowerForm), true,
  'the shared LOS wrapper must preserve the grand stair cross-deck sightline');
assert.ok(stairSim.lineOfSightAgents(lowerForm, (agent) => agent === upperMarine).includes(upperMarine),
  'cross-deck stair occupants must enter the cached combat candidate set');
upperMarine.dead = true;
lowerForm.dead = true;
for (const [from, to] of [[stair.upper, stair.lower], [stair.lower, stair.upper]]) {
  const walker = makeAgent(FACTION.COMBAT, from, stairSim.graph);
  stairSim.spawn(walker);
  stairSim.setPath(walker, [{ to, link: stair.edge, layer: 'std' }]);
  stairSim._refreshOccupancy();
  let ticks = 0;
  while ((walker.move || walker.path.length) && ticks++ < 1000) {
    stairSim._advanceMovement(stairSim.dt);
    stairSim._refreshOccupancy();
    assert.equal(stairSim.graph.node(walker.node).deck, walker.deck,
      'a stair mover room and coordinate frame must always name the same deck');
    const room = stairSim.graph.node(walker.pnode ?? walker.node);
    assert.equal(room.deck, walker.deck, 'physical stair occupancy must stay on the active deck');
  }
  assert.ok(ticks < 1000, 'grand stair traversal must finish');
  assert.equal(walker.node, to, 'grand stair traversal must land in its paired room');
  walker.dead = true;
}

// LOS is allowed to cross more than one graph node. A marine detecting such a
// target must enter FIGHT and actually fire through the aligned openings.
const doorwaySim = new Sim('marine-los-check');
for (const agent of doorwaySim.agents) agent.dead = true;
for (const edge of doorwaySim.graph.edges) {
  if (edge.door && !edge.locked) edge.open01 = 1;
}
let sightPair = null;
for (const a of doorwaySim.graph.nodes) {
  for (const b of doorwaySim.graph.nodes) {
    if (a.idx >= b.idx || a.deck !== b.deck) continue;
    const hops = doorwaySim.graph.hops(a.idx, b.idx, ['std'], () => true);
    if (hops <= 1 || Math.hypot(b.x - a.x, b.y - a.y) >= doorwaySim.P.combat.sightM) continue;
    if (doorwaySim.losClear(a.x, a.y, a.idx, b.x, b.y, b.idx)) { sightPair = { a, b }; break; }
  }
  if (sightPair) break;
}
assert.ok(sightPair, 'marine fixture needs a dynamically discovered multi-room sightline');
const squadMarine = doorwaySim.agents.find((agent) => agent.faction === FACTION.MARINE && agent.squad >= 0);
assert.ok(squadMarine, 'marine LOS fixture needs a line marine');
squadMarine.dead = false;
squadMarine.hp = squadMarine.maxHp = 45;
squadMarine.node = squadMarine.pnode = sightPair.a.idx;
squadMarine.deck = sightPair.a.deck;
squadMarine.x = sightPair.a.x;
squadMarine.y = sightPair.a.y;
squadMarine.state = STATE.IDLE;
squadMarine.path = [];
squadMarine.move = null;
squadMarine.frags = 0;
squadMarine.flamer = false;
squadMarine._sawThreatT = 0;
const doorwayForm = makeAgent(FACTION.COMBAT, sightPair.b.idx, doorwaySim.graph);
doorwayForm.hp = doorwayForm.maxHp = 90;
doorwaySim.spawn(doorwayForm);
const doorwaySquad = doorwaySim.squads[squadMarine.squad];
doorwaySquad.broken = false;
doorwaySquad.objective = { node: sightPair.b.idx, kind: 'sweep' };
doorwaySim.P.combat.marine.gun.accNear = 1;
doorwaySim.P.combat.marine.gun.accFar = 1;
doorwaySim.P.combat.marksmanSpread = 0;
doorwaySim.P.combat.aimInitialAccuracy = 1;
doorwaySim.P.darkness.darkAccMult = 1;
doorwaySim.P.darkness.fogAccMult = 1;
doorwaySim.P.darkness.unlitAccMult = 1;
doorwaySim.P.darkness.flickerAccMult = 1;
doorwaySim._refreshOccupancy();
assert.ok(doorwaySim.lineOfSightAgents(squadMarine, (a) => a === doorwayForm).includes(doorwayForm),
  'the shared LOS query must see through multiple aligned openings');
updateHumansTick(doorwaySim, doorwaySim.dt);
assert.equal(squadMarine.state, STATE.FIGHT, 'a visible cross-room form must start the firefight');
const formHp = doorwayForm.hp;
resolveCombat(doorwaySim, doorwaySim.dt);
assert.ok(doorwayForm.hp < formHp, 'the marine must fire through the same sightline it detected');
assert.ok(Math.abs(squadMarine.heading - Math.atan2(doorwayForm.y - squadMarine.y,
  doorwayForm.x - squadMarine.x)) < 1e-6, 'a firing marine must face the selected target');
const heldX = squadMarine.x, heldY = squadMarine.y;
doorwaySim.tickCount = 1; // tick zero matches the default held marker
for (let tick = 0; tick < 30; tick++) doorwaySim._advanceMovement(doorwaySim.dt);
assert.ok(Math.hypot(squadMarine.x - heldX, squadMarine.y - heldY) < 1e-6,
  'a marine must not drift to a new firing line while fighting');
doorwayForm.dead = true;
squadMarine.state = STATE.MOVE;
squadMarine.path = [];
for (let tick = 0; tick < 30; tick++) doorwaySim._advanceMovement(doorwaySim.dt);
assert.ok(Math.hypot(squadMarine.x - heldX, squadMarine.y - heldY) < 1e-6,
  'a marine must not slide back to a parking slot after the fight');

// A shut panel is an absolute combat LOS blocker even when unlocked. The same
// deterministic opening fraction drives the visible panel, acquisition, and
// rifle damage, so marines cannot fire into steel while waiting for it to move.
const closedDoorSim = new Sim('closed-door-los-check');
for (const agent of closedDoorSim.agents) agent.dead = true;
const closedDoor = closedDoorSim.graph.edges.find((edge) => edge.kind === 'std'
  && edge.door && edge.losOpen
  && closedDoorSim.graph.node(edge.a).deck === closedDoorSim.graph.node(edge.b).deck);
assert.ok(closedDoor, 'closed-door fixture needs a same-deck rendered door');
const closedA = closedDoorSim.graph.node(closedDoor.a);
const closedB = closedDoorSim.graph.node(closedDoor.b);
const nearDoor = (room) => {
  const dx = room.x - closedDoor.door.x, dy = room.y - closedDoor.door.y;
  const length = Math.hypot(dx, dy) || 1;
  return [closedDoor.door.x + dx / length * 0.7, closedDoor.door.y + dy / length * 0.7];
};
const closedMarine = makeAgent(FACTION.MARINE, closedDoor.a, closedDoorSim.graph);
const closedForm = makeAgent(FACTION.COMBAT, closedDoor.b, closedDoorSim.graph);
closedMarine.hp = closedMarine.maxHp = 1000; // keep the sightline fixture alive during point-blank combat
[closedMarine.x, closedMarine.y] = nearDoor(closedA);
[closedForm.x, closedForm.y] = nearDoor(closedB);
closedForm.hp = closedForm.maxHp = 90;
closedMarine._sawThreatT = closedDoorSim.t;
closedMarine._reactUntil = 0;
closedDoorSim.spawn(closedMarine);
closedDoorSim.spawn(closedForm);
closedDoor.locked = true;
closedDoorSim._doorMutated();
closedDoorSim._refreshOccupancy();
assert.equal(closedDoorSim.hasLineOfSight(closedMarine, closedForm), false,
  'a locked door must block a target centered in its visible panel seam');
const closedHp = closedForm.hp;
resolveCombat(closedDoorSim, closedDoorSim.dt);
assert.equal(closedMarine.fireTargetId, undefined,
  'a marine must not acquire a Flood form through a locked door');
assert.equal(closedForm.hp, closedHp, 'a marine must not damage a Flood form through a locked door');

closedDoor.locked = false;
closedDoorSim._doorMutated();
closedDoorSim._refreshOccupancy();
assert.equal(closedDoorSim.hasLineOfSight(closedMarine, closedForm), false,
  'unlocking a still-shut panel must not make it transparent');
for (let tick = 0; tick < 20; tick++) closedDoorSim._advanceDoors(closedDoorSim.dt);
closedDoorSim._refreshOccupancy();
assert.equal(closedDoorSim.hasLineOfSight(closedMarine, closedForm), true,
  'approaching bodies must restore geometric LOS once the panel is visibly clear');
closedDoorSim.P.combat.marine.gun.accNear = 1;
closedDoorSim.P.combat.marksmanSpread = 0;
closedDoorSim.P.combat.aimInitialAccuracy = 1;
closedDoorSim.P.darkness.darkAccMult = 1;
closedDoorSim.P.darkness.fogAccMult = 1;
resolveCombat(closedDoorSim, closedDoorSim.dt);
assert.ok(closedForm.hp < closedHp, 'the marine may fire once the door is open');

// An open doorway is still a narrow opening in a bulkhead. A form outside
// its projected span must neither be acquired nor hit through the wall.
let behindWall = null;
for (const xf of [-0.42, 0, 0.42]) for (const yf of [-0.42, 0, 0.42]) {
  const x = closedB.x + xf * closedB.w, y = closedB.y + yf * closedB.d;
  closedForm.x = x; closedForm.y = y;
  closedDoorSim._refreshOccupancy();
  if (closedDoorSim.agentDistance(closedMarine, closedForm) < closedDoorSim.P.combat.sightM
    && !closedDoorSim.hasLineOfSight(closedMarine, closedForm)) { behindWall = [x, y]; break; }
}
assert.ok(behindWall, 'the open-door fixture needs a position hidden by the bulkhead');
[closedForm.x, closedForm.y] = behindWall;
closedDoorSim._refreshOccupancy();
closedMarine.nextShotAt = 0;
const wallHp = closedForm.hp;
resolveCombat(closedDoorSim, closedDoorSim.dt);
assert.equal(closedMarine.fireTargetId, undefined, 'a marine must not acquire through a bulkhead');
assert.equal(closedForm.hp, wallHp, 'an open door must not allow shots through adjacent steel');

closedMarine.dead = true;
closedForm.dead = true;
for (let tick = 0; tick < 20; tick++) closedDoorSim._advanceDoors(closedDoorSim.dt);
assert.ok(closedDoor.open01 < closedDoorSim.P.door.sightOpenFraction,
  'an unattended door must close back across the combat sightline');

console.log('combat LOS tactics ✓');
