// physics/ragdoll-check.mjs — the verifiable gate for the cosmetic ragdoll.
//
// Companion to physics/physics-check.mjs. That one proves the AUTHORITATIVE
// Rapier layer replays bit-identically; this one proves the RENDER-SIDE ragdoll
// solver (physics/ragdoll.js) is well-behaved: reproducible, bounded (no NaN /
// no launch to infinity), it never sinks through the floor, its joints stay
// inside their limits, it settles to rest, and the concurrent cap holds. The
// ragdoll is cosmetic (never fingerprinted, never read back into the sim — see
// the module header), so "determinism" here means only "identical inputs →
// identical output," which is what makes an automated gate possible at all.
//
//   node physics/ragdoll-check.mjs
//
// Exits non-zero on any failure. Runs in CI and in an agent's edit→verify loop.

import { RagdollSystem, RAGDOLL_LIMBS } from './ragdoll.js';
import { PARAMS } from '../../shared/params.js';

// Validate the ACTUAL shipped tuning (shared/params.js), not just the solver's
// built-in fallback defaults — so a param that destabilises the flop is caught.
const RP = PARAMS.ragdoll;

// the most violent death in the game — a point-blank grenade — is the worst
// case for a stability bug: max radial launch, big air, a violent tumble, and
// limbs whipping. Set at/above the shipped blast params so the gate covers them.
function violentImpulse() {
  return { dirX: 1, dirZ: 0.2, speed: 15, up: 6.5, spin: 18, kick: 15 };
}

// Drive one ragdoll on a flat floor (y = 0) for `steps` fixed sub-steps and
// report everything the assertions need: a pose fingerprint, whether anything
// went non-finite, the deepest floor penetration seen, the largest limb swing,
// and whether it fell asleep.
function drive({ id = 1, floorY = 0, steps = 1200, dt = 1 / 60 } = {}) {
  const sys = new RagdollSystem(RP);
  const groundYAt = () => floorY;
  sys.spawn(id, { x: 0, y: 1.0, z: 0, heading: 0.5, deck: 1 }, violentImpulse(), groundYAt);

  let finite = true;
  let worstPen = 0;        // how far below the floor a capsule end ever got
  let maxLimbSwing = 0;    // largest limb rotation magnitude (rad)
  const rr = sys.p.bodyRadius, bodyLen = sys.p.bodyLen;

  const checkFinite = (v) => { for (const x of v) if (!Number.isFinite(x)) finite = false; };

  for (let s = 0; s < steps; s++) {
    sys.step(dt);
    const r = sys.get(id);
    if (!r) break;
    checkFinite(r.rootPos); checkFinite(r.rootQuat); checkFinite(r.vel); checkFinite(r.omega);

    // capsule-end penetration: transform the two model-space ends by the root
    // and measure how far below (floorY + radius) they sit.
    for (const ly of [rr, bodyLen - rr]) {
      const p = rotY(r.rootQuat, [0, ly, 0]);
      const worldY = r.rootPos[1] + p[1];
      const pen = (floorY + rr) - worldY;
      if (pen > worstPen) worstPen = pen;
    }
    // limb swing magnitude
    for (const { part } of RAGDOLL_LIMBS) {
      const q = r.limbs[part];
      checkFinite(q);
      const ang = 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
      if (ang > maxLimbSwing) maxLimbSwing = ang;
    }
  }

  const r = sys.get(id);
  return {
    finite,
    worstPen,
    maxLimbSwing,
    asleep: !!(r && r.asleep),
    fingerprint: r ? fp(r) : 0,
    restY: r ? r.rootPos[1] : NaN,
    // world y-component of the body's up axis: ~0 = lying down, ~1 = standing
    upY: r ? rotY(r.rootQuat, [0, 1, 0])[1] : NaN,
  };
}

// rotate v by quat (mirror of the solver's qrot — kept local so the gate is an
// INDEPENDENT check, not a re-run of the solver's own helpers)
function rotY(q, v) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

