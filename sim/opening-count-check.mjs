import assert from 'node:assert/strict';
import { FACTION } from '../shared/agentBuffer.js';
import { PARAMS } from '../shared/params.js';
import { openingInfectionFormCount } from './init.js';
import { Sim } from './sim.js';

assert.equal(openingInfectionFormCount(PARAMS.flood, 3), 12);
assert.equal(openingInfectionFormCount(PARAMS.flood, 4), 10);
assert.equal(openingInfectionFormCount(PARAMS.flood, 5, 4), 19);
assert.equal(openingInfectionFormCount(PARAMS.flood, 3, 4), 21);

const countForms = (sim) => sim.agents.filter((agent) => agent.faction === FACTION.INFECTION).length;
const cases = [
  { seed: 'charon-1', deck: 5, solo: 10 },
  { seed: 'opening-count-5', deck: 3, solo: 12 },
];

for (const testCase of cases) {
  for (const players of [1, 2, 4]) {
    const sim = new Sim(testCase.seed, null, { playerCount: players });
    assert.equal(sim.graph.node(sim.graph.breachNode).deck, testCase.deck);
    const expected = testCase.solo + (players - 1) * 3;
    assert.equal(sim.P.flood.initialInfectionForms, expected);
    assert.equal(countForms(sim), expected);
  }
}

const explicit = new Sim(
  'charon-1',
  { flood: { initialInfectionForms: 7 } },
  { playerCount: 4 },
);
assert.equal(explicit.P.flood.initialInfectionForms, 7);
assert.equal(countForms(explicit), 7);

console.log('opening infection count check ok');

for (const [fraction, expected] of [[null, null], [0, 0], [0.75, 8], [1, 10]]) {
  const sim = new Sim('charon-1', { hive: { openingVentFraction: fraction } });
  const infection = sim.agents.filter((a) => a.faction === FACTION.INFECTION);
  const bodies = sim.agents.filter((a) => a.faction === FACTION.CORPSE);
  const larder = bodies.filter((a) => a.node === sim.graph.breachNode).length;
  const spread = sim.hive._openingSpread(infection, bodies);
  assert.equal(spread.size, expected ?? Math.max(0, infection.length - larder));
  assert.equal(infection.filter((a) => a.task?.spread).length, spread.size,
    'opening vent orders must exist before the first actuator tick');
  for (const target of spread.values()) assert.notEqual(target, sim.graph.breachNode);
  if (fraction === 1) {
    sim.tick();
    assert.equal(bodies.filter((a) => a.node === sim.graph.breachNode && a.claimed).length, 0,
      'vent-bound forms must leave crash-site corpses for local feeders');
  }
}

console.log('opening dispersion count check ok');

const portCapacitor = new Sim('holdout-02');
assert.equal(portCapacitor.graph.node(portCapacitor.graph.breachNode).id, 'capPort');
assert.equal(portCapacitor.openingVentFromStart, false,
  'the port capacitor keeps its opening forms near the crash-site bodies first');
assert.equal(portCapacitor.hive._spreadPlan, undefined);
assert.equal(new Sim('holdout-03').openingVentFromStart, true,
  'the starboard capacitor sends its spare forms into the vents immediately');
