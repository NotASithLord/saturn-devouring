# Design — the Rapier physics stack

This supersedes the open **"Engine question"** at the end of `ROADMAP-3D.md`.
It records the engine decision, the invariant that keeps the decision honest,
what the first slice actually shipped, and the follow-ups it sets up.

## Decision: keep Three.js, add Rapier (authoritative, deterministic physics)

The 3D layer stays **Three.js** (it already renders the game) and gains
**Rapier** (`@dimforge/rapier3d-compat`, vendored at `vendor/rapier.js`) as the
physics engine.

Babylon.js + Havok was considered and dropped. Once physics is going to be
*authoritative* — the thing that must agree across peers for lockstep and
replay — the engine has to be **deterministic**, and that is exactly what
Rapier documents and tests (bit-level cross-platform determinism in the wasm
build; a `takeSnapshot()` that hashes identically across machines). Choosing
Rapier for that reason removed Havok's one big advantage (its first-party
integration into Babylon), and:

- Saturn Devouring is **already on Three.js** — no renderer migration;
- Rapier pairs idiomatically with a custom/Three renderer (there is no
  first-party Rapier plugin for Babylon anyway);
- the `-compat` build is **single-threaded** (no `SharedArrayBuffer`), so it
  needs no COOP/COEP cross-origin-isolation headers — a hard requirement of
  peerd's opaque-origin dwapp sandbox — and it **inlines the wasm as base64**,
  so it is one self-contained ES module that runs in the browser, in a dwapp,
  and in Node for the headless harness, all off the same bytes.

## The invariant: physics may be continuous, but authority must be deterministic

The line is **not** "discrete sim vs. continuous physics." The sim already does
continuous, deterministic math (body separation, spatial combat, line of
sight). The real rule is:

> Anything that feeds authoritative state must be computed by the deterministic
> layer. That layer may be continuous — but if it is a physics *engine*, the
> engine itself must be deterministic and stepped at a fixed timestep.

So the authoritative, snapshot-hashable set is: **the JS sim** (graph, hive,
combat, command queue) **plus the Rapier world** (fixed `PHYS_DT`, same wasm
everywhere, no `Math.random`). Purely cosmetic effects (ragdoll flourish,
debris, camera shake) live *outside* that set and are never read back. Break
the invariant — let a non-deterministic result decide authoritative state — and
replay and P2P lockstep break with it.

The **cosmetic death ragdoll now exists** as exactly this kind of outside-the-set
flourish: `physics/ragdoll.js` is a pure render-side articulated solver (no
THREE/DOM, no `Math.random`, floor sampling injected) that `game/agents3d.js`
drives from the AgentBuffer when a body dies. It writes NOTHING back — the sim
stays byte-identical with it present or absent (`sim/determinism-check.js` is
unchanged and still green), so it is fingerprinted by neither `hashState` nor
`snapshotHash`. Its own gate is `physics/ragdoll-check.mjs` (`npm run ragdoll`).
It is deterministic given identical inputs (which is what makes that gate
possible), but being cosmetic it makes no cross-machine bit-equality claim. This
is deliberately NOT the authoritative death-knockback of follow-up 3 below — it
is the flourish this paragraph carves out.

## What owns what

| Layer | Owner | Authoritative? |
|---|---|---|
| Which room / door / when, hive economy, combat outcomes | JS sim (unchanged) | yes (lockstep via the command queue) |
| Player horizontal collision (walls, cover, other bodies) | Rapier character controller | yes (fixed-step, deterministic) |
| Player vertical (gravity, floor rest, stairwell ramp, ladders) | analytic in player.js + world.groundHeightAt | yes (deterministic arithmetic) |
| NPC locomotion | JS sim, graph-driven (unchanged) | yes |
| NPC bodies as obstacles the player bumps | Rapier kinematic capsules synced from the sim | yes |
| Rendering, camera | Three.js, interpolated | no |

## What the first slice shipped

Scope was chosen to kill the day-to-day pain (janky grid collision, walking
through marines) at the lowest regression risk, and to prove the determinism
claim headlessly.

- **vendor/rapier.js** — the vendored, unmodified compat build (see
  vendor/SOURCE.txt).
- **physics/physics-world.js** — the Rapier world. Static wall colliders, the
  player's kinematic capsule + KinematicCharacterController (swept horizontal
  collision + wall sliding), a pool of NPC obstacle capsules synced from the
  sim, and a snapshotHash() desync fingerprint. No THREE, no DOM — runs
  identically in the browser and in Node.
- **world.collisionBoxes()** — sources the colliders from the SAME meshes the
  player sees (wallMeshes + locked door panels), so physics can never drift
  from the render. Floors/ceilings are deliberately excluded in this slice:
  full-height wall boxes are all a horizontal sweep needs, and vertical stays
  analytic.
- **game/player.js** — rewritten onto the controller. Physics attaches
  asynchronously (attachPhysics) so a slow/failed wasm load never wedges the
  loading screen. The old grid isWalkable slide and manual sphere-separation
  are gone; vertical, climbing, and the grand-stair portal are unchanged;
  climbs/portals teleport the capsule; the camera interpolates.
- **game/main.js** — the player steps at a fixed PHYS_DT (1/60) in an
  accumulator (the prior variable-frame-dt update was itself a determinism
  hole), and the camera reads an interpolated pose.
- **physics/physics-check.mjs** — the verifiable gate (companion to
  sim/determinism-check.js): proves the physics replays bit-identically, does
  not tunnel through a wall, and never stands inside another body. Runs in CI
  and in an agent's edit->verify loop.

### Why this also advances multiplayer

REVIEW-PHYSICS-GAMEPLAY.md flagged that "the player's free movement stream
bypasses the command queue." With the player now a fixed-step deterministic
capsule, it is finally the kind of thing lockstep can carry. The remaining step
is to route player intent through the command queue so lockstep covers players
and NPCs uniformly (below).

## Follow-ups this sets up

Rough dependency order:

1. **Full-Rapier vertical.** Promote floors, ceilings, and the stair treads to
   colliders and retire analytic vertical — with per-room ceiling heights (the
   big holds, especially the hangar, get taller), so leaps have air.
2. **Flood leap arcs.** A combat form that recognises a tall room leaps across
   it in a ballistic arc computed by Rapier (deterministic dynamic body), then
   rejoins graph locomotion on landing — the authoritative-dynamic pattern.
3. **Authoritative dynamic bodies — explosion/death knockback.** Thrown corpses
   as deterministic Rapier bodies; resolve the resting node back into the sim.
   (The *cosmetic* half of this — the render-side death ragdoll flop — shipped
   in `physics/ragdoll.js`; what remains open here is the AUTHORITATIVE version
   that feeds a body's resting node back into sim state.)
4. **NPC locomotion into Rapier** (the "aggressive" option): continuous
   collision-driven crowding at doorways. Watch the headless-tuning cost.
5. **Dynamic door colliders** for locked-state changes mid-run.
6. **Player intent on the command queue** — the multiplayer step above.
7. **The dwapp actor loop** — expose game state (an AgentBuffer projection) and
   actions (command-queue enqueues) so a peerd actor plays the game through the
   SAME contract a human does. Humans and models as the same kind of
   participant is the platform thesis; the determinism work here makes it
   possible.
8. **Pure graph -> colliders extraction** so the headless harness exercises the
   real ship geometry and world.js consumes the same source.