// FNV-1a over the settled pose — a stable fingerprint for the determinism check
function fp(r) {
  let h = 0x811c9dc5 >>> 0;
  const mix = (x) => {
    const q = Math.round(x * 4096) | 0;
    h ^= q & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (q >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (q >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
  };
  r.rootPos.forEach(mix); r.rootQuat.forEach(mix);
  for (const { part } of RAGDOLL_LIMBS) r.limbs[part].forEach(mix);
  return h >>> 0;
}

function assert(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

let ok = true;

// 1) determinism — identical inputs must produce a byte-identical settled pose
{
  const a = drive();
  const b = drive();
  ok &= assert('deterministic (identical settled pose across runs)',
    a.fingerprint === b.fingerprint && a.finite && b.finite,
    `fpA=${a.fingerprint} fpB=${b.fingerprint}`);
}

// 2) bounded / no NaN under a violent launch — nothing goes non-finite
{
  const r = drive({ steps: 3000 });
  ok &= assert('stays finite under a violent launch (no NaN / no blow-up)', r.finite);
}

// 3) never sinks through the floor (beyond a small solver tolerance)
{
  const r = drive({ steps: 3000 });
  ok &= assert('never sinks through the floor', r.worstPen < 0.08,
    `worst penetration=${r.worstPen.toFixed(4)} m`);
}

// 4) joint limits respected — no limb ever exceeds the configured limit plus
//    the tip-contact allowance (the floor / torso keep-out constraints may
//    push a limb past the generic limit by up to their 0.6 rad/substep
//    correction — deliberate: never-through-the-floor wins over the limit)
{
  const r = drive({ steps: 3000 });
  ok &= assert('limbs stay within the joint limit', r.maxLimbSwing <= RP.limbLimit + 0.65,
    `max swing=${r.maxLimbSwing.toFixed(3)} vs limit=${RP.limbLimit}+0.65 contact slack`);
}

// 5) settles — a body comes to rest (asleep) within a few seconds, lying FLAT
//    on the floor (not floating, not buried, and not standing upright)
{
  const r = drive({ steps: 900, dt: 1 / 60 }); // 15 s
  const restedOnFloor = r.restY > -0.1 && r.restY < 1.2;
  const lyingDown = Math.abs(r.upY) < 0.55; // body up-axis near-horizontal
  ok &= assert('settles flat on the floor within 15 s', r.asleep && restedOnFloor && lyingDown,
    `asleep=${r.asleep} restY=${r.restY.toFixed(3)} upY=${r.upY.toFixed(3)}`);
}

// 6) a sloped floor (stairwell) still settles without sinking or exploding
{
  const sys = new RagdollSystem(RP);
  const id = 7;
  const groundYAt = (x) => 0.15 * x; // a ramp
  sys.spawn(id, { x: 0, y: 1.0, z: 0, heading: 0, deck: 1 },
    { dirX: 1, dirZ: 0, speed: 6, up: 3, spin: 8, kick: 6 }, groundYAt);
  let finite = true, worstPen = 0;
  const rr = sys.p.bodyRadius, bodyLen = sys.p.bodyLen;
  for (let s = 0; s < 1800; s++) {
    sys.step(1 / 60);
    const r = sys.get(id);
    for (const x of [...r.rootPos, ...r.rootQuat, ...r.vel, ...r.omega]) if (!Number.isFinite(x)) finite = false;
    for (const ly of [rr, bodyLen - rr]) {
      const p = rotY(r.rootQuat, [0, ly, 0]);
      const worldY = r.rootPos[1] + p[1];
      const floorY = groundYAt(r.rootPos[0] + p[0]);
      const pen = (floorY + rr) - worldY;
      if (pen > worstPen) worstPen = pen;
    }
  }
  ok &= assert('settles on a sloped floor without sinking or blowing up',
    finite && worstPen < 0.2, `finite=${finite} worstPen=${worstPen.toFixed(4)}`);
}

// 7) the concurrent cap holds — spawning far past maxActive never grows the set
{
  const sys = new RagdollSystem({ ...RP, maxActive: 8 });
  for (let i = 0; i < 200; i++) {
    sys.spawn(i, { x: i, y: 1, z: 0, heading: 0, deck: 1 },
      { dirX: 1, dirZ: 0, speed: 5, up: 2.5, spin: 6, kick: 5 }, () => 0);
  }
  ok &= assert('honors the concurrent cap (evicts oldest)', sys.size === 8,
    `size=${sys.size} cap=8`);
}

// 8) a fresh spawn for the SAME id replaces (never duplicates or grows past 1)
{
  const sys = new RagdollSystem(RP);
  const imp = { dirX: 1, dirZ: 0, speed: 5, up: 2.5, spin: 6, kick: 5 };
  sys.spawn(42, { x: 0, y: 1, z: 0, heading: 0, deck: 1 }, imp, () => 0);
  sys.spawn(42, { x: 0, y: 1, z: 0, heading: 0, deck: 1 }, imp, () => 0);
  ok &= assert('re-spawning the same id does not duplicate', sys.size === 1, `size=${sys.size}`);
}

// 9) re-fling (grenade on a body already down): reimpulse wakes a settled body,
//    stays bounded, and re-settles without sinking or blowing up
{
  const sys = new RagdollSystem(RP);
  const id = 5;
  sys.spawn(id, { x: 0, y: 1, z: 0, heading: 0, deck: 1 },
    { dirX: 1, dirZ: 0, speed: 5, up: 2.5, spin: 6, kick: 5 }, () => 0);
  for (let s = 0; s < 900; s++) sys.step(1 / 60); // let it settle
  const wasAsleep = sys.get(id).asleep;
  const missing = sys.reimpulse(999, { dirX: 1, dirZ: 0, speed: 10, up: 5, spin: 12, kick: 10 });
  sys.reimpulse(id, { dirX: -1, dirZ: 0.3, speed: 14, up: 6, spin: 17, kick: 14 });
  const woke = !sys.get(id).asleep;
  let finite = true, worstPen = 0;
  const rr = sys.p.bodyRadius, bodyLen = sys.p.bodyLen;
  for (let s = 0; s < 1500; s++) {
    sys.step(1 / 60);
    const r = sys.get(id);
    for (const x of [...r.rootPos, ...r.rootQuat, ...r.vel, ...r.omega]) if (!Number.isFinite(x)) finite = false;
    for (const ly of [rr, bodyLen - rr]) {
      const pnt = rotY(r.rootQuat, [0, ly, 0]);
      const pen = (0 + rr) - (r.rootPos[1] + pnt[1]);
      if (pen > worstPen) worstPen = pen;
    }
  }
  const reSettled = sys.get(id).asleep;
  ok &= assert('grenade re-fling wakes a settled body, stays stable, re-settles',
    wasAsleep && missing === false && woke && finite && worstPen < 0.08 && reSettled,
    `wasAsleep=${wasAsleep} wokeUnknown=${missing} woke=${woke} finite=${finite} pen=${worstPen.toFixed(4)} reSettled=${reSettled}`);
}

// 10) limb tips never clip into the floor (user report: settled bodies had
//     arms/legs buried in the deck). Checked at rest — the tip constraint
//     holds them a limbRadius above the plating, minus a small tolerance.
// 11) limb tips stay outside the torso keep-out (user report: limbs folded
//     INTO the body) — no settled tip inside the keep-out cylinder while
//     alongside the torso capsule.
{
  const sys = new RagdollSystem(RP);
  const geomOf = (k) => (RP.limbGeom && RP.limbGeom[RAGDOLL_LIMBS[k].part]) || RAGDOLL_LIMBS[k];
  for (let i = 0; i < 6; i++) {
    sys.spawn(100 + i, { x: i * 3, y: 1.0, z: 0, heading: i * 1.1, deck: 1 },
      { dirX: Math.cos(i), dirZ: Math.sin(i), speed: 6 + i * 2, up: 3 + (i % 3), spin: 8 + i * 2, kick: 6 + i * 2 },
      () => 0);
  }
  for (let s = 0; s < 1200; s++) sys.step(1 / 60);
  let worstTipPen = -1, worstKeepIn = 1e9, allAsleep = true;
  const rr = sys.p.bodyRadius, limbR = sys.p.limbRadius ?? 0.08;
  const keep = rr * (sys.p.limbKeepOut ?? 0.8) + limbR;
  for (const id of [...sys.ids()]) {
    const r = sys.get(id);
    if (!r.asleep) allAsleep = false;
    for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
      const { part, axis } = RAGDOLL_LIMBS[k];
      const g = geomOf(k);
      const d = rotY(r.limbs[part], axis);
      const tipL = [g.pivot[0] + d[0] * g.len, g.pivot[1] + d[1] * g.len, g.pivot[2] + d[2] * g.len];
      const tw = rotY(r.rootQuat, tipL);
      const tipY = r.rootPos[1] + tw[1];
      const pen = (0 + limbR) - tipY; // floor at 0
      if (pen > worstTipPen) worstTipPen = pen;
      if (tipL[1] > rr * 0.5 && tipL[1] < sys.p.bodyLen - rr * 0.5) {
        const h = Math.hypot(tipL[0], tipL[2]);
        if (h < worstKeepIn) worstKeepIn = h;
      }
    }
  }
  ok &= assert('settled limb tips never clip into the floor', worstTipPen < 0.04,
    `worst tip penetration=${worstTipPen.toFixed(4)} m (allAsleep=${allAsleep})`);
  ok &= assert('settled limb tips stay outside the torso keep-out',
    worstKeepIn === 1e9 || worstKeepIn > keep - 0.04,
    `closest tip-to-axis=${worstKeepIn === 1e9 ? 'n/a' : worstKeepIn.toFixed(3)} vs keep-out=${keep.toFixed(3)}`);
}

// 12) a high-speed body cannot tunnel through a closed bulkhead. This fake
// swept contact has the same callback contract as game/world.js: the solver
// must project the root to the free side and reflect its inward velocity.
{
  const sys = new RagdollSystem(RP);
  const wallX = 2;
  sys.spawn(301, { x: 0, y: 1, z: 0, heading: 0, deck: 1 },
    { dirX: 1, dirZ: 0, speed: 18, up: 2.5, spin: 12, kick: 10 },
    () => 0, null,
    (fromX, fromZ, toX, toZ, radius) => {
      if (toX + radius < wallX) return null;
      return { x: wallX - radius - 0.001, z: fromZ, nx: -1, nz: 0 };
    });
  let farthestX = -Infinity;
  let reflected = false;
  for (let step = 0; step < 120; step++) {
    sys.step(1 / 60);
    const rag = sys.get(301);
    farthestX = Math.max(farthestX, rag.rootPos[0]);
    if (rag.vel[0] < 0) reflected = true;
  }
  ok &= assert('melee-launched bodies collide with bulkheads without tunnelling',
    farthestX < wallX && reflected,
    `farthestX=${farthestX.toFixed(3)} wallX=${wallX} reflected=${reflected}`);
}

// 13) a swinging leg or arm cannot pass through a wall while its torso stays
// on the clear side. This was visible in casualty close-ups near bulkheads.
{
  const wallX = 0;
  let worstPen = 0;
  for (let id = 1; id <= 30; id++) {
    const sys = new RagdollSystem(RP);
    const rag = sys.spawn(id, { x: 0.55, y: 0, z: 0, heading: id * 0.3, deck: 1 },
      { dirX: -1, dirZ: 0, speed: 4, up: 2, spin: 8, kick: 12 }, () => 0, null,
      (fromX, fromZ, toX, toZ, radius) => toX - radius < wallX
        ? { x: wallX + radius + 0.001, z: toZ, nx: 1, nz: 0 } : null);
    for (let step = 0; step < 180; step++) {
      sys.step(1 / 60);
      if (step < 10) continue; // the initial standing pose may touch the wall
      for (let k = 0; k < RAGDOLL_LIMBS.length; k++) {
        const { part, axis } = RAGDOLL_LIMBS[k];
        const geom = RP.limbGeom?.[part] ?? RAGDOLL_LIMBS[k];
        const pv = rotY(rag.rootQuat, geom.pivot);
        const dir = rotY(rag.rootQuat, rotY(rag.limbs[part], axis));
        const tipX = rag.rootPos[0] + pv[0] + dir[0] * geom.len;
        worstPen = Math.max(worstPen, wallX + sys.p.limbRadius - tipX);
      }
    }
  }
  ok &= assert('limb tips stay clear of bulkheads after impact', worstPen < 0.02,
    `worst wall penetration=${worstPen.toFixed(4)} m`);
}

console.log(ok ? '\nragdoll-check OK' : '\nragdoll-check FAILED');
process.exit(ok ? 0 : 1);
