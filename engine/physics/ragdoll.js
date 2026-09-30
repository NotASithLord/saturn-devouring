// physics/ragdoll.js — the classic-Halo cosmetic ragdoll solver.
//
// When a body dies, Halo hands it to physics: it goes limp, is thrown off the
// killing blow, tumbles, and settles into a heap. Saturn Devouring's dead used to snap
// flat (downed combat forms rotated to -90° over 380 ms; human corpses simply
// appeared prone) — REVIEW-PHYSICS-GAMEPLAY.md names this exact gap ("no
// ragdolls; corpses are grey boxes; downed forms rotate flat with zero
// transition"), and PLAN-ANIM-POLISH.md's P1 asks for "hit-direction deaths —
// fall away from the killing shot." This is that, done as real articulated
// physics rather than a canned pose.
//
// WHERE THIS SITS RELATIVE TO THE INVARIANT (docs/DESIGN-RAPIER-STACK.md):
// this is the "ragdoll flourish" the design doc explicitly puts OUTSIDE the
// authoritative, snapshot-hashable set. It is pure render-side cosmetics — it
// reads the AgentBuffer, it NEVER writes sim state, is never fingerprinted
// (sim.hashState / PhysicsWorld.snapshotHash never see it), and is never read
// back into the sim. So it cannot affect replay or P2P lockstep, and the sim
// stays byte-identical with this module present or absent.
//
// It is nonetheless DETERMINISTIC given identical inputs (fixed sub-step, no
// Math.random anywhere — per-body variety comes from a hash of the agent id),
// which is what makes the headless gate (physics/ragdoll-check.mjs) able to
// pin it. In the live game the step dt is a real frame delta, so cross-machine
// bit-equality is neither required nor claimed — it does not need to be, being
// cosmetic. why the fixed sub-step regardless: a physics integrator fed a
// variable frame dt is a stability hole; whole 1/120 s sub-steps keep the flop
// stable and frame-rate independent.
//
// No THREE, no DOM, no chrome.* — plain arrays for vec3 [x,y,z] and quat
// [x,y,z,w]. IO (the floor height under a point) is INJECTED as a function, so
// the solver is a pure functional core the shell (game/agents3d.js) drives and
// the Node gate exercises identically. why: same testability lever as
// physics-world.js — values in, values out, runs anywhere.

// The five limbs that hang off the torso root, matched to the six-part JMS rig
// (game/characters.js): torso is the root body itself, these swing about their
// joint pivots. `axis` is the limb's rest direction in model space (unit
// vector from the pivot toward the limb's far end) — legs and arms hang down,
// the head rides up — used to sag each limb toward gravity. `pivot` and `len`
// are the joint position and pivot→tip reach of the standard 1.7 m rig (the
// converted JMS pivots), used by the limb-tip contact constraints below;
// override via params.limbGeom for a different rig.
export const RAGDOLL_LIMBS = [
  { part: 'head', axis: [0, 1, 0], pivot: [0.03, 1.36, 0], len: 0.30 },
  { part: 'armL', axis: [0, -1, 0], pivot: [0.03, 1.29, -0.03], len: 0.72 },
  { part: 'armR', axis: [0, -1, 0], pivot: [0.03, 1.29, 0.03], len: 0.72 },
  { part: 'legL', axis: [0, -1, 0], pivot: [0.03, 0.92, -0.09], len: 0.92 },
  { part: 'legR', axis: [0, -1, 0], pivot: [0.03, 0.92, 0.09], len: 0.92 },
];

// --- tiny vec3 / quat kit (arrays; no allocation-heavy library) ------------

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.sqrt(dot3(a, a));
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Hamilton product a*b (apply b, then a).
function qmul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qnorm(q) {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  // a zero-length quat can only arise from a numeric blow-up; fall back to
  // identity rather than propagate a NaN (defensive — the clamps below make it
  // unreachable, but a cosmetic layer must never poison the render matrix).
  if (!(l > 1e-12)) return [0, 0, 0, 1];
  const k = 1 / l;
  return [q[0] * k, q[1] * k, q[2] * k, q[3] * k];
}

