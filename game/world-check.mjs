import assert from 'node:assert/strict';
import { Sim } from '../sim/sim.js';
import { CLEAR_H, elevOf, floorBandOf } from '../shared/geometry.js';
import {
  World,
  ceilingFixtureLayout,
  exteriorObservationSpan,
  insideHullPoint,
  observationSideForRoom,
  observationWindowForRun,
  roomLightFixtureLayout,
} from './world.js';

for (let deck = 1; deck <= 5; deck++) {
  assert.equal(floorBandOf(elevOf(deck) + CLEAR_H / 2), deck,
    `deck ${deck} walls must remain in their physical render band`);
}
assert.equal(floorBandOf(elevOf(4) - 0.2), 5,
  'the expanded hangar airspace must remain on deck 5 below the deck-4 floor');
assert.equal(floorBandOf(elevOf(4) + 0.2), 4,
  'deck-4 geometry must become visible before a climber settles on deck 4');

const sim = new Sim('world-connector-check');
const { graph } = sim;
const connectors = graph.edges.filter((edge) => edge.doorA && edge.doorB && !edge.shared
  && graph.node(edge.a).deck === graph.node(edge.b).deck);
assert.ok(connectors.length, 'world fixture needs at least one non-flush room connector');

for (const edge of connectors) {
  const deck = graph.node(edge.a).deck;
  const x = (edge.doorA.x + edge.doorB.x) / 2;
  const y = (edge.doorA.y + edge.doorB.y) / 2;
  assert.equal(insideHullPoint(graph, deck, x, y), true,
    `${graph.node(edge.a).name} → ${graph.node(edge.b).name} connector must be inside the hull`);
}

const gym = graph.byId.get('gym');
const security = graph.byId.get('security');
const sideDoor = connectors.find((edge) => (edge.a === gym && edge.b === security)
  || (edge.a === security && edge.b === gym));
assert.ok(sideDoor, 'Gymnasium side-door fixture must remain a real connector');
const mx = (sideDoor.doorA.x + sideDoor.doorB.x) / 2;
const my = (sideDoor.doorA.y + sideDoor.doorB.y) / 2;
const dx = sideDoor.doorB.x - sideDoor.doorA.x;
const dy = sideDoor.doorB.y - sideDoor.doorA.y;
const length = Math.hypot(dx, dy);
assert.equal(insideHullPoint(graph, 3, mx - dy / length * 2, my + dx / length * 2), false,
  'containment must not widen a connector into the surrounding void');

const bridge = graph.node(graph.byId.get('bridge'));
assert.equal(observationSideForRoom(bridge), 'S', 'the bridge must face the outer command-deck hull');
assert.equal(exteriorObservationSpan(graph, bridge, 'S', bridge.x - 2, bridge.x + 2), true,
  'the bridge observation wall must be exposed to space');
const bridgeWindow = observationWindowForRun(graph, bridge,
  { key: 'S', horiz: true }, [[bridge.x - bridge.w / 2, bridge.x + bridge.w / 2]]);
assert.ok(bridgeWindow?.width >= 4, 'the bridge must receive a usable observation window');

const cic = graph.node(graph.byId.get('cic'));
assert.equal(exteriorObservationSpan(graph, cic, 'S', cic.x - 2, cic.x + 2), false,
  'an outboard compartment must block an interior room observation wall');
assert.equal(observationSideForRoom(graph.node(graph.byId.get('reactor'))), null,
  'hazard and power compartments must keep solid hull plating');

const archer = graph.node(graph.byId.get('archerPort'));
const archerFixtures = roomLightFixtureLayout(archer);
assert.equal(archerFixtures.length, 3, 'a forty-metre compartment needs three visible fixtures');
assert.deepEqual(archerFixtures.map((fixture) => fixture.dz), [0, 0, 0],
  'wide-room fixtures must follow the room axis');
assert.ok(archerFixtures[0].dx < 0 && archerFixtures[2].dx > 0,
  'large-room fixtures must cover both ends around a center strip');

const smallRoom = graph.nodes.find((room) => Math.max(room.w, room.d) <= 14);
assert.equal(roomLightFixtureLayout(smallRoom).length, 1,
  'small rooms must retain one centered fixture');

const mainCorridor = graph.node(graph.byId.get('corrM'));
const deckBand = graph.deckBands[mainCorridor.deck - 1];
const mainZ = mainCorridor.y - (deckBand.y0 + deckBand.y1) / 2;
const mainCeilingHoles = graph.edges.flatMap((edge) => {
  if (!edge.trunkVertical || !edge.padA) return [];
  const a = graph.node(edge.a), b = graph.node(edge.b);
  if (a.idx !== mainCorridor.idx && b.idx !== mainCorridor.idx) return [];
  const lower = a.deck > b.deck ? a : b;
  if (lower.idx !== mainCorridor.idx) return [];
  const pad = lower.idx === a.idx ? edge.padA : edge.padB;
  return [{ x: pad.x, z: pad.y - (deckBand.y0 + deckBand.y1) / 2 }];
});
const safeStrips = ceilingFixtureLayout(mainCorridor, mainCeilingHoles, mainCorridor.x, mainZ);
assert.equal(safeStrips.length, 3, 'Main Corridor should keep all three ceiling strips');
for (const strip of safeStrips) for (const hole of mainCeilingHoles) {
  const sx = mainCorridor.x + strip.dx, sz = mainZ + strip.dz;
  assert.ok(Math.abs(sx - hole.x) >= strip.length / 2 + 0.9 + 0.12
    || Math.abs(sz - hole.z) >= 0.55 / 2 + 0.9 + 0.12,
  'no Main Corridor ceiling strip may cross a ladder or lift opening');
}

const collisionWorld = Object.create(World.prototype);
collisionWorld.worldToSim = (x, z) => [x, z];
collisionWorld.isWalkable = (_deck, x) => x >= 0;
collisionWorld.propBlocked = () => false;
collisionWorld.doors = [];
assert.equal(collisionWorld.ragdollBlocked(1, 0.25, 0, 0.3), true,
  'a ragdoll radius crossing a bulkhead must collide even when its centre is clear');
assert.equal(collisionWorld.ragdollBlocked(1, 0.6, 0, 0.3), false);

console.log('world connectors and observation windows ✓');
