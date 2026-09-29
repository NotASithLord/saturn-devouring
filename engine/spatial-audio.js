const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Shared by ordinary and through-deck effects: no louder "far" shortcut.
export function spatialMix(listener, at, volume, transmission = {}) {
  if (!at) return { gain: volume, pan: 0, cutoff: 20000 };
  const dx = at.x - listener.x, dz = at.z - listener.z;
  const decks = Math.abs((at.deck ?? listener.deck ?? 0) - (listener.deck ?? 0));
  const d = Math.hypot(dx, dz, decks * 4);
  const fade = clamp((72 - d) / 16, 0, 1);
  const gain = volume * fade / (1 + (d / 8) ** 2) * (transmission.gain ?? 0.16 ** decks);
  const pan = d > 0.5 ? clamp((dx * Math.cos(listener.yaw) - dz * Math.sin(listener.yaw)) / d, -1, 1) * 0.8 : 0;
  return { gain, pan, cutoff: Math.min(18000 / (1 + d / 24), transmission.cutoff ?? (decks ? (decks === 1 ? 350 : 180) : 20000)) };
}

// Match recording levels without boosting near-silence or clipping peaks.
export function balanceRecording(buffer) {
  let energy = 0, peak = 0, count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (const v of data) { energy += v * v; peak = Math.max(peak, Math.abs(v)); count++; }
  }
  const rms = Math.sqrt(energy / Math.max(1, count));
  if (rms < 0.0001 || !Number.isFinite(rms)) return buffer;
  const gain = Math.min(clamp(0.14 / rms, 0.2, 2), 0.85 / Math.max(peak, 0.0001));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  return buffer;
}
