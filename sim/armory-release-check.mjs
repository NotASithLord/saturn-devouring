import assert from 'node:assert/strict';
import { FACTION } from '../shared/agentBuffer.js';
import { shipForceCounts } from '../shared/force-counts.js';
import { Sim } from './sim.js';

const releases = [];
for (let index = 0; index < 32; index++) {
  const sim = new Sim(`armory-release-${index}`);
  assert.ok(sim.armoryReleaseAt >= 6.5 * 60 && sim.armoryReleaseAt < 9.5 * 60,
    `seed ${index} must release between 6:30 and 9:30`);
  releases.push(sim.armoryReleaseAt);
}
assert.ok(Math.max(...releases) - Math.min(...releases) > 2 * 60,
  'seeded release times must vary across most of the three-minute window');

const seed = 'armory-release-force-independence';
const first = new Sim(seed);
const replay = new Sim(seed);
assert.equal(first.armoryReleaseAt, replay.armoryReleaseAt,
  'the same seed must reproduce the same release time');

// Deck 1 losses alone do not meet parity, so the seal still waits for its
// seeded deadline and opens exactly on it.
for (const agent of first.agents) {
  if (agent.faction === FACTION.MARINE && first.graph.node(agent.node).deck === 1) {
    agent.dead = true;
    agent.hp = 0;
  }
}
first.t = first.armoryReleaseAt - 0.001;
assert.ok(shipForceCounts(first.agents).floodAlive < shipForceCounts(first.agents).marinesAlive);
first._armoryWatch();
assert.equal(first.armoryLocked, true, 'Deck 1 losses must not release the reserve early');

first.t = first.armoryReleaseAt;
first._armoryWatch();
assert.equal(first.armoryLocked, false, 'the seed timer must release the reserve');
const armory = first.graph.byId.get('armory');
assert.ok(first.graph.edges
  .filter((edge) => edge.a === armory || edge.b === armory)
  .every((edge) => !edge.locked), 'the timed release must open every armory seal');

// The same active-body counts used by the HUD trigger the early release at
// equality, not only when the Flood already outnumber the marines.
const parity = new Sim('armory-release-parity');
const initial = shipForceCounts(parity.agents);
assert.ok(initial.floodAlive > 0 && initial.marinesAlive > initial.floodAlive + 1);
const marines = parity.agents.filter((a) => a.faction === FACTION.MARINE);
for (const marine of marines.slice(initial.floodAlive + 1)) {
  marine.dead = true; marine.hp = 0;
}
parity.t = 60;
assert.deepEqual(shipForceCounts(parity.agents), {
  floodAlive: initial.floodAlive, marinesAlive: initial.floodAlive + 1,
});
parity._armoryWatch();
assert.equal(parity.armoryLocked, true, 'one extra marine must keep the reserve sealed');
marines[initial.floodAlive].dead = true; marines[initial.floodAlive].hp = 0;
parity._armoryWatch();
assert.equal(parity.armoryLocked, false, '1:1 parity must release before the seeded deadline');
assert.ok(parity.graph.edges
  .filter((edge) => edge.a === parity.graph.byId.get('armory') || edge.b === parity.graph.byId.get('armory'))
  .every((edge) => !edge.locked), 'parity release must open the armory seal');
const releaseLogs = parity.events.filter((event) => event.msg?.includes('ARMORY SEAL RELEASED'));
assert.equal(releaseLogs.length, 1, 'parity release broadcasts once');
parity._armoryWatch();
assert.equal(parity.events.filter((event) => event.msg?.includes('ARMORY SEAL RELEASED')).length,
  releaseLogs.length, 'release must not repeat');

const tickParity = new Sim('armory-release-tick');
const tickFlood = shipForceCounts(tickParity.agents).floodAlive;
const tickMarines = tickParity.agents.filter((a) => a.faction === FACTION.MARINE);
for (const marine of tickMarines.slice(tickFlood)) { marine.dead = true; marine.hp = 0; }
assert.equal(shipForceCounts(tickParity.agents).marinesAlive, tickFlood);
tickParity.tick();
assert.equal(tickParity.armoryLocked, false,
  'the regular simulation tick must notice parity before the next strategic round');

assert.deepEqual(shipForceCounts([
  { faction: FACTION.INFECTION, hp: 10 },
  { faction: FACTION.COMBAT, hp: 10, downed: true },
  { faction: FACTION.CARRIER, hp: 10 },
  { faction: FACTION.MARINE, hp: 10, odst: true },
  { faction: FACTION.MARINE, hp: 10, isPlayer: true },
  { faction: FACTION.MARINE, hp: 10, fromPlayer: true },
]), { floodAlive: 2, marinesAlive: 1 },
'downed forms and players do not alter the ship-force threshold');

console.log(`armory release check passed (${Math.min(...releases).toFixed(1)}s–${Math.max(...releases).toFixed(1)}s)`);
