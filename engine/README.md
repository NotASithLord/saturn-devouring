# FTL Engine

A reusable browser FPS engine, extracted from the *Saturn Devouring* project.
WebGPU-required (three.js node/TSL materials; a WebGL2 backend survives
only behind the `forceWebGL` dev flag — headless CI containers cannot run
WebGPU, so the screenshot/validation harness rides `?gl=1`),
built for moody interior shooters that must run well on integrated
laptop GPUs and package as a single self-contained file.

The engine is **game-agnostic**: nothing in this directory knows about
Saturn Devouring's ship, sim, or HUD. The game injects content and per-game policy
through constructor options and callbacks.

## Module map

| Module | What it is |
| --- | --- |
| `runtime.js` | The shell: `createRenderer` (WebGPU boot with automatic WebGL2 fallback when WebGPU is missing or fails to init — a browser can expose `navigator.gpu` yet not actually work on an older OS; `forceWebGL` pins WebGL2; linear-HDR + PCFSoft defaults), `installDeviceLostReload` (reload-in-place recovery with a session cap; a lost WebGPU device downgrades the reload onto WebGL2 via `?gl=1`), `QualityGovernor` (rung ladder + per-rung effects callback + whole-frame pixel budget + cancellable prewarm with force-warm/restore), `TickScheduler` (fixed-step sim ticks in coalesced MessageChannel macrotasks, off the rAF path — see `tick.js`). |
| `frame-timing.js` | Separates bounded gameplay steps from uncapped frame-cadence measurements. Visibility changes, page restoration, and isolated suspend gaps reset measurements without hiding sustained low FPS. |
| `post.js` | HDR post pipeline on the TSL node system: scene pass → bloom (patched `BloomNode`, mip-count parameterized) → grade (chromatic aberration, Narkowicz ACES, vignette, midtone grain, manual sRGB) → compact FXAA. One `PostFX` class; cancellable, graph-deduplicated `prewarm`, `setBloomScale`, `exposure`, `setSize`. |
| `lights.js` | `LightPool` — a fixed pool of point lights serving unlimited *virtual* light declarations per frame (brightest-and-nearest win). Constant light count = bounded fragment cost and zero shader recompiles. Zero per-frame garbage. |
| `fx.js` | Instanced-billboard particle FX (fire with TSL shader flames, sparks, blood decals with a ring buffer and canvas-baked smears). Camera-billboarded quads — the node renderer draws `THREE.Points` at 1px, so never use Points. |
| `fps-controller.js` | `FpsController` — pointer-lock look, exponential-accel walking, jump/gravity, Rapier capsule sweep for horizontal with analytic vertical (ground rest, step-down snap, ceiling clamp), fixed-step determinism, render-pose interpolation. Floors/ceilings/level stacking injected as callbacks; hosts subclass and override `poseY()` for climbs/vehicles. |
| `audio.js` | `PositionalSynth` — zero-asset WebAudio harness: context lifecycle on first gesture, master bus, bearing-panned distance-attenuated one-shots, a through-the-structure far layer (lowpass per level of separation), ambience bed, klaxon loop, throttle keys, and `_mk`/`_rand` bake helpers. Hosts subclass and implement `_bake()` with their sample bank. |
| `physics/physics-world.js` | Rapier wrapper: static box world + kinematic capsule character controller. Colliders are sourced from the same meshes the player sees, so physics can never drift from the render. |
| `physics/ragdoll.js` | Deterministic, allocation-light cosmetic ragdolls: capsule root with two floor/ceiling contact spheres, damped limb sag, hard velocity clamps (unconditionally stable), hash-based scatter — same inputs, same flop. |
| `vendor/` | Vendored runtime deps: `three.webgpu.module.js` + `three.core.js` + `three.tsl.module.js` (r185, patched: identity swizzles removed for Chromium 141), `BloomNode.js` (patched, `nMips` parameterized), `rapier.js`. |

## Integration contract

A host game supplies:

- a `<canvas>`, URL-param policy (`?gl=1`, `?hd=1`, quality pins), and a
  seed for device-loss reboot;
- a **rung table** (`res` window per rung plus whatever fields its `apply`
  callback reads — shadow map size, light count, bloom scale, particle
  counts…) and the `apply` callback that enacts them;
- a `forceWarm(scene)` callback listing late-appearing pipelines
  (hidden veils, count-0 instanced sets) so prewarm compiles them; it
  returns a restore function that the governor *always* runs;
- a `compileRung(rung, index, signal)` callback when using custom render
  targets; pass the signal through and call `cancelPrewarm()` as gameplay
  begins so loading work can never spill into a live session;
- a fixed-step `run()` body for `TickScheduler` (the deterministic sim);
- scene content, materials, HUD, input — all game-side.

Hard-won invariants the engine encodes (see comments at each site):

- **Never tick on the frame.** Sim steps go through `TickScheduler` so a
  30ms strategic tick delays at most one frame instead of every frame.
- **Never resize render targets on the fly more than ~every 3s** — the
  governor's cadence exists so RT reallocation can't hitch play.
- **Stable vsync is not a GPU-utilization measurement.** Resolution recovery
  uses small probes, remembers failed sizes per rung, and backs off retries.
  A viewport/DPR change invalidates those size limits; an ordinary wake does
  not. Quality pins and prewarming still suppress automatic adaptation.
- **Measure cadence separately from simulation time.** Feed the governor
  uncapped visible-frame intervals, not the gameplay step. Reset its timing
  history after a wake so an idle gap cannot force a downgrade. The HUD
  reports frame cadence, not GPU execution time.
- **Recompiles are prewarmed, then rung changes are uniform-only.** Warm-up
  is cancellable, and shared full/lite post graphs submit only once.
- **Fixed light pool.** Adding/removing real lights recompiles every
  program; declare virtual lights instead.
- **Partial instanced uploads.** Upload `count × 16` floats, not the
  buffer capacity (see the host's `commitInstanced` pattern).
- **No `THREE.Points`** on the node renderer (1px on both backends).

Run `npm run quality` for deterministic resolution, wake/HUD timing, and
GPU timestamp-readback regressions. Optional GPU timestamp tracking remains
disabled by default; when enabled, invalid batches preserve the last valid
result instead of publishing negative or implausible durations.

## Not yet extracted (next candidates)

Still living in `game/` but engine-shaped; pulling them out mostly means
parameterizing content tables:

- `agents3d.js`'s instanced character renderer + `characters.js` VAT-style
  part sets (needs a faction/skin table instead of hardcoded sets).
- `world.js`'s builders: procedural deck/wall materials, merge-static
  pass, volume culling bins, door system (a generic "interior kit").

Already extracted from that list: the player controller (now
`fps-controller.js`, with `game/player.js` subclassing for the sim agent,
armor model, ladder reservations and stair portals) and the audio harness
(now `audio.js`, with `game/audio.js` carrying only the sample bank).

## Packaging

`scripts/build-dwapp.mjs` flattens a host page (game code + this engine +
vendored deps) into one esbuild ESM bundle with data-URI assets —
compatible with peerd's sandboxed single-document app runtime. The engine
has no build step of its own; it is plain ES modules.
