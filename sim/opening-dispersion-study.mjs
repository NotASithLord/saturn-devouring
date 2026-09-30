#!/usr/bin/env node
// Paired seven-minute, no-player seed study. The only policy difference is
// what share of opening infection forms enters the vents immediately.
import { Sim } from './sim.js';
import { FACTION } from '../shared/agentBuffer.js';

const holdout = process.argv.includes('--holdout');
const control = process.argv.includes('--control');
const legacyOnly = process.argv.includes('--legacy-only');
const siteAwareOnly = process.argv.includes('--site-aware-only');
const final = process.argv.includes('--final');
const usableOnly = process.argv.includes('--usable-only');
const seeds = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const studySeeds = seeds.length ? seeds : Array.from({ length: 12 }, (_, i) => `dispersion-${String(i + 1).padStart(2, '0')}`);
const broadPolicies = [
  ['body-matched', null],
  ['all-local', 0],
  ['quarter-vent', 0.25],
  ['half-vent', 0.5],
  ['three-quarter-vent', 0.75],
  ['all-vent', 1],
];
const policies = usableOnly ? [['usable-bodies', null]]
  : final ? [['old-timing', null], ['site-aware', null]]
  : legacyOnly ? [['old-timing', null]]
  : siteAwareOnly ? [['site-aware', null]] : holdout ? [
  ['body-matched', null],
  ['all-local', 0],
  ['deck-adaptive', 'deck-adaptive'],
] : control ? [
  ['old-timing', null],
  ['spawn-aware', null],
] : broadPolicies;

function snapshot(sim) {
  const s = sim.getStats();
  const active = sim.agents.filter((a) => !a.dead && !a.downed &&
    (a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER));
  return {
    second: Math.round(sim.t),
    kills: s.humansDead,
    conversions: s.conversions,
    humansConverted: s.humansConverted,
    flood: s.infection + s.combat + s.carrier,
    combat: s.combat,
    carriers: s.carrier,
    rooms: new Set(active.map((a) => a.node)).size,
    decks: new Set(active.map((a) => a.deck)).size,
    controlled: s.floodControlled,
    outcome: sim.outcome,
  };
}

const rows = [];
for (const seed of studySeeds) {
  for (const [policy, fraction] of policies) {
    const sim = new Sim(seed, { hive: {
      openingVentFraction: fraction,
      openingVentFromStart: policy === 'old-timing' ? false
        : policy === 'site-aware' || policy === 'usable-bodies' ? 'spawn-aware' : true,
      openingCountUsableBodies: policy === 'usable-bodies',
    } });
    const initial = sim.agents.filter((a) => a.faction === FACTION.INFECTION).length;
    const larder = sim.agents.filter((a) => a.faction === FACTION.CORPSE && a.node === sim.graph.breachNode).length;
    const samples = [];
    let firstFiveKills = null;
    for (let tick = 1; tick <= 420 * sim.P.sim.tickHz; tick++) {
      sim.tick();
      if (firstFiveKills === null && sim.stats.humansDead >= 5) firstFiveKills = sim.t;
      if (tick % (60 * sim.P.sim.tickHz) === 0 || sim.outcome) {
        samples.push(snapshot(sim));
      }
      if (sim.outcome) break;
    }
    const row = {
      seed, policy, fraction, breach: sim.graph.node(sim.graph.breachNode).id,
      deck: sim.graph.node(sim.graph.breachNode).deck, initial, larder,
      firstFiveKills: firstFiveKills === null ? null : Math.round(firstFiveKills),
      samples,
    };
    rows.push(row);
    console.error(`${seed.padEnd(14)} ${policy.padEnd(18)} D${row.deck} ${String(row.firstFiveKills ?? '-').padStart(3)}s 7m ${JSON.stringify(samples.at(-1))}`);
  }
}
console.log(JSON.stringify({ minutes: 7, policies: policies.map(([name, fraction]) => ({ name, fraction })), rows }, null, 2));
