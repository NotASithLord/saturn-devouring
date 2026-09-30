import assert from 'node:assert/strict';
import { FACTION } from '../shared/agentBuffer.js';
import { makeAgent, STATE } from './init.js';
import { TASK } from './hive.js';
import { updateFloodTick } from './floodExec.js';
import { Sim } from './sim.js';

const sim = new Sim('navigation-check');
const form = sim.agents.find((agent) => agent.faction === FACTION.INFECTION);
const corpse = sim.agents.find((agent) => agent.faction === FACTION.CORPSE && !agent.dead);
assert.ok(form && corpse, 'navigation fixture needs an infection form and corpse');

const destination = sim.graph.node(corpse.pnode ?? corpse.node);
form.task = { kind: TASK.CONVERT, corpseId: corpse.id };
assert.deepEqual(sim._moveArrivalPoint(form, destination), [corpse.x, corpse.y],
  'a committed infection form must leave a vent heading directly to its corpse');
corpse.x += 2;
corpse.y -= 1;
assert.deepEqual(sim._moveArrivalPoint(form, destination), [corpse.x, corpse.y],
  'the vent exit must track a corpse that is still settling');

corpse.claimed = true;
for (const agent of sim.agents) {
  if (agent.faction === FACTION.CORPSE) agent.claimed = true;
}
sim.hive.beliefs.clear();
assert.equal(sim.hive.nearestFoodNode(form), -1,
  'claimed corpses must not hold an idle form in a room with no usable body');

const nurserySim = new Sim('idle-nursery-check');
for (const agent of nurserySim.agents) agent.dead = true;
const nursery = nurserySim.graph.nodes.find((node) => node.roles.includes('cargo'));
assert.ok(nursery, 'idle nursery fixture needs a cargo room');
const pods = Array.from({ length: 8 }, () => makeAgent(FACTION.INFECTION, nursery.idx, nurserySim.graph));
const carrier = makeAgent(FACTION.CARRIER, nursery.idx, nurserySim.graph);
for (const pod of pods) nurserySim.spawn(pod);
nurserySim.spawn(carrier);
nurserySim.hive.opening = false;
nurserySim.hive.allIn = false;
nurserySim.hive.searchingAll = false;
nurserySim.hive.beliefs.clear();
nurserySim._refreshOccupancy();
nurserySim._computeInfluence();
nurserySim.hive.steadyState(pods, [], [carrier], [], pods.length, 0, 1,
  nurserySim.hive.scarcity(pods.length + 2));
assert.ok(pods.every((pod) => pod.task?.kind === TASK.SCOUT && pod.task.sweep),
  'spare infection forms must leave an empty nursery on safe coverage tasks');
assert.ok(new Set(pods.map((pod) => pod.task.node)).size > 1,
  'nursery coverage must spread pods across the topology instead of moving the pile together');

const openingSim = new Sim('opening-newborn-check');
for (const agent of openingSim.agents) agent.dead = true;
const firstPod = makeAgent(FACTION.INFECTION, openingSim.graph.breachNode, openingSim.graph);
openingSim.spawn(firstPod);
openingSim.hive._openingSpread([firstPod], []);
const newborn = makeAgent(FACTION.INFECTION, nursery.idx, openingSim.graph);
openingSim.spawn(newborn);
openingSim.hive.beliefs.clear();
openingSim._refreshOccupancy();
openingSim._computeInfluence();
openingSim.hive.openingMove([firstPod, newborn], [], []);
assert.equal(newborn.task?.kind, TASK.SCOUT,
  'a pod born after the frozen opening plan must receive a coverage task');
const planned = openingSim.hive._spreadPlan.get(firstPod.id);
assert.notEqual(planned, undefined, 'opening fixture must assign the initial pod a spread destination');
const plannedRoom = openingSim.graph.node(planned);
firstPod.node = firstPod.pnode = planned;
firstPod.deck = plannedRoom.deck;
firstPod.x = plannedRoom.x;
firstPod.y = plannedRoom.y;
firstPod.task = null;
firstPod.path = [];
firstPod.move = null;
openingSim._refreshOccupancy();
openingSim._computeInfluence();
openingSim.hive.openingMove([firstPod, newborn], [], []);
assert.equal(firstPod.task?.kind, TASK.SCOUT,
  'a pod that reaches its frozen opening destination must continue coverage');
