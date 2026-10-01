import assert from 'node:assert/strict';
import * as THREE from '../engine/vendor/three.webgpu.module.js';
import { World } from './world.js';
import { Agents3D } from './agents3d.js';
import { rayBoxDistance } from './light-occlusion.js';

const wall = { cx: 3, cy: 1.5, cz: 0, hx: 0.1, hy: 1.5, hz: 3, ry: 0 };
assert.ok(Math.abs(rayBoxDistance(0, 1.5, 0, 1, 0, 0, wall, 6) - 2.9) < 1e-6);
assert.equal(rayBoxDistance(0, 1.5, 4, 1, 0, 0, wall, 6), Infinity);
assert.equal(rayBoxDistance(0, 4, 0, 1, 0, 0, wall, 6), Infinity);
const rotated = { cx: 3, cy: 1.5, cz: 0, hx: 3, hy: 1.5, hz: 0.1, ry: Math.PI / 2 };
assert.ok(Math.abs(rayBoxDistance(0, 1.5, 0, 1, 0, 0, rotated, 6) - 2.9) < 1e-6);

const world = Object.create(World.prototype);
world._collBoxCache = [wall];
world.doors = [];
assert.ok(Math.abs(world.lightRayDistance(0, 1.5, 0, 1, 0, 0, 6) - 2.9) < 1e-6,
  'an interior bulkhead stops the light before its fixed six-metre cone ends');
world._collBoxCache = [];
world._doorPW = 0.91; world._doorPH = 3;
const door = { x: 3, z: 0, elev: 0, phi: Math.PI / 2, open01: 0, buckle: null };
world.doors = [door];
assert.ok(world.lightRayDistance(0, 1.5, 0, 1, 0, 0, 6) < 3,
  'closed sliding panels stop a beam');
door.open01 = 1;
assert.equal(world.lightRayDistance(0, 1.5, 0, 1, 0, 0, 6), 6,
  'open doorway lets a beam through');

const agent = Object.create(Agents3D.prototype);
agent.world = world;
agent._e = new THREE.Euler(); agent._q = new THREE.Quaternion();
agent._m = new THREE.Matrix4(); agent._p = new THREE.Vector3(); agent._s = new THREE.Vector3();
world.doors = []; world._collBoxCache = [wall];
assert.equal(agent._beamAt(0, 1.5, 0, 0, 0, 0), true);
const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
agent._m.decompose(position, rotation, scale);
assert.ok(position.x + 6 * scale.x < 2.9,
  'the drawn shaft ends on the near side of the wall');
console.log('weapon lights stop at bulkheads and closed doors ✓');
