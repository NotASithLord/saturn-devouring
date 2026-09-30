// Choose a casualty view with room for the camera. A wall directly behind the
// body must not collapse the view to a point inside its ragdoll.
export function deathCameraPose(anchor, rayDistance, groundHeight, ceilingHeight) {
  const focus = [anchor.x, anchor.y + (anchor.prone ? 0.45 : 1.05), anchor.z];
  const height = anchor.prone ? 1.65 : 2.15;
  let best = null;
  for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const angle = anchor.heading + turn;
    const goal = [anchor.x - Math.cos(angle) * 3.6, anchor.y + height,
      anchor.z - Math.sin(angle) * 3.6];
    const dx = goal[0] - focus[0], dy = goal[1] - focus[1], dz = goal[2] - focus[2];
    const length = Math.hypot(dx, dy, dz);
    const clear = Math.max(0, Math.min(length, rayDistance(focus, goal) - 0.28));
    if (!best || clear > best.clear) {
      best = { clear, position: [focus[0] + dx * clear / length,
        focus[1] + dy * clear / length, focus[2] + dz * clear / length] };
    }
    if (clear >= length - 0.01) break;
  }
  // In a tight nook every horizontal view can be blocked. Look from above
  // the body instead of placing the lens inside it.
  if (best.clear < 1.2) {
    const top = Math.min(ceilingHeight(anchor.x, anchor.z) - 0.3, focus[1] + 2.0);
    best.position = [anchor.x, Math.max(focus[1] + 0.75, top), anchor.z];
  }
  const p = best.position;
  p[1] = Math.max(groundHeight(p[0], p[2]) + 0.3,
    Math.min(ceilingHeight(p[0], p[2]) - 0.3, p[1]));
  return { focus, position: p };
}