assert.notEqual(firstPod.task.node, planned,
  'completed opening spread orders must not be reissued to the room underfoot');

const routeSim = new Sim('disconnected-route-check');
for (const agent of routeSim.agents) agent.dead = true;
const routeForm = makeAgent(FACTION.INFECTION, routeSim.graph.breachNode, routeSim.graph);
const foreignEdge = routeSim.graph.edges.find((edge) =>
  edge.a !== routeForm.node && edge.b !== routeForm.node);
assert.ok(foreignEdge, 'route fixture needs a connector unrelated to the current room');
routeSim.spawn(routeForm);
routeSim.tickCount = 1;
routeSim.t = routeSim.dt;
routeForm.path = [{ to: foreignEdge.b, link: foreignEdge, layer: foreignEdge.kind }];
routeSim._advanceMovement(routeSim.dt);
assert.equal(routeForm.move, null, 'a disconnected connector must never begin a movement leg');
assert.equal(routeForm.path.length, 0, 'a disconnected route must be discarded for clean re-planning');

// Enclosed vertical links used to expose a climber on the destination hatch
// halfway through the timer, then leave it standing there for the other half.
// Pin the topology-derived behavior so every ladder in a future ship layout
// gets the same enter → hidden climb → immediate walk-clear sequence.
const ladderSim = new Sim('ladder-exit-check');
for (const agent of ladderSim.agents) agent.dead = true;
const ladder = ladderSim.graph.edges.find((edge) => edge.kind === 'std' && edge.type === 'ladder'
  && ladderSim.graph.node(edge.a).deck !== ladderSim.graph.node(edge.b).deck && !edge.locked);
assert.ok(ladder, 'ladder exit fixture needs an open cross-deck ladder');
const ladderForm = makeAgent(FACTION.COMBAT, ladder.a, ladderSim.graph);
ladderSim.spawn(ladderForm);
ladderSim.tickCount = 1;
ladderSim.t = ladderSim.dt;
ladderForm.task = { kind: TASK.DART, node: ladder.b };
ladderSim.setPath(ladderForm, [{ to: ladder.b, link: ladder, layer: 'std' }]);
ladderSim._refreshOccupancy();
ladderSim._advanceMovement(ladderSim.dt);
assert.ok(ladderForm.move, 'the flood form must begin its ladder leg');
assert.equal(ladder.occupiedBy, ladderForm.id, 'the climber must reserve the ladder while on its rungs');
let emerged = false;
for (let tick = 0; tick < 1_000 && ladderForm.move; tick++) {
  ladderSim._advanceMovement(ladderSim.dt);
  if (ladderForm.node !== ladder.b || ladderForm.move.hidden) continue;
  emerged = true;
  const x = ladderForm.x, y = ladderForm.y;
  ladderSim._advanceMovement(ladderSim.dt);
  assert.ok(Math.hypot(ladderForm.x - x, ladderForm.y - y) > 0.001,
    'a form must walk clear immediately after it appears at the far hatch');
  assert.equal(ladder.occupiedBy, undefined,
    'the ladder must be free as soon as the previous body clears the rungs');
  break;
}
assert.ok(emerged, 'the flood form must emerge from the destination ladder hatch');

// Cross-deck travellers approach a real pad that is usually nowhere near the
// abstract bearing between the two room centres. The rendered walk must face
// that visible displacement, including formation and collision correction.
const humanFacingSim = new Sim('human-cross-deck-facing-check');
for (const agent of humanFacingSim.agents) agent.dead = true;
humanFacingSim.fires = [];
const command = humanFacingSim.graph.byId.get('d1corr');
const commandLift = humanFacingSim.graph.edges.find((edge) => edge.kind === 'std'
  && edge.type === 'lift' && (edge.a === command || edge.b === command));
