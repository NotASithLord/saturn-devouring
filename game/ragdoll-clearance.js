// Minimum vertical correction for a rendered body part. The physics capsule
// protects its joints, but the visible meshes extend past those contacts.
export function floorLiftForBounds(bounds, matrix, groundHeightAt, clearance = 0.012) {
  let lift = 0;
  const { min, max } = bounds;
  for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
    const x = xi ? max.x : min.x, y = yi ? max.y : min.y, z = zi ? max.z : min.z;
    const wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const wy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    lift = Math.max(lift, groundHeightAt(wx, wz) + clearance - wy);
  }
  return lift;
}
