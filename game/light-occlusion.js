// The ship's collision boxes are the same solids used for movement and shots.
// Intersect a light ray with them in the box's own frame; this also handles
// the rotated stair rails and door panels that room-rectangle maths misses.
export function rayBoxDistance(ox, oy, oz, dx, dy, dz, box, limit) {
  const c = Math.cos(box.ry || 0), s = Math.sin(box.ry || 0);
  const px = ox - box.cx, pz = oz - box.cz;
  const lx = c * px - s * pz, ly = oy - box.cy, lz = s * px + c * pz;
  const vx = c * dx - s * dz, vy = dy, vz = s * dx + c * dz;
  let near = 0, far = limit;
  if (Math.abs(vx) < 1e-8) { if (Math.abs(lx) > box.hx) return Infinity; }
  else {
    const a = (-box.hx - lx) / vx, b = (box.hx - lx) / vx;
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  if (Math.abs(vy) < 1e-8) { if (Math.abs(ly) > box.hy) return Infinity; }
  else {
    const a = (-box.hy - ly) / vy, b = (box.hy - ly) / vy;
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  if (Math.abs(vz) < 1e-8) { if (Math.abs(lz) > box.hz) return Infinity; }
  else {
    const a = (-box.hz - lz) / vz, b = (box.hz - lz) / vz;
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  return near;
}
