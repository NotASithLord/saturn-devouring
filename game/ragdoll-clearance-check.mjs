import assert from 'node:assert/strict';
import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { Agents3D } from './agents3d.js';
import { floorLiftForBounds } from './ragdoll-clearance.js';

const ground = (x, z) => 0.04 * x - 0.03 * z;
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
    mesh.geometry.computeBoundingBox();
    const remaining = floorLiftForBounds(mesh.geometry.boundingBox, matrix.elements, ground);
    assert.ok(remaining < 1e-6, `rendered ${mesh.userData.part} penetrated on pose ${i}: ${remaining}`);
  }
}
// The no-physics fallback uses the same mesh clearance, after its sprawl is stamped.
const buried = new THREE.Matrix4().makeTranslation(0, -0.4, 0);
for (const mesh of set) mesh.setMatrixAt(0, buried);
rig._floorCorrectStamped(set, 0, 1);
for (const mesh of set) {
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
  assert.ok(floorLiftForBounds(mesh.geometry.boundingBox, matrix.elements, ground) < 1e-6,
    'fallback thrash must also remain above the floor');
}
console.log('thrashing ragdoll: rotated torso and limbs clear a sloped deck across 36 poses ✓');