assert.ok(commandLift, 'human facing fixture needs the Command Corridor lift');
const liftTarget = commandLift.a === command ? commandLift.b : commandLift.a;
const walker = makeAgent(FACTION.MARINE, command, humanFacingSim.graph);
humanFacingSim.spawn(walker);
walker.state = STATE.MOVE;
humanFacingSim.setPath(walker, [{ to: liftTarget, link: commandLift, layer: 'std' }]);
humanFacingSim._refreshOccupancy();
humanFacingSim._advanceMovement(humanFacingSim.dt); // begin the leg
humanFacingSim._captureHumanWalkStart();
humanFacingSim._advanceMovement(humanFacingSim.dt); // visibly approach the pad
humanFacingSim._faceWalkingHumans();
const walkDx = walker.x - walker.walkStartX, walkDy = walker.y - walker.walkStartY;
assert.ok(Math.hypot(walkDx, walkDy) > 0.001, 'the lift approach must visibly move');
const walkBearing = Math.atan2(walkDy, walkDx);
const headingError = Math.abs(Math.atan2(Math.sin(walker.heading - walkBearing),
  Math.cos(walker.heading - walkBearing)));
assert.ok(headingError < 1e-6, 'a walking human must face its actual visible travel vector');

// A combat wave that has already committed to a shared surge must not stop
// for the full climb behind its lead form. Ordinary bodies still use the
// one-at-a-time reservation; this only lets the same hive response scramble
// onto the rungs as a continuous attack.
const surgeLadderSim = new Sim('ladder-surge-check');
for (const agent of surgeLadderSim.agents) agent.dead = true;
surgeLadderSim.tickCount = 1;
surgeLadderSim.t = surgeLadderSim.dt;
const surgeLadder = surgeLadderSim.graph.edges.find((edge) => edge.kind === 'std'
  && edge.type === 'ladder' && surgeLadderSim.graph.node(edge.a).deck
    !== surgeLadderSim.graph.node(edge.b).deck && !edge.locked);
assert.ok(surgeLadder, 'ladder surge fixture needs an open cross-deck ladder');
surgeLadder.occupiedBy = undefined;
surgeLadder.reservedBy = undefined;
const lead = makeAgent(FACTION.COMBAT, surgeLadder.a, surgeLadderSim.graph);
const wing = makeAgent(FACTION.COMBAT, surgeLadder.a, surgeLadderSim.graph);
surgeLadderSim.spawn(lead);
surgeLadderSim.spawn(wing);
for (const form of [lead, wing]) {
  form.task = { kind: TASK.ATTACK, node: surgeLadder.b, surge: true };
}
surgeLadderSim.setPath(lead, [{ to: surgeLadder.b, link: surgeLadder, layer: 'std' }]);
surgeLadderSim._refreshOccupancy();
surgeLadderSim._advanceMovement(surgeLadderSim.dt);
for (let tick = 0; tick < 1_000 && !lead.move?.hidden; tick++) {
  surgeLadderSim._advanceMovement(surgeLadderSim.dt);
}
assert.equal(lead.move?.hidden, true, 'the lead surge form must be on the ladder');
surgeLadderSim.setPath(wing, [{ to: surgeLadder.b, link: surgeLadder, layer: 'std' }]);
surgeLadderSim._advanceMovement(surgeLadderSim.dt);
assert.ok(wing.move, 'a packmate in the same surge must join the occupied ladder without an idle wait');
assert.equal(wing.charging, true, 'the joined ladder leg must preserve the shared charge');
const reservedWing = makeAgent(FACTION.COMBAT, surgeLadder.a, surgeLadderSim.graph);
const playerClimber = makeAgent(FACTION.MARINE, surgeLadder.a, surgeLadderSim.graph);
playerClimber.isPlayer = true;
surgeLadderSim.spawn(reservedWing);
surgeLadderSim.spawn(playerClimber);
surgeLadder.reservedBy = playerClimber.id;
reservedWing.task = { kind: TASK.ATTACK, node: surgeLadder.b, surge: true };
surgeLadderSim.setPath(reservedWing,
  [{ to: surgeLadder.b, link: surgeLadder, layer: 'std' }]);
surgeLadderSim._refreshOccupancy();
surgeLadderSim._advanceMovement(surgeLadderSim.dt);
assert.equal(reservedWing.move, null, 'a hive surge must still yield a player-reserved ladder slot');

