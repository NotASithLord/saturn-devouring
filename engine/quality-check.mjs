import assert from 'node:assert/strict';
import { QualityGovernor } from './runtime.js';

// Exercise the production controller with deterministic delivered-frame models.
// These are not browser/GPU benchmarks and do not infer GPU execution from rAF.
const originals = new Map(['window', 'devicePixelRatio'].map(key =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalInfo = console.info;
const install = (key, value) => Object.defineProperty(globalThis, key,
  { configurable: true, writable: true, value });
const rungs = [
  { res: [0.85, 1.25] }, { res: [0.7, 1.1] }, { res: [0.7, 1] },
  { res: [0.6, 1] }, { res: [0.55, 0.9] },
];
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

function fixture({ initial = 1.25, dpr = 2, pinned = false } = {}) {
  install('window', { devicePixelRatio: dpr }); install('devicePixelRatio', dpr);
  let now = 0, ratio = initial, width = 1280, height = 720;
  const changes = [], ladder = [];
  const renderer = {
    domElement: { clientWidth: width, clientHeight: height },
    getPixelRatio: () => ratio,
    setPixelRatio(value) { ratio = value; changes.push({ at: now, ratio: value, rung: governor.rung }); },
    setSize() {},
  };
  const governor = new QualityGovernor({ renderer, rungs, pinned,
    apply(_, rung) { ladder.push({ at: now, rung }); } });
  return {
    governor, renderer, changes, ladder,
    get now() { return now; }, get ratio() { return ratio; },
    step(deltaMS) { now += deltaMS; governor.frame(now, deltaMS / 1000, width, height); },
    run(durationMS, cost) {
      const end = now + durationMS;
      while (now < end) this.step(cost(this));
    },
    idle(durationMS) { now += durationMS; governor.resetFrameTiming(now); },
    viewport(w, h, nextDPR = globalThis.devicePixelRatio) {
      width = w; height = h;
      renderer.domElement.clientWidth = w; renderer.domElement.clientHeight = h;
      window.devicePixelRatio = nextDPR; globalThis.devicePixelRatio = nextDPR;
    },
  };
}
const model = (cost, hz = 60) => state => Math.max(1000 / hz, cost * state.ratio ** 2);
const withinRungs = state => state.changes.every(change =>
  change.ratio >= rungs[change.rung].res[0] - 1e-9 && change.ratio <= rungs[change.rung].res[1] + 1e-9);

try {
  console.info = () => {};
  check('The previous 17-resize/180-second limit cycle settles after three useful changes', () => {
    const state = fixture(); state.run(180000, model(20));
    assert.equal(state.governor.rung, 0); assert.equal(state.changes.length, 3);
    assert.ok(Math.abs(state.ratio - 0.95) < 1e-9);
    assert.ok(state.changes.at(-1).at < 40000);
    assert.ok(withinRungs(state));
    state.run(420000, model(20));
    assert.equal(state.changes.length, 3, 'No continuing reallocation on an unchanged workload');
  });
  check('A failed promotion rolls back, then bisects instead of retrying the same size', () => {
    const state = fixture(); state.run(180000, model(23));
    assert.deepEqual(state.changes.map(change => +change.ratio.toFixed(3)), [1.05, 0.85, 0.95, 0.85, 0.9]);
    assert.ok(state.changes.at(-1).at < 50000);
    assert.ok(Math.abs(state.governor._resolutionLimits[0].ceiling - 0.95) < 1e-9);
    state.run(420000, model(23)); assert.equal(state.changes.length, 5);
  });
  check('A discontinuous quality cliff uses a bounded retry budget with increasing backoff', () => {
    const state = fixture({ initial: 0.85 });
    const cliff = ({ ratio }) => ratio > 0.850001 ? 33 : 1000 / 60;
    state.run(180000, cliff);
    const limit = state.governor._resolutionLimits[0];
    assert.equal(state.ratio, 0.85); assert.equal(state.governor.rung, 0);
    assert.ok(state.changes.length <= 8); assert.ok(limit.backoffMS >= 120000);
    const count = state.changes.length; state.run(30000, cliff);
    assert.equal(state.changes.length, count, 'A failed retry cannot immediately become a new probe');
  });
  for (const hz of [60, 120]) {
    check(`${hz} Hz steady delivery at full quality does not cause gratuitous resizing`, () => {
      const state = fixture(); state.run(180000, model(5, hz));
      assert.equal(state.changes.length, 0); assert.equal(state.governor.rung, 0);
    });
    check(`${hz} Hz recovery starts correctly below the cap without prewarming`, () => {
      const state = fixture({ initial: 1 }); state.run(90000, model(5, hz));
      assert.equal(state.ratio, 1.25); assert.ok(Number.isFinite(state.governor._resFast));
      assert.ok(state.changes.length <= 3); assert.ok(withinRungs(state));
    });
  }
  check('Persistent severe overload descends to the lowest rung without breaking its floor', () => {
    const state = fixture(); state.run(90000, model(160));
    assert.equal(state.governor.rung, 4); assert.equal(state.ratio, 0.55);
    assert.ok(state.ladder.at(-1).at < 45000); assert.ok(withinRungs(state));
  });
  check('A genuine sustained workload improvement recovers both resolution and every rung', () => {
    const state = fixture(); state.run(45000, model(80));
    assert.equal(state.governor.rung, 4);
    state.run(600000, model(5));
    assert.equal(state.governor.rung, 0); assert.equal(state.ratio, 1.25);
    assert.ok(withinRungs(state));
    const count = state.changes.length; state.run(120000, model(5)); assert.equal(state.changes.length, count);
  });
  check('A failed-probe ceiling can be exceeded after a genuine sustained improvement', () => {
    const state = fixture(); state.run(90000, model(23));
    assert.ok(Number.isFinite(state.governor._resolutionLimits[0].ceiling));
    state.run(180000, model(5));
    assert.equal(state.ratio, 1.25); assert.equal(state.governor._resolutionLimits[0].ceiling, Infinity);
  });
  check('One late frame cannot establish sustained overload at an evaluation boundary', () => {
    const state = fixture(); state.run(30000, model(5));
    state.step(500); state.run(30000, model(5));
    assert.equal(state.changes.length, 0); assert.equal(state.governor.rung, 0);
  });
  check('A pause followed by the public wake reset does not lower a healthy scene', () => {
    const state = fixture(); state.run(30000, model(5)); state.idle(60000);
    state.run(30000, model(5));
    assert.equal(state.ratio, 1.25); assert.equal(state.changes.length, 0);
  });
  check('Wake reset clears transient votes but preserves learned failures and their retry deadlines', () => {
    const state = fixture(); state.run(90000, model(23));
    const limit = { ...state.governor._resolutionLimits[0] };
    state.idle(60000);
    assert.equal(state.governor._resFast, 0); assert.equal(state.governor._fast, 0);
    assert.equal(state.governor._resolutionProbe, null);
    assert.deepEqual(state.governor._resolutionLimits[0], limit);
    state.run(90000, model(23)); assert.ok(Math.abs(state.ratio - 0.9) < 1e-9);
  });
  check('Materially smaller viewports discard obsolete failure bounds and recover useful detail', () => {
    const state = fixture(); state.run(90000, model(23));
    assert.ok(Number.isFinite(state.governor._resolutionLimits[0].ceiling));
    state.viewport(640, 360); state.step(1000 / 60);
    assert.equal(state.governor._resolutionLimits[0].ceiling, Infinity);
    state.run(90000, model(23 / 4)); assert.equal(state.ratio, 1.25);
  });
  check('Changed device pixel ratio invalidates stale failure bounds and respects the new cap', () => {
    const state = fixture(); state.run(90000, model(23));
    state.viewport(1280, 720, 1); state.step(1000 / 60);
    assert.equal(state.governor._resolutionLimits[0].ceiling, Infinity);
    state.run(90000, model(5)); assert.equal(state.ratio, 1);
    state.viewport(1280, 720, 2); state.step(1000 / 60);
    state.run(90000, model(5)); assert.equal(state.ratio, 1.25);
  });
  for (const mode of ['pinned', 'prewarming']) {
    check(`${mode} quality cannot move during an overloaded frame stream`, () => {
      const state = fixture({ pinned: mode === 'pinned' });
      state.governor.prewarming = mode === 'prewarming';
      state.run(90000, model(160));
      assert.equal(state.governor.rung, 0); assert.equal(state.ratio, 1.25);
      assert.equal(state.changes.length, 0);
    });
  }
  check('External rung selection resets obsolete frame evidence and immediately honors the selected limits', () => {
    const state = fixture(); state.run(1000, model(5));
    state.governor.applyRung(4, state.now);
    assert.equal(state.ratio, 0.9); assert.equal(state.governor._hasFrameSample, false);
    assert.equal(state.governor._resFast, 0); assert.equal(state.governor._resolutionProbe, null);
    assert.equal(state.governor._resMovedAt, state.now, 'Rung clamping is a real resize and starts its cooldown');
  });
  check('Invalid frame samples cannot poison the controller or change quality', () => {
    const state = fixture();
    for (const delta of [0, -1, NaN, Infinity]) state.governor.frame(5000, delta, 1280, 720);
    assert.ok(Number.isFinite(state.governor._ema)); assert.equal(state.changes.length, 0);
    state.step(1000); assert.equal(state.governor._ema, 1000, 'Real slow delivery is not truncated to 50 ms');
  });
  console.log(`${passed}/${passed} quality-governor controller checks passed (no browser/GPU execution).`);
} finally {
  console.info = originalInfo;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
