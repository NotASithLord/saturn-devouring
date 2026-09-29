import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { FrameTiming } from './frame-timing.js';

let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

check('Raw visible cadence stays separate from the bounded gameplay step', () => {
  const timing = new FrameTiming({ now: 0, warmupMS: 0 });
  timing.sample(16);
  const frame = timing.sample(516);
  assert.equal(frame.simulationSeconds, 0.1);
  assert.equal(frame.measurementMS, 500);
  assert.equal(frame.qualitySeconds, 0.5);
});
check('Fresh warm-up excludes quality votes but permits honest visible HUD samples', () => {
  const timing = new FrameTiming({ now: 0 });
  assert.equal(timing.sample(16).measurementMS, null);
  assert.equal(timing.sample(32).measurementMS, 16);
  assert.equal(timing.sample(999).qualitySeconds, null);
  assert.notEqual(timing.sample(1016).qualitySeconds, null);
});
check('Hidden frames keep bounded simulation updates without contributing quality or HUD measurements', () => {
  const timing = new FrameTiming({ now: 0 });
  timing.reset(100, { visible: false });
  for (const now of [1100, 2100, 3100]) {
    const frame = timing.sample(now);
    assert.equal(frame.simulationSeconds, 0.1);
    assert.equal(frame.measurementMS, null); assert.equal(frame.qualitySeconds, null);
  }
});
check('An observed visibility transition resets even if its DOM event was missed', () => {
  const timing = new FrameTiming({ now: 0 });
  assert.equal(timing.sample(100, { visible: false }).reset, true);
  const wake = timing.sample(30_000, { visible: true });
  assert.equal(wake.reset, true); assert.equal(wake.measurementMS, null);
  assert.equal(wake.qualitySeconds, null); assert.equal(wake.simulationSeconds, 0);
  assert.equal(timing.sample(30_016).qualitySeconds, null);
});
check('A long suspend gap is ignored once, not reinterpreted as a huge GPU workload', () => {
  const timing = new FrameTiming({ now: 0 });
  timing.sample(16);
  const wake = timing.sample(60_016);
  assert.equal(wake.reset, true); assert.equal(wake.measurementMS, null);
  assert.equal(wake.simulationSeconds, 0.1);
  assert.equal(timing.sample(60_032).qualitySeconds, null);
  assert.notEqual(timing.sample(61_032).qualitySeconds, null);
});
check('Sustained genuine one-FPS rendering remains slow quality evidence', () => {
  const timing = new FrameTiming({ now: 0 });
  timing.sample(1000);
  for (let now = 2000; now <= 10_000; now += 1000) {
    const frame = timing.sample(now);
    assert.equal(frame.reset, false); assert.equal(frame.qualitySeconds, 1);
    assert.equal(frame.measurementMS, 1000); assert.equal(frame.simulationSeconds, 0.1);
  }
});
check('Even extremely slow repeated frames cannot indefinitely reset the wake detector', () => {
  const timing = new FrameTiming({ now: 0 });
  assert.equal(timing.sample(6000).reset, true);
  const slow = timing.sample(12_000);
  assert.equal(slow.reset, false); assert.equal(slow.qualitySeconds, 6);
  timing.sample(12_016); timing.sample(12_032);
  assert.equal(timing.sample(20_000).reset, true, 'Two prompt intervals rearm suspend detection.');
});
check('Invalid and backwards clocks cannot send negative or nonfinite time into gameplay', () => {
  const timing = new FrameTiming({ now: 100 });
  for (const now of [NaN, Infinity, -Infinity]) {
    const frame = timing.sample(now); assert.equal(frame.simulationSeconds, 0);
    assert.equal(frame.qualitySeconds, null); assert.equal(frame.measurementMS, null);
  }
  const frame = timing.sample(50);
  assert.equal(frame.reset, true); assert.equal(frame.simulationSeconds, 0);
  assert.equal(frame.qualitySeconds, null);
  const overflow = new FrameTiming({ now: -1e308 }).sample(1e308);
  assert.equal(overflow.simulationSeconds, 0); assert.equal(overflow.measurementMS, null);
});

