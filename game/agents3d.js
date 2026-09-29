// Renders every sim agent in 3D straight from the AgentBuffer + sim state.
// Faction bodies are simple primitives for the slice — the shapes and cues
// (charge stretch, swelling carrier, hosted weapon, tracers, muzzle flashes)
// are all driven by sim flags, per the fidelity contract (ROADMAP-3D §4).

import * as THREE from '../engine/vendor/three.webgpu.module.js';
import * as TSL from '../engine/vendor/three.tsl.module.js';
import { FACTION, FLAG, CLIP } from '../shared/agentBuffer.js';
import { elevOf, clearHeightOf } from './world.js';
import { carryGeometry, flamerGeometry, FLAMER_MUZZLE, MA5_GUNMETAL } from './rifle-model.js';
import { characterParts } from './characters.js';
import { buildCarrier, CarrierAnimator, SACK_BLOAT_M } from './carrier-model.js';
import { RagdollSystem } from '../engine/physics/ragdoll.js';
import { TASK } from '../sim/hive.js';
import { combatAttackArmPose, combatChargeArmPose } from '../sim/charge-pose.js';

const CAP = 512;
// the carry yaw _rifleAt applies; the weapon light rides the same axis
const RIFLE_YAW = 0.40;

// --- procedural rig -------------------------------------------------------
// Model space for every character: +X forward, +Y up, +Z the body's own
// right, feet at y = 0. Limbs are RIGID single meshes swung about the JMS
// shoulder/hip pivot — there is no elbow and no knee, which is the constraint
// every number below is written against.

// CARRY (user: "marines should actually be holding on their rifles and in a
// pose similar to halo games", then "both hands outstretched, still looks
// silly"). Both of those come from the same root cause: the weapon and the
// arms were tuned independently, so the hands never actually met the gun and
// the only way to close the gap was to reach for it.
//
// So the weapon is placed FIRST and the arms are SOLVED to it — each arm is
// simply aimed at its attachment point on the rifle, which is all a jointless
// arm can do. That makes "hands on the weapon" true by construction on any
// body proportions, and it is why the carry height is expressed relative to
// where THIS body's fingertips hang (shoulder − arm length) rather than as an
// absolute: a straight arm cannot hold a rifle above its own hands, and a
// rifle placed there is exactly the outstretched pose that was rejected.
export const CARRY = {
  drop: 0.15,        // weapon centre this far above the fingertip line
  fwd: 0.17,         // in front of the spine
  right: 0.28,       // out at the strong-side hip
  yaw: RIFLE_YAW,    // muzzle carried across the body (the torch rides this)
  // NOSED DOWN 3 DEGREES, which is where a low-ready muzzle actually points
  // and what the lighting host used to fake for every beam on the ship. Now it
  // is a real barrel angle the beam and the weapon light both follow, so a man
  // walking a dark corridor throws his torch onto the plating ahead of him.
  pitch: -0.05,
  // WHERE EACH HAND GRABS, in the WEAPON's own frame: `grip`/`guard` run down
  // the barrel, `*Down` hangs below the bore and `*Side` comes out of its
  // flank. The two perpendicular terms are what stop the arms merging (see
  // AIM): along the barrel alone the two hands have nowhere to go.
  grip: -0.02,       // firing hand, measured along the rifle's own axis
  guard: 0.24,       // support hand, up on the handguard
  gripDown: 0, gripSide: 0, guardDown: 0, guardSide: 0,
  // how far INSIDE its own reach each hand is asked to close, when the station
  // it was given is further out than the arm can go (see solveCarry). Keeping
  // it non-zero is what keeps the residual negative — the hand shuts past the
  // weapon rather than hanging short of it, which is the one that shows.
  bite: 0.012,
  // SIGHTED (user: "obviously need marines leaning in and sighting their
  // guns"). See AIM below for why this is a straight-armed presentation and
  // not a shouldered one — the rig gives no other option.
  // drop 0.88 puts the barrel at y 1.43 — the man's own cheek line, with the
  // hands 0.74 m out where a straight arm can actually hold them. Lower and it
  // slides back toward the hip carry it has to be told apart from; higher and
  // he is aiming over his own head. yaw 0: the low-ready's 0.40 rad across the
  // body is a carry angle, and a man shooting at something points the weapon
  // AT it. pitch 0.19 cancels the 0.24 lean, leaving the barrel 3 degrees down
  // in world — level enough to be aimed, low enough for the beam to land.
  // The two hands take OPPOSITE CORNERS of the receiver — firing hand under it
  // and out to the strong side, support hand over it and across — because
  // along the barrel they have nowhere to go (see AIM). Both stations sit
  // 12 mm inside where that arm exactly reaches, so both residuals land at
  // −0.011: each hand closes PAST its hold, never short of it.
  fire: {
    drop: 0.88, fwd: 0.61, right: 0.10, yaw: 0.0, pitch: 0.19,
    grip: 0.126, gripDown: 0.05, gripSide: 0.06,
    guard: 0.132, guardDown: -0.03, guardSide: -0.06,
  },
};

// AIMING, AND WHY IT LOOKS LIKE THIS.
//
// The one thing that decides this pose is that an arm is a single rigid
// segment: its hand is ALWAYS exactly `armLen` (0.743 m) from a shoulder that
// sits at (0.03, 1.29, ±0.03) — the two shoulder pivots are 6 cm apart, so for
// this purpose both hands hang off the same point. Put both hands on one
// straight barrel and the geometry closes: the mid-grip must be ~0.73 m from
// that point and the BARREL MUST BE PERPENDICULAR TO THAT REACH. Solve it and
// there are exactly two families — weapon hanging under the shoulders (the
// low-ready carry we already ship) or weapon held out at arm's length to the
// side. A shouldered rifle needs the firing hand 0.3 m from the shoulder; this
// arm cannot be shorter than 0.743 m, so it does not exist on this rig, and
// the previous pass was right to stop reaching for it.
//
// What DOES exist is the presentation: weapon pushed out in front at chest
// height with the barrel level and down the man's own bearing, which is what
// every jointless-limb shooter has ever done. Committing to it fully is what
// makes it read — half-measures land back on the hip carry, which is the
// complaint.
//
// TWO ARMS, NOT ONE MASS (user, on the last pass: "the two arms visually merge
// into one mass while aiming"). They did, and moving the hands apart ALONG the
// barrel cannot fix it. A hand is always exactly 0.743 m from its shoulder, so
// the only stations where it is truly ON a straight barrel are where that
// sphere cuts the barrel line:
//     t = (shoulder − origin)·axis + sqrt(armLen² − h²),   h = shoulder→line
// Run it for both shoulders at this placement and they come out at 0.146 and
// 0.137 — the entire axial spread available is NINE MILLIMETRES, and pushing
// either hand past its own root only floats it off the weapon. The bracket
// only opens up as h approaches armLen, i.e. with the arm stretched square to
// the barrel, which is the weapon-out-to-the-side family this pose exists to
// avoid: even at 0.6 m off the hip it is worth 9 cm. (The low-ready carry gets
// its hand spread for free precisely because its barrel hangs 0.59 m below the
// shoulders, so h IS large down there.)
//
// So the second solve target is PERPENDICULAR instead. The firing hand takes
// the underside of the receiver on the strong side, the support hand comes
// over the top from the far side, and the 0.15 m between them is bought out of
// the weapon's own cross-section rather than its length. Both hands still sit
// within ~2 cm of the mesh and both residuals stay negative — nothing floats.
//
// The rest is body language, and it is doing most of the work:
//   lean   the whole body pitches onto the weapon (about the feet, so the
//          legs slant into it too — he is driving forward, not standing).
//   head   chin down and forward, tucked in behind the receiver.
//   stance rear leg braced back, front leg under him — a bladed firing stance
//          instead of the ATTACK clip's twitching shuffle, which was written
//          for a flood form swinging claws and has no business under a rifle.
// `pitch` above then cancels the lean so the barrel comes out LEVEL in world
// and the beam leaves it pointing at what he is shooting.
export const AIM = {
  lean: -0.24,       // body frame, negative = forward (see _pose)
  head: 0.28,        // chin down behind the weapon
  stance: 0.32,      // rear/front leg split
  rate: 6.5,         // eased in and out at this rate (≈0.2 s to commit)
  // A HELD SIGHT PICTURE IS NOT A STATUE (user: "the aiming legs are
  // completely static"). Two slow, unrelated oscillations off the id hash:
  // `sway` rocks the whole man fore/aft over his feet, `swayRoll` rolls his
  // weight from one boot to the other. Both are hip angles, so both would
  // SLIDE the feet — the rock is cancelled by translating the body the exact
  // distance its feet would have travelled (_aimShift), and the roll's is a
  // 3 cm scuff spread over 13 s, which is what a man settling his weight
  // actually does. Height is _aimDip's job, and it now takes the real leg
  // angles instead of assuming a fixed split, so no phase of this lifts a
  // boot off the plating or drives one into it.
  sway: 0.05,        // fore/aft rock at the hip
  swayRoll: 0.035,   // weight rolling between the feet
  swayRate: 0.75,    // rad/s — an 8 s rock under a 13 s roll
};
const RIFLE_TIP = 0.515;   // muzzle along the rifle's own +X (RIFLE_MUZZLE.z)
const AXIS_Z = new THREE.Vector3(0, 0, 1);   // model-frame fore/aft swing axis
// folded-ODST diffuse tints (setColorAt needs Color objects, not hex numbers)
const PLATE_ODST = new THREE.Color(0x3f434c), PLATE_LINE = new THREE.Color(0xffffff);

// per-body constant in [0,1) — stance, stride length and step phase all vary
// off it so a crowd never marches in lockstep
const bodyRnd = (id) => ((Math.imul(id, 1597334677) ^ 0x5f3a1c) >>> 0) / 4294967296;
// which foot this body blades forward when it sights (see AIM.stance)
const leadFoot = (id) => (bodyRnd(id) < 0.5 ? 1 : -1);
// One full cycle = two steps. The rate is chosen so the FEET COVER GROUND at
// the speed the body actually travels: stride = 2·L·sin(A) with L ≈ 0.96 m and
// the amplitudes below give 1.40 m/s walking and 2.11 m/s running, which are
// P.movement.baseMps and the fleeing/charging multiplier. The old fixed 7.2
// rad/s against a ±0.5 rad stride was a 2.0 m/s footfall under a 1.4 m/s body
// — a 44% mismatch, and the reason the walk read as skating metronome.
const LEG_AMP = { walk: 0.38, run: 0.50 };
const gaitRate = (clip) => (clip === CLIP.RUN ? 7.2 : clip === CLIP.ATTACK ? 9
  : clip === CLIP.WRITHE ? 13 : 6.2);
const gaitPhase = (clip, t, id) => {
  const r = bodyRnd(id);
  return t * gaitRate(clip) * (0.94 + r * 0.12) + r * 6.2832;
};
// hip angle over one cycle. The second harmonic is what stops it being a
// metronome: it makes the swing leg travel faster than the stance leg, so the
// foot spends longer under the body than out in front of it, the way a real
// step does.
const strideOf = (p) => Math.sin(p) + 0.16 * Math.sin(2 * p);
// deterministic per-(shooter, tick, salt) jitter in [-1, 1] for tracer spread
function shotJitter(id, tick, salt) {
  let h = (id * 374761393 + tick * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
}
// shadow-caster curation (swarm finding): the torch's shadow camera reaches
// 32m — an instance beyond ~34m of the eye can't cast into the beam, so a
// part-set with no stamped instance that close skips the depth pass entirely
const CAST_NEAR2 = 34 * 34;

// commit an instanced mesh's frame: draw `count` instances and upload ONLY
// that range of the matrix buffer (falls back to a full upload on builds
// without updateRanges)
function commitInstanced(mesh, count) {
  // never draw past the buffer (perf pass 4 shrank per-set capacities —
  // see mkSet — so the count MUST clamp; capacities carry generous margin
  // over each faction's theoretical maximum, this is belt-and-braces)
  const cap = mesh.instanceMatrix.count;
  mesh.count = count > cap ? cap : count;
  // EMPTY SETS LEAVE THE RENDER LIST (swarm finding: a count-0 InstancedMesh
  // still paid bindings processing and a full uniform upload per pass per
  // frame — and most of the 57 character part-meshes are empty most frames).
  // Firefox's wgpu pays the most per redundant binding; every backend wins.
  mesh.visible = count > 0;
  // FULL UPLOAD, DELIBERATELY. This used to declare a partial update range
  // (0 .. count*16) to avoid re-sending 512 unused slots every frame. That
  // saving is not worth it: bodies keep going invisible on WebGPU, the update
  // range is the one thing standing between "matrix written" and "matrix on
  // the GPU", and it is a documented soft spot in this backend — a range that
  // is mis-scaled, ignored, or applied against a stale version leaves those
  // instances reading whatever was in the buffer before, which for a slot that
  // has never been drawn is zeros. A zero matrix collapses the body to a point:
  // exactly "invisible flood". Correctness first; the copy is cheap next to
  // losing an enemy you are supposed to be fighting.
  if (count > 0) mesh.instanceMatrix.needsUpdate = true;
}

// Measure a converted character once: where its shoulders and hips are, and
// how far its fingertips sit from the shoulder. That radius is fixed — a rigid
// arm's hand is ALWAYS exactly that far out — so it is the number every carry
// and every swing has to respect.
function rigMetrics(parts) {
  const reach = (part) => {
    let pivot = null, best = 0, tip = null;
    for (const p of parts) {
      if (p.part !== part || !p.pivot) continue;
      pivot = p.pivot;
      const pos = p.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - pivot[0], dy = pos[i + 1] - pivot[1], dz = pos[i + 2] - pivot[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > best) { best = d2; tip = [dx, dy, dz]; }
      }
    }
    if (!pivot || !tip) return null;
    const r = Math.sqrt(best);
    return { pivot, len: r, dir: [tip[0] / r, tip[1] / r, tip[2] / r] };
  };
  const armR = reach('armR'), armL = reach('armL');
  const hip = parts.find((p) => p.part === 'legR' && p.pivot)?.pivot
    ?? parts.find((p) => p.part === 'legL' && p.pivot)?.pivot;
  return { armR, armL, legLen: hip ? hip[1] : 0.95 };
}

