import assert from 'node:assert/strict';
import { agentCullPosition, agentInView } from './agents3d.js';

// A ragdoll launched away from its sim anchor remains visible as the player
// approaches its drawn position, then backs away while facing the same pile.
const rag = { rootPos: [5, 0.2, 0] };
const [x, z] = agentCullPosition(-4, 0, rag, [-3, 0, 0], true);
assert.deepEqual([x, z], [5, 0]);
for (const playerX of [-2, 0, 2, 4, 0]) {
  assert.equal(agentInView(x, z, playerX, 0, 1, 0, 14 * 14, 64), true,
    `body must stay visible at player x=${playerX}`);
}
assert.equal(agentInView(-4, 0, 5, 0, 1, 0, 14 * 14, 64), false,
  'the old sim anchor would wrongly hide the visible ragdoll');
assert.deepEqual(agentCullPosition(-4, 0, null, [5, 0.2, 0], true), [5, 0],
  'cap-evicted ragdolls keep their settled anchor');
assert.deepEqual(agentCullPosition(-4, 0, null, [5, 0.2, 0], false), [-4, 0],
  'walking agents still cull at their current position');
assert.equal(agentInView(20, 0, 0, 0, 1, 0, 14 * 14, 64), false,
  'bodies past the fog wall remain culled');
assert.equal(agentInView(-12, 0, 0, 0, 1, 0, 14 * 14, 64), false,
  'distant bodies behind the camera remain culled');
console.log('agent visibility: OK');
