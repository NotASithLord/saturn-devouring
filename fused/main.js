// Step 9 (§11): point the VAT renderer at the LIVE sim agent buffer.
// The ship schematic (x = fore/aft, y = lateral-ish layout, deck = height)
// maps onto a world plane per deck; the crowd you see is the actual sim.

import { Sim, fmtTime } from '../sim/sim.js';
import { VatRenderer } from '../vat/renderer.js';
import { bufferToInstances } from '../vat/driver.js';

const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');
const errEl = document.getElementById('err');

let renderer;
try {
  renderer = await VatRenderer.create(canvas, { maxInstances: 512 });
} catch (e) {
  errEl.style.display = 'flex';
  errEl.textContent = String(e.message || e);
  throw e;
}

let sim = new Sim(document.getElementById('seed').value);
document.getElementById('restart').addEventListener('click', () => {
  sim = new Sim(document.getElementById('seed').value.trim() || 'saturn-1');
});
document.getElementById('seed').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('restart').click();
});

// schematic -> world: x spans ~[90,1190] -> [-55,55]; deck -> stacked height
const mapPos = (x, y, deck) => [
  (x - 640) / 10,
  (5 - deck) * 14,           // deck 5 at ground, deck 1 highest
  (y - 46 - (deck - 1) * 132 - 66) / 4,
];

let camAngle = 0.4;
let acc = 0;
let last = performance.now();
const frameTimes = [];

function frame(now) {
  const frameMs = now - last;
  last = now;
  frameTimes.push(frameMs);
  if (frameTimes.length > 60) frameTimes.shift();
  const dt = Math.min(0.1, frameMs / 1000);

  acc += dt;
  let guard = 0;
  while (acc >= sim.dt && guard++ < 60) { sim.tick(); acc -= sim.dt; }

  camAngle += dt * 0.07;
  const eye = [Math.sin(camAngle) * 78, 52, Math.cos(camAngle) * 78];
  const instances = bufferToInstances(sim.buffer, mapPos);
  const stats = renderer.render(instances, { eye, at: [0, 26, 0] }, { near: 30, mid: 65 });

  const s = sim.getStats();
  const avg = frameTimes.reduce((a, x) => a + x, 0) / frameTimes.length;
  hud.innerHTML = [
    ['sim time', fmtTime(s.t) + (s.outcome ? ` — ${s.outcome.toUpperCase()}` : '')],
    ['agents in buffer', sim.buffer.count],
    ['humans / flood', `${s.civ + s.armed + s.marine} / ${s.infection + s.combat + s.carrier}`],
    ['frame avg', avg.toFixed(2) + ' ms'],
    ['draw calls', stats.drawCalls],
    ['LOD n/m/f', stats.lodCounts.join('/')],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