// unit-axis + angle -> quat
function qAxisAngle(axis, angle) {
  const l = len3(axis);
  if (!(l > 1e-12) || angle === 0) return [0, 0, 0, 1];
  const h = angle * 0.5, s = Math.sin(h) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

// rotate v by q (fast t = 2·(q.xyz × v) form)
function qrot(q, v) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];

// integrate a quaternion by an angular-velocity vector over dt (world frame if
// q maps model->world and omega is world; local if both are local). Rotation
// applied on the LEFT so a world omega rotates about world axes.
function qintegrate(q, omega, dt) {
  const a = len3(omega) * dt;
  if (a < 1e-9) return q;
  return qnorm(qmul(qAxisAngle(omega, a), q));
}

// the minimal rotation vector (axis·angle) of q, angle wrapped to [-π, π].
function qrotvec(q) {
  const v = [q[0], q[1], q[2]];
  const s = len3(v);
  if (s < 1e-9) return [0, 0, 0];
  let angle = 2 * Math.atan2(s, q[3]);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  const k = angle / s;
  return [v[0] * k, v[1] * k, v[2] * k];
}

// deterministic per-body scatter in [-1, 1] — stands in for Math.random so the
// solver stays reproducible (and headlessly checkable). Cheap integer hash.
function hash11(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 15), 0x119de1f5);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

// --- the solver ------------------------------------------------------------

// Sensible defaults; every value is overridable from shared/params.js
// (sim.P.ragdoll) so the feel is tunable without touching this file.
const DEFAULTS = {
  maxActive: 48,
  gravity: 22,
  bodyLen: 1.7, bodyRadius: 0.3, comY: 0.9,
  restitution: 0.18, groundFriction: 6.0, groundAngFriction: 5.0,
  linDamp: 0.1, angDamp: 1.0,
  maxLinSpeed: 24, maxAngSpeed: 28,
  sleepLin: 0.16, sleepAng: 0.4, sleepSec: 0.5,
  inertia: 1.2,
  limbGrav: 9, limbBind: 2.5, limbDamp: 3.0, limbLimit: 1.4, limbKick: 7.0,
  // limb-tip contact (user: limbs folded through the torso and clipped into
  // the deck): tips are kept a limbRadius above the floor and outside a
  // keep-out cylinder around the torso capsule's axis.
  limbRadius: 0.08, limbKeepOut: 0.8, // keepOut × bodyRadius + limbRadius
  limbGeom: null, // { part: { pivot: [x,y,z], len } } rig override
  subDt: 1 / 120, maxSubSteps: 8, dtCap: 0.05,
};

export class RagdollSystem {
  constructor(params = {}) {
    this.p = { ...DEFAULTS, ...params };
    this._byId = new Map(); // agentId -> ragdoll
    this._acc = 0;          // shared fixed-step accumulator
    this._seq = 0;          // spawn order, for oldest-first eviction
  }

  get size() { return this._byId.size; }
  has(id) { return this._byId.has(id); }
  get(id) { return this._byId.get(id); }
  ids() { return this._byId.keys(); }
  remove(id) { this._byId.delete(id); }
  clear() { this._byId.clear(); }

  // Spawn a ragdoll for a just-dead body.
  //   pose:    { x, y, z, heading, deck }  world-space feet position + facing
  //   impulse: { dirX, dirZ, speed, up, spin, kick }  the launch off the blow
  //   groundYAt: (x, z) => floorY   injected floor sampler (deck-bound closure)
  //   ceilYAt:  (x, z) => ceilY    optional ceiling sampler — a blast-lofted
  //             body bounces off the overhead plating instead of poking into
  //             the deck above (user: bodies clipping through ceilings)
  // Returns the ragdoll, or null if disabled. Enforces the concurrent cap by
  // evicting the oldest ASLEEP body first (already settled — least missed),
  // falling back to the oldest overall; the evicted id then renders as a plain
  // static corpse via the caller's fallback path.
  spawn(id, pose, impulse, groundYAt, ceilYAt, collideXZ = null) {
    const p = this.p;
    if (p.maxActive <= 0) return null;
    if (!this._byId.has(id)) this._evictIfFull();

    // root orientation from the facing, so it starts exactly where the standing
    // pose stood — then physics tips it over (no pop-in). Limbs start at their
    // bind (identity) pose; _launch below seeds the velocities.
    const limbs = {};
    const limbState = {};
    for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
      const { part } = RAGDOLL_LIMBS[k];
      limbs[part] = [0, 0, 0, 1];
      limbState[part] = { q: limbs[part], omega: [0, 0, 0] };
    }

