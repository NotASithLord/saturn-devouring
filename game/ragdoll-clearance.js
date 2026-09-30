// An AABB corner is often empty space on the irregular Flood meshes. Rotating
// that box can put a nonexistent corner far below the deck, and lifting the
// entire corpse to clear it leaves the actual torso hovering. Cache actual
// vertices that support the hull in many directions, then sample only those
// points each frame. The full mesh is checked by the regression gate.
export function floorLiftForGeometry(geometry, matrix, groundHeightAt, clearance = 0.025) {
  let samples = geometry.userData.floorSupport;
  if (!samples) {
    const pos = geometry.attributes.position.array;
    const count = pos.length / 3;
    const picked = new Set();
    const directions = 256;
    for (let d = 0; d < directions; d++) {
      const y = 1 - 2 * (d + 0.5) / directions;
      const r = Math.sqrt(1 - y * y);
      const a = d * Math.PI * (3 - Math.sqrt(5));
      const dx = r * Math.cos(a), dz = r * Math.sin(a);
      let best = -Infinity, bestIdx = 0;
      for (let i = 0; i < count; i++) {
        const score = pos[i * 3] * dx + pos[i * 3 + 1] * y + pos[i * 3 + 2] * dz;
        if (score > best) { best = score; bestIdx = i; }
      }
      picked.add(bestIdx);
    }
    samples = new Float32Array(picked.size * 3);
    let i = 0;
    for (const idx of picked) {
      samples[i++] = pos[idx * 3];
      samples[i++] = pos[idx * 3 + 1];
      samples[i++] = pos[idx * 3 + 2];
    }
    geometry.userData.floorSupport = samples;
  }
  let lift = 0;
  for (let i = 0; i < samples.length; i += 3) {
    const x = samples[i], y = samples[i + 1], z = samples[i + 2];
    const wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const wy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    lift = Math.max(lift, groundHeightAt(wx, wz) + clearance - wy);
  }
  return lift;
}
