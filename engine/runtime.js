// FTL ENGINE · runtime — the reusable FPS shell around a three.js
// WebGPURenderer: renderer boot with WebGL2 fallback, device-lost
// recovery, a rung-based quality governor with a whole-frame pixel
// budget, and a fixed-step tick scheduler that runs simulation work
// OUTSIDE the rAF task (in the idle gap between vsyncs).
//
// Nothing in this file knows about any particular game: the governor's
// per-rung effects, the reload URL params, and the tick body are all
// injected by the host. See engine/README.md for the module map.

import * as THREE from './vendor/three.webgpu.module.js';

// Boot a WebGPU renderer, FALLING BACK to the WebGL2 backend when WebGPU
// is missing or fails to initialise. WebGPU is the product path, but a
// hard requirement stranded real players (user report: a browser can
// EXPOSE navigator.gpu yet fail or limp on an OS too old for its WebGPU
// stack — Firefox on older macOS). The same TSL materials compile to
// GLSL for free, so the fallback is the full game, just on the older
// API. `forceWebGL` (`?gl=1` in hosts) still pins the WebGL2 backend
// outright — the headless screenshot/validation harness rides it.
// MSAA off by design: FTL's post chain (see engine/post.js) does FXAA
// in the final grade. Tone mapping is OFF at the renderer — the scene
// renders LINEAR into a half-float target and the grade pass applies
// ACES + exposure.
// Throws only when BOTH backends fail to produce a renderer.
export async function createRenderer({ canvas, forceWebGL = false, pixelRatioCap = 1.25 }) {
  const boot = async (gl) => {
    const renderer = new THREE.WebGPURenderer({
      // alpha:false configures the WebGPU canvas 'opaque' (swarm finding:
      // the default 'premultiplied' makes Firefox composite the full-window
      // canvas WITH blending every frame — pure waste over a black page)
      canvas, antialias: false, alpha: false,
      powerPreference: 'high-performance', forceWebGL: gl,
    });
    await renderer.init();
    return renderer;
  };
  let renderer;
  if (forceWebGL || !navigator.gpu) {
    renderer = await boot(true);
  } else {
    try {
      renderer = await boot(false);
      if (!renderer.backend.isWebGPUBackend) throw new Error('webgpu init fell through');
    } catch (err) {
      console.warn('[ftl] WebGPU unavailable, falling back to WebGL2:', err?.message ?? err);
      renderer = await boot(true);
    }
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.info.autoReset = false; // hosts accumulate per-frame across post passes
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

// The device can be lost mid-run — WebGPU by spec at any time, WebGL2 by
// context loss. Rather than a frozen black canvas: reload in place, capped
// by a session counter so a hopeless driver doesn't reload-loop. A lost
// WEBGPU device downgrades the reload onto the WebGL2 backend (?gl=1) —
// an immature WebGPU stack that dies mid-run (user report: Firefox on an
// older macOS) reboots into the backend that works instead of back into
// the one that just failed. `params` are written onto the reload URL so
// the host can reboot into the same state (seed).
export function installDeviceLostReload(renderer, { label = 'ftl', storageKey = 'ftl-lost', params = {} } = {}) {
  let handled = false;
  renderer.onDeviceLost = (info) => {
    if (handled || info?.reason === 'destroyed') return;
    handled = true;
    console.error(`[${label}] render device lost:`, info?.message ?? info);
    const n = +(sessionStorage.getItem(storageKey) ?? 0);
    if (n >= 2) return; // twice is a pattern — stop reloading into it
    sessionStorage.setItem(storageKey, String(n + 1));
    const u = new URL(location.href);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    if (renderer.backend?.isWebGPUBackend) u.searchParams.set('gl', '1');
    location.replace(u);
  };
}

// QUALITY GOVERNOR — a degradation LADDER: each rung sheds one cost,
// ordered cheapest-look-loss first, and the governor walks it per machine.
// Frame-time EMA drives resolution WITHIN the rung (re-evaluated every ~3s
// so RT reallocation never hitches play), then the rung itself: down when
// pinned at the resolution floor and still slow, back up after a long
// provably-stable stretch. A whole-frame PIXEL BUDGET caps resolution on
// huge windows (integrated GPUs can't buy retina supersampling).
//
//   rungs:  [{ res: [floor, cap], ...anything the host reads }]
//   apply:  (rungDef, index) => void   — host-side effects of the rung
//   onResize: (w, h) => void           — host resizes its post chain
export class QualityGovernor {
  constructor({ renderer, rungs, pixelBudget = 3.0e6, hd = false, pinned = false, apply, onResize, label = 'ftl' }) {
    this.renderer = renderer;
    this.rungs = rungs;
    this.pixelBudget = pixelBudget;
    this.hd = hd;
    this.pinned = pinned;
    this.apply = apply;
    this.onResize = onResize;
    this.label = label;
    this.rung = 0;
    this.prewarming = false;
    this._ema = 16;
    this._evalAt = 0;
    this._slow = 0;
    this._fast = 0;
    this._resFast = 0;
    this._movedAt = 0;
    this._resMovedAt = 0;
    this._resolutionProbe = null;
    this._resolutionLimits = rungs.map(() => ({ ceiling: Infinity, retryAt: 0, backoffMS: 0 }));
    this._prewarmRun = null;
    this._resetFrameHistory(0);
  }

  applyRung(i, now = performance.now()) {
    const changed = this.rung !== i;
    this.rung = i;
    this.apply(this.rungs[i], i);
    if (!this.prewarming) {
      this.fitResolution(now);
      if (changed) this.resetFrameTiming(now);
    }
  }

  // Clamp immediately when a rung is selected. Pinned ?q=low/full modes never
  // enter frame()'s adaptive branch, so deferring this work left them at the
  // renderer's boot DPR even when it violated the selected rung.
  fitResolution(now = performance.now()) {
    const R = this.rungs[this.rung];
    const viewportW = this.renderer.domElement?.clientWidth || globalThis.innerWidth || 1;
    const viewportH = this.renderer.domElement?.clientHeight || globalThis.innerHeight || 1;
    const floor = R.res[0];
    const budgetCap = this.hd ? 9 : Math.max(1, Math.sqrt(this.pixelBudget / (viewportW * viewportH)));
    const cap = Math.max(floor, Math.min(globalThis.devicePixelRatio || 1,
      this.hd ? 2 : R.res[1], budgetCap));
    const current = this.renderer.getPixelRatio();
    const next = Math.max(floor, Math.min(cap, current));
    if (Math.abs(next - current) <= 0.01) return;
    this._resMovedAt = now;
    this.renderer.setPixelRatio(next);
    this.renderer.setSize(viewportW, viewportH, false);
    this.onResize?.(viewportW, viewportH);
  }

  // Compile the recompile-heavy rung variants up front (behind a loading /
  // intro screen), so a mid-fight ladder step is a uniform change instead
  // of a shader storm. `forceWarm(scene)` may flip hidden/count-0 objects
  // visible so their pipelines compile too — it must return a restore
  // function, which ALWAYS runs (a failed compile that left warm state
  // applied once read as a fully-dark scene).
  //
  // `compileRung(rungDef, index, signal)` — REQUIRED for hosts with a post chain
  // (perf pass 3): WebGPU pipelines are RENDER-TARGET-FORMAT specific, and
  // the default renderer.compileAsync(scene, camera) compiles against the
  // CANVAS. A host whose scene pass renders into an HDR PassNode target was
  // prewarming variants the real frame never uses — every material still
  // compiled synchronously on first sight, mid-game, which is the exact
  // shader storm prewarm exists to prevent. The host callback compiles
  // against its own targets (e.g. PassNode.compileAsync + one real post
  // render for the fullscreen chain and shadow-depth pipelines).
  async prewarm(scene, camera, { order, forceWarm, compileRung } = {}) {
    if (this.pinned) return;
    this.cancelPrewarm();
    this.prewarming = true;
    const start = this.rung;
    const seq = [...new Set(order ?? [2, 3, this.rungs.length - 1, start])]
      .filter((i) => i >= 0 && i < this.rungs.length);
    const run = {
      start,
      controller: new AbortController(),
      restore: null,
      cancelled: false,
      finished: false,
    };
    this._prewarmRun = run;
    // WATCHDOG (swarm finding, live incident): Firefox's wgpu can grind a
    // compileAsync for minutes (the backend yields one rAF per object at
    // whatever the frame rate is) or stall a pipeline promise outright — and
    // the vendored wrapper only ever RESOLVES, so the catch below can never
    // fire on a stall. Un-deadlined, `prewarming` latched true forever and
    // the descend ladder below was dead code: the game sat at rung 0 at 20
    // FPS. Each rung now races a generous deadline; on timeout the signal
    // stops compilation after its current material instead of letting
    // abandoned warm-up work spill into gameplay. `prewarming` ALWAYS clears.
    const DEADLINE_MS = 18000;
    try {
      run.restore = forceWarm ? forceWarm(scene) : null;
      try {
        for (const i of seq) {
          if (run.cancelled) break;
          this.applyRung(i);
          const compile = compileRung
            ? Promise.resolve(compileRung(this.rungs[i], i, run.controller.signal))
            : this.renderer.compileAsync(scene, camera, null, run.controller.signal);
          let timer;
          const timedOut = await Promise.race([
            compile.then(() => false),
            new Promise((r) => { timer = setTimeout(() => r(true), DEADLINE_MS); }),
          ]).finally(() => clearTimeout(timer));
          if (timedOut) {
            console.warn(`[${this.label}] prewarm rung ${i} compile exceeded ${DEADLINE_MS}ms — stopping warm-up before it can spill into gameplay`);
            run.cancelled = true;
            run.controller.abort();
            this._pinWarm();
            break;
          }
          // pin before the NEXT applyRung: rung N is evicted during rung N+1's
          // compile, so the pin has to land while it is still referenced
          this._pinWarm();
        }
      } finally {
        const restore = run.restore;
        run.restore = null;
        restore?.();
      }
    } catch { /* fall through to the finally — the ladder must never stay latched */ } finally {
      this._finishPrewarm(run);
    }
  }

  // Gameplay must never inherit unfinished loading work. Aborting stops the
  // renderer after its current material, restores force-warmed objects and
  // returns to the live rung immediately.
  cancelPrewarm() {
    const run = this._prewarmRun;
    if (!run || run.finished) return;
    run.cancelled = true;
    run.controller.abort();
    this._finishPrewarm(run);
  }

  _finishPrewarm(run) {
    if (run.finished) return;
    run.finished = true;
    try { run.restore?.(); } catch { /* restore the ladder even if host cleanup fails */ }
    run.restore = null;
    if (this._prewarmRun !== run) return;
    this.applyRung(run.start);
    this.prewarming = false;
    this._prewarmRun = null;
    this.fitResolution();
    this.resetFrameTiming(performance.now());
  }

  // Warm-up hitches are loading samples, not evidence that gameplay is slow.
  // Reset them before the governor can turn one compile into a target resize
  // and a second visible hitch.
  _resetFrameHistory(now) {
    this._ema = 16;
    this._interval = 16.7;
    this._evalAt = now;
    this._slow = 0;
    this._fast = 0;
    this._resFast = 0;
    this._frameSamples = 0;
    this._slowSamples = 0;
    this._hasFrameSample = false;
  }

  // The host calls this after visibility/wake transitions. A paused interval
  // is neither workload evidence nor a reason to forget a failed quality probe.
  resetFrameTiming(now = performance.now()) {
    if (!Number.isFinite(now)) return;
    this._resetFrameHistory(now);
    this._resolutionProbe = null;
  }

  _rememberSlowResolution(ratio, now, failedRetry = false) {
    const limit = this._resolutionLimits[this.rung];
    limit.ceiling = Math.min(limit.ceiling, ratio);
    limit.backoffMS = failedRetry ? Math.min(300000, Math.max(60000, limit.backoffMS * 2))
      : Math.max(60000, limit.backoffMS);
    limit.retryAt = now + limit.backoffMS;
  }

  // KEEP WHAT PREWARM BUILT (swarm finding, and the standing "invisible flood"
  // report). three REF-COUNTS compiled pipelines and node-builder state, and
  // applyRung() changes the scene's light set — which changes the render
  // object's cache key, drops the old refcount to zero and DESTROYS the
  // GPUShaderModule and its NodeBuilderState. There is no retained tier.
  //
  // So prewarm's whole point was being undone as it went: compiling rung 2 and
  // then applying rung 3 threw rung 2's work away, and only the final rung
  // survived the intro. Worse for a pooled InstancedMesh that is EMPTY at boot
  // — every flood set is — because its first real appearance mid-run then has
  // to rebuild from cold, synchronously, in the middle of a fight.
  //
  // Pinning usedTimes to Infinity makes the `usedTimes === 0` eviction test
  // unreachable, so nothing prewarm built is ever destroyed. Called ONLY from
  // prewarm, never on a live ladder step, so mid-game material churn still
  // evicts normally and this cannot grow without bound.
  _pinWarm() {
    try {
      const nbc = this.renderer._nodes?.nodeBuilderCache;
      if (nbc) for (const st of nbc.values()) st.usedTimes = Infinity;
      const caches = this.renderer._pipelines?.caches;
      if (caches) for (const p of caches.values()) {
        p.usedTimes = Infinity;
        if (p.vertexProgram) p.vertexProgram.usedTimes = Infinity;
        if (p.fragmentProgram) p.fragmentProgram.usedTimes = Infinity;
        if (p.computeProgram) p.computeProgram.usedTimes = Infinity;
      }
    } catch { /* vendored-three internals moved: degrade to the old behaviour */ }
  }

  // Call once per frame with the real frame delta; walks resolution and
  // rungs on its internal 3s cadence.
  frame(now, dtRealSec, viewportW, viewportH) {
    if (!Number.isFinite(now) || !Number.isFinite(dtRealSec) || dtRealSec <= 0) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (Number.isFinite(viewportW) && viewportW > 0 && Number.isFinite(viewportH) && viewportH > 0) {
      const context = this._resolutionContext;
      const changed = context && (Math.abs(viewportW * viewportH / (context.width * context.height) - 1) > 0.1
        || Math.abs(dpr - context.dpr) > 0.01);
      if (!context || changed) this._resolutionContext = { width: viewportW, height: viewportH, dpr };
      if (changed) {
        this._resolutionLimits = this.rungs.map(() => ({ ceiling: Infinity, retryAt: 0, backoffMS: 0 }));
        this.resetFrameTiming(now);
        this._resMovedAt = now;
        if (!this.prewarming) this.fitResolution(now);
      }
    }
    const dtMs = dtRealSec * 1000;
    // TIME-BASED, not frame-count. alpha 0.06 is a ~16-frame window: 267ms at
    // 60Hz but only 67ms at 240Hz, so each 3s decision on a high-refresh panel
    // summarised 2% of its own interval.
    if (!this._hasFrameSample) {
      this._ema = dtMs;
      this._interval = Math.min(16.7, Math.max(3.5, dtMs));
      this._hasFrameSample = true;
    } else this._ema += (dtMs - this._ema) * (1 - Math.exp(-Math.min(dtMs, 250) / 250));
    this._frameSamples++;
    if (dtMs > 20) this._slowSamples++;
    // VSYNC-LOCK detection (user q: "will it re-upgrade when able?"): a
    // 60Hz display never shows sub-16.7ms frames however fast the GPU is,
    // so the old "ema < 13" ascend gate made the ladder a RATCHET there —
    // down, never up. Track the display's own cadence as a rolling min
    // (with a slow upward leak so a one-off fast frame can't pin it), and
    // Stable delivery only permits a bounded experiment. It does NOT measure
    // unused GPU capacity: a vsync-limited frame hides its execution cost.
    this._interval = Math.min((this._interval ?? 16.7) + 0.01, Math.max(3.5, dtMs));
    if (now - this._evalAt <= 3000 || this._frameSamples < 3) return;
    this._evalAt = now;
    const slowFraction = this._slowSamples / this._frameSamples;
    const sustainedSlow = this._slowSamples >= 3 && slowFraction >= 0.35;
    this._frameSamples = 0;
    this._slowSamples = 0;
    // _interval is a leaky rolling MIN of observed deltas. On a 60Hz panel that
    // IS the refresh interval; on 120/240Hz it is merely the fastest frame we
    // happened to present, so it sits far below the mean forever and `locked`
    // is permanently false — which kills the ascend gate and re-creates the
    // exact ratchet the vsync detection was added to remove. Clamp the FAST
    // side to the cadence these thresholds are tuned to. A slow rAF stream
    // alone cannot identify GPU load versus CPU work or browser throttling;
    // these are delivered-frame quality experiments, not GPU measurements.
    const cadence = this._interval < 16.0 ? 16.7 : this._interval;
    const locked = this._ema <= cadence + 0.8;
    // ...but "at cadence" is NOT headroom when the cadence itself is slow.
    // A machine that cannot hold 60 gets vsync-halved to exactly 33.3 ms, so
    // _interval converges on 33.3, `locked` goes true, and the ladder reads a
    // GPU drowning at 30 fps as a healthy 30 Hz display — it then stops
    // descending and periodically climbs BACK up (playtest: a 2017 integrated
    // GPU pinned at 30). Treat a cadence at/above ~20 ms as evidence of a
    // problem rather than proof of comfort: never promote from that alone.
    // A genuine 30 Hz browser/display throttle also lands here; distinguishing
    // it from overload would require additional evidence, not a GPU-time guess.
    const slowCadence = cadence > 20;
    // A rolling minimum must not gradually redefine a 19-20 ms overload as
    // a slower display refresh and invite another promotion. The game's
    // recovery target remains approximately 60 FPS on higher-refresh screens.
    const stableDelivery = slowFraction <= 0.1 && this._ema <= 17.5
      && (this._ema < 13 || (locked && !slowCadence));
    // NOTHING moves while pinned or prewarming (swarm finding: the walk used
    // to run on prewarm's TRANSIENT rungs — it read rung 3's 0.60 floor
    // mid-compile-grind and stranded pixel ratio below rung 0's 0.85 floor
    // forever once prewarm restored the start rung)
    if (this.pinned || this.prewarming) return;
    const R = this.rungs[this.rung];
    const cur = this.renderer.getPixelRatio();
    const floor = R.res[0];
    // NEVER BELOW NATIVE. sqrt(3.0e6 / 4.10e6) = 0.856 on a 2560x1600 dpr=1
    // panel, so the budget pinned an RTX 4070 at 72% of native for the whole
    // run — and the ascend step's 0.006 proposal was rejected by the 0.01
    // epsilon below, so it could never climb back out either.
    const budgetCap = this.hd ? 9 : Math.max(1, Math.sqrt(this.pixelBudget / ((viewportW * viewportH) || 1)));
    const cap = Math.max(floor, Math.min(window.devicePixelRatio || 1, this.hd ? 2 : R.res[1], budgetCap));
    let next = cur;
    // Resizing reallocates the post chain, so quality recovery is a small,
    // measured experiment rather than a repeated +0.2/-0.2 toggle. Remember
    // slow sizes and bisect toward that boundary. Once the remaining change
    // is too small to justify a resize, hold it. An occasional bounded retry
    // allows real workload/hardware recovery without permanently ratcheting.
    const resReady = now - (this._resMovedAt ?? 0) > 9000;
    const wantAscend = stableDelivery && cur < cap;
    const probe = this._resolutionProbe;
    const limit = this._resolutionLimits[this.rung];
    let rejectedProbe = false;
    if (probe && sustainedSlow && this._ema > 20) {
      this._rememberSlowResolution(cur, now, probe.retry);
      next = Math.max(floor, Math.min(cap, probe.from));
      this._resolutionProbe = null;
      rejectedProbe = true;
    } else if (probe && now - probe.at >= 6000) {
      // Two observation windows survived without a persistent regression.
      if (probe.retry && cur >= limit.ceiling - 0.01) {
        limit.ceiling = Infinity;
        limit.retryAt = 0;
        limit.backoffMS = 0;
      }
      this._resolutionProbe = null;
    }
    // snap into range FIRST: boot can start above the cap (pixelRatioCap is a
    // fixed 1.25) and no other branch walks it down
    if (cur > cap + 0.01) next = cap;
    else if (!rejectedProbe && resReady && sustainedSlow && this._ema > 20 && cur > floor) {
      this._rememberSlowResolution(cur, now);
      next = Math.max(floor, cur - 0.2);
      this._resolutionProbe = null;
    } else if (!rejectedProbe && !this._resolutionProbe && resReady && wantAscend) {
      // ascends need TWO consecutive fast evaluations — a single quiet 3s
      // window between background-app bursts is not proof of headroom, and
      // a failed promotion costs two reallocation hitches (up, then down)
      if (++this._resFast >= 2) {
        const bounded = Math.min(cap, cur + 0.1, (cur + limit.ceiling) / 2);
        const retry = bounded - cur < 0.02 && now >= limit.retryAt && Number.isFinite(limit.ceiling);
        const proposal = retry ? Math.min(cap, Math.max(cur + 0.02, limit.ceiling + 0.02), cur + 0.1) : bounded;
        if (proposal - cur > 0.01 && proposal - cur >= Math.min(0.02, cap - cur) - 1e-9) {
          next = proposal;
          this._resolutionProbe = { from: cur, at: now, retry };
        }
      }
    } else if (cur < floor - 0.01) next = floor; // self-heal: never sit stranded below the active rung's floor
    if (!wantAscend) this._resFast = 0;
    if (Math.abs(next - cur) > 0.01) {
      this._resMovedAt = now;
      this._resFast = 0;
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(viewportW, viewportH, false);
      this.onResize?.(viewportW, viewportH);
      // Do not evaluate costs from the old resolution against the new one.
      this._resetFrameHistory(now);
      return;
    }
    // descend: pinned at the floor and still under ~42fps, twice running —
    // or CATASTROPHICALLY slow (~<25fps), where waiting out the resolution
    // walk first costs 12+ seconds of slideshow (swarm finding): drop a rung
    // immediately per evaluation until the machine breathes
    // 33 ms IS catastrophic on a 60 Hz panel — it is a halved present rate,
    // not a comfortable cadence — so the fast descent has to see it. The old
    // >40 ms gate sat just above the vsync-halved 33.3 ms, which is exactly
    // where a GPU-bound machine parks, so the fast path never fired for the
    // hardware that needed it most.
    const catastrophic = sustainedSlow && (this._ema > 40 || (slowCadence && this._ema > 30))
      && this.rung < this.rungs.length - 1;
    if (catastrophic || (sustainedSlow && this._ema > 24 && cur <= floor + 0.01 && this.rung < this.rungs.length - 1)) {
      if (catastrophic || ++this._slow >= 2) {
        const observedMS = this._ema;
        this.applyRung(this.rung + 1, now);
        this._slow = 0;
        this._movedAt = now;
        console.info(`[${this.label}] quality rung -> ${this.rung} (frame ${observedMS.toFixed(1)}ms${catastrophic ? ', fast descent' : ''})`);
      }
    } else this._slow = 0;
    // ascend: locked-vsync smooth at full rung resolution, 35s after the
    // last move, 4 consecutive fast evaluations (~12s of proof). Full
    // recovery rung 4 -> 0 lands in ~3 minutes (user: the old 90s + 24s per
    // rung — 7-8 minutes total — read as too punishing). A failed promotion
    // still descends immediately and re-sits the cooldown, so the worst
    // oscillation is one gentle probe every ~47s.
    if (stableDelivery && cur >= cap - 0.01 && this.rung > 0 && now - this._movedAt > 35000) {
      if (++this._fast >= 4) {
        this.applyRung(this.rung - 1, now);
        this._fast = 0;
        this._movedAt = now;
        console.info(`[${this.label}] quality rung -> ${this.rung} (stable-delivery probe)`);
      }
    } else this._fast = 0;
  }
}

// TickScheduler lives in engine/tick.js (three-free — hosts with their own
// renderers can import it without pulling the vendored three build); re-
// exported here so existing runtime.js importers keep working.
export { TickScheduler } from './tick.js';
