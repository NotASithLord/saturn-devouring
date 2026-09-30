#!/usr/bin/env node
// Convert the Halo 3 Orbital station's plated interior surfaces for Saturn.
// Source files and credits: source-assets/halo3-world/NOTICE.txt.
import sharp from 'sharp';

const root = new URL('../source-assets/halo3-world/', import.meta.url);
const out = new URL('../game/assets/world/', import.meta.url);
const files = {
  'h3-wall-color.jpg': 'mc_metal_wall_plate_a_dif.tif',
  'h3-wall-normal.png': 'mc_metal_wall_plate_a_zbump.tif',
  'h3-floor-color.jpg': 'mc_metal_floor_a_dif.tif',
  'h3-floor-normal.png': 'mc_metal_floor_a_zbump.tif',
};
const { cp, mkdir } = await import('node:fs/promises');
await mkdir(out, { recursive: true });
for (const [target, source] of Object.entries(files)) {
  const img = sharp(new URL(source, root).pathname).removeAlpha();
  // Orbital's diffuse exports are deliberately near-black (mean ~45/255).
  // Lift them for Saturn's physically lit interiors so plating remains
  // readable when a flashlight strikes it; ship darkness stays light-driven.
  if (target.endsWith('.jpg')) await img.modulate({ brightness: 2.25 })
    .jpeg({ quality: 85, mozjpeg: true }).toFile(new URL(target, out).pathname);
  else await img.png({ compressionLevel: 9 }).toFile(new URL(target, out).pathname);
}
await cp(new URL('NOTICE.txt', root), new URL('H3-WORLD-NOTICE.txt', out));
console.log('Converted four Halo 3 Orbital surface maps.');
