// physics/physics-world.js — the Rapier physics world for Saturn Devouring.
//
// This is the authoritative collision layer, and it sits on the RENDER side of
// the AgentBuffer boundary (docs/DESIGN-RAPIER-STACK.md). In this first slice
// it owns exactly one thing: the player's HORIZONTAL swept-capsule collision —
// sliding along walls and cover, being blocked by other bodies — replacing the
// hand-rolled grid `isWalkable` slide and the manual sphere separation in the
// old player controller. Vertical motion (gravity, resting on the floor,
// stairs, ladders) stays analytic in game/world.js + game/player.js for now;
// full-height wall boxes are all a horizontal sweep needs, so that split is
// clean and low-risk. Thrown dynamic bodies come in a later slice.
//
// Determinism by construction (the property the lockstep/replay model rests
// on): the same Rapier wasm runs everywhere, the world steps at a FIXED
// timestep, and nothing here draws Math.random. No THREE, no chrome.*, no DOM —
// so this module runs bit-identically in the browser AND in the Node
// determinism harness (physics/physics-check.mjs). why it matters: the moment
// physics can disagree between two machines, replay and P2P lockstep break.

import RAPIER from '../vendor/rapier.js';

// The fixed physics timestep. The game accumulates real frame time and steps
// the world in whole PHYS_DT increments, interpolating the camera between the
// last two steps (see game/main.js). 60 Hz reads smooth for input; the sim's
// own 15 Hz AI tick is a separate, coarser clock.
export const PHYS_DT = 1 / 60;

