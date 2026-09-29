import assert from 'node:assert/strict';
import { createShadowBudget } from './shadow-budget.js';

const map = { depthTexture: { version: 1 } };
const light = { shadow: { intensity: 0.62, autoUpdate: false, needsUpdate: false } };
// A quality transition must never invoke setters that invalidate cached GPU resources.
Object.defineProperty(light, 'castShadow', { get: () => true, set() { assert.fail('castShadow changed'); } });
Object.defineProperty(light.shadow, 'map', { get: () => map, set() { assert.fail('shadow target replaced'); } });
const budget = createShadowBudget(light);
for (const enabled of [true, false, true, false, false, true]) {
  light.shadow.needsUpdate = true; // include a pending update on downgrade
  budget.setEnabled(enabled);
  assert.equal(light.shadow.intensity, enabled ? 0.62 : 0);
  assert.equal(light.shadow.autoUpdate, false);
  assert.equal(light.shadow.needsUpdate, enabled);
  light.shadow.needsUpdate = false; // renderer consumed the queued update
  assert.equal(budget.requestUpdate(), enabled);
  assert.equal(light.shadow.needsUpdate, enabled, 'disabled shadows must stay idle, including during prewarm');
  assert.equal(light.shadow.map, map);
}
console.log('shadow quality: stable resources, idle low tier, restored intensity and updates ✓');