// Execute the actual small host integration and HUD block extracted from the
// game entry point. This exercises wiring without importing the DOM/game/Three
// world or opening a browser, and deliberately keeps the simulation loop intact.
const source = await readFile(new URL('../game/main.js', import.meta.url), 'utf8');
const hooksStart = source.indexOf('const frameTiming = new FrameTiming(');
const hooksEnd = source.indexOf('\nfunction frame(now)', hooksStart);
const hudStart = source.indexOf('  if (timing.measurementMS !== null) {', hooksEnd);
const hudEnd = source.indexOf('  // WALL CLOCK, not frame parity:', hudStart);
const governorLine = source.match(/if \(timing\.qualitySeconds !== null\) governor\.frame\([^\n]+/);
assert.ok(hooksStart >= 0 && hooksEnd > hooksStart && hudStart > hooksEnd && hudEnd > hudStart && governorLine);
let clock = 0;
const documentEvents = new Map(), windowEvents = new Map(), resets = [], votes = [];
const meter = { textContent: '', innerHTML: '', className: '' };
const context = {
  FrameTiming, performance: { now: () => clock },
  document: { hidden: false, addEventListener: (name, callback) => documentEvents.set(name, callback) },
  window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
  governor: { resetFrameTiming: now => resets.push(now), frame: (...args) => votes.push(args) },
  _fpsEma: 0, _fpsWorst: 0, _fpsShownAt: 0, _hudCache: {}, _vpW: 1280, _vpH: 720, rung: 0,
  renderer: { getPixelRatio: () => 1, backend: { isWebGPUBackend: true } },
  el: id => { assert.equal(id, 'fpsMeter'); return meter; },
};
vm.createContext(context);
const integration = vm.runInContext(source.slice(hooksStart, hooksEnd) + `
  function observe(now) {
    const timing = sampleFrameTiming(now);
    ${governorLine[0]}
    ${source.slice(hudStart, hudEnd)}
    return timing;
  }
  ({ observe, frameTiming });`, context);
check('Actual game integration installs explicit visibility and pageshow resets', () => {
  assert.ok(documentEvents.has('visibilitychange')); assert.ok(windowEvents.has('pageshow'));
  assert.deepEqual(resets, [0]);
  assert.equal(meter.textContent, 'Measuring frame cadence…');
});
check('Actual HUD uses a 500ms visible stall rather than a 100ms simulation clamp', () => {
  integration.observe(16); integration.observe(516);
  assert.equal(context._fpsEma, 500);
  assert.match(meter.innerHTML, /2 FPS/); assert.match(meter.innerHTML, /500\.0ms · spike 500ms/);
  assert.equal(votes.length, 0, 'The fresh measurement window is not yet warm.');
});
check('Actual governor receives raw visible seconds after warm-up', () => {
  const frame = integration.observe(1016);
  assert.equal(frame.simulationSeconds, 0.1);
  assert.deepEqual(votes.at(-1), [1016, 0.5, 1280, 720]);
});
check('Hidden host callbacks do not advance quality votes or retain a stale FPS display', () => {
  clock = 1100; context.document.hidden = true; documentEvents.get('visibilitychange')();
  const count = votes.length;
  assert.equal(context._fpsEma, 0); assert.equal(context._fpsWorst, 0);
  assert.equal(meter.textContent, 'Measuring frame cadence…');
  assert.equal(integration.observe(2100).simulationSeconds, 0.1);
  integration.observe(3100); assert.equal(votes.length, count);
});
check('Resume and pageshow each reset stale governor evidence and wait for fresh measurements', () => {
  const count = votes.length;
  clock = 30_000; context.document.hidden = false; documentEvents.get('visibilitychange')();
  assert.equal(resets.at(-1), 30_000);
  assert.equal(integration.observe(30_016).measurementMS, null);
  integration.observe(30_032); assert.equal(votes.length, count);
  integration.observe(31_016); assert.equal(votes.length, count + 1);
  clock = 40_000; windowEvents.get('pageshow')();
  assert.equal(resets.at(-1), 40_000); assert.equal(context._fpsEma, 0);
  assert.equal(integration.observe(40_016).qualitySeconds, null);
});
check('Actual host wiring resets once for an inferred wake and still admits subsequent slow frames', () => {
  integration.observe(50_000); assert.equal(resets.at(-1), 50_000);
  const count = resets.length;
  integration.observe(56_000);
  assert.equal(resets.length, count); assert.equal(votes.at(-1)[1], 6);
});
check('Gameplay and multiplayer retain their existing bounded-step update path', () => {
  assert.match(source, /const dtReal = timing\.simulationSeconds;/);
  assert.match(source, /if \(isSimAuthority\(\)\) ticker\.add\(dtReal\)/);
  assert.match(source, /gameSync\?\.update\(dtReal, now\)/);
  assert.match(source, /physAcc \+= dtReal;/);
  assert.match(source, /frameMs: _fpsEma \? Number\(_fpsEma\.toFixed\(2\)\) : null/);
});
console.log(`${passed}/${passed} frame-timing checks passed; no browser or GPU execution performed.`);