const allInSim = new Sim('ladder-all-in-check');
for (const agent of allInSim.agents) agent.dead = true;
allInSim.tickCount = 1;
allInSim.t = allInSim.dt;
allInSim.hive.allIn = true;
const allInLadder = allInSim.graph.edges.find((edge) => edge.kind === 'std'
  && edge.type === 'ladder' && allInSim.graph.node(edge.a).deck
    !== allInSim.graph.node(edge.b).deck && !edge.locked);
assert.ok(allInLadder, 'all-in ladder fixture needs an open cross-deck ladder');
const allInLead = makeAgent(FACTION.COMBAT, allInLadder.a, allInSim.graph);
const allInWing = makeAgent(FACTION.COMBAT, allInLadder.a, allInSim.graph);
for (const form of [allInLead, allInWing]) {
  allInSim.spawn(form);
  form.task = { kind: TASK.ATTACK, node: allInLadder.b };
}
allInSim.setPath(allInLead, [{ to: allInLadder.b, link: allInLadder, layer: 'std' }]);
allInSim._refreshOccupancy();
allInSim._advanceMovement(allInSim.dt);
for (let tick = 0; tick < 1_000 && !allInLead.move?.hidden; tick++) {
  allInSim._advanceMovement(allInSim.dt);
}
assert.equal(allInLead.move?.hidden, true, 'the all-in lead form must be on the ladder');
allInSim.setPath(allInWing, [{ to: allInLadder.b, link: allInLadder, layer: 'std' }]);
allInSim._refreshOccupancy();
allInSim._advanceMovement(allInSim.dt);
assert.ok(allInWing.move,
  'an all-in attack must pour onto an occupied ladder even without a local surge flag');

const ventFireSim = new Sim('vent-fire-detour-check');
for (const agent of ventFireSim.agents) agent.dead = true;
ventFireSim.tickCount = 1;
ventFireSim.t = ventFireSim.dt;
const ventRoom = ventFireSim.graph.nodes.find((node) => node.grate
  && Math.hypot(node.grate.x - node.x, node.grate.y - node.y) > 6);
const ventTarget = ventFireSim.graph.nodes.find((node) => node.idx !== ventRoom?.idx);
assert.ok(ventRoom && ventTarget, 'vent fire fixture needs two rooms and a long grate approach');
const ventPod = makeAgent(FACTION.INFECTION, ventRoom.idx, ventFireSim.graph);
ventPod.x = ventRoom.x;
ventPod.y = ventRoom.y;
ventFireSim.spawn(ventPod);
ventFireSim.fires = [{
  deck: ventRoom.deck,
  node: ventRoom.idx,
  x: (ventPod.x + ventRoom.grate.x) / 2,
  y: (ventPod.y + ventRoom.grate.y) / 2,
  scale: 1,
}];
ventFireSim.setPath(ventPod, ventFireSim.graph.ventRoute(ventRoom.idx, ventTarget.idx));
ventFireSim._advanceMovement(ventFireSim.dt);
assert.ok(ventPod.move?.entryPoints?.length > 2,
  'a vent approach crossing fire must receive an in-room detour');
for (let tick = 0; tick < 1_000 && !ventPod.move?.hidden; tick++) {
  ventFireSim._advanceMovement(ventFireSim.dt);
  ventFireSim._fireDamage(ventFireSim.dt);
}
assert.equal(ventPod.dead, false, 'a pod must survive a viable route around fire to its grate');
assert.equal(ventPod.move?.hidden, true, 'the pod must reach the vent after taking the detour');

// A pod that surfaces into an empty room still knows about the marine one
// doorway away. It must dive back into the network, not walk into the rifle
// line simply because it has not crossed that threshold yet.
const ventContactSim = new Sim('vent-adjacent-contact-check');
for (const agent of ventContactSim.agents) agent.dead = true;
const contactEdge = ventContactSim.graph.edges.find((edge) => edge.kind === 'std' && !edge.locked);
assert.ok(contactEdge, 'vent contact fixture needs an open doorway');
const ventEscapePod = makeAgent(FACTION.INFECTION, contactEdge.a, ventContactSim.graph);
const nextRoomMarine = makeAgent(FACTION.MARINE, contactEdge.b, ventContactSim.graph);
ventContactSim.spawn(ventEscapePod);
ventContactSim.spawn(nextRoomMarine);
ventContactSim.hive.beliefs.clear();
ventContactSim.hive.believedHardness.fill(0);
ventContactSim.hive.believedHumanStr.fill(0);
ventContactSim.tickCount = 1;
ventContactSim.t = ventContactSim.dt;
ventEscapePod.task = { kind: TASK.SCOUT, node: contactEdge.b };
ventContactSim._refreshOccupancy();
ventContactSim._computeInfluence();
assert.equal(ventContactSim.hive.infectionSurfaceSafe(contactEdge.a), true,
  'an empty vent exit remains usable beside a marine in the next room');
