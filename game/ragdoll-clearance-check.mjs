import assert from 'node:assert/strict';
import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { Agents3D, rigMetrics } from './agents3d.js';
import { RagdollSystem } from '../engine/physics/ragdoll.js';
import { PARAMS } from '../shared/params.js';
import { CHARACTERS } from './characters-data.js';

const ground = (x, z) => 0.04 * x - 0.03 * z;
const actualPenetration = (mesh, matrix, floor) => {
  const p = mesh.geometry.attributes.position.array, m = matrix.elements;
  let deepest = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    deepest = Math.max(deepest, floor(wx, wz) - wy);
  }
  return deepest;
};
const geom = new THREE.BoxGeometry(0.28, 0.95, 0.24);
geom.translate(0, 0.95, 0);
const torso = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial(), 1);
torso.userData.part = 'torso';
const arm = new THREE.InstancedMesh(geom.clone(), new THREE.MeshBasicMaterial(), 1);
arm.userData.part = 'armL'; arm.userData.pivot = [0, 1.25, -0.2];
const rig = Object.create(Agents3D.prototype);
rig._q = new THREE.Quaternion(); rig._q2 = new THREE.Quaternion();
rig._m = new THREE.Matrix4(); rig._mPart = new THREE.Matrix4();
rig._mRot = new THREE.Matrix4(); rig._mOut = new THREE.Matrix4();
rig._p = new THREE.Vector3(); rig._s = new THREE.Vector3();
rig.world = {groundHeightAt: (_deck, x, z) => ground(x, z)};
rig._curD2 = Infinity; rig._castNear = new Set();
const rag = {rootPos:[0,0.15,0], rootQuat:[0,0,0,1],
  limbs:{armL:[0,0,0,1]}, deck:1};
const set = [torso, arm];
for (let i=0; i<36; i++) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i*0.17, i*0.11, i*0.21));
  const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(i*0.31, 0, i*0.24));
  rag.rootQuat = q.toArray(); rag.limbs.armL = lq.toArray();
  const lift = rig._ragdollFloorLift(set, rag);
  assert.ok(lift >= 0 && Number.isFinite(lift));
  rag.visualLift = lift;
  rig._stampRagdoll(set, 0, rag);
  for (const mesh of set) {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
    const remaining = actualPenetration(mesh, matrix, ground);
    assert.ok(remaining < 1e-6, `rendered ${mesh.userData.part} penetrated on pose ${i}: ${remaining}`);
  }
}
// The no-physics fallback uses the same mesh clearance, after its sprawl is stamped.
const buried = new THREE.Matrix4().makeTranslation(0, -0.4, 0);
for (const mesh of set) mesh.setMatrixAt(0, buried);
rig._floorCorrectStamped(set, 0, 1);
for (const mesh of set) {
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
  assert.ok(actualPenetration(mesh, matrix, ground) < 1e-6,
    'fallback thrash must also remain above the floor');
}
// The converted Flood's whip arm is over twice the generic ragdoll's reach.
// Simulate that actual rig through a full settle: a proxy-length arm used to
// leave its mesh buried, and the render pass lifted the entire corpse to
// clear it, making the torso appear to float above the deck.
const model = CHARACTERS.combat_civ;
const combatParts = model.groups.map((group) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.pos, 3));
  return { part: group.part, pivot: model.pivots[group.part] ?? null, geometry };
});
const measured = rigMetrics(combatParts);
assert.ok(measured.limbGeom.armL.len > 1.5, 'fixture must exercise the long Flood arm');
const combatSet = combatParts.map((part) => {
  const mesh = new THREE.InstancedMesh(part.geometry, new THREE.MeshBasicMaterial(), 1);
  mesh.userData.part = part.part; mesh.userData.pivot = part.pivot;
  return mesh;
});
const combatSys = new RagdollSystem(PARAMS.ragdoll);
const combat = combatSys.spawn(77,
  { x: 0, y: 0, z: 0, heading: 0, deck: 1, limbGeom: measured.limbGeom },
  { dirX: 1, dirZ: 0, speed: 6.5, up: 3.2, spin: 9, kick: 7 }, () => 0);
assert.equal(combat.limbGeom.armL.len, measured.limbGeom.armL.len);
for (let i = 0; i < 1200; i++) combatSys.step(1 / 60);
rig.world = { groundHeightAt: () => 0 };
const combatLift = rig._ragdollFloorLift(combatSet, combat);
assert.ok(combatLift < 0.33, 'the real Flood mesh should not need a large empty-box lift');
let maxLift = combatLift;
for (let id = 80; id < 100; id++) {
  const sys = new RagdollSystem(PARAMS.ragdoll);
  const body = sys.spawn(id, { x: 0, y: 0, z: 0, heading: id * 0.7, deck: 1,
    limbGeom: measured.limbGeom },
    { dirX: 1, dirZ: 0.2, speed: 6.5, up: 3.2, spin: 9, kick: 7 }, () => 0);
  for (let step = 0; step < 1000; step++) sys.step(1 / 60);
  const lift = rig._ragdollFloorLift(combatSet, body);
  maxLift = Math.max(maxLift, lift);
  body.visualLift = lift;
  rig._stampRagdoll(combatSet, 0, body);
  for (const mesh of combatSet) {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
    assert.ok(actualPenetration(mesh, matrix, () => 0) < 0.012,
      `settled Flood ${id} ${mesh.userData.part} must clear the deck`);
  }
}
assert.ok(maxLift < 0.33, `settled Flood bodies must not float (max lift ${maxLift.toFixed(3)}m)`);
console.log('ragdoll mesh clearance and grounded Flood poses ✓');
