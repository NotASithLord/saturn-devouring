#!/usr/bin/env node
// Convert the extracted Halo 3 Marine FBX into Saturn's instanced, rigid-part
// character format. Source provenance is in source-assets/halo3-marine/NOTICE.txt.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { cp, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../source-assets/halo3-marine/', import.meta.url);
const out = new URL('../game/marine-h3-data.js', import.meta.url);
const textureOut = new URL('../game/assets/characters/', import.meta.url);
const sources = {
  h3_marine_standard: 'marine_standard_game_diffuse.tif',
  h3_marine_equipment: 'marine_arm_pack_perm_diffuse.tif',
  h3_marine_backpack: 'marinebp_diffuse.tif',
  h3_marine_head: 'marine_head_plate.tif',
  h3_marine_eyes: 'eyes_blue.tif',
  h3_marine_teeth: 'teeth.tif',
};
const materialTexture = (name) => {
  if (name.startsWith('marine_standard')) return 'h3_marine_standard';
  if (name === 'equipment' || name === 'goggles') return 'h3_marine_equipment';
  if (name === 'comm_pack') return 'h3_marine_backpack';
  if (name === 'head_smith') return 'h3_marine_head';
  if (name === 'eyes_smith') return 'h3_marine_eyes';
  if (name === 'marine_mouth' || name === 'teeth') return 'h3_marine_teeth';
  return null; // exclude wound decals and unused permutations
};
const chosen = new Set([
  'bodystandard', 'armsstandard', 'headsmith', 'helmeton',
  'packs_cheston', 'packs_thighon', 'packs_abdominon',
  'armorpadson', 'comm_packon', 'cheststandard',
]);
const partOfBone = (name) => {
  if (/head|jaw|eye|^f_/.test(name)) return 'head';
  if (/^(l|r)_(thigh|calf|foot|toe)/.test(name)) return name[0] === 'l' ? 'legL' : 'legR';
  if (/^(l|r)_(clavicle|upperarm|forearm|hand|thumb|index|ring)/.test(name)) return name[0] === 'l' ? 'armL' : 'armR';
  return 'torso';
};
// FBXLoader asks for image elements while parsing. These are external TIFFs;
// the game uses separately converted PNGs below, so no DOM is needed here.
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };
const fbx = await readFile(new URL('marine.fbx', root));
const scene = new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), '');
scene.updateMatrixWorld(true);
const meshes = [];
scene.traverse((object) => { if (object.isSkinnedMesh && chosen.has(object.name)) meshes.push(object); });
if (meshes.length !== chosen.size) throw new Error(`Expected ${chosen.size} Marine permutations, found ${meshes.length}`);

const bounds = new THREE.Box3();
for (const mesh of meshes) bounds.expandByObject(mesh);
const scale = 1.83 / (bounds.max.y - bounds.min.y);
const body = meshes.find((mesh) => mesh.name === 'bodystandard');
const pelvis = body.skeleton.bones.find((bone) => bone.name === 'pelvis').getWorldPosition(new THREE.Vector3());
const centerX = pelvis.x, centerZ = pelvis.z, floorY = bounds.min.y;
const toModel = (v) => [
  +((v.x - centerX) * scale).toFixed(4),
  +((v.y - floorY) * scale).toFixed(4),
  +((v.z - centerZ) * scale).toFixed(4),
];
const pivotNames = { head: 'head', armL: 'l_upperarm', armR: 'r_upperarm', legL: 'l_thigh', legR: 'r_thigh' };
const pivots = Object.fromEntries(Object.entries(pivotNames).map(([part, boneName]) => [
  part, toModel(body.skeleton.bones.find((bone) => bone.name === boneName).getWorldPosition(new THREE.Vector3())),
]));

const groups = new Map();
const position = new THREE.Vector3(), normal = new THREE.Vector3();
for (const mesh of meshes) {
  const geo = mesh.geometry;
  if (geo.index) throw new Error(`Unexpected indexed FBX mesh ${mesh.name}`);
  const positions = geo.getAttribute('position'), normals = geo.getAttribute('normal');
  const uvs = geo.getAttribute('uv'), skinIndex = geo.getAttribute('skinIndex'), skinWeight = geo.getAttribute('skinWeight');
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const bonePart = (i) => {
    let weight = -1, boneIndex = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w > weight) { weight = w; boneIndex = skinIndex.getComponent(i, k); }
    }
    return partOfBone(mesh.skeleton.bones[boneIndex]?.name ?? 'pelvis');
  };
  for (const drawGroup of geo.groups) {
    const tex = materialTexture(mesh.material[drawGroup.materialIndex]?.name ?? '');
    if (!tex) continue;
    for (let i = drawGroup.start; i < drawGroup.start + drawGroup.count; i += 3) {
      const parts = [bonePart(i), bonePart(i + 1), bonePart(i + 2)];
      const part = parts.find((p) => parts.filter((q) => q === p).length >= 2) ?? parts[0];
      const key = `${part}:${tex}`;
      let group = groups.get(key);
      if (!group) { group = { part, tex, pos: [], norm: [], uv: [], idx: [] }; groups.set(key, group); }
      for (let j = i; j < i + 3; j++) {
        position.fromBufferAttribute(positions, j).applyMatrix4(mesh.matrixWorld);
        normal.fromBufferAttribute(normals, j).applyMatrix3(normalMatrix).normalize();
        group.pos.push(...toModel(position));
        group.norm.push(+normal.x.toFixed(3), +normal.y.toFixed(3), +normal.z.toFixed(3));
        group.uv.push(+uvs.getX(j).toFixed(4), +uvs.getY(j).toFixed(4));
        group.idx.push(group.idx.length);
      }
    }
  }
}
const model = { height: 1.83, pivots, groups: [...groups.values()] };
if (model.groups.length < 10 || model.groups.every((g) => g.part !== 'armL')) throw new Error('Incomplete Marine conversion');
await writeFile(out, `// Generated by scripts/convert-h3-marine.mjs. Source provenance: source-assets/halo3-marine/NOTICE.txt.\nexport const H3_MARINE = ${JSON.stringify(model)};\n`);
for (const [key, name] of Object.entries(sources)) {
  await sharp(new URL(`bitmaps/${name}`, root).pathname).removeAlpha().resize(512, 512, { fit: 'inside' })
    .png({ palette: false }).toFile(new URL(`${key}.png`, textureOut).pathname);
}
await cp(new URL('NOTICE.txt', root), new URL('H3-MARINE-NOTICE.txt', textureOut));
console.log(`Halo 3 Marine: ${meshes.length} permutations, ${model.groups.length} groups, ${model.groups.reduce((n, g) => n + g.idx.length / 3, 0)} triangles`);