// Solve the two arm rotations that put this body's hands on a rifle carried at
// `cfg`, and hand back the weapon transform they were solved against so the
// two can never be tuned apart again. Pure geometry, run once per model.
export function solveCarry(rig, over) {
  if (!rig.armR || !rig.armL) return null;
  const C = { ...CARRY, ...over };
  const y = rig.armR.pivot[1] - rig.armR.len + C.drop;
  const cp = Math.cos(C.pitch), sp = Math.sin(C.pitch);
  const cy = Math.cos(C.yaw), sy = Math.sin(C.yaw);
  // the weapon's own frame in model space: down the barrel, up out of the
  // receiver, out of its right flank (ax × up)
  const ax = [cp * cy, sp, -cp * sy];
  const up = [-sp * cy, cp, sp * sy];
  const rt = [sy, 0, cy];
  // a point on the WEAPON: `t` along its axis, `dn` below the bore, `side`
  // out of its right flank. The last two are the second solve target — the
  // only axis on which the two hands can actually be told apart (see AIM).
  const at = (t, dn = 0, side = 0) => [
    C.fwd + t * ax[0] - dn * up[0] + side * rt[0],
    y + t * ax[1] - dn * up[1] + side * rt[1],
    C.right + t * ax[2] - dn * up[2] + side * rt[2],
  ];
  const aim = (arm, target) => {
    const dx = target[0] - arm.pivot[0], dy = target[1] - arm.pivot[1], dz = target[2] - arm.pivot[2];
    const d = Math.hypot(dx, dy, dz) || 1;
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(arm.dir[0], arm.dir[1], arm.dir[2]),
      new THREE.Vector3(dx / d, dy / d, dz / d));
    return { q, slack: d - arm.len };
  };
  // REACH-CLAMPED, PER BODY. A station is only worth asking for if that arm
  // can get there, and the bodies are not the same: the armed crewman's arm is
  // 0.725 m off a shoulder set 6 cm further back than the marine's, so the
  // marine's stations left BOTH his hands floating 7 cm short of the weapon.
  // Solve the arm's reach sphere against the (offset) barrel line and pull the
  // station back to that root — never past it — so the residual comes out
  // negative on any proportions instead of only on the model it was tuned on.
  const hold = (arm, t, dn, side) => {
    const p0 = at(0, dn, side);
    const dx = arm.pivot[0] - p0[0], dy = arm.pivot[1] - p0[1], dz = arm.pivot[2] - p0[2];
    const a = dx * ax[0] + dy * ax[1] + dz * ax[2];
    const r2 = arm.len * arm.len - (dx * dx + dy * dy + dz * dz - a * a);
    // barrel further off this shoulder than the arm is long — no station on it
    // is reachable at all, so take the closest approach and leave the residual
    // as small as the geometry allows rather than choosing an arbitrary miss
    if (r2 <= 0) return aim(arm, at(a, dn, side));
    return aim(arm, at(Math.min(t, a + Math.sqrt(r2) - C.bite), dn, side));
  };
  const r = hold(rig.armR, C.grip, C.gripDown, C.gripSide);
  const l = hold(rig.armL, C.guard, C.guardDown, C.guardSide);
  return {
    qR: r.q, qL: l.q, slackR: r.slack, slackL: l.slack,
    rifle: {
      fwd: C.fwd, y, right: C.right, yaw: C.yaw, pitch: C.pitch,
      sh: rig.armR.pivot[1],
      // where the barrel actually ends, so the torch can leave the nozzle
      // instead of the sternum (user: "flashlights aligned with gun nozzles")
      muzzleY: y + RIFLE_TIP * sp, muzzleF: C.fwd + RIFLE_TIP * cp * cy,
    },
  };
}