    const rag = {
      id,
      rootPos: [pose.x, pose.y, pose.z],
      rootQuat: qAxisAngle([0, 1, 0], pose.heading),
      vel: [0, 0, 0], omega: [0, 0, 0],
      limbs,               // part -> quat (the render reads this)
      limbState,           // part -> { q, omega }
      groundYAt,
      ceilYAt,
      collideXZ,
      asleep: false,
      sleepT: 0,
      seq: this._seq++,
      // where the sim placed the body at spawn — if the sim later MOVES it far
      // (a carrier dragging a corpse, a reanimation relocation, any teleport),
      // the caller drops the ragdoll and hands rendering back to the sim.
      originX: pose.x, originZ: pose.z, deck: pose.deck,
    };
    this._launch(rag, impulse, false);
    this._byId.set(id, rag);
    return rag;
  }

  // Add a fresh impulse to a ragdoll that already exists — a grenade re-flinging
  // a body that is already on the deck (settled or mid-flop). Wakes it and ADDS
  // to its current motion. Returns false if there is no such ragdoll.
  reimpulse(id, impulse) {
    const r = this._byId.get(id);
    if (!r) return false;
    this._launch(r, impulse, true);
    return true;
  }

  // Seed (additive=false) or add (additive=true) a launch onto a ragdoll: a root
  // linear throw + a tumble about an axis ⟂ to travel + a per-limb angular kick
  // so the limbs whip. All scatter is a hash of the id — no Math.random — so a
  // given (id, impulse) always produces the same flop.
  _launch(rag, impulse, additive) {
    const p = this.p;
    const id = rag.id;
    const dl = Math.hypot(impulse.dirX, impulse.dirZ) || 1;
    const dx = impulse.dirX / dl, dz = impulse.dirZ / dl;
    const spin = impulse.spin ?? p.limbKick;
    const tumbleAxis = [-dz, hash11(id ^ 0x51) * 0.5, dx]; // mostly horizontal, ⟂ to travel
    const ta = len3(tumbleAxis) || 1;
    const ov = [(tumbleAxis[0] / ta) * spin, (tumbleAxis[1] / ta) * spin, (tumbleAxis[2] / ta) * spin];
    // the random component of a launch. A death flop wants it (0.6/0.5 keeps
    // two bodies killed by the same burst from landing identically); a body
    // writhing in place must not have it, or repeated additive kicks random-
    // walk it across the room.
    const jl = impulse.jitter ?? 0.6, ju = impulse.jitterUp ?? 0.5;
    const vv = [
      dx * impulse.speed + hash11(id ^ 0x11) * jl,
      (impulse.up ?? 2.5) + hash11(id ^ 0x22) * ju,
      dz * impulse.speed + hash11(id ^ 0x33) * jl,
    ];
    for (let a = 0; a < 3; a++) {
      rag.vel[a] = (additive ? rag.vel[a] : 0) + vv[a];
      rag.omega[a] = (additive ? rag.omega[a] : 0) + ov[a];
    }
    const kick = impulse.kick ?? p.limbKick;
    for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
      const { part } = RAGDOLL_LIMBS[k];
      const salt = id * 7 + k * 131;
      const lo = [hash11(salt) * kick, hash11(salt ^ 0x5a) * kick, hash11(salt ^ 0xa5) * kick];
      const st = rag.limbState[part];
      for (let a = 0; a < 3; a++) st.omega[a] = (additive ? st.omega[a] : 0) + lo[a];
    }
    rag.asleep = false;
    rag.sleepT = 0;
    clampVec(rag.vel, p.maxLinSpeed);
    clampVec(rag.omega, p.maxAngSpeed);
  }

  // TRIM TO THE CAP. The quality ladder lowers maxActive (48 -> 16 by rung 4)
  // precisely to shed CPU on a weak machine, but eviction only ever ran when
  // a NEW body flopped — so a pool that was already full stayed full and the
  // rung's saving never materialised on the machine that asked for it.
  trimToCap() {
    while (this._byId.size > this.p.maxActive) {
      let victim = null;
      for (const r of this._byId.values()) {
        if (!victim) { victim = r; continue; }
        const better = (r.asleep && !victim.asleep)
          || (r.asleep === victim.asleep && r.seq < victim.seq);
        if (better) victim = r;
      }
      if (!victim) return;
      this._byId.delete(victim.id);
    }
  }

  _evictIfFull() {
    if (this._byId.size < this.p.maxActive) return;
    let victim = null;
    for (const r of this._byId.values()) {
      if (!victim) { victim = r; continue; }
      // prefer an already-asleep body; among equals, the oldest.
      const better = (r.asleep && !victim.asleep)
        || (r.asleep === victim.asleep && r.seq < victim.seq);
      if (better) victim = r;
    }
    if (victim) this._byId.delete(victim.id);
  }

  // WRITHE IN PLACE — a body convulsing where it lies (a corpse being taken,
  // a man burning, a seizure), as opposed to _launch's hurl. The distinction
  // that matters is that reimpulse is ADDITIVE: a repeated kick with any real
  // `up` compounds into flight, and a repeated kick with any linear jitter
  // random-walks across the room. So this profile spends its energy on the
  // ROOT SPIN (rolling) and the LIMBS (flailing) and almost none on the root's
  // translation — which is what "agony" actually looks like.
  //
  //   sys.writhe(id, 0..1)  — intensity ramps the roll and the limb whip
  //
  // Pair it with tether() to guarantee the body cannot wander at all.
  writhe(id, intensity = 1) {
    const k = Math.max(0, Math.min(1, intensity));
    const rag = this._byId.get(id);
    if (!rag) return false;
    // SHORT-DISTANCE SHUDDER (user: "slightly more short distance limb
    // thrashing and convulsing. We over corrected the other way too much").
    // The zero-translation profile read as rolling in molasses. Real travel is
    // back — but the launch jitter hashes on the ID, so a repeated additive
    // kick with jitter shoves the SAME way every beat and the body slides.
    // Instead each beat pushes along a direction that walks the golden angle,
    // so successive shoves point everywhere and net to ~zero: a body jerking
    // an arm's width side to side, with the tether as the hard fence.
    const beat = rag.wbeat = (rag.wbeat ?? 0) + 1;
    const ang = id * 2.399 + beat * 2.618;
    this.reimpulse(id, {
      dirX: Math.cos(ang), dirZ: Math.sin(ang),
      speed: 0.5 + 0.6 * k,  // a jerk, not a slide — decays before the next beat
      up: 0,                 // no lift: the deck keeps it
      jitter: 0, jitterUp: 0,
      spin: 1.3 + 1.8 * k,   // a roll, not a cartwheel
      kick: 12 + 12 * k,     // the limbs carry the agony
    });
    // A CONVULSION REPEATS, SO IT MUST NOT COMPOUND. reimpulse is additive by
    // design (that is what makes a grenade re-fling feel like one), but a body
    // kicked every quarter second would otherwise ratchet its roll into a
    // cartwheel and — via the floor depenetration lifting a spinning rig — climb
    // off the deck. Cap the roll and never allow upward velocity: gravity, not
    // the convulsion, decides the vertical. The linear speed is capped too, so
    // a beat landing on a still-moving body cannot stack into a launch.
    clampVec(rag.omega, 2.0 + 2.2 * k);
    clampVec(rag.vel, 1.4);
    if (rag.vel[1] > 0) rag.vel[1] = 0;
    return true;
  }

  // Hold a body near a point on the deck. Anything beyond `radius` is pulled
  // back and has its outward velocity killed, so a long convulsion cannot
  // migrate. Cheap: one distance test per sub-step per tethered body.
  // `y` (optional) is the DECK the body is writhing on: the root is also kept
  // from climbing more than `lift` above it. That ceiling is not cosmetic —
  // limbs whipping at 10+ rad/s punch through the floor every sub-step, and
  // the depenetration that pushes them out ratchets the root upward, so a long
  // convulsion slowly levitates (measured: median root height climbing to
  // 0.35 m over 4 s, half the frames airborne) even with zero upward velocity.
  tether(id, x, z, radius = 0.45, y = null, lift = 0.3) {
    const rag = this._byId.get(id);
    if (!rag) return false;
    rag.tether = { x, z, r: radius, y, lift };
    return true;
  }

  clearTether(id) {
    const rag = this._byId.get(id);
    if (rag) rag.tether = null;
  }

  // Advance every awake ragdoll by a real frame delta, in whole fixed sub-steps
  // (leftover carried in the accumulator). Capped sub-steps so a stalled frame
  // can't spiral. Asleep bodies are frozen — free to keep around as the resting
  // pose until the sim removes the corpse.
  step(dtReal) {
    if (this._byId.size > this.p.maxActive) this.trimToCap();
    const p = this.p;
    this._acc += Math.min(dtReal, p.dtCap);
    let n = 0;
    while (this._acc >= p.subDt && n < p.maxSubSteps) {
      for (const r of this._byId.values()) if (!r.asleep) this._sub(r, p.subDt);
      this._acc -= p.subDt;
      n++;
    }
    if (n >= p.maxSubSteps) this._acc = 0;
  }

  _sub(r, dt) {
    const p = this.p;

    // 1) gravity + semi-implicit integrate of the root
    const prevX = r.rootPos[0], prevZ = r.rootPos[2];
    r.vel[1] -= p.gravity * dt;
    r.rootPos[0] += r.vel[0] * dt;
    r.rootPos[1] += r.vel[1] * dt;
    r.rootPos[2] += r.vel[2] * dt;
    r.rootQuat = qintegrate(r.rootQuat, r.omega, dt);
    // TETHER: keep a writhing body where it fell (see tether()). Applied to the
    // root before collision so the projection below still has the last word.
    if (r.tether) {
      const tx = r.rootPos[0] - r.tether.x, tz = r.rootPos[2] - r.tether.z;
      const td = Math.hypot(tx, tz);
      if (td > r.tether.r) {
        const nx = tx / td, nz = tz / td;
        r.rootPos[0] = r.tether.x + nx * r.tether.r;
        r.rootPos[2] = r.tether.z + nz * r.tether.r;
        const out = r.vel[0] * nx + r.vel[2] * nz;   // kill only the outward part
        if (out > 0) { r.vel[0] -= out * nx; r.vel[2] -= out * nz; }
      }
    }
    // Bulkheads, props, and door panels are render-world collision. The
    // callback projects a swept root back to the last free point and supplies
    // a contact normal; reflecting only the inward component loses energy and
    // turns a high-momentum melee launch into the expected door/wall slam.
    if (r.collideXZ) {
      const hit = r.collideXZ(prevX, prevZ, r.rootPos[0], r.rootPos[2], p.bodyRadius);
      if (hit) {
        r.rootPos[0] = hit.x; r.rootPos[2] = hit.z;
        const nl = Math.hypot(hit.nx, hit.nz) || 1;
        const nx = hit.nx / nl, nz = hit.nz / nl;
        const vn = r.vel[0] * nx + r.vel[2] * nz;
        if (vn < 0) {
          const bounce = (1 + p.restitution) * vn;
          r.vel[0] -= nx * bounce;
          r.vel[2] -= nz * bounce;
          r.omega[0] += nz * Math.abs(vn) * 0.35;
          r.omega[2] -= nx * Math.abs(vn) * 0.35;
        }
      }
    }

    // 2) floor contact for the two capsule ends (feet-end + head-end). The
    // torso is a capsule from y=radius to y=bodyLen-radius in model space; two
    // contact spheres at its ends make it TUMBLE (a shoulder landing first flips
    // it) and settle flat (both ends resting is the only stable pose). Contacts
    // are resolved AFTER integration (post-stabilisation): impulse first, then
    // project the penetration straight out — simple and unconditionally stable.
    const rr = p.bodyRadius;
    // world centre of mass = rootPos + R·(0, comY, 0)
    const comOff = qrot(r.rootQuat, [0, p.comY, 0]);
    const com = [
      r.rootPos[0] + comOff[0],
      r.rootPos[1] + comOff[1],
      r.rootPos[2] + comOff[2],
    ];

    let grounded = false;
    let maxPen = 0;
    let maxCeilPen = 0;
    for (const localY of [rr, p.bodyLen - rr]) {
      const off = qrot(r.rootQuat, [0, localY, 0]);
      const P = [r.rootPos[0] + off[0], r.rootPos[1] + off[1], r.rootPos[2] + off[2]];
      // ceiling contact (mirror of the floor): a lofted end hitting the
      // overhead plating loses its upward velocity and is pushed back down —
      // no body ever pokes into the deck above.
      if (r.ceilYAt) {
        const ceilY = r.ceilYAt(P[0], P[2]);
        const cpen = P[1] + rr - ceilY;
        if (cpen > 0) {
          if (cpen > maxCeilPen) maxCeilPen = cpen;
          const rVecC = [P[0] - com[0], P[1] - com[1], P[2] - com[2]];
          const vnC = r.vel[1] + cross3(r.omega, rVecC)[1];
          if (vnC > 0) {
            const rxnC = cross3(rVecC, [0, -1, 0]);
            const denomC = 1 + dot3(rxnC, rxnC) / p.inertia;
            const jC = ((1 + p.restitution) * vnC) / denomC;
            r.vel[1] -= jC;
            const dOmegaC = cross3(rVecC, [0, -jC, 0]);
            r.omega[0] += dOmegaC[0] / p.inertia;
            r.omega[1] += dOmegaC[1] / p.inertia;
            r.omega[2] += dOmegaC[2] / p.inertia;
          }
        }
      }
      const floorY = r.groundYAt(P[0], P[2]);
      const pen = (floorY + rr) - P[1];
      if (pen <= 0) continue;
      grounded = true;
      if (pen > maxPen) maxPen = pen;

      // velocity of this contact point: vel + omega × (P - com)
      const rVec = [P[0] - com[0], P[1] - com[1], P[2] - com[2]];
      const wxr = cross3(r.omega, rVec);
      const vn = r.vel[1] + wxr[1]; // n = +Y
      if (vn < 0) {
        // scalar-inertia normal impulse: j = -(1+e)·vn / (1/m + |r×n|²/I)
        const rxn = cross3(rVec, [0, 1, 0]);
        const denom = 1 + dot3(rxn, rxn) / p.inertia;
        const j = (-(1 + p.restitution) * vn) / denom;
        r.vel[1] += j;                 // n·j, mass = 1
        const dOmega = cross3(rVec, [0, j, 0]);
        r.omega[0] += dOmega[0] / p.inertia;
        r.omega[1] += dOmega[1] / p.inertia;
        r.omega[2] += dOmega[2] / p.inertia;
      }
    }
    // project the deepest penetration out — pure position fix, injects no
    // energy, so it can never destabilise. (Floor wins over ceiling if a body
    // is somehow squeezed by both — it must never sink below the deck.)
    if (maxCeilPen > 0) r.rootPos[1] -= maxCeilPen;
    if (maxPen > 0) r.rootPos[1] += maxPen;

    // TETHER CEILING — after depenetration, because depenetration is what
    // lifts a writhing body: limbs whipping at ~10 rad/s punch the floor every
    // sub-step and the push-out ratchets the root upward (measured: a 4 s
    // convulsion levitating to a 0.35 m median with ZERO upward velocity).
    // Clamped here, the deck genuinely holds the body down.
    if (r.tether && r.tether.y !== null && r.tether.y !== undefined) {
      const ceil = r.tether.y + r.tether.lift;
      if (r.rootPos[1] > ceil) {
        r.rootPos[1] = ceil;
        if (r.vel[1] > 0) r.vel[1] = 0;
      }
    }

    // 3) friction as damping while grounded (never adds energy → always stable)
    if (grounded) {
      const fk = Math.exp(-p.groundFriction * dt);
      r.vel[0] *= fk; r.vel[2] *= fk;
      const ak = Math.exp(-p.groundAngFriction * dt);
      r.omega[0] *= ak; r.omega[1] *= ak; r.omega[2] *= ak;
    }

    // 4) global damping + hard clamps (the stability backstop: the state simply
    // cannot grow past these, so no impulse or contact can ever blow it up)
    const ld = Math.exp(-p.linDamp * dt), ad = Math.exp(-p.angDamp * dt);
    r.vel[0] *= ld; r.vel[1] *= ld; r.vel[2] *= ld;
    r.omega[0] *= ad; r.omega[1] *= ad; r.omega[2] *= ad;
    clampVec(r.vel, p.maxLinSpeed);
    clampVec(r.omega, p.maxAngSpeed);

    // 5) limbs — each a damped limb sagging toward gravity, clamped to its joint
    // limit so it can't fold through the body.
    const gLocal = qrot(qconj(r.rootQuat), [0, -1, 0]); // world-down in torso frame
    for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
      const { part, axis } = RAGDOLL_LIMBS[k];
      const st = r.limbState[part];
      // sag: rotate the limb's current direction toward gravity
      const cur = qrot(st.q, axis);
      const tq = cross3(cur, gLocal);
      st.omega[0] += tq[0] * p.limbGrav * dt;
      st.omega[1] += tq[1] * p.limbGrav * dt;
      st.omega[2] += tq[2] * p.limbGrav * dt;
      // bind spring: pull back toward the rest pose so joints have some stiffness
      const rv = qrotvec(st.q);
      st.omega[0] -= rv[0] * p.limbBind * dt;
      st.omega[1] -= rv[1] * p.limbBind * dt;
      st.omega[2] -= rv[2] * p.limbBind * dt;
      // damp + integrate
      const dk = Math.exp(-p.limbDamp * dt);
      st.omega[0] *= dk; st.omega[1] *= dk; st.omega[2] *= dk;
      clampVec(st.omega, p.maxAngSpeed);
      st.q = qintegrate(st.q, st.omega, dt);
      // clamp to the joint limit: if the swing exceeds it, pin to the limit and
      // kill the outward angular velocity (no energy injected).
      const sv = qrotvec(st.q);
      const sa = len3(sv);
      if (sa > p.limbLimit) {
        const s = p.limbLimit / sa;
        st.q = qAxisAngle(sv, p.limbLimit);
        st.omega[0] *= s * 0.5; st.omega[1] *= s * 0.5; st.omega[2] *= s * 0.5;
      }

      // LIMB-TIP CONTACT (user: limbs folded through the torso and clipped
      // into the deck — the flop had no self-collision). Two position-level
      // constraints on the limb TIP, both pure corrective rotations about the
      // pivot (no energy injected, unconditionally stable like the root's
      // post-stabilisation):
      const geom = (p.limbGeom && p.limbGeom[part]) || RAGDOLL_LIMBS[k];
      if (geom.pivot) {
        const reach = geom.len;
        // tip in TORSO-LOCAL space: pivot + swing·(axis·len)
        const dLocal = qrot(st.q, axis);
        let tipL = [
          geom.pivot[0] + dLocal[0] * reach,
          geom.pivot[1] + dLocal[1] * reach,
          geom.pivot[2] + dLocal[2] * reach,
        ];
        // (a) torso keep-out: the torso capsule runs up local Y — a tip that
        // swings inside its radius is a limb folded INTO the body; rotate it
        // straight back out to the keep-out cylinder.
        if (tipL[1] > rr * 0.5 && tipL[1] < p.bodyLen - rr * 0.5) {
          const keep = p.bodyRadius * p.limbKeepOut + p.limbRadius;
          const h = Math.hypot(tipL[0], tipL[2]);
          if (h < keep && h > 1e-6) {
            const out = [tipL[0] / h, 0, tipL[2] / h];
            const axc = cross3(dLocal, out);
            const al = len3(axc);
            if (al > 1e-6) {
              const th = Math.min(0.6, (keep - h) / reach);
              st.q = qnorm(qmul(qAxisAngle(axc, th), st.q));
              st.omega[0] *= 0.8; st.omega[1] *= 0.8; st.omega[2] *= 0.8;
              const d2 = qrot(st.q, axis);
              tipL = [
                geom.pivot[0] + d2[0] * reach,
                geom.pivot[1] + d2[1] * reach,
                geom.pivot[2] + d2[2] * reach,
              ];
            }
          }
        }
        // (b) floor: the tip never sinks below the deck under the body. The
        // corrective rotation is applied in the torso frame (world axis
        // conjugated in), so the render — which composes root × limb — sees
        // the tip exactly on the floor.
        const tipOff = qrot(r.rootQuat, tipL);
        const tipW = [r.rootPos[0] + tipOff[0], r.rootPos[1] + tipOff[1], r.rootPos[2] + tipOff[2]];
        const tipFloor = r.groundYAt(tipW[0], tipW[2]) + p.limbRadius;
        if (tipW[1] < tipFloor) {
          const pvOff = qrot(r.rootQuat, geom.pivot);
          const dW = [tipOff[0] - pvOff[0], tipOff[1] - pvOff[1], tipOff[2] - pvOff[2]];
          const axw = cross3(dW, [0, 1, 0]);
          const al = len3(axw);
          if (al > 1e-6) {
            const th = Math.min(0.6, (tipFloor - tipW[1]) / reach);
            // world-axis correction, conjugated into the torso frame
            const qw = qAxisAngle(axw, th);
            const ql = qmul(qmul(qconj(r.rootQuat), qw), r.rootQuat);
            st.q = qnorm(qmul(ql, st.q));
            st.omega[0] *= 0.7; st.omega[1] *= 0.7; st.omega[2] *= 0.7;
          }
        }
        // (c) bulkheads and door panels: the root capsule alone cannot keep
        // a metre-long leg out of a wall. Sweep the limb from its joint to
        // its tip and fold the tip back to the last clear point. The vertical
        // component grows to preserve its length, so the limb rotates rather
        // than shrinking or dragging the entire corpse away from the wall.
        if (r.collideXZ) {
          const pivotOff = qrot(r.rootQuat, geom.pivot);
          const pivotW = [r.rootPos[0] + pivotOff[0], r.rootPos[1] + pivotOff[1], r.rootPos[2] + pivotOff[2]];
          const dirW = qrot(r.rootQuat, qrot(st.q, axis));
          const hit = r.collideXZ(pivotW[0], pivotW[2],
            pivotW[0] + dirW[0] * reach, pivotW[2] + dirW[2] * reach, p.limbRadius);
          if (hit) {
            const hx = hit.x - pivotW[0], hz = hit.z - pivotW[2];
            const horizontal = Math.min(Math.hypot(hx, hz), reach * 0.999);
            const rise = Math.sqrt(Math.max(0, reach * reach - horizontal * horizontal));
            const downY = pivotW[1] - rise;
            const floorY = r.groundYAt(hit.x, hit.z) + p.limbRadius;
            const y = dirW[1] < 0 && downY >= floorY ? -rise : rise;
            const desired = [hx / reach, y / reach, hz / reach];
            const axisW = cross3(dirW, desired);
            const angle = Math.atan2(len3(axisW), Math.max(-1, Math.min(1, dot3(dirW, desired))));
            if (angle > 1e-6) {
              const qw = qAxisAngle(axisW, Math.min(angle, 0.6));
              const ql = qmul(qmul(qconj(r.rootQuat), qw), r.rootQuat);
              st.q = qnorm(qmul(ql, st.q));
              st.omega[0] *= 0.65; st.omega[1] *= 0.65; st.omega[2] *= 0.65;
            }
          }
        }
      }
      r.limbs[part] = st.q;
    }

    // 6) sleep: once grounded and barely moving for sleepSec, freeze the pose.
    // This is the resting corpse — cheap forever after, and no perpetual jitter.
    if (grounded && len3(r.vel) < p.sleepLin && len3(r.omega) < p.sleepAng) {
      r.sleepT += dt;
      if (r.sleepT >= p.sleepSec) r.asleep = true;
    } else {
      r.sleepT = 0;
    }
  }
}

function clampVec(v, max) {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l > max) {
    const k = max / l;
    v[0] *= k; v[1] *= k; v[2] *= k;
  }
}
