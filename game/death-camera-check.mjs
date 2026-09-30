import assert from 'node:assert/strict';
import { deathCameraPose } from './death-camera.js';

const anchor = { x: 0, y: 0, z: 0, heading: 0, prone: true };
const clear = deathCameraPose(anchor, () => Infinity, () => 0, () => 3);
assert.ok(clear.position[0] < -3, 'an open room keeps the rear view');

let casts = 0;
const againstWall = deathCameraPose(anchor, () => ++casts === 1 ? 0.55 : Infinity,
  () => 0, () => 3);
assert.ok(Math.abs(againstWall.position[2]) > 3,
  'a wall behind the body chooses a full-distance side view');
assert.ok(Math.hypot(againstWall.position[0], againstWall.position[2]) > 3,
  'the lens stays outside the corpse');

const boxedIn = deathCameraPose(anchor, () => 0.5, () => 0, () => 3);
assert.ok(boxedIn.position[1] >= 2 && Math.abs(boxedIn.position[0]) < 0.01,
  'a tight nook uses an overhead view instead of placing the lens inside the body');
console.log('death camera clearance ✓');