function makeInstanced(scene, geo, color, emissive = 0x000000, emissiveIntensity = 0.4) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15, emissive, emissiveIntensity });
  const mesh = new THREE.InstancedMesh(geo, mat, CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

export class Agents3D {
  constructor(scene, sim, world) {
    this.sim = sim;
    this.world = world;
    this.scene = scene;
    this.rpos = new Map(); // id -> smoothed {x, y(z-sim), deck}
    this.playerId = -1;

    // REAL SKINS (user note): converted Halo character meshes — H2 marines/
    // crew/infection form, H3 flood combat forms (civilian + ODST hosts) —
    // drawn as one InstancedMesh per texture group, feet at y=0. The
    // carrier keeps its procedural swelling body (no source mesh exists);
    // corpses are the character meshes laid flat (burned husks stay slabs).
    const mkSet = (name, cap = CAP) => {
      const parts = characterParts(name);
      const flood = name === 'infection' || name === 'combat_civ' || name === 'combat_odst';
      // FrontSide (swarm finding): DoubleSide on the densest textured meshes
      // in the game doubled raster work in the main AND shadow passes. The
      // humanoid parts are closed shells — verified by a 4-angle spin-around
      // pixel diff — but the infection form's feeler paddles and tentacles
      // are open single-sided fins that vanish from behind, so it keeps
      // DoubleSide.
      // FLOOD SETS STAY DoubleSide (user report on Chrome: some combat forms
      // lost their bodies but kept their SHADOW — a reverse-wound part is
      // culled by FrontSide in the main pass while the shadow pass draws
      // BackSide, leaving a black silhouette with no caster). The humanoid
      // crew/marine shells verified clean under FrontSide and keep the win.
      const set = parts.map((p) => {
        const mat = new THREE.MeshStandardMaterial({
          map: p.texture, roughness: 0.78, metalness: 0.06,
          side: flood ? THREE.DoubleSide : THREE.FrontSide,
        });
        const mesh = new THREE.InstancedMesh(p.geometry, mat, cap);
        // every one of these matrices is rewritten each frame
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.userData.part = p.part;
        mesh.userData.pivot = p.pivot;
        scene.add(mesh);
        return mesh;
      });
      set.rig = rigMetrics(parts);
      // ARMS IN, NOT OUT. These meshes are bound in an A-POSE — the hand sits
      // ~43° out from the shoulder — so a pure fore/aft swing walks the body
      // around with its arms held off its sides like a gorilla. Adduction
      // about model X is the only axis that closes that, and it is applied to
      // every human limb, not just to rifle carriers. Flood limbs are left
      // alone: one of a combat form's arms is a whip tentacle that is MEANT to
      // hang wide.
      const dz = set.rig.armR ? set.rig.armR.dir[2] : 0;
      set.adduct = flood || Math.abs(dz) < 0.4 ? 0 : Math.sign(dz) * 0.34;
      set.hold = solveCarry(set.rig, null);
      set.holdFire = solveCarry(set.rig, CARRY.fire);
      return set;
    };
    // PER-SET CAPACITIES (perf pass 4): commitInstanced deliberately uploads
    // the FULL matrix buffer of every non-empty mesh (partial update ranges
    // are a documented soft spot on this backend — see commitInstanced), so
    // buffer size IS per-frame upload traffic: 512x64B = 32KB per part mesh,
    // ~40 live part meshes = >1MB/frame. Capacities now track each faction's
    // real ceiling with heavy margin (crew tops out ~148 souls TOTAL; the
    // marine detachment is ~30; a faction's renderable bodies can never
    // exceed the ship's 296). commitInstanced clamps count at capacity as a
    // backstop. Corpse/rifle/flash/beams/carrier keep the full 512.
    this.civSet = mkSet('civilian', 256);
    this.armedSet = mkSet('crew_armed', 128);
    this.marineSet = mkSet('marine', 128);
    // ODST reserve rides the SAME set with a per-instance tint (perf pass 5:
    // odstSet was a byte-identical clone of marineSet differing only by
    // material.color — 13 duplicate InstancedMeshes for at most 5 bodies).
    // instanceColor multiplies DIFFUSE, so green BDU armor still reads as
    // matte-black ODST hardsuit with a darkened visor (user: armory ODSTs
    // need their own skin). The buffer is allocated NOW, not lazily via the
    // first setColorAt: prewarm compiles every set at boot, and a buffer
    // that appears later builds render objects without the instanceColor
    // node — the ODSTs would silently render marine-green.
    for (const m of this.marineSet) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(128 * 3).fill(1), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.marineSet.tintLast = new Uint8Array(128).fill(0xff);
    this.infectionSet = mkSet('infection', 256);
    this.combatCivSet = mkSet('combat_civ', 256);
    this.combatOdstSet = mkSet('combat_odst', 128);
    // REAL CARRIER MESH: the Halo 3 carrier, GPU-skinned per instance from a
    // baked bone bank (game/carrier-model.js). Replaces the sculpted gas-sack
    // primitive — it has an actual skeleton, so its states are animation
    // rather than scale: rooted and breathing while it incubates, a lumbering
    // waddle, a strain cycle when the skin is nearly full, and a collapse it
    // ruptures out of.
    const carrier = buildCarrier(CAP);
    this.carrier = carrier.mesh;
    this.carrierAnim = carrier.anim;
    this._commitCarrierAnim = carrier.commitAnim;
    scene.add(this.carrier);
    this._carrierAnims = new Map();   // agent id -> CarrierAnimator
    this._carrierLast = new Map();    // agent id -> last drawn [x, y, z, heading, load]
    this._bursting = [];              // carriers mid-detonation, render-only
    this.corpse = makeInstanced(scene, new THREE.BoxGeometry(1.5, 0.28, 0.55), 0x5a5a5a);
    // real MA5 silhouette (first-strike asset), merged grip+gun, one draw
    // call for every carried rifle on the ship (marines, armed crew, armed
    // combat forms) — see game/rifle-model.js
    this.rifle = makeInstanced(scene, carryGeometry(), MA5_GUNMETAL);
    this.rifle.material.roughness = 0.78;
    this.rifle.material.metalness = 0.25;
    // THE FLAMETHROWER IS NOT AN MA5 (it was rendering as one, which made the
    // only weapon that permanently destroys a body indistinguishable from the
    // ones that don't). Same carry solve, different silhouette — see
    // game/rifle-model.js. Scorched olive, and only a whisper of emissive for
    // the igniter pilot: the material is uniform over the whole mesh, so a
    // pilot bright enough to see at the nozzle turns the entire weapon into a
    // bar of hot copper (it did).
    this.flamer = makeInstanced(scene, flamerGeometry(), 0x36382f, 0x2a0800, 0.16);
    this.flamer.material.roughness = 0.72;
    this.flamer.material.metalness = 0.45;
    // flame jets declared this frame; the host drains them into its FlameJetFX
    // exactly as it drains rifleLights into the light pool (records recycle)
    this.flameJets = [];
    this.flameJetN = 0;

    // combat FX: tracers + muzzle flashes. Flood fire (a hostArmed combat
    // form emptying its stolen rifle) gets its own sickly-green tracer so
    // it visibly reads as THEM shooting, not human gunfire.
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(256 * 6), 3));
    this.tracers = new THREE.LineSegments(tGeo,
      new THREE.LineBasicMaterial({ color: 0xffe08c, transparent: true, opacity: 0.85 }));
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 6), 3));
    this.floodTracers = new THREE.LineSegments(fGeo,
      new THREE.LineBasicMaterial({ color: 0x9dff6a, transparent: true, opacity: 0.85 }));
    this.floodTracers.frustumCulled = false;
    scene.add(this.floodTracers);
    this.flash = makeInstanced(scene, new THREE.SphereGeometry(0.14, 6, 5), 0xfff2c8, 0xffdf8a, 3.0);
    // FLASHLIGHT BEAMS (user rule): marines and armed crew fighting in a
    // flood-darkened room sweep visible torch cones. Additive translucent
    // cone, +X-forward like the carry rifle, one instance per light-bearer
    // standing in a dark room.
    {
      const beamGeo = new THREE.ConeGeometry(0.8, 6, 20, 1, true);
      beamGeo.rotateZ(Math.PI / 2);      // point the cone along +X
      beamGeo.translate(3.0, 0, 0);      // apex at the carrier's hands
      // A LIGHT SHAFT, NOT A PIPE (user screenshot: an opaque white cylinder
      // sticking out of a marine's chest). The old material shaded the cone's
      // lateral surface with an axial gradient only, so the surface itself was
      // what you saw — hard silhouette, uniform density, solid-looking.
      //
      // The fix is view-dependent: fade by how face-on the surface is. Where
      // you look straight AT the cone wall the view ray passes through the
      // most air, so it is brightest; at the silhouette the wall is edge-on
      // and goes to zero, which is what kills the hard outline. DoubleSide
      // then makes the near and far walls both contribute, so the middle of
      // the shaft naturally reads denser than its edges — a cheap volumetric
      // that costs one instanced draw.
      const beamMat = new THREE.MeshBasicNodeMaterial({
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      beamMat.colorNode = TSL.vec3(0.66, 0.78, 1.0);
      beamMat.opacityNode = TSL.Fn(() => {
        const v = TSL.uv().y;                       // 1 at the apex (hands), 0 at the far mouth
        // hot at the lens, gone by the throw's end, with a touch off the very
        // apex so it doesn't start on a hard disc
        const axial = TSL.smoothstep(0.0, 0.55, v).mul(TSL.oneMinus(TSL.smoothstep(0.95, 1.0, v)));
        const facing = TSL.abs(TSL.dot(TSL.normalize(TSL.normalView), TSL.positionViewDirection));
        return axial.mul(TSL.pow(facing, 1.7)).mul(0.42);
      })();
      this.beams = new THREE.InstancedMesh(beamGeo, beamMat, CAP);
      this.beams.count = 0;
      this.beams.frustumCulled = false;
      scene.add(this.beams);
    }
    this.floodFlash = makeInstanced(scene, new THREE.SphereGeometry(0.13, 6, 5), 0xd8ffc0, 0x8fef5a, 3.0);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._mPart = new THREE.Matrix4();
    this._mRot = new THREE.Matrix4();
    this._mOut = new THREE.Matrix4();
    this._downAt = new Map(); // id -> ms when first seen downed (death blend)
    this._playerShots = []; // {ax,ay,az,bx,by,bz,ttl}
    // weapon lights declared this frame; the host drains them into its light
    // pool (records recycle — no per-frame garbage)
    this.rifleLights = [];
    this.rifleLightN = 0;
    this._q2 = new THREE.Quaternion(); // second temp for the ragdoll limb stamp

    // CLASSIC-HALO RAGDOLLS (cosmetic; physics/ragdoll.js). A dead body is
    // handed to physics: it goes limp, is thrown off the killing blow, tumbles,
    // and settles. When disabled — or a body is a burned husk, or the cap is
    // full — everything falls back to the legacy flat-corpse / rotate-flat
    // paths below, unchanged. Pure render-side: the sim never sees any of it.
    const rp = sim.P?.ragdoll;
    this.ragdolls = (rp?.enabled ?? false) ? new RagdollSystem(rp) : null;
    this._ragSeen = new Set(); // ids already handed to a ragdoll (never respawn one)
    this._ragRest = new Map(); // id -> [x,y,z] where its ragdoll last rested, so a
                               // handoff to the legacy render (burn, cap-evict, revive)
                               // anchors there instead of teleporting to the sim node
    this._ragPrimed = false;   // first frame: mark the pre-placed dead so they never flop
    this._blasts = [];         // recent explosions (grenades): {deck, cx, cz, r, ttl} —
                               // deaths inside one get a big radial flailing launch, and a
                               // blast re-flings bodies already on the deck
    this._seen = new Set();
    this._counts = { civ: 0, armed: 0, marine: 0, infection: 0, combatCiv: 0, combatOdst: 0, carrier: 0, corpse: 0, rifle: 0, flamer: 0, flash: 0, beam: 0 };
  }

  // The game calls this when a grenade detonates (game/main.js stepFrags). It
  // records the blast so deaths it causes launch dramatically, and immediately
  // re-flings any body already ragdolling within reach. Pure render-side.
  noteExplosion(deck, cx, cz, radius) {
    const R = this.sim.P?.ragdoll;
    if (!this.ragdolls || !R) return;
    this._blasts.push({ deck, cx, cz, r: radius, ttl: R.blastTtl ?? 0.5 });
    const reach = radius + (R.blastRadiusPad ?? 1.5);
    for (const id of this.ragdolls.ids()) {
      const rag = this.ragdolls.get(id);
      if (rag.deck !== deck) continue;
      const d = Math.hypot(rag.rootPos[0] - cx, rag.rootPos[2] - cz);
      if (d > reach) continue;
      this.ragdolls.reimpulse(id, this._blastImpulse(rag.rootPos[0], rag.rootPos[2], cx, cz, d, radius));
    }
  }

  // Stable third-person focus for death/spectator cameras. A fresh corpse
  // follows its cosmetic ragdoll (including a grenade toss); a living target
  // follows the same eased position used by its rendered mesh.
  cameraAnchor(agent) {
    if (!agent) return null;
    const rag = this.ragdolls?.get(agent.id);
    if (rag) return {
      x: rag.rootPos[0], y: rag.rootPos[1], z: rag.rootPos[2],
      deck: rag.deck, node: agent.pnode ?? agent.node, heading: agent.heading,
      prone: true,
    };
    const rest = this._ragRest.get(agent.id);
    if (rest) return {
      x: rest[0], y: rest[1], z: rest[2],
      deck: agent.deck, node: agent.pnode ?? agent.node, heading: agent.heading,
      prone: agent.faction === 6 || agent.downed,
    };
    const rp = this.rpos.get(agent.id) ?? agent;
    const [x, z] = this.world.simToWorld(rp.x, rp.y, rp.deck);
    return {
      x, y: this.world.groundHeightAt(rp.deck, x, z) + (rp.hoverY ?? 0), z,
      deck: rp.deck, node: agent.pnode ?? agent.node, heading: agent.heading,
      prone: agent.faction === 6 || agent.downed,
    };
  }

  // the blast the point sits inside (strongest = nearest to a centre), or null
  _blastAt(wx, wz, deck) {
    const R = this.sim.P.ragdoll;
    const pad = R.blastRadiusPad ?? 1.5;
    let best = null, bestD = Infinity;
    for (const b of this._blasts) {
      if (b.deck !== deck) continue;
      const d = Math.hypot(wx - b.cx, wz - b.cz);
      if (d <= b.r + pad && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  // a radial launch off a blast centre, scaled down toward the edge
  _blastImpulse(wx, wz, cx, cz, d, radius) {
    const R = this.sim.P.ragdoll;
    let dx = wx - cx, dz = wz - cz;
    const dl = Math.hypot(dx, dz);
    if (dl < 0.05) { dx = 1; dz = 0; } else { dx /= dl; dz /= dl; } // epicentre → any dir (solver scatters it)
    const prox = 1 - Math.min(1, d / Math.max(0.001, radius)) * (R.blastFalloff ?? 0.55);
    return {
      dirX: dx, dirZ: dz,
      speed: (R.blastSpeed ?? 13) * prox,
      up: (R.blastUp ?? 6) * prox,
      spin: R.blastSpin ?? 17,
      kick: R.blastKick ?? 14,
    };
  }

  // RUDIMENTARY SKELETAL ANIMATION (user note): each character is six rigid
  // parts cut along its real bone weights; limbs swing about their actual
  // joint pivots (shoulder/hip from the JMS skeleton) with a procedural
  // cycle picked by the sim's animation clip. Pure render-side — the sim's
  // deterministic state is untouched.
  _swingFor(part, clip, t, id, panic) {
    const rnd = bodyRnd(id);
    const ph = gaitPhase(clip, t, id);
    const s = Math.sin(ph);
    switch (clip) {
      case CLIP.WALK: {
        // HUMAN GAIT, NOT A METRONOME (user: unarmed NPCs need realistic
        // walking). Contralateral arm/leg, a shaped hip curve (see strideOf),
        // a per-body stride length, and a head that counters the body's
        // two-per-cycle dip instead of nodding on its own unrelated clock.
        const v = 0.9 + rnd * 0.2;               // this body's stride length
        const A = LEG_AMP.walk * v;
        if (part === 'legL') return A * strideOf(ph);
        if (part === 'legR') return A * strideOf(ph + Math.PI);
        // arms swing a little further BACK than forward, as they really do
        if (part === 'armL') return -0.30 * v * s - 0.04;
        if (part === 'armR') return 0.30 * v * s - 0.04;
        if (part === 'head') return Math.sin(ph * 2) * 0.05 - 0.02;
        return 0;
      }
      case CLIP.RUN: {
        // A jog at the sim's fleeing speed. The legs cannot open much further
        // than a walk without the knee this rig does not have, so the run is
        // sold on CADENCE (gaitRate), pumped arms and the deeper bounce the
        // dip below produces — not on a wider scissor.
        const v = 0.9 + rnd * 0.2;
        const A = LEG_AMP.run * v;
        // PANIC (FLAG.PANICKED): a fleeing civilian is not jogging. Arms come
        // up and thrash out of time with the legs, the head snaps around.
        const armA = panic ? 0.85 : 0.55;
        const jitter = panic ? Math.sin(ph * 2.7 + rnd * 9) * 0.22 : 0;
        if (part === 'legL') return A * strideOf(ph);
        if (part === 'legR') return A * strideOf(ph + Math.PI);
        if (part === 'armL') return -armA * v * s + jitter;
        if (part === 'armR') return armA * v * s - jitter;
        if (part === 'head') return panic
          ? 0.10 + Math.sin(ph * 1.7 + rnd * 5) * 0.16
          : 0.07 + Math.sin(ph * 2) * 0.05;
        return 0;
      }
      case CLIP.ATTACK:
        // A fast, feral two-beat mauling motion. The old single-axis swipe
        // disappeared head-on — exactly where the player sees a form hitting
        // them. Both arms now recoil and lash independently without crossing
        // the body's centre plane; the outward lift is applied below.
        // `animTime` resets on the actual damage event, so the visual contact
        // and the physical impulse share the same beat.
        {
          const u = Math.max(0, Math.min(1, t / 0.74));
          const envelope = Math.sin(u * Math.PI);
          const right = Math.sin(u * Math.PI * 3.2) * envelope;
          const left = Math.sin((u * Math.PI * 3.2) - 1.25) * envelope;
          if (part === 'armR') return 0.25 + right * 2.65;
          if (part === 'armL') return -0.18 - left * 2.45;
          if (part === 'legL') return -right * 0.28;
          if (part === 'legR') return left * 0.34;
          if (part === 'head') return (right - left) * 0.22;
        }
        return 0;
      case CLIP.WRITHE:
        // infection form: tripod legs skitter, sensory stalks quiver
        if (part === 'legL') return s * 0.35;
        if (part === 'legR') return -s * 0.35;
        if (part === 'head') return Math.sin(ph * 1.3) * 0.25;
        return 0;
      default: {
        // IDLE — a body at rest is never rigid (user: standing all weird and
        // stiff): slow breath in the arms, an occasional unhurried look around,
        // and a static per-body stance offset so no two read as clones.
        const set2 = rnd - 0.5;
        if (part === 'armL' || part === 'armR') {
          return Math.sin(ph * 0.35 + (part === 'armR' ? 1 : 0)) * 0.05
            + set2 * (part === 'armR' ? 0.06 : -0.05); // asymmetric rest
        }
        if (part === 'head') return Math.sin(ph * 0.13 + id) * 0.1 + set2 * 0.08; // scanning
        if (part === 'legL') return set2 * 0.05;  // weight on one foot
        if (part === 'legR') return -set2 * 0.05;
        return 0;
      }
    }
  }

  // FEET ON THE DECK. A rigid leg swung θ about its hip lifts its foot
  // L·(1−cos θ) off the floor, so the old ±0.5 rad stride had BOTH feet
  // floating up to 11 cm at full scissor — a body skating along above the
  // plating. Dropping the whole body by the lift of whichever foot is closest
  // to vertical plants that foot exactly, and the drop is the two-per-cycle
  // vertical bob a real gait has for free: lowest at double support, highest
  // at midstance. Capped so the deeper running stride bounces instead of
  // squatting.
  _gaitDip(clip, t, id, legLen) {
    if (clip !== CLIP.WALK && clip !== CLIP.RUN) return 0;
    const ph = gaitPhase(clip, t, id);
    const A = (clip === CLIP.RUN ? LEG_AMP.run : LEG_AMP.walk) * (0.9 + bodyRnd(id) * 0.2);
    const lo = Math.min(Math.abs(strideOf(ph)), Math.abs(strideOf(ph + Math.PI)));
    return Math.min(0.085, legLen * (1 - Math.cos(A * lo)));
  }

  // Forward/back lean of the WHOLE body, in the body's own frame: positive
  // tips onto the back (the same axis and sign the death fall uses). Walking
  // and running lean into the travel; a jog leans further.
  _leanFor(clip, t, id) {
    if (clip === CLIP.RUN) return -0.13 + Math.sin(gaitPhase(clip, t, id) * 2) * 0.02;
    if (clip === CLIP.WALK) return -0.045;
    return 0;
  }

  // How committed to the weapon this body is, 0..1, eased toward the target so
  // the gun comes up and goes down instead of popping between two stances.
  _aimBlend(id, want, dt) {
    const m = (this._aimW ??= new Map());
    const target = want ? 1 : 0;
    let w = m.get(id);
    if (w === undefined) w = target;                  // first sight of a body: no swing-up
    else w += (target - w) * Math.min(1, dt * AIM.rate);
    if (w > 0.999) w = 1; else if (w < 0.001) w = 0;
    m.set(id, w);
    return w;
  }

  // the body's own forward tip when engaging (see AIM)
  _aimLean(w) { return AIM.lean * w; }

  // The two hip angles a sighted body is holding — the bladed split plus the
  // slow weight shift (see AIM). Unscaled: every caller blends them in by the
  // same `aim` weight the rest of the pose uses.
  //
  // BOTH BOOTS ON THE DECK, NOT JUST THE FRONT ONE. A rigid leg swung `a`
  // about its hip, on a body leaning `λ` about its feet, lifts its sole by
  //     L·(cos λ − cos(a + λ))
  // so the ONLY two hip angles that leave a boot touching are a = 0 and
  // a = −2λ. The shipped split was ±stance about ZERO, which satisfies neither
  // and left the rear boot hanging 14 cm in the air once _aimDip had planted
  // the front one. Centring the split on −lean instead makes a+λ come out ±s
  // for both legs: they lift by exactly the same amount, the dip takes it out,
  // and the man stands on both feet — square about the vertical in world,
  // which is what a leaning body's stance actually looks like.
  _aimLegs(id) {
    const o = (this._legs ??= { l: 0, r: 0, rock: 0 });
    const s = leadFoot(id) * AIM.stance;
    const p = this.sim.t * AIM.swayRate + bodyRnd(id) * 6.2832;
    // two periods that do not divide into each other, so a squad never falls
    // into step and no one body repeats on a short loop
    const rock = AIM.sway * Math.sin(p);
    const roll = AIM.swayRoll * Math.sin(p * 0.63 + 1.7 + bodyRnd(id) * 3.1);
    o.l = -AIM.lean + s + rock + roll; o.r = -AIM.lean - s + rock - roll; o.rock = rock;
    return o;
  }

  // ...and the drop that plants them (the same rule _gaitDip enforces for the
  // walk). Takes the real hip angles rather than assuming a fixed ±stance
  // split, because the weight shift above is always moving them: whatever the
  // legs are doing, the body rides by the LOWER sole's lift and that sole ends
  // up exactly on the plating.
  _aimDip(legLen, aL, aR, lean) {
    if (!aL && !aR) return 0;
    const cl = Math.cos(lean);
    return legLen * Math.min(cl - Math.cos(aL + lean), cl - Math.cos(aR + lean));
  }

  // ...and the fore/aft translation that stops the rock from SKATING him
  // across the deck. Turning both legs through `rock` walks the average sole
  // forward by L·sin(rock)·cos(stance); move the body back by exactly that and
  // the boots stay where they were planted (the two soles differ by under
  // half a millimetre, which is the whole of the residual scuff).
  _aimShift(legLen, aim, rock) {
    return -legLen * Math.sin(rock * aim) * Math.cos(AIM.stance * aim);
  }

  // The carry this body is actually holding: the relaxed low-ready, the
  // sighted presentation, or a point between the two while it swings up.
  // Both solves are per-model constants; only the interpolation is per-body.
  _holdFor(set, w) {
    if (!set.hold || !set.holdFire) return set.hold;
    if (w <= 0) return set.hold;
    if (w >= 1) return set.holdFire;
    const a = set.hold, b = set.holdFire;
    const o = (this._holdMix ??= {
      qR: new THREE.Quaternion(), qL: new THREE.Quaternion(), rifle: {},
    });
    o.qR.copy(a.qR).slerp(b.qR, w);
    o.qL.copy(a.qL).slerp(b.qL, w);
    const ar = a.rifle, br = b.rifle, r = o.rifle;
    r.fwd = ar.fwd + (br.fwd - ar.fwd) * w;
    r.y = ar.y + (br.y - ar.y) * w;
    r.right = ar.right + (br.right - ar.right) * w;
    r.yaw = ar.yaw + (br.yaw - ar.yaw) * w;
    r.pitch = ar.pitch + (br.pitch - ar.pitch) * w;
    r.sh = ar.sh;
    r.muzzleY = ar.muzzleY + (br.muzzleY - ar.muzzleY) * w;
    r.muzzleF = ar.muzzleF + (br.muzzleF - ar.muzzleF) * w;
    return o;
  }

  // dead-sprawl stamp for bodies lying flat: limbs splayed at deterministic
  // per-body angles instead of the bind-pose T (user: corpses read as
  // cardboard cutouts half-sunk in the deck). The swing plane IS the lying
  // plane once the base matrix pitches the body flat, so no angle can dig a
  // limb into the floor. `ease` grows the sprawl in as a downed body falls.
  _stampSprawl(set, i, id, ease = 1) {
    if (this._curD2 < CAST_NEAR2) this._castNear.add(set);
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      if (!pivot) { mesh.setMatrixAt(i, this._m); continue; }
      const part = mesh.userData.part;
      const k = part === 'armL' ? 0 : part === 'armR' ? 1 : part === 'legL' ? 2 : part === 'legR' ? 3 : 4;
      // TWO INDEPENDENT HASHES so a body's left and right don't mirror each
      // other — one arm can end up tucked under the ribs while the other is
      // thrown wide.
      const u = (Math.sin(id * 17.3 + k * 3.1) + 1) / 2;
      const v = (Math.sin(id * 5.77 + k * 9.4) + 1) / 2;
      // ADDUCTION about model X. With the body laid on its BACK (see the base
      // matrix) that axis points at the ceiling, so this sweep runs ACROSS the
      // plating and can never dig a limb in — and it is the ONLY axis that
      // closes the bind-pose T. The old Z sweep rotated in a vertical plane:
      // it slid outstretched arms forward and back but never brought them
      // down to the body, so every corpse kept its arms straight out (user:
      // "T posing posture still a problem").
      const ang = (part === 'armR' ? 0.35 + u * 0.95
        : part === 'armL' ? -(0.35 + v * 0.95)
        : part === 'legR' ? 0.08 + u * 0.34
        : part === 'legL' ? -(0.08 + v * 0.34)
        : (u - 0.5) * 0.5) * ease;
      // a little sway in the perpendicular plane so limbs aren't all coplanar
      this._eSpr ??= new THREE.Euler();
      this._eSpr.set(ang, 0, (u - 0.5) * (part === 'head' ? 0.3 : 0.5) * ease);
      this._mRot.makeRotationFromEuler(this._eSpr);
      this._mPart.makeTranslation(pivot[0], pivot[1], pivot[2])
        .multiply(this._mRot)
        .multiply(this._mOut.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this._mOut.multiplyMatrices(this._m, this._mPart);
      mesh.setMatrixAt(i, this._mOut);
    }
  }

  // write base × (pivot-anchored swing) into every part mesh of a set.
  // `hold` picks the solved carry (see solveCarry): the two arms stop being
  // animated at all and are simply placed on the weapon, and `bob` swings that
  // whole assembly — arms AND rifle together, about the shoulder line — so
  // nothing can shake the gun out of the hands.
  _stampAnimated(set, i, clip, animT, id, hold = null, bob = 0, panic = false, aim = 0,
    armsHighCharge = false) {
    if (this._curD2 < CAST_NEAR2) this._castNear.add(set);
    const arms = hold && clip !== CLIP.DEATH;
    if (arms && bob) {
      (this._qBob ??= new THREE.Quaternion()).setFromAxisAngle(AXIS_Z, bob);
      this._qArm ??= new THREE.Quaternion();
    }
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      const part = mesh.userData.part;
      if (!pivot || clip === CLIP.DEATH) { mesh.setMatrixAt(i, this._m); continue; }
      if (arms && (part === 'armL' || part === 'armR')) {
        const q = part === 'armR' ? hold.qR : hold.qL;
        if (bob) this._mRot.makeRotationFromQuaternion(this._qArm.copy(this._qBob).multiply(q));
        else this._mRot.makeRotationFromQuaternion(q);
      } else {
        let ang = this._swingFor(part, clip, animT, id, panic);
        // SIGHTED: chin tucked in behind the receiver and the feet bladed —
        // the ATTACK cycle underneath is a flood form's claw shuffle, which
        // twitched a rifleman's legs and bobbed his head off the sights.
        if (aim > 0) {
          if (part === 'head') ang += (AIM.head - ang) * aim;
          else if (part === 'legL' || part === 'legR') {
            const lg = this._aimLegs(id);
            ang += ((part === 'legL' ? lg.l : lg.r) - ang) * aim;
          }
        }
        // ARMS IN (user: "both hands outstretched", "still looks silly"): the
        // A-pose bind holds the hands ~43° off the body, so every unarmed
        // walker swung wide-splayed arms. Adduction about model X — the only
        // axis that closes that splay — brings them down beside the hips
        // while the Z swing still does the walking.
        const add = set.adduct && (part === 'armL' || part === 'armR')
          ? (part === 'armR' ? set.adduct : -set.adduct) : 0;
        if (!ang && !add) { mesh.setMatrixAt(i, this._m); continue; }
        const armsHigh = armsHighCharge && clip === CLIP.RUN
          && (set === this.combatCivSet || set === this.combatOdstSet)
          && (part === 'armL' || part === 'armR');
        const feral = clip === CLIP.ATTACK
          && (set === this.combatCivSet || set === this.combatOdstSet)
          && (part === 'armL' || part === 'armR');
        if (armsHigh) {
          const side = part === 'armR' ? 1 : -1;
          const phase = gaitPhase(clip, animT, id);
          const pose = combatChargeArmPose(side, phase, id,
            this._chargeArmPose ??= { x: 0, y: 0, z: 0 });
          // Halo CE elite-combat-form silhouette: a wide Y whose two rigid
          // arms wave independently instead of holding a symmetrical pose.
          (this._eHold ??= new THREE.Euler()).set(
            pose.x,
            pose.y,
            pose.z,
          );
          this._mRot.makeRotationFromEuler(this._eHold);
        } else if (feral) {
          const u = Math.max(0, Math.min(1, animT / 0.74));
          const side = part === 'armR' ? 1 : -1;
          const pose = combatAttackArmPose(side, u, id, ang,
            this._attackArmPose ??= { x: 0, y: 0, z: 0 });
          // Twist at both shoulder axes as well as the fore/aft hinge. The
          // helper keeps each rigid limb on its anatomical side throughout.
          (this._eHold ??= new THREE.Euler()).set(
            add + pose.x,
            pose.y,
            pose.z,
          );
          this._mRot.makeRotationFromEuler(this._eHold);
        } else if (add) {
          (this._eHold ??= new THREE.Euler()).set(add, 0, ang);
          this._mRot.makeRotationFromEuler(this._eHold);
        } else this._mRot.makeRotationZ(ang);
      }
      this._mPart.makeTranslation(pivot[0], pivot[1], pivot[2])
        .multiply(this._mRot)
        .multiply(this._mOut.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this._mOut.multiplyMatrices(this._m, this._mPart);
      mesh.setMatrixAt(i, this._mOut);
    }
  }

  // Where the barrel ENDS and where it POINTS, in the body's frame, after the
  // carry's bob and the body's lean have both swung it. The torch cone and the
  // weapon light hang off this, which is how the beam stays on the nozzle
  // through a stance change instead of drifting off it.
  _aimOf(cfg, bob, lean) {
    let f = cfg.muzzleF, y = cfg.muzzleY;
    if (bob) {   // about the shoulder line, exactly as _carryAt swings it
      const dy = y - cfg.sh, c = Math.cos(bob), s = Math.sin(bob);
      const nx = f * c - dy * s; y = cfg.sh + f * s + dy * c; f = nx;
    }
    if (lean) {  // ...and about the feet
      const c = Math.cos(lean), s = Math.sin(lean);
      const nx = f * c - y * s; y = f * s + y * c; f = nx;
    }
    const o = (this._aimOut ??= { f: 0, y: 0, yaw: 0, elev: 0 });
    // the bob moves the NOZZLE but is deliberately kept out of the AIM: it is
    // a breath, and at a 16 m throw 0.045 rad of it would slide the pool on the
    // wall by three quarters of a metre at walking cadence.
    o.f = f; o.y = y; o.yaw = cfg.yaw; o.elev = cfg.pitch + lean;
    return o;
  }

  // the breathing / walking sway of a shouldered weapon, shared by the arms
  // and the rifle so they move as one rigid carry
  _carryBob(clip, animT, id) {
    if (clip === CLIP.WALK || clip === CLIP.RUN) {
      return Math.sin(gaitPhase(clip, animT, id) * 2) * (clip === CLIP.RUN ? 0.075 : 0.045);
    }
    return Math.sin(animT * 0.9 + bodyRnd(id) * 6.28) * 0.022;   // breathing
  }

  // transient tracer for the player's own rifle
  playerShot(from, to) {
    this._playerShots.push({ ax: from.x, ay: from.y, az: from.z, bx: to.x, by: to.y, bz: to.z, ttl: 0.09 });
  }

  // RIFLE LIGHT (user: a weapon light that does REAL work, so a dark room is
  // genuinely brighter with your fireteam in it). The pool lives in main.js
  // and re-declares AFTER this runs, so collect into a recycled buffer here
  // and let the host drain it. Position is a couple of metres down the
  // barrel: a point source out in front throws like a torch without paying
  // for a second shadow-casting spot per marine.
  // WEAPON LIGHT THAT LANDS ON SOMETHING (user: "what is it reflecting off?
  // what is it illuminating? i dont see the direction of the wall hes looking
  // at illuminated. I want different illuminated spots coming from their
  // heading"). A point source floating 2.6 m off the muzzle lit the air in
  // front of the man and nothing else. Instead: march along his heading to
  // the first wall of the room he is standing in — pure rect maths against
  // the sim node, no raycast — and put the light just short of that surface.
  // That is the bright pool on the wall he is facing, and because every
  // marine faces somewhere different, a dark room fills with separate spots
  // that move as they cover their arcs.
  _addRifleLight(nodeIdx, sx, sy, deck, elev, hSim, muzzleY = 1.15, yaw = RIFLE_YAW, tilt = 0) {
    const [mwx, mwz] = this.world.simToWorld(sx, sy, deck);
    const ddx = mwx - (this.viewX ?? 0), ddz = mwz - (this.viewZ ?? 0);
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 > 1600) return;                       // 40 m — the pool scores the rest
    const nd = this.sim.graph.node(nodeIdx);
    // ALONG THE BARREL (user: "flashlights aligned with gun nozzles"). The
    // rifle is carried yawed across the body, so the body's heading points
    // somewhere the weapon does not.
    const gh = hSim - yaw;
    const hx = Math.cos(gh), hy = Math.sin(gh);
    const ox = sx + Math.cos(hSim) * 0.20 + hx * 0.55;   // muzzle
    const oy = sy + Math.sin(hSim) * 0.20 + hy * 0.55;
    // march to the first wall of the room he is standing in — rect maths, no
    // raycast — so the throw ends on a surface rather than in mid-air
    let t = 16;
    if (hx > 1e-4) t = Math.min(t, (nd.x + nd.w / 2 - ox) / hx);
    else if (hx < -1e-4) t = Math.min(t, (nd.x - nd.w / 2 - ox) / hx);
    if (hy > 1e-4) t = Math.min(t, (nd.y + nd.d / 2 - oy) / hy);
    else if (hy < -1e-4) t = Math.min(t, (nd.y - nd.d / 2 - oy) / hy);
    t = Math.max(1.4, t - 0.4);
    const [owx, owz] = this.world.simToWorld(ox, oy, deck);
    const [hwx, hwz] = this.world.simToWorld(ox + hx * t, oy + hy * t, deck);
    const r = this.rifleLights[this.rifleLightN]
      ?? (this.rifleLights[this.rifleLightN] = {});
    // origin + aim, so the host can drive a real SPOTLIGHT with it: a point
    // light at the wall is a round blob, and the user wants to see the beam's
    // footprint picking out what the man is actually looking at.
    // the carry solve reports where the barrel actually ends — the old
    // hardcoded 1.15 sat ~45 cm above it once the rifle came down to the hip
    // ...and the barrel's real ELEVATION drives the aim point, so the pool
    // rides up the wall when he sights and sits on the deck when he doesn't.
    // The host used to nose every beam down a flat 3 degrees to stand in for
    // this; `tilt` is the true angle and needs no compensating.
    // clamped so a long throw aims at the deck at worst, never under it
    const rise = Math.max(-muzzleY, Math.min(muzzleY + 1.5, Math.tan(tilt) * t));
    r.ox = owx; r.oy = elev + muzzleY; r.oz = owz;
    r.tx = hwx; r.ty = elev + muzzleY + rise; r.tz = hwz;
    r.throw = t; r.d2 = d2;
    this.rifleLightN++;
  }

  // is this room dark enough that an armed body would have its light on?
  // NOT just flood-darkness (user: "only the fireteam seems to have it") — a
  // room whose mains are dead is pitch black too, and every marine standing
  // in one was walking around with the lamp off.
  _needsLamp(nodeIdx) {
    return this.sim.darkAt(nodeIdx) || this.sim.graph.lightMode[nodeIdx] === 3;
  }

  // A JET OUT OF THE NOZZLE (FLAG.FLAMING — the sim's trigger, held only while
  // fuel is actually leaving the weapon). Two things are borrowed rather than
  // invented, and both matter:
  //   DIRECTION is the barrel's real world bearing and elevation, the same
  //     `_aimOf` vector the torch cone and the weapon light already ride, so
  //     the stream physically cannot point somewhere the weapon does not.
  //   LENGTH comes from the sim: graph.burnX/burnY is the exact spot the fuel
  //     is landing on, so the jet REACHES what it is setting alight and the
  //     fire that appears there is the end of this stream, not a coincidence.
  // The host drains these into a FlameJetFX (engine/fx.js).
  _noteFlameJet(nodeIdx, wx, gy, wz, heading, cfg, mz, deck, id) {
    const rotY = heading + mz.yaw;                 // down the barrel, like the beam
    const ce = Math.cos(mz.elev);
    const dx = Math.cos(rotY) * ce, dy = Math.sin(mz.elev), dz = -Math.sin(rotY) * ce;
    const fx = Math.cos(heading), fz = -Math.sin(heading);
    // the carry solve measured its muzzle against the MA5's tip; the igniter
    // ring stands a little proud of that, so push the origin the difference
    const over = FLAMER_MUZZLE.z - RIFLE_TIP;
    const ox = wx + fx * mz.f - fz * cfg.right + dx * over;
    const oy = gy + mz.y + dy * over;
    const oz = wz + fz * mz.f + fx * cfg.right + dz * over;
    let len = 5.0;
    const g = this.sim.graph;
    const live = this.sim.byId.get(id);
    const aimDeck = live?.flameAimDeck ?? deck;
    if (live?.flameAimX !== undefined && (live.flamingT ?? -Infinity) >= this.sim.t - this.sim.dt * 1.5) {
      const [bwx, bwz] = this.world.simToWorld(live.flameAimX, live.flameAimY, aimDeck);
      // ...over-reached by the fraction of the card the flame burns out before
      // (the shader spends the fuel by ~0.85 of the quad), so the VISIBLE end
      // of the stream lands on the fire instead of a metre short of it
      len = Math.hypot(bwx - ox, bwz - oz) / 0.85;
    } else if (g.burningUntil[nodeIdx] > this.sim.t) {
      const [bwx, bwz] = this.world.simToWorld(g.burnX[nodeIdx], g.burnY[nodeIdx], deck);
      len = Math.hypot(bwx - ox, bwz - oz) / 0.85;
    }
    const r = this.flameJets[this.flameJetN] ?? (this.flameJets[this.flameJetN] = {});
    r.ox = ox; r.oy = oy; r.oz = oz; r.deck = deck;
    r.dx = dx; r.dy = dy; r.dz = dz;
    // a stream has a range whatever it is pointed at: too short and it reads as
    // a blowtorch, too long and it is a laser
    r.len = Math.max(2.2, Math.min(this.sim.P.flamethrower.rangeM, len));
    r.seed = id;
    this.flameJetN++;
  }

  update(dt) {
    const { sim, world } = this;
    const buf = sim.buffer;
    this.rifleLightN = 0;
    this.flameJetN = 0;
    // First frame: everything already dead is PRE-PLACED (the event/breach
    // corpses seeded at t=0) — mark it so it lies where it was authored instead
    // of every corpse on the ship flopping the instant the game loads. Only
    // deaths that happen DURING play ragdoll.
    if (this.ragdolls && !this._ragPrimed) {
      this._ragPrimed = true;
      for (let j = 0; j < buf.count; j++) {
        if (buf.faction[j] === FACTION.CORPSE || (buf.flags[j] & FLAG.DOWNED)) this._ragSeen.add(buf.id[j]);
      }
    }
    // advance the flops (fixed sub-step inside; asleep bodies are frozen)
    if (this.ragdolls) this.ragdolls.step(dt);
    // CULL RADIUS TRACKS THE FOG (perf pass 5). scene.fog.far collapses to
    // ~34 m in flood dark and ~11 m in spore fog — the frames where the
    // machine is already drowning — so a fixed 62 m posed and stamped its
    // biggest crowd at the worst possible moment.
    const far = this.scene?.fog?.far;
    const cullR = Math.max(14, Math.min(62, (far ?? 62) + 6));
    this._cullD2 = cullR * cullR;
    // age recent blasts (a death registers a frame or two after the boom)
    if (this._blasts.length) this._blasts = this._blasts.filter((b) => (b.ttl -= dt) > 0);
    const k = Math.min(1, dt * 14);
    // pooled and zeroed rather than rebuilt: this runs every frame
    const counts = (this._counts ??= { civ: 0, armed: 0, marine: 0, infection: 0, combatCiv: 0, combatOdst: 0, carrier: 0, corpse: 0, rifle: 0, flamer: 0, flash: 0, beam: 0 });
    for (const key in counts) counts[key] = 0;
    let clip = 0, animT = 0, curId = 0, curPanic = false, curBob = 0, curAim = 0;
    const stamp = (set, i, armsHighCharge = false) => this._stampAnimated(
      set, i, clip, animT, curId, null, 0, curPanic, 0, armsHighCharge,
    );
    // rifle carriers: arms placed on the solved carry, not swung
    const stampHold = (set, i) => this._stampAnimated(set, i, clip, animT, curId,
      this._holdFor(set, curAim), curBob, curPanic, curAim);

    const seen = this._seen;
    seen.clear();
    // per-frame per-set "any instance near enough to cast into the torch cone"
    (this._castNear ??= new Set()).clear();
    this._curD2 = 0; // stays 0 (always cast) until the camera position is known
    this._emergeAt ??= new Map();
    this._hiddenPrev ??= new Set();
    const hiddenNow = (this._hiddenNow ??= new Set());
    hiddenNow.clear();
    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      seen.add(id);
      const deck = buf.posZ[i]; // sim writes deck into posZ
      const hidden = (buf.flags[i] & (FLAG.EXPOSED | FLAG.IN_SHAFT)) !== 0;
      if (hidden) hiddenNow.add(id);
      let rp = this.rpos.get(id);
      // EMERGE AT A MARKED OPENING (user: combat forms teleported into the
      // middle of the last-stand hallway). A body that arrives on a deck —
      // out of a hidden duct/shaft transit, or any cross-deck hop — surfaces
      // AT the nearest vent grate / shaft hatch / ladder in its room and
      // rises out of it, instead of popping in at its sim position.
      const emerged = !hidden && this._hiddenPrev.has(id);
      if (!rp || rp.deck !== deck || emerged) {
        let sx = buf.posX[i], sy = buf.posY[i];
        let snap = emerged;
        if (!snap && rp && rp.deck !== deck) {
          // a cross-deck hop with a world-space position JUMP is a ladder or
          // shaft arrival → snap to a mouth. A continuous crossing (walking
          // the grand stairwell — same footprint, deck label flips) is not.
          const [owx, owz] = this.world.simToWorld(rp.x, rp.y, rp.deck);
          const [nwx, nwz] = this.world.simToWorld(sx, sy, deck);
          snap = Math.hypot(nwx - owx, nwz - owz) > 3.5;
        }
        if (snap && buf.faction[i] !== FACTION.CORPSE) {
          const m = this.world.mouthNear(buf.nodeId[i], sx, sy);
          if (m) {
            sx = m.x; sy = m.y;
            // only a real OPENING gets the climb-out rise — a stairwell-kiosk
            // pad arrival steps out at floor level (user: marines sprang out
            // of solid deck at the stair pads)
            //
            // WHICH WAY DID IT COME? (user: flood arriving from the deck above
            // "still has them coming out from the bottom of the hole".) The
            // crawl-out was hard-coded to rise out of the floor, so a body
            // descending a ladder played the climbing-UP animation. elevOf is
            // (5 - deck) * DECK_H, so a LOWER deck number is HIGHER in the
            // ship: arriving on deck D from deck F < D means it came down
            // through the ceiling and has to descend, not surface.
            if (m.kind !== 'pad') {
              this._emergeAt.set(id, { t: performance.now(), down: rp ? rp.deck < deck : false });
            }
          }
        }
        rp = { x: sx, y: sy, deck, hoverY: buf.hoverY[i] || 0 };
        this.rpos.set(id, rp);
      } else {
        rp.x += (buf.posX[i] - rp.x) * k; rp.y += (buf.posY[i] - rp.y) * k;
        rp.hoverY = (rp.hoverY || 0) + ((buf.hoverY[i] || 0) - (rp.hoverY || 0)) * k;
      }
    }
    // swap hidden sets (allocation-free)
    { const t = this._hiddenPrev; this._hiddenPrev = hiddenNow; this._hiddenNow = t; }
    if (this.rpos.size > buf.count * 2) {
      for (const id of this.rpos.keys()) if (!seen.has(id)) this.rpos.delete(id);
    }
    if (this._aimW && this._aimW.size > buf.count * 2) {
      for (const id of this._aimW.keys()) if (!seen.has(id)) this._aimW.delete(id);
    }
    // PIXEL-LOCK a seated burrower onto the body it's converting/raising (user:
    // form, corpse and the combat form that rises must be ONE spot). The sim
    // clamps them together; snap the render position past the ease-in lag so the
    // form never slides across or floats off the body while it burrows.
    for (const a of sim.agents) {
      if (a.dead || !a.task || a.taskProgress <= 0) continue;
      if (a.task.kind !== TASK.CONVERT && a.task.kind !== TASK.REANIMATE) continue;
      const body = sim.byId.get(a.task.corpseId ?? a.task.targetId);
      if (!body || body.dead) continue;
      const rp = this.rpos.get(a.id), bp = this.rpos.get(body.id);
      // ...and lock onto the corpse's VISIBLE resting spot when it flopped
      // away from its sim anchor (review F4: with the 12 cm seat the pod was
      // digging into bare deck a metre from the drawn body)
      const rest = this._ragRest.get(body.id);
      if (rest) {
        const [sx2, sy2] = this.world.worldToSim(rest[0], rest[2], body.deck);
        if (rp && rp.deck === body.deck) { rp.x = sx2; rp.y = sy2; }
      } else if (rp && rp.deck === body.deck) { rp.x = body.x; rp.y = body.y; }
      if (bp && bp.deck === body.deck) { bp.x = body.x; bp.y = body.y; }
    }

    // deck-scoped stamping (perf, user: don't render the whole ship): a body
    // two opaque decks away cannot be seen — don't animate or stamp it
    const playerDeck = sim.byId.get(this.playerId)?.deck ?? 3;
    for (let i = 0; i < buf.count; i++) {
      const id = buf.id[i];
      if (id === this.playerId) continue; // first person — don't draw your own body
      const f = buf.faction[i];
      const flags = buf.flags[i];
      // inside the ductwork: a form transiting a vent is genuinely out of
      // sight — don't render a body standing in the room it left
      // inside the ductwork — vent OR maintenance shaft — nobody can see it.
      // (Un-hidden shaft movers ghosted through walls at the wrong deck and
      // then teleported — user report at Maintenance Aft.)
      if (flags & (FLAG.EXPOSED | FLAG.IN_SHAFT)) continue;
      clip = buf.animClip[i];
      animT = buf.animTime[i];
      curId = id;
      curPanic = (flags & FLAG.PANICKED) !== 0;
      curBob = this._carryBob(clip, animT, id);
      curAim = 0;
      const rp = this.rpos.get(id);
      const deck = rp.deck;
      if (Math.abs(deck - playerDeck) > 1) continue; // invisible through opaque decks
      // beyond scene.fog.far (max 60m) fog is FULLY opaque — a body 62m out
      // is pixel-for-pixel invisible; skip its pose math and stamping
      if (this.viewX !== undefined) {
        const [ax, az] = world.simToWorld(rp.x, rp.y, deck);
        const vdx = ax - this.viewX, vdz = az - this.viewZ;
        this._curD2 = vdx * vdx + vdz * vdz;
        // CULL AT THE FOG WALL, NOT A FIXED 62 m (perf pass 5). scene.fog.far
        // collapses to ~34 m in flood dark and ~11 m in spore fog, and those
        // are exactly the moments the frame is already drowning — so the old
        // constant posed and stamped its largest crowd at the worst possible
        // time. Nothing past the fog can be seen by definition.
        if (this._curD2 > this._cullD2) continue;
        // ...and nothing BEHIND you can be seen either. The instanced sets are
        // frustumCulled=false, so every stamped body is submitted whatever the
        // camera is doing; a generous half-space test (cos ~ -0.35, well wider
        // than the 72 deg fov) drops ~40% of them with no popping at the edge.
        if (this._viewFX !== undefined && this._curD2 > 9) {
          const inv = 1 / Math.sqrt(this._curD2);
          if ((vdx * inv) * this._viewFX + (vdz * inv) * this._viewFZ < -0.35) continue;
        }
      }
      let [wx, wz] = world.simToWorld(rp.x, rp.y, deck);
      // a body whose sim transit crosses the enclosed stair housing at
      // hangar level renders pushed out through the nearest face instead
      // of walking through its walls (user report)
      [wx, wz] = world.clampStairTower(deck, wx, wz);
      // and one crossing the GRAND stair well at entry level slides around
      // the balustrade instead of through it (user: NPCs clopped through the
      // railings onto the flights) — unless it is genuinely on the stairwell
      // edge descending, which is the one legal way into the well footprint
      const simAg = sim.byId.get(id);
      if (simAg?.move?.link?.type !== 'stairwell') {
        [wx, wz] = world.clampStairWell(deck, wx, wz);
      }
      // feet on the ground surface — in a stairwell room that follows the
      // mezzanine/ramp/hall, so bodies walk the stairs instead of floating
      // at one deck level (user: navigable stairwell room)
      let elev = world.groundHeightAt(deck, wx, wz);
      const heading = -buf.headingR[i];

      if (f === FACTION.CORPSE) {
        // a fresh kill flops via physics (_ragdollBody handles the burned/capped
        // cases internally and returns false to hand back here).
        if (this._ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts)) continue;
        // Legacy static render. Anchor at the ragdoll's settled spot if it
        // flopped (burned/cap-evicted after settling), so it doesn't snap back
        // to the sim node; otherwise the sim position (ragdoll off, or a
        // dragged/relocated body the drift-guard handed back to follow the sim).
        const rest = this._ragRest.get(id);
        const bx = rest ? rest[0] : wx, bz = rest ? rest[2] : wz;
        const bElev = rest ? world.groundHeightAt(deck, bx, bz) : elev;
        const lieAng = (id * 2.399963) % (Math.PI * 2);
        if (flags & FLAG.BURNED) {
          // charred husk — a blackened low mass, no body left to speak of
          this._e.set(0, lieAng, 0);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(bx, bElev + 0.1, bz), this._q, this._s.set(1, 0.55, 1));
          this.corpse.setMatrixAt(counts.corpse++, this._m);
        } else {
          // a REAL body lying where it fell (user note: render bodies
          // appropriately, not grey boxes) — laid flat WITH a per-body limb
          // sprawl (user: the bind-pose T read as a cardboard cutout), resting
          // ON the plating instead of sunk into it. The armed dead keep
          // their rifle beside them, so the scavenge prompt points at
          // something you can see.
          // ON ITS BACK, not its side. Rx(-90) put the model's LATERAL axis
          // vertical, so a bind-pose T threw one arm at the ceiling and drove
          // the other through the deck. Rz(+90) stands the chest up instead:
          // the body lies face-up, both arms rest in the floor plane, and the
          // sprawl above can tuck them.
          this._e.set(0, lieAng, Math.PI / 2);
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(bx, bElev + 0.16, bz), this._q, this._s.set(1, 1, 1));
          if (flags & FLAG.ARMED_HOST) {
            this._stampSprawl(this.armedSet, counts.armed++, id);
            this._rifleAt(bx + Math.cos(lieAng + 1.2) * 0.55, bElev + 0.12,
              bz + Math.sin(lieAng + 1.2) * 0.55, lieAng * 1.7);
            this.rifle.setMatrixAt(counts.rifle++, this._m);
          } else {
            this._stampSprawl(this.civSet, counts.civ++, id);
          }
        }
        continue;
      }
      // HALO-3 THRASH (user: the thrashing body IS a combat form already —
      // counts, health, effects). A transforming form renders as a body
      // convulsing under real physics: force a ragdoll up and beat it with
      // crescendo impulses (_ragdollBody). When the flag clears, the SAME id
      // falls through to the ordinary render below, where the existing
      // ragdoll-rise telegraph plays the 0.85 s stand-up out of the settled
      // pose — position slide and orientation slerp both come free.
      if (f === FACTION.COMBAT && (flags & FLAG.THRASHING)) {
        if (!(this._thrashInfo ??= new Map()).has(id)) this._thrashInfo.set(id, { t0: performance.now(), last: 0 });
        if (this._ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts, true)) continue;
        // fallback (ragdoll off or at cap): a violent arch-and-roll on the
        // flat body so the transformation still reads
        const tn = performance.now();
        const arch = Math.abs(Math.sin(tn * 0.012 + id)) * 0.16;
        const wob = Math.sin(tn * 0.017 + id * 1.7) * 0.35;
        this._e.set(wob * 0.6, heading + wob, Math.PI / 2);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(wx, elev + 0.16 + arch, wz), this._q, this._s.set(1, 1, 1));
        if (flags & FLAG.ARMED_HOST) this._stampSprawl(this.combatOdstSet, counts.combatOdst++, id);
        else this._stampSprawl(this.combatCivSet, counts.combatCiv++, id);
        continue;
      } else if (this._thrashInfo?.has(id)) this._thrashInfo.delete(id);
      const downed = flags & FLAG.DOWNED;
      if (downed) { // downed combat forms FALL, then lie flat (death blend)
        // a fresh down flops via physics (_ragdollBody handles burned/capped
        // internally and returns false to hand back here).
        if (this._ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts)) continue;
        // Legacy rotate-flat blend. If the body already flopped (it carries a
        // rest anchor or the _ragSeen mark), it is ALREADY lying flat — seed the
        // fall as long-complete so it renders flat at the settled spot instead
        // of snapping upright and re-falling. A genuinely fresh down (ragdoll
        // disabled) still falls from upright, unchanged.
        const rest = this._ragRest.get(id);
        const flopped = rest || this._ragSeen.has(id);
        let fell = this._downAt.get(id);
        if (fell === undefined) { fell = performance.now() - (flopped ? 380 : 0); this._downAt.set(id, fell); }
        const p = Math.min(1, (performance.now() - fell) / 380);
        const ease = 1 - (1 - p) * (1 - p);
        const bx = rest ? rest[0] : wx, bz = rest ? rest[2] : wz;
        const bElev = rest ? world.groundHeightAt(deck, bx, bz) : elev;
        // falls ONTO ITS BACK (same axis the settled corpse lies on, so the
        // blend lands exactly where the static render expects it)
        this._e.set(0, heading, (Math.PI / 2) * ease);
        this._q.setFromEuler(this._e);
        this._m.compose(this._p.set(bx, bElev + 0.16 * ease, bz), this._q, this._s.set(1, 1, 1));
        // sprawl grows in as it falls — flat is a settled sprawl, not a T
        if (flags & FLAG.ARMED_HOST) this._stampSprawl(this.combatOdstSet, counts.combatOdst++, id, ease);
        else this._stampSprawl(this.combatCivSet, counts.combatCiv++, id, ease);
        continue;
      }
      // REVIVE TELEGRAPH (user note: forms "getting back up just happen
      // suddenly, seems like a bug"): a form that was down last frame RISES
      // through a reverse of its death fall, with a shudder — 0.85 s of
      // clearly-readable "it's getting back up"
      if (this._downAt.has(id) || this.ragdolls?.has(id)) {
        this._downAt.delete(id);
        // a form getting back up drops its ragdoll and plays the reverse-fall
        // telegraph. Capture WHERE it was lying (the ragdoll's settled spot, or
        // the last rest anchor) so the rise SLIDES back to the sim node over the
        // 0.85 s instead of teleporting to it on frame one. Clearing _ragSeen
        // lets it flop again if it re-dies.
        const rag = this.ragdolls?.get(id);
        const rest = rag ? [rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]] : this._ragRest.get(id);
        // also capture the settled ORIENTATION so the rise slerps out of the
        // exact pose the body was lying in (no face-up→prone flip on frame one)
        const fromQuat = rag ? [rag.rootQuat[0], rag.rootQuat[1], rag.rootQuat[2], rag.rootQuat[3]] : null;
        if (rag) this.ragdolls.remove(id);
        this._ragSeen.delete(id);
        this._ragRest.delete(id);
        (this._riseAt ??= new Map()).set(id, { t0: performance.now(), from: rest || null, fromQuat });
      }
      let rise = 0;
      const riseEntry = this._riseAt?.get(id);
      if (riseEntry !== undefined) {
        const p = Math.min(1, (performance.now() - riseEntry.t0) / 850);
        if (p >= 1) this._riseAt.delete(id);
        else {
          const ease = p * p * (3 - 2 * p);
          // POSITIVE: it fell onto its BACK (+PI/2 in the downed blend above),
          // so it has to come up off its back too — the old negative sign
          // raised it out of a face-down pose it was never in.
          rise = Math.PI / 2 * (1 - ease) + Math.sin(performance.now() * 0.05 + id) * 0.07 * (1 - p);
        }
      }
      // FLINCH (hit feedback): a freshly-hurt body jerks — backwards, off the
      // shot, in its own frame (see _pose on the axis this now uses)
      const flinch = (flags & FLAG.FLINCH ? Math.sin(performance.now() * 0.06 + id) * 0.09 + 0.14 : 0)
        + rise + this._leanFor(clip, animT, id);

      // CRAWL-OUT (user: deck arrivals must surface at the opening): a body
      // snapped to a grate/hatch mouth starts sunk into the deck and climbs
      // out over ~0.7s — the floor slab hides the sunk part, so it reads as
      // hauling itself out of the ductwork.
      {
        const em = this._emergeAt.get(id);
        if (em !== undefined) {
          // a descent covers more ground than a climb-out and should not look
          // like a plummet, so it gets its own span and a longer window
          const span = em.down ? Math.min(2.6, clearHeightOf(sim.graph.node(buf.nodeId[i])) - 0.4) : 1.35;
          const p = (performance.now() - em.t) / (em.down ? 900 : 700);
          if (p >= 1) this._emergeAt.delete(id);
          else {
            const es = p * p * (3 - 2 * p);
            // down: start at the ceiling opening and come through it.
            // up: start sunk under the deck, where the floor slab hides it.
            elev += (1 - es) * span * (em.down ? 1 : -1);
          }
        }
      }

      // FEET ON THE DECK: drop the body by the lift its planted foot would
      // otherwise have (see _gaitDip). This is also the walk's vertical bob.
      switch (f) {
        case FACTION.CIVILIAN: {
          this._pose(wx, elev - this._gaitDip(clip, animT, id, this.civSet.rig.legLen),
            wz, heading, 1, 1, 1, flinch);
          stamp(this.civSet, counts.civ++);
          break;
        }
        case FACTION.ARMED: {
          // Players are ARMED in the sim because their health/loadout follows
          // crew rules. Their selected body is render-only: male uses the
          // helmeted marine rig, female keeps the armed-crew rig.
          const malePlayer = (flags & FLAG.MALE_PLAYER) !== 0;
          const set = malePlayer ? this.marineSet : this.armedSet;
          // ENGAGED OR NOT (user: "obviously need marines leaning in and
          // sighting their guns"). _clipFor turns STATE.FIGHT/GRABBING into
          // CLIP.ATTACK, so for a rifle carrier the clip IS the engagement
          // flag. Eased, not switched: the weapon comes UP over ~0.2 s.
          curAim = this._aimBlend(id, clip === CLIP.ATTACK, dt);
          const aimLean = this._aimLean(curAim);
          const lean = flinch + aimLean;
          // the slow weight shift, and the fore/aft translation that keeps his
          // boots where he planted them while he rocks over them
          const lg = curAim > 0 ? this._aimLegs(id) : null;
          const gy = elev - this._gaitDip(clip, animT, id, set.rig.legLen)
            - (lg ? this._aimDip(set.rig.legLen, lg.l * curAim, lg.r * curAim, aimLean) : 0);
          const sh = lg ? this._aimShift(set.rig.legLen, curAim, lg.rock) : 0;
          const bx = wx + Math.cos(heading) * sh, bz = wz - Math.sin(heading) * sh;
          this._pose(bx, gy, bz, heading, 1, 1, 1, lean);
          const slot = malePlayer ? counts.marine++ : counts.armed++;
          stampHold(set, slot);
          if (malePlayer) this._tintSlot(set, slot, 1);
          const carry = this._holdFor(set, curAim);
          this._carryAt(bx, gy, bz, heading, carry.rifle, curBob, lean);
          // the flamethrower rides the SAME solve — only the mesh differs
          if (flags & FLAG.FLAMER) this.flamer.setMatrixAt(counts.flamer++, this._m);
          else this.rifle.setMatrixAt(counts.rifle++, this._m);
          // bx/bz, not wx/wz: the aim sway rocks the body over its planted
          // boots, and the jet has to leave the nozzle where the nozzle IS
          if (flags & FLAG.FLAMING) this._noteFlameJet(buf.nodeId[i], bx, gy, bz, heading,
            carry.rifle, this._aimOf(carry.rifle, curBob, lean), deck, id);
          if (this._needsLamp(buf.nodeId[i])) {
            // out of the NOZZLE, not the sternum (user: "flashlights aligned
            // with gun nozzles") — and down the barrel's REAL bearing and
            // elevation once the lean and the bob have swung it
            const mz = this._aimOf(carry.rifle, curBob, lean);
            if (sim.fogAt(buf.nodeId[i])) { // only fog gives the shaft something to scatter off
              this._beamAt(bx, gy + mz.y, bz, heading, mz.yaw, mz.elev);
              this.beams.setMatrixAt(counts.beam++, this._m);
            }
            this._addRifleLight(buf.nodeId[i], buf.posX[i], buf.posY[i], deck, elev, -heading,
              mz.y, mz.yaw, mz.elev);
          }
          break;
        }
        case FACTION.MARINE: {
          const set = this.marineSet;
          curAim = this._aimBlend(id, clip === CLIP.ATTACK, dt);
          const aimLean = this._aimLean(curAim);
          const lean = flinch + aimLean;
          const lg = curAim > 0 ? this._aimLegs(id) : null;
          const gy = elev - this._gaitDip(clip, animT, id, set.rig.legLen)
            - (lg ? this._aimDip(set.rig.legLen, lg.l * curAim, lg.r * curAim, aimLean) : 0);
          const sh = lg ? this._aimShift(set.rig.legLen, curAim, lg.rock) : 0;
          const bx = wx + Math.cos(heading) * sh, bz = wz - Math.sin(heading) * sh;
          this._pose(bx, gy, bz, heading, 1, 1, 1, lean);
          const slot = counts.marine++;
          stampHold(set, slot);
          this._tintSlot(set, slot, (flags & FLAG.ODST) ? 1 : 0);
          const carry = this._holdFor(set, curAim);
          this._carryAt(bx, gy, bz, heading, carry.rifle, curBob, lean);
          if (flags & FLAG.FLAMER) this.flamer.setMatrixAt(counts.flamer++, this._m);
          else this.rifle.setMatrixAt(counts.rifle++, this._m);
          if (flags & FLAG.FLAMING) this._noteFlameJet(buf.nodeId[i], bx, gy, bz, heading,
            carry.rifle, this._aimOf(carry.rifle, curBob, lean), deck, id);
          if (this._needsLamp(buf.nodeId[i])) {
            const mz = this._aimOf(carry.rifle, curBob, lean);
            if (sim.fogAt(buf.nodeId[i])) {
              this._beamAt(bx, gy + mz.y, bz, heading, mz.yaw, mz.elev);
              this.beams.setMatrixAt(counts.beam++, this._m);
            }
            this._addRifleLight(buf.nodeId[i], buf.posX[i], buf.posY[i], deck, elev, -heading,
              mz.y, mz.yaw, mz.elev);
          }
          break;
        }
        case FACTION.INFECTION: {
          const pulse = 1 + Math.sin(this.sim.t * 7 + id) * 0.15;
          // POUNCE: a pod that has committed its 2 m hop (sim combat.pounce)
          // rides the arc off the deck. This case used to plant every pod on
          // the floor unconditionally — hoverY was only read by the combat
          // form's branch — so an infection form mid-pounce skated the hop
          // flat instead of flying it. (The gait dip is the run's footfall
          // bob; there are no feet on the plating to bob against in the air.)
          // ...and OFF THE DECK is a threshold, not `!== 0`. rp.hoverY is an
          // exponential ease (k = dt*14) toward the sim's value, so after a
          // landing it approaches zero and never arrives: from a 0.8 m apex at
          // 60 fps it takes 2,798 frames — 47 s — to reach a denormal, and it
          // can stall there outright (h - h*k rounds back to h). For that whole
          // window a truthy test read as "airborne", so the pod rode an epsilon
          // offset with its footfall bob switched off. A millimetre is under
          // the render's own precision; the threshold clears in 26 frames.
          const hover = rp.hoverY > 1e-3 ? rp.hoverY : 0;
          // HALO-3 BURROW (user): a pod seated on a corpse digs IN — it sinks
          // into the chest over the burrow window with an accelerating
          // wriggle, the writhe clip doing the leg-work. The floor of the
          // sink is the corpse itself, so it reads as disappearing into the
          // body, and the sim removes the pod the instant it's fully in.
          let sink = 0, dx2 = 0, dz2 = 0;
          if (flags & FLAG.BURROWING) {
            const bt = (this._burrowAt ??= new Map());
            let t0 = bt.get(id);
            if (t0 === undefined) { t0 = performance.now(); bt.set(id, t0); }
            const p = Math.min(1, (performance.now() - t0) / (this.sim.P.combat.burrowSec * 1000));
            sink = p * p * 0.5;
            const wig = 0.05 * (1 - p * 0.5);
            dx2 = Math.sin(performance.now() * 0.045 + id) * wig;
            dz2 = Math.cos(performance.now() * 0.039 + id * 1.7) * wig;
          } else this._burrowAt?.delete(id);
          this._pose(wx + dx2, elev + hover - sink - (hover || sink ? 0 : this._gaitDip(clip, animT, id, this.infectionSet.rig.legLen)),
            wz + dz2, heading, pulse, pulse, pulse, flinch);
          stamp(this.infectionSet, counts.infection++);
          break;
        }
        case FACTION.COMBAT: {
          const charging = flags & FLAG.CHARGING;
          const armsHighCharge = charging && (flags & FLAG.ARMS_HIGH);
          const leaping = flags & FLAG.LEAPING;
          // thresholded for the same reason as the infection case above: the
          // eased hoverY decays toward zero without reaching it, so a truthy
          // test suppressed this form's gait dip for the rest of the run after
          // its first leap.
          const hover = rp.hoverY > 1e-3 ? rp.hoverY : 0;
          // a reviving form slides from where its ragdoll settled back to the
          // sim node over the rise telegraph, so it reads continuous instead of
          // teleporting on frame one. (from is null for a normal combat form.)
          let bx = wx, by = elev + hover, bz = wz;
          if (riseEntry && riseEntry.from) {
            const e2 = Math.min(1, (performance.now() - riseEntry.t0) / 850);
            const es = e2 * e2 * (3 - 2 * e2);
            bx = riseEntry.from[0] + (wx - riseEntry.from[0]) * es;
            bz = riseEntry.from[2] + (wz - riseEntry.from[2]) * es;
            by = riseEntry.from[1] + ((elev + hover) - riseEntry.from[1]) * es;
          }
          if (!hover) by -= this._gaitDip(clip, animT, id, this.combatCivSet.rig.legLen);
          // charge: lean hard forward, stretched stride; a leap tucks and
          // stretches further and rides the arc up off the floor.
          // NEGATIVE, AND IN THE BODY FRAME (see _pose): written into the
          // euler's X slot this was a rotation about the WORLD x-axis applied
          // before the heading, so a form running along world +X did not lean
          // at all — it ROLLED, and one running along world +Z pitched. Every
          // charging form was toppling sideways in the render grid.
          let attackPitch = 0, attackYaw = 0, attackRoll = 0;
          if (clip === CLIP.ATTACK) {
            const u = Math.max(0, Math.min(1, animT / 0.74));
            const envelope = Math.sin(u * Math.PI);
            attackPitch = -0.28 * envelope;
            attackYaw = Math.sin(u * Math.PI * 3.2) * 0.34 * envelope;
            attackRoll = Math.sin(u * Math.PI * 4.4 + id) * 0.22 * envelope;
          }
          this._e.set(attackRoll, heading + attackYaw,
            -(leaping ? 0.55 : charging ? 0.42 : 0.14) + flinch + attackPitch);
          this._q.setFromEuler(this._e);
          // a reviving form slerps out of its settled ragdoll orientation into
          // the rising pose, so there is no orientation snap to pair with the
          // (already-continuous) position slide
          if (riseEntry && riseEntry.fromQuat) {
            const e2 = Math.min(1, (performance.now() - riseEntry.t0) / 850);
            const es = e2 * e2 * (3 - 2 * e2);
            this._q2.set(riseEntry.fromQuat[0], riseEntry.fromQuat[1], riseEntry.fromQuat[2], riseEntry.fromQuat[3]);
            this._q2.slerp(this._q, es);
            this._q.copy(this._q2);
          }
          this._m.compose(this._p.set(bx, by, bz), this._q,
            // MODEST STRETCH (user: "body clipping still looks silly"): the old
            // 1.35-1.5x elongation threw limbs far outside the body radius the
            // sim clamps to, so charging forms speared through walls and each
            // other. Enough lean to read as a sprint, not enough to escape the
            // collision the sim actually enforces.
            this._s.set(1, leaping ? 1.08 : charging ? 1.05 : 1, leaping ? 1.18 : charging ? 1.12 : 1));
          if (flags & FLAG.ARMED_HOST) {
            stamp(this.combatOdstSet, counts.combatOdst++, armsHighCharge);
            // The stolen rifle is composed IN THE BODY'S FRAME (bx/bz, and the
            // body quaternion) so it leans, rises and slides with the form —
            // it used to hang plumb at a fixed world height while a charging
            // form pitched forward out from under it.
            (this._v ??= new THREE.Vector3()).set(0.26, 1.04, 0.16).applyQuaternion(this._q);
            this._e.set(0, RIFLE_YAW, -0.18);
            this._q2.setFromEuler(this._e).premultiply(this._q);
            this._m.compose(this._p.set(bx + this._v.x, by + this._v.y, bz + this._v.z),
              this._q2, this._s.set(1, 1, 1));
            this.rifle.setMatrixAt(counts.rifle++, this._m);
          } else {
            stamp(this.combatCivSet, counts.combatCiv++, armsHighCharge);
          }
          break;
        }
        case FACTION.CARRIER: {
          const held = sim.byId.get(id)?.held ?? 0;
          const load = Math.min(1, held / sim.P.carrier.maxInfectionForms);
          let anim = this._carrierAnims.get(id);
          if (!anim) this._carrierAnims.set(id, anim = new CarrierAnimator(id));
          // CLIP FROM SIM STATE: a carrier past the seek threshold is fit to
          // burst, so it strains wherever it is — rooted it convulses in
          // place, moving it hurries. Below that it incubates and waddles.
          const ripe = load >= sim.P.carrier.seekOrExplodeFraction;
          const moving = clip === CLIP.WALK || clip === CLIP.RUN;
          anim.play(moving ? (ripe ? 'run' : 'walk') : (ripe ? 'strain' : 'idle'));
          anim.advance(dt);
          // the load reads as the SACK filling, not as a bigger animal — the
          // old primitive scaled the whole body 0.8x to 1.5x and grew its feet
          anim.write(this.carrierAnim, counts.carrier, load * SACK_BLOAT_M);
          const s = 0.94 + load * 0.1;
          this._pose(wx, elev, wz, heading, s, s, s, flinch);
          this._carrierLast.set(id, [wx, elev, wz, heading, load]);
          if (this._curD2 < CAST_NEAR2) this._castNear.add(this.carrier);
          this.carrier.setMatrixAt(counts.carrier++, this._m);
          break;
        }
      }
    }

    // drop ragdolls for bodies the sim has removed (burned to nothing,
    // converted, dragged off the buffer) — keeps the set and _ragSeen bounded
    // by the live roster.
    if (this.ragdolls) {
      for (const id of this._ragSeen) {
        if (!seen.has(id)) { this.ragdolls.remove(id); this._ragSeen.delete(id); this._ragRest.delete(id); }
      }
    }
    if (this._burrowAt?.size) {
      for (const id of this._burrowAt.keys()) if (!seen.has(id)) this._burrowAt.delete(id);
    }
    if (this._thrashInfo?.size) {
      for (const id of this._thrashInfo.keys()) if (!seen.has(id)) this._thrashInfo.delete(id);
    }

    // DETONATION, RENDER-ONLY. explodeCarrier() kills the agent and spawns the
    // spilled infection forms in the same tick, so a rupturing carrier is
    // simply gone from the buffer the next frame — there is no dying body to
    // animate. A carrier only ever leaves the buffer by rupturing (the sim has
    // no other exit for one), so a vanished id IS a detonation: keep drawing
    // it where it stood for the length of the collapse clip, with the sack
    // running away with itself into the burst.
    for (const [id, anim] of this._carrierAnims) {
      if (seen.has(id)) continue;
      const at = this._carrierLast.get(id);
      this._carrierAnims.delete(id);
      this._carrierLast.delete(id);
      if (!at) continue;
      anim.play('detonate', 0.1);
      this._bursting.push({ anim, at });
    }
    for (let b = this._bursting.length - 1; b >= 0; b--) {
      const burst = this._bursting[b];
      burst.anim.advance(dt);
      if (burst.anim.finished || counts.carrier >= CAP) { this._bursting.splice(b, 1); continue; }
      const [bx, by, bz, bh, load] = burst.at;
      // same visibility rules the live bodies get: fully-fogged at 62m, and
      // its OWN distance decides shadow casting (_curD2 still holds whatever
      // the last agent in the loop above measured)
      let d2 = 0;
      if (this.viewX !== undefined) {
        const vdx = bx - this.viewX, vdz = bz - this.viewZ;
        d2 = vdx * vdx + vdz * vdz;
        if (d2 > 62 * 62) continue;
      }
      const p = burst.anim.progress;
      burst.anim.write(this.carrierAnim, counts.carrier,
        SACK_BLOAT_M * (Math.max(load, 0.7) + p * p * 1.9));
      const s = 0.94 + load * 0.1 + p * 0.12;
      this._pose(bx, by, bz, bh, s, s, s);
      if (d2 < CAST_NEAR2) this._castNear.add(this.carrier);
      this.carrier.setMatrixAt(counts.carrier++, this._m);
    }

    // tracers + muzzle flashes from live fights
    this.flashPoints = []; // world positions of this frame's NPC muzzle flashes (pooled gunfire lights)
    const pos = this.tracers.geometry.attributes.position;
    let seg = 0;
    const g = sim.graph;
    for (let n = 0; n < g.n && seg < 250; n++) {
      if (sim.tickCount - sim.gunfireTick[n] > 2) continue;
      const occ = sim.occupants(n);
      const shooters = occ.filter((a) => a.hp > 0 && !a.dead && !a.isPlayer &&
        (a.faction === FACTION.MARINE || (a.faction === FACTION.ARMED && a.state === 5)));
      if (!shooters.length) continue;
      for (const sh of shooters) {
        if (seg >= 250) break;
        if ((sh.id + sim.tickCount) % 3 === 0) continue;
        const targets = sim.lineOfSightAgents(sh, (a) => !a.downed
          && (a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER || a.faction === FACTION.INFECTION));
        if (!targets.length) continue;
        const t = targets.find((target) => target.id === sh.fireTargetId) ?? targets[0];
        const sr = this.rpos.get(sh.id), tr = this.rpos.get(t.id);
        if (!sr || !tr) continue;
        const [sx, sz] = this.world.simToWorld(sr.x, sr.y, sr.deck);
        let [tx, tz] = this.world.simToWorld(tr.x, tr.y, tr.deck);
        const ey = elevOf(sr.deck) + 1.3;
        let ty = elevOf(tr.deck) + 0.7 + (tr.hoverY || 0);
        const range = Math.hypot(tx - sx, tz - sz);
        // PER-SHOT SPREAD (user: every tracer from every marine converged on
        // the exact same point) — deterministic jitter around the target,
        // wider at range and for the squad's worse shots; misses visibly miss
        const sp = (0.22 + range * 0.05) * (0.7 + 0.7 * ((sh.id * 7) % 5) / 4);
        const inv = 1 / (range || 1);
        const px = -(tz - sz) * inv, pz = (tx - sx) * inv;
        const j1 = shotJitter(sh.id, sim.tickCount, 1) * sp;
        const j2 = shotJitter(sh.id, sim.tickCount, 2) * sp * 0.6;
        tx += px * j1; tz += pz * j1; ty += j2;
        pos.setXYZ(seg * 2, sx, ey, sz);
        pos.setXYZ(seg * 2 + 1, tx, ty, tz);
        seg++;
        if (counts.flash < CAP) {
          const dx = tx - sx, dz = tz - sz, dl = Math.hypot(dx, dz) || 1;
          const fs = 0.8 + ((sh.id + sim.tickCount) % 2) * 0.6;
          const fx2 = sx + dx / dl * 0.6, fz2 = sz + dz / dl * 0.6;
          this._m.compose(this._p.set(fx2, ey, fz2),
            this._q.identity(), this._s.set(fs, fs, fs));
          this.flash.setMatrixAt(counts.flash++, this._m);
          if (this.flashPoints.length < 3) this.flashPoints.push({ x: fx2, y: ey, z: fz2 });
        }
      }
    }
    // the player's own shots (short-lived tracers from the muzzle)
    this._playerShots = this._playerShots.filter((s) => (s.ttl -= dt) > 0);
    for (const s of this._playerShots) {
      if (seg >= 255) break;
      pos.setXYZ(seg * 2, s.ax, s.ay, s.az);
      pos.setXYZ(seg * 2 + 1, s.bx, s.by, s.bz);
      seg++;
    }
    this.tracers.geometry.setDrawRange(0, seg * 2);
    // upload only the live segments; zero segments = no upload, no draw
    // (swarm finding: both tracer buffers uploaded whole every frame even
    // with nothing firing anywhere on the ship)
    this.tracers.visible = seg > 0;
    if (pos.clearUpdateRanges) {
      pos.clearUpdateRanges();
      if (seg > 0) pos.addUpdateRange(0, seg * 2 * 3);
    }
    pos.needsUpdate = seg > 0;

    // flood gunfire (user note: armed forms should be VISIBLY shooting) —
    // render only the shooter/target pair that combat actually resolved.
    // Room-level gunfire is shared sensory state and cannot identify either;
    // using it here made every armed form in a hot room shoot arbitrary people.
    const fpos = this.floodTracers.geometry.attributes.position;
    let fseg = 0;
    counts.floodFlash = 0;
    const shooters = sim.agents.filter((a) => a.hp > 0 && !a.dead && !a.downed
      && a.faction === FACTION.COMBAT && a.hostArmed
      && sim.tickCount - (a.hostShotTick ?? -999) <= 6);
    for (const sh of shooters) {
      if (fseg >= 125) break;
      const t = sim.byId.get(sh.hostShotTargetId);
      if (!t) continue;
      const sr = this.rpos.get(sh.id), tr = this.rpos.get(t.id);
      if (!sr || !tr) continue;
      const [sx, sz] = this.world.simToWorld(sr.x, sr.y, sr.deck);
      let [tx, tz] = this.world.simToWorld(tr.x, tr.y, tr.deck);
      const ey = elevOf(sr.deck) + 1.05 + (sr.hoverY || 0);
      let ty = elevOf(tr.deck) + 0.9 + (tr.hoverY || 0);
      // a host's weapon fired one-handed sprays WIDE (lore: suppressive
      // noise, not marksmanship) — big visible scatter
      const fdx = tx - sx, fdz = tz - sz;
      const frange = Math.hypot(fdx, fdz) || 1;
      const fsp = 0.5 + frange * 0.07;
      const finv = 1 / frange;
      const fj1 = shotJitter(sh.id, sim.tickCount, 3) * fsp;
      const fj2 = shotJitter(sh.id, sim.tickCount, 4) * fsp * 0.7;
      tx += -fdz * finv * fj1; tz += fdx * finv * fj1; ty += fj2;
      fpos.setXYZ(fseg * 2, sx, ey, sz);
      fpos.setXYZ(fseg * 2 + 1, tx, ty, tz);
      fseg++;
      if (counts.floodFlash < CAP) {
        const dx = tx - sx, dz = tz - sz, dl = Math.hypot(dx, dz) || 1;
        const fs = 0.7 + ((sh.id + sim.tickCount) % 2) * 0.5;
        this._m.compose(this._p.set(sx + dx / dl * 0.6, ey, sz + dz / dl * 0.6),
          this._q.identity(), this._s.set(fs, fs, fs));
        this.floodFlash.setMatrixAt(counts.floodFlash++, this._m);
      }
    }
    this.floodTracers.geometry.setDrawRange(0, fseg * 2);
    this.floodTracers.visible = fseg > 0;
    if (fpos.clearUpdateRanges) {
      fpos.clearUpdateRanges();
      if (fseg > 0) fpos.addUpdateRange(0, fseg * 2 * 3);
    }
    fpos.needsUpdate = fseg > 0;
    commitInstanced(this.floodFlash, counts.floodFlash);

    // PARTIAL UPLOADS (perf pass 2): ~35 instanced meshes used to re-upload
    // their FULL 512-slot matrix buffers every frame (~1MB/frame of copy
    // whether 3 or 300 instances were live). Only the used range goes to
    // the GPU now; slots past `count` are never drawn, so they never need
    // uploading.
    const cull = this.shadowCull !== false; // ?nosc=1 pins every set casting
    for (const [set, c] of [[this.civSet, counts.civ], [this.armedSet, counts.armed],
    [this.marineSet, counts.marine], [this.infectionSet, counts.infection],
    [this.combatCivSet, counts.combatCiv], [this.combatOdstSet, counts.combatOdst]]) {
      const cast = !cull || this._castNear.has(set);
      for (const mesh of set) { mesh.castShadow = cast; commitInstanced(mesh, c); }
      // folded-ODST tint: upload only when some slot's faction bit moved
      if (set.tintDirty) {
        for (const mesh of set) mesh.instanceColor.needsUpdate = true;
        set.tintDirty = false;
      }
    }
    // a carried rifle is only ever within torch reach when its carrier is
    this.rifle.castShadow = !cull || this._castNear.has(this.armedSet) || this._castNear.has(this.marineSet)
      || this._castNear.has(this.combatOdstSet);
    this.flamer.castShadow = this.rifle.castShadow;
    this.carrier.castShadow = !cull || this._castNear.has(this.carrier);
    for (const [mesh, c] of [[this.carrier, counts.carrier],
    [this.corpse, counts.corpse], [this.rifle, counts.rifle], [this.flamer, counts.flamer],
    [this.flash, counts.flash], [this.beams, counts.beam]]) {
      commitInstanced(mesh, c);
    }
    this._commitCarrierAnim(counts.carrier);   // per-instance clip/phase/swell
  }

  // LEAN IN THE BODY'S OWN FRAME. This used to write the lean into the euler's
  // X slot, i.e. about the WORLD x-axis, ahead of the heading — so a body
  // facing world +X was not leaning at all, it was ROLLING, and one facing
  // world +Z pitched instead. Charging combat forms visibly toppled sideways.
  // XYZ order with x=0 gives Ry(heading)·Rz(lean), which is the same axis and
  // sign the death fall already uses: positive tips onto the back, negative
  // leans into the direction of travel.
  _pose(x, y, z, rotY, sx, sy, sz, lean = 0) {
    this._e.set(0, rotY, lean);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(sx, sy, sz));
  }

  // Place a CARRIED rifle from the same solve its owner's arms were placed
  // from, so the two cannot drift apart. `floorY` is the deck under his feet:
  // the offsets are model-space, exactly as solveCarry produced them.
  // THE GUN LEANS WITH THE MAN. `lean` is the body's own fore/aft tip — the
  // same value _pose writes — and the carry has to eat it or the two come
  // apart: _pose rotates the body about its FEET, so a marine who pitches
  // forward onto his weapon left the weapon standing plumb behind his hands.
  // Invisible at the walk's 0.045 rad; a gaping hole at the aiming lean.
  _carryAt(x, floorY, z, rotY, cfg, bob = 0, lean = 0) {
    let ox = cfg.fwd, oy = cfg.y, pitch = cfg.pitch;
    if (bob) {   // the whole carry rotates about the shoulder line, as the arms do
      const dx = ox, dy = oy - cfg.sh, c = Math.cos(bob), s = Math.sin(bob);
      ox = dx * c - dy * s; oy = cfg.sh + dx * s + dy * c; pitch += bob;
    }
    if (lean) {  // ...and the body's lean rotates it about the FEET
      const c = Math.cos(lean), s = Math.sin(lean);
      const nx = ox * c - oy * s;
      oy = ox * s + oy * c; ox = nx; pitch += lean;
    }
    const fx = Math.cos(rotY), fz = -Math.sin(rotY);   // +X-forward after rotY
    this._e.set(0, rotY + cfg.yaw, pitch);
    this._q.setFromEuler(this._e);
    this._m.compose(
      this._p.set(x + fx * ox - fz * cfg.right, floorY + oy, z + fz * ox + fx * cfg.right),
      this._q, this._s.set(1, 1, 1));
  }

  // The torch points WHERE HE IS LOOKING. Riding _rifleAt put the cone on the
  // low-ready rifle, which is held across the chest — so the beam came out of
  // the marine's sternum and threw off to one side (user screenshot).
  // THE CONE NOW CARRIES ELEVATION. It used to be yaw-only, which is why the
  // carry was pinned to a level barrel and why the lighting host had to fake a
  // flat 3-degree droop for every marine on the ship. The carry hands back its
  // real world-frame yaw and elevation (barrel pitch plus the body's lean), so
  // a man sighting down his rifle throws the beam where the rifle is actually
  // pointing and a man at low-ready throws it at the deck ahead of him.
  _beamAt(x, y, z, rotY, yaw = RIFLE_YAW, elev = 0) {
    rotY += yaw;                                  // down the barrel, like the light
    const fx = Math.cos(rotY) * Math.cos(elev), fz = -Math.sin(rotY) * Math.cos(elev);
    this._e.set(0, rotY, elev);
    this._q.setFromEuler(this._e);
    this._m.compose(this._p.set(x + fx * 0.35, y + Math.sin(elev) * 0.35, z + fz * 0.35),
      this._q, this._s.set(1, 1, 1));
  }

  _rifleAt(x, y, z, rotY) {
    // HALO LOW-READY (user: "holding rifles in a pose similar to halo
    // games"): across the chest, muzzle angled down and slightly across the
    // body, sitting in the raised hands — candidate C of the pose grid
    const fx = Math.cos(rotY), fz = -Math.sin(rotY); // +X-forward after rotY
    const rx = -fz, rz = fx;                          // right-hand direction
    this._e.set(0, rotY + RIFLE_YAW, -0.26);
    this._q.setFromEuler(this._e);
    this._m.compose(
      this._p.set(x + fx * 0.20 + rx * 0.04, y - 0.09, z + fz * 0.20 + rz * 0.04),
      this._q, this._s.set(1, 1, 1));
  }

  // --- ragdolls ------------------------------------------------------------

  // Render a dead body — a fresh CORPSE or a just-DOWNED combat form — as a
  // physics ragdoll. Returns true if it drew it (the caller then `continue`s),
  // false to hand back to the legacy static/rotate-flat render. It returns
  // false (handing off) when: ragdolls are disabled; the body is an
  // already-incinerated husk (no flop to start); the sim has relocated the body
  // (drift → follow the sim); or the body just burned/was cap-evicted after
  // flopping — in which case _ragRest carries the settled spot so the legacy
  // render anchors there instead of teleporting to the sim node.
  // per-slot diffuse tint for the folded ODST look. Keyed on SLOT, not agent
  // id — the slot->agent mapping reshuffles every frame, and this repaints
  // exactly the slots whose faction bit moved. Slots past `count` keep stale
  // colors and are never drawn.
  _tintSlot(set, slot, kind) {
    if (set.tintLast[slot] === kind) return;
    set.tintLast[slot] = kind;
    const c = kind ? PLATE_ODST : PLATE_LINE;
    for (const mesh of set) mesh.setColorAt(slot, c);
    set.tintDirty = true;
  }

  _ragdollBody(id, f, flags, rp, wx, wz, deck, heading, counts, thrashing = false) {
    const sys = this.ragdolls;
    if (!sys) return false;
    const burned = (flags & FLAG.BURNED) !== 0;
    let rag = sys.get(id);
    if (rag) {
      // drift guard: if the sim MOVED the body (a carrier dragging a corpse, a
      // reanimation relocation, any teleport), abandon the flop and follow the
      // sim. The ragdoll's OWN motion never trips this — it compares the sim's
      // position, not the flopped one. KEEP the _ragSeen mark (a relocated body
      // must never respawn a fresh flop) but DROP the rest anchor so the legacy
      // render tracks the sim position (the drag), not the old spot.
      const drift = this.sim.P.ragdoll.driftLimitM ?? 1.5;
      if (rag.deck !== deck || Math.hypot(wx - rag.originX, wz - rag.originZ) > drift) {
        sys.remove(id); this._ragRest.delete(id);
        return false;
      }
      // incinerated after flopping: hand to the legacy husk/slab, anchored at
      // the settled pose (recorded just below), and free the ragdoll slot.
      if (burned) { this._ragRest.set(id, [rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]]); sys.remove(id); return false; }
    } else {
      if (burned) return false;                // never START a flop for an already-incinerated body
      // a body only flops once — UNLESS a grenade goes off on it (the classic
      // "toss a nade into the pile and they scatter" moment) OR a pod is
      // inside it: a thrashing corpse ALWAYS gets a live ragdoll — the
      // convulsions are real impulses, not a canned clip.
      if (this._ragSeen.has(id) && !thrashing && !this._blastAt(wx, wz, deck)) return false;
      const elev = this.world.groundHeightAt(deck, wx, wz);
      const hoverY = rp.hoverY || 0; // a form that died mid-leap starts in the air
      // a thrash-forced flop starts with a SEIZE (a jolt and a limb whip
      // where it lies), not the full death launch that would hurl the body
      const impulse = thrashing
        // a SEIZE where it lies — no lift, no travel, no jitter. The old
        // profile hurled the body: measured 1.57 m into the air and 4.64 m
        // across the deck over one 4 s convulsion (user: "flipping around in
        // the air"). The agony belongs in the roll and the limbs.
        ? { dirX: 1, dirZ: 0, speed: 0, up: 0, jitter: 0, jitterUp: 0, spin: 1.4, kick: 9 }
        : this._deathImpulse(id, f, flags, wx, wz, deck, heading);
      // the ceiling sampler is called for BOTH capsule ends every substep,
      // and ceilHeightAt is a linear all-rooms scan (swarm finding) — the
      // value only changes when the body crosses a room boundary. Two cache
      // slots (the ends are ~1m apart, so one slot would ping-pong and
      // re-resolve every call), re-resolved after >0.5m of lateral travel.
      const cc = [{ x: 1e9, z: 1e9, y: 0 }, { x: 1e9, z: 1e9, y: 0 }];
      rag = sys.spawn(id,
        { x: wx, y: elev + hoverY, z: wz, heading, deck },
        impulse,
        (x, z) => this.world.groundHeightAt(deck, x, z),
        (x, z) => {
          const da = (x - cc[0].x) ** 2 + (z - cc[0].z) ** 2;
          const db = (x - cc[1].x) ** 2 + (z - cc[1].z) ** 2;
          if (Math.min(da, db) <= 0.25) return (da <= db ? cc[0] : cc[1]).y;
          const s = da <= db ? cc[1] : cc[0]; // miss: evict the farther slot
          s.x = x; s.z = z;
          s.y = elevOf(deck) + this.world.ceilHeightAt(deck, x, z) - 0.15;
          return s.y;
        },
        (fromX, fromZ, toX, toZ, radius) => {
          if (!this.world.ragdollBlocked(deck, toX, toZ, radius)) return null;
          // Swept bisection prevents a fast pounce launch from tunnelling
          // through a thin door panel between fixed ragdoll substeps.
          let lo = 0, hi = 1;
          for (let step = 0; step < 8; step++) {
            const mid = (lo + hi) * 0.5;
            const x = fromX + (toX - fromX) * mid;
            const z = fromZ + (toZ - fromZ) * mid;
            if (this.world.ragdollBlocked(deck, x, z, radius)) hi = mid;
            else lo = mid;
          }
          const dx = toX - fromX, dz = toZ - fromZ;
          const dl = Math.hypot(dx, dz) || 1;
          return {
            x: fromX + dx * Math.max(0, lo - 0.01),
            z: fromZ + dz * Math.max(0, lo - 0.01),
            nx: -dx / dl, nz: -dz / dl,
          };
        });
      if (!rag) return false; // disabled at the system level
      this._ragSeen.add(id);
    }

    // NON-FINITE GUARD: a single NaN instance matrix can corrupt an entire
    // instanced draw on tile-based GPUs (Apple M-series) — every body sharing
    // the mesh vanishes, not just the bad one. If a flop ever goes non-finite,
    // drop the ragdoll and hand the body to the legacy flat render.
    let finite = Number.isFinite(rag.rootPos[0] + rag.rootPos[1] + rag.rootPos[2] + rag.rootQuat[3]);
    if (finite) for (const part in rag.limbs) {
      const q = rag.limbs[part];
      if (!Number.isFinite(q[0] + q[1] + q[2] + q[3])) { finite = false; break; }
    }
    if (!finite) {
      sys.remove(id);
      this._ragRest.delete(id);
      return false;
    }

    // record where the body currently rests, so any later handoff to the legacy
    // render (burn, cap-eviction, revive) anchors there instead of the sim node
    this._ragRest.set(id, [rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]]);

    // HALO-3 THRASH (user): while the pod works inside, beat the body with
    // rising-intensity impulses — every ~quarter second, harder as the rise
    // nears, limbs whipping (kick >> speed so it convulses in place rather
    // than sliding). Math.random is legal here: the ragdoll layer is
    // render-only cosmetics and never feeds back into the sim.
    if (thrashing) {
      const ti = this._thrashInfo?.get(id);
      const tn = performance.now();
      if (ti) {
        // hold it where it fell — a convulsion must not migrate
        sys.tether(id, rag.originX, rag.originZ, 0.4,
          this.world.groundHeightAt(deck, wx, wz), 0.22);
        if (tn >= ti.last + 185 + (id % 5) * 25) {
          ti.last = tn;
          // ROLLING IN AGONY, NOT CARTWHEELING (user). reimpulse is ADDITIVE,
          // so the old rising `up` compounded into flight and the old linear
          // jitter random-walked the body across the room. writhe() spends the
          // energy on the roll and the limbs and none on translation; the ramp
          // still builds toward the moment it rises.
          const ramp = Math.min(1, (tn - ti.t0) / 2800);
          sys.writhe(id, 0.45 + 0.55 * ramp);
        }
      }
    }

    // stamp the right model set + counter from the ragdoll pose (same sets the
    // legacy paths use, so no extra draw calls)
    let set, ci;
    if (f === FACTION.CORPSE) {
      if (flags & FLAG.ARMED_HOST) { set = this.armedSet; ci = counts.armed++; }
      else { set = this.civSet; ci = counts.civ++; }
    } else {
      if (flags & FLAG.ARMED_HOST) { set = this.combatOdstSet; ci = counts.combatOdst++; }
      else { set = this.combatCivSet; ci = counts.combatCiv++; }
    }
    this._stampRagdoll(set, ci, rag);

    // the armed dead keep a rifle on the deck beside them, so the "take mags off
    // the dead" prompt still points at something visible
    if (flags & FLAG.ARMED_HOST) {
      const gy = this.world.groundHeightAt(deck, rag.rootPos[0], rag.rootPos[2]);
      const lieAng = (id * 2.399963) % (Math.PI * 2);
      this._rifleAt(rag.rootPos[0] + Math.cos(lieAng) * 0.5, gy + 0.12,
        rag.rootPos[2] + Math.sin(lieAng) * 0.5, lieAng * 1.7);
      this.rifle.setMatrixAt(counts.rifle++, this._m);
    }
    return true;
  }

  // The launch off the killing blow (PLAN-ANIM-POLISH "hit-direction deaths").
  // Direction, in priority order: away from the recorded attacker (lastHurtBy);
  // for a human corpse with no attacker, away from the nearest live hostile;
  // else along the body's facing. All scatter is a deterministic hash of the id
  // — no Math.random — so the flop is reproducible (the headless gate pins it).
  _deathImpulse(id, f, flags, wx, wz, deck, heading) {
    const R = this.sim.P.ragdoll;
    const world = this.world;

    // killed by a grenade → thrown off the blast, flailing (overrides the
    // hit-direction logic below)
    const blast = this._blastAt(wx, wz, deck);
    if (blast) return this._blastImpulse(wx, wz, blast.cx, blast.cz, Math.hypot(wx - blast.cx, wz - blast.cz), blast.r);

    let dirX = 0, dirZ = 0, known = false, speed = R.launchSpeed;

    const agent = this.sim.byId.get(id);
    if (agent?.deathImpulse?.kind === 'melee') {
      const hit = agent.deathImpulse;
      return {
        dirX: hit.dirX, dirZ: hit.dirY,
        speed: hit.speed, up: hit.up, spin: hit.spin, kick: hit.kick,
      };
    }
    if (agent && agent.lastHurtBy != null && agent.lastHurtBy >= 0) {
      const src = this.sim.byId.get(agent.lastHurtBy);
      if (src && !src.dead && src.deck === deck && src.id !== id) {
        const [sxw, szw] = world.simToWorld(src.x, src.y, deck);
        dirX = wx - sxw; dirZ = wz - szw;
        if (Math.hypot(dirX, dirZ) > 0.05) known = true;
      }
    }
    if (!known && f === FACTION.CORPSE) {
      let bestD = R.corpseHostileRangeM, bx = 0, bz = 0, found = false;
      for (const a of this.sim.agents) {
        if (a.dead || a.deck !== deck) continue;
        if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT && a.faction !== FACTION.CARRIER) continue;
        const [axw, azw] = world.simToWorld(a.x, a.y, deck);
        const d = Math.hypot(wx - axw, wz - azw);
        if (d < bestD) { bestD = d; bx = axw; bz = azw; found = true; }
      }
      if (found) {
        dirX = wx - bx; dirZ = wz - bz;
        if (Math.hypot(dirX, dirZ) > 0.05) { known = true; speed = R.corpseKnockSpeed; }
      }
    }
    if (!known) {
      dirX = Math.cos(heading); dirZ = -Math.sin(heading); // world-forward at this render heading
      if (f === FACTION.CORPSE) speed = R.corpseKnockSpeed;
    }
    // deterministic scatter so a heap doesn't fan out identically
    let dl = Math.hypot(dirX, dirZ) || 1;
    dirX = dirX / dl + this._scatter(id, 1) * 0.35;
    dirZ = dirZ / dl + this._scatter(id, 2) * 0.35;
    dl = Math.hypot(dirX, dirZ) || 1;
    dirX /= dl; dirZ /= dl;

    const violent = flags & (FLAG.CHARGING | FLAG.LEAPING);
    if (violent) speed += R.chargeBonus; // it was sprinting — the momentum carries into the tumble
    return { dirX, dirZ, speed, up: R.launchUp, spin: R.spin, kick: R.limbKick + (violent ? 3 : 0) };
  }

  // deterministic per-body scatter in [-1, 1] (stands in for Math.random)
  _scatter(id, salt) {
    const h = Math.imul((id * 2654435761) ^ (salt * 40503), 2246822519) >>> 0;
    return (h / 0xffffffff) * 2 - 1;
  }

  // Write the ragdoll's root + per-limb transforms into the instanced part
  // meshes — the same pivot-anchored composition as _stampAnimated, but the
  // limb rotation is a full physics quaternion and the base is the tumbling
  // root instead of the upright pose.
  _stampRagdoll(set, i, rag) {
    if (this._curD2 < CAST_NEAR2) this._castNear.add(set);
    this._q.set(rag.rootQuat[0], rag.rootQuat[1], rag.rootQuat[2], rag.rootQuat[3]);
    this._m.compose(this._p.set(rag.rootPos[0], rag.rootPos[1], rag.rootPos[2]),
      this._q, this._s.set(1, 1, 1));
    for (const mesh of set) {
      const pivot = mesh.userData.pivot;
      const lq = pivot ? rag.limbs[mesh.userData.part] : null;
      if (!lq) { mesh.setMatrixAt(i, this._m); continue; } // torso / pivotless → root only
      this._q2.set(lq[0], lq[1], lq[2], lq[3]);
      this._mRot.makeRotationFromQuaternion(this._q2);
      this._mPart.makeTranslation(pivot[0], pivot[1], pivot[2])
        .multiply(this._mRot)
        .multiply(this._mOut.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this._mOut.multiplyMatrices(this._m, this._mPart);
      mesh.setMatrixAt(i, this._mOut);
    }
  }
}
