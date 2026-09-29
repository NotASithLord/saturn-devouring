// Keep the shadow node and its render target alive across quality changes.
// Flipping light.castShadow disposes the node while cached render pipelines
// can still schedule updateBefore on it (a null shadowMap.depthTexture).
export function createShadowBudget(light) {
  const intensity = light.shadow.intensity;
  let enabled = true;
  return {
    setEnabled(value) {
      enabled = !!value;
      light.shadow.autoUpdate = false;
      light.shadow.intensity = enabled ? intensity : 0;
      light.shadow.needsUpdate = enabled;
    },
    requestUpdate() {
      if (!enabled) return false;
      light.shadow.needsUpdate = true;
      return true;
    },
  };
}