assert.equal(ventContactSim.hive.infectionArmedContact(contactEdge.b), true,
  'an infection form must sense a live marine before crossing into its room');
const ventSafeRoom = ventContactSim.hive.ventBoltTarget(contactEdge.a);
assert.notEqual(ventSafeRoom, -1, 'the vent network must have a safe fallback room');
assert.equal(ventContactSim.hive.infectionArmedContact(ventSafeRoom), false,
  'the fallback vent exit must not surface into armed contact');
updateFloodTick(ventContactSim, ventContactSim.dt);
assert.equal(ventEscapePod.task, null,
  'a pod must abandon an empty-room scout when it senses the adjacent rifle line');
assert.equal(ventEscapePod.path[0]?.layer, 'vent',
  'a pod exposed beside a rifle line must return to the vent network');
assert.equal(ventEscapePod.path[0]?.to, ventSafeRoom,
  'the pod must surface in the selected safe room rather than entering the marine room');

const reserveSim = new Sim('dormant-vent-reserve-check', {
  flood: { dormantVentReserves: 2 },
});
for (const agent of reserveSim.agents) {
  if (agent.faction === FACTION.INFECTION || agent.faction === FACTION.COMBAT
    || agent.faction === FACTION.CARRIER) agent.dead = true;
}
reserveSim._checkOutcome();
let released = reserveSim.agents.find((agent) => !agent.dead
  && agent.faction === FACTION.INFECTION);
assert.ok(released, 'apparent extinction must wake the first dormant vent reserve');
assert.equal(reserveSim.outcome, null, 'a dormant reserve must keep the outbreak live');
released.dead = true;
reserveSim._checkOutcome();
released = reserveSim.agents.find((agent) => !agent.dead
  && agent.faction === FACTION.INFECTION);
assert.ok(released, 'the second extinction must wake the final dormant vent reserve');
assert.equal(reserveSim.dormantVentReserves, 0, 'exactly two dormant reserves may wake');
released.dead = true;
reserveSim._checkOutcome();
assert.equal(reserveSim.outcome, 'contained', 'a third extinction must remain a real containment');

const weakSim = new Sim('weak-hive-reserve-check');
const lastPod = weakSim.agents.find((agent) => agent.faction === FACTION.INFECTION);
for (const agent of weakSim.agents) {
  if (agent === lastPod) continue;
  if (agent.faction === FACTION.INFECTION || agent.faction === FACTION.COMBAT
    || agent.faction === FACTION.CARRIER) agent.dead = true;
}
weakSim.t = 100;
weakSim._checkOutcome();
weakSim.t += weakSim.P.flood.weakHiveReserveDelaySec - 1;
weakSim._checkOutcome();
assert.equal(weakSim.dormantVentReserves, 2,
  'a brief weak opening must not spend the hidden reserve');
weakSim.t += 1;
weakSim._checkOutcome();
assert.equal(weakSim.dormantVentReserves, 1,
  'sustained near-extinction must wake one finite reserve');
assert.equal(weakSim.outcome, null, 'the weak hive remains a live outbreak');
weakSim.t += 1;
weakSim._checkOutcome();
assert.equal(weakSim.dormantVentReserves, 1,
  'the weak-hive timer must prevent back-to-back reserve releases');
const growingForm = makeAgent(FACTION.COMBAT, lastPod.node, weakSim.graph);
weakSim.spawn(growingForm);
weakSim.t += weakSim.P.flood.weakHiveReserveDelaySec;
weakSim._checkOutcome();
assert.equal(weakSim.dormantVentReserves, 1,
  'a recovered production path must stop spending reserves');

console.log('infection navigation ✓');