// quaternion for a rotation of `a` radians about the world Y axis.
function quatY(a) {
  const h = a * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

let _ready = null;
// Resolve Rapier's embedded wasm exactly once. Callers `await initRapier()`
// before constructing a PhysicsWorld. why the console dance: Rapier's own
// wasm-bindgen glue prints a one-time deprecation notice on init that we can't
// fix without editing the (unmodified) vendored file — so we swallow just that
// one line here and leave every other warning intact.
export function initRapier() {
  _ready ??= (async () => {
    const { warn, error } = console;
    const mute = (orig) => (...a) =>
      (typeof a[0] === 'string' && a[0].includes('deprecated parameters for the initialization'))
        ? undefined : orig(...a);
    console.warn = mute(warn);
    console.error = mute(error);
    try { await RAPIER.init(); } finally { console.warn = warn; console.error = error; }
  })();
  return _ready;
}

export class PhysicsWorld {
  // staticBoxes: the array from world.collisionBoxes()
  // gravity: only used by dynamic bodies (a later slice); the player's vertical
  //   is analytic, so this does not affect the character.
  constructor({ staticBoxes = [], gravity = -24, rapier = RAPIER } = {}) {
    this.R = rapier;
    this.world = new rapier.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = PHYS_DT;

    // one shared fixed body carries every static wall collider (cheaper than a
    // body per wall; the geometry never moves)
    this._staticBody = this.world.createRigidBody(rapier.RigidBodyDesc.fixed());

    // the character controller: a small collision offset, autostep for door
    // sills and low lips (but well under prop height, so cover still blocks),
    // and sliding on so you scrape along a wall instead of stopping dead.
    this.controller = this.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.3, 0.1, true);
    this.controller.setSlideEnabled(true);

    this.player = null;
    this._npc = new Map(); // agentId -> { body, col }

    if (staticBoxes.length) this.setStaticBoxes(staticBoxes);
  }

  setStaticBoxes(boxes) {
    for (const b of boxes) {
      this.world.createCollider(
        this.R.ColliderDesc
          .cuboid(Math.max(b.hx, 1e-3), Math.max(b.hy, 1e-3), Math.max(b.hz, 1e-3))
          .setTranslation(b.cx, b.cy, b.cz)
          .setRotation(quatY(b.ry || 0)),
        this._staticBody);
    }
  }

  // Create the player capsule. (x, feetY, z) is the feet position; the capsule
  // is centred half a body above that. radius/halfHeight give a ~1.8 m tall,
  // ~0.68 m wide body (eye height 1.62 sits just under the top).
  spawnPlayer(x, feetY, z, { radius = 0.34, halfHeight = 0.56 } = {}) {
    const cy = feetY + halfHeight + radius;
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, cy, z));
    const col = this.world.createCollider(
      this.R.ColliderDesc.capsule(halfHeight, radius), body);
    this.player = { body, col, radius, halfHeight };
    return this.player;
  }

  // world-space centre of the player capsule, {x, y, z}
  playerCenter() {
    const t = this.player.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  // Hard-place the player (spawn, ladder climb, stair portal — anything that is
  // NOT ordinary walking). Sets both the immediate and the next-step transform
  // so the following sweep starts from the true spot.
  teleportPlayer(x, feetY, z) {
    const p = this.player;
    const cy = feetY + p.halfHeight + p.radius;
    p.body.setNextKinematicTranslation({ x, y: cy, z });
    p.body.setTranslation({ x, y: cy, z }, true);
  }

  // Resolve one physics step of horizontal walking. (dx, dz) is the desired
  // horizontal displacement THIS step; feetY is the analytic feet height the
  // vertical layer computed. Returns the collision-corrected {dx, dz} actually
  // travelled (so the caller can bleed velocity into walls). The world is NOT
  // stepped here — call step() once per physics tick after all movers are set.
  movePlayer(dx, dz, feetY) {
    const p = this.player;
    // the controller sweeps from the collider's CURRENT position (as left by
    // the previous step). Only the horizontal desire is offered; walls are
    // full height, so the exact capsule Y does not change the horizontal
    // answer — we set Y from the analytic feet height and never let the
    // controller move it vertically.
    this.controller.computeColliderMovement(p.col, { x: dx, y: 0, z: dz });
    const mv = this.controller.computedMovement();
    const t = p.body.translation();
    const cy = feetY + p.halfHeight + p.radius;
    p.body.setNextKinematicTranslation({ x: t.x + mv.x, y: cy, z: t.z + mv.z });
    return { dx: mv.x, dz: mv.z };
  }

  // Update the set of body-obstacles the player can bump into. `bodies` is a
  // list of { id, x, y, z, radius, half } in world coords — the caller passes
  // only the agents that actually matter (same deck, alive). Bodies seen before
  // but absent now are parked far below the map rather than destroyed, so their
  // colliders can be reused next time they reappear.
  syncBodies(bodies, count = bodies.length) {
    // persistent Set + parked flag (swarm finding: a fresh Set per 60Hz step,
    // and every retired body re-parked at y=-1000 every step forever — once
    // parked, a kinematic body stays put with zero velocity until reused)
    const seen = (this._seen ??= new Set());
    seen.clear();
    for (let i = 0; i < count; i++) {
      const a = bodies[i];
      seen.add(a.id);
      let e = this._npc.get(a.id);
      if (!e) {
        const body = this.world.createRigidBody(
          this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(a.x, a.y, a.z));
        const col = this.world.createCollider(
          this.R.ColliderDesc.capsule(a.half ?? 0.5, a.radius ?? 0.4), body);
        e = { body, col, parked: false };
        this._npc.set(a.id, e);
      }
      const target = { x: a.x, y: a.y, z: a.z };
      if (e.parked) {
        // Reactivation is a change in collision membership, not a physical
        // journey from the parking coordinate. setNext alone makes Rapier
        // derive a one-frame velocity spanning the ship (and 1 km upward),
        // so a doorway body reappearing beside the player can carry that
        // impossible sweep into the character controller.
        e.body.setTranslation(target, true);
        e.body.setNextKinematicTranslation(target);
        e.parked = false;
      } else {
        e.body.setNextKinematicTranslation(target);
      }
    }
    for (const [id, e] of this._npc) {
      if (!seen.has(id) && !e.parked) {
        e.parked = true;
        // Parking is equally discontinuous. Hard-place both transforms so the
        // removed body has zero velocity and cannot sweep across other rooms
        // on its way out of the active collision set.
        const parked = { x: 0, y: -1000, z: 0 };
        e.body.setTranslation(parked, true);
        e.body.setNextKinematicTranslation(parked);
      }
    }
  }

  // Door colliders: fixed cuboids spanning each closed opening, parked far
  // below the map while the door is open/unlocked. Doors change lock state
  // rarely (a seal release, a jam), so a teleporting fixed body is the
  // cheapest correct shape — no per-step sync, no kinematic velocity.
  setDoorBoxes(boxes) {
    this._doors = boxes.map((b) => {
      const body = this.world.createRigidBody(
        this.R.RigidBodyDesc.fixed()
          .setTranslation(b.cx, b.closed ? b.cy : b.cy - 1000, b.cz)
          .setRotation(quatY(b.ry || 0)));
      this.world.createCollider(
        this.R.ColliderDesc.cuboid(Math.max(b.hx, 1e-3), Math.max(b.hy, 1e-3), Math.max(b.hz, 1e-3)),
        body);
      return { body, cy: b.cy, closed: !!b.closed };
    });
  }

  setDoorClosed(i, closed) {
    const d = this._doors?.[i];
    if (!d || d.closed === closed) return;
    d.closed = closed;
    const t = d.body.translation();
    d.body.setTranslation({ x: t.x, y: closed ? d.cy : d.cy - 1000, z: t.z }, true);
  }

  step() {
    this.world.step();
  }

  // A stable hash of the world snapshot — the desync fingerprint the lockstep
  // model compares across peers, and what the determinism harness checks.
  snapshotHash() {
    const bytes = this.world.takeSnapshot();
    // FNV-1a over the snapshot bytes
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}
