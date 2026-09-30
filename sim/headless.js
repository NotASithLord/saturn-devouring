#!/usr/bin/env node
// Headless sim runner: watch infection rounds as text. Used to tune the AI
// and sanity-check the §1 emergent behaviors without a browser.
//   node sim/headless.js [seed] [minutes] [--quiet]

import { Sim, fmtTime } from './sim.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seed = args[0] ?? 'saturn-1';
const minutes = Number(args[1] ?? 20);
const quiet = process.argv.includes('--quiet');

const sim = new Sim(seed);
let lastEvent = 0;
let lastReport = -60;

const totalTicks = Math.round(minutes * 60 * sim.P.sim.tickHz);
for (let i = 0; i < totalTicks; i++) {
  sim.tick();
  if (!quiet) {
    while (lastEvent < sim.events.length) {
      const e = sim.events[lastEvent++];
      console.log(`[${fmtTime(e.t)}] ${e.type.padEnd(9)} ${e.msg}`);
    }
    // events buffer is trimmed when it grows; re-anchor if that happened
    if (lastEvent > sim.events.length) lastEvent = sim.events.length;
  }
  if (sim.t - lastReport >= 60) {
    lastReport = sim.t;
    const s = sim.getStats();
    console.log(
      `== ${fmtTime(sim.t)} | humans c${s.civ}/a${s.armed}/m${s.marine} | ` +
      `flood I:${s.infection} C:${s.combat}(+${s.combatDowned}dn) K:${s.carrier} | ` +
      `bodies ${s.corpses} (${s.corpsesBurned} burned) | scarcity ${s.scarcity.toFixed(2)} | ` +
      `${s.opening ? 'OPENING' : 'steady'} | controlled ${s.floodControlled} | conv ${s.conversions}`
    );
  }
  if (sim.outcome) {
    const s = sim.getStats();
    console.log(`\nOUTCOME: ${sim.outcome.toUpperCase()} at ${fmtTime(sim.t)}`);
    console.log(`humans left ${s.civ + s.armed + s.marine}, conversions ${s.conversions}, carriers seated ${s.carriersSeated}, forms minted ${s.formsMinted}, corpses burned ${s.corpsesBurned}`);
    break;
  }
}
if (!sim.outcome) {
  const s = sim.getStats();
  console.log(`\nran ${minutes} min, no terminal outcome (this is fine — the run continues)`);
  console.log(JSON.stringify(s, null, 1));
}
