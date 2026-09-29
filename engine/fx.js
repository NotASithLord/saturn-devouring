// Fire effects — REWORKED (user: flames were basic and low-res). Each site
// is now a real shader flame: a ray-marched turbulent volume with a black-body
// profile, an ember fountain, a scorch decal burned into the deck, and
// a guttering warm light. Sites come from the sim (breach blaze, burning
// doors, flamethrower burns) plus seeded small damage smolders. The sim owns
// the damaging sites; this module only turns those coordinates into pixels.

import * as THREE from './vendor/three.webgpu.module.js';
import {
  Fn, uv, float, vec2, vec3, vec4,
  fract, sin, dot, floor, mix, smoothstep, abs, clamp, Loop, userData,
  texture, normalize, sqrt, length, cameraPosition, positionWorld,
  modelWorldMatrixInverse, modelScale, mx_noise_float, select, time,
} from './vendor/three.tsl.module.js';

// TSL flame — the same fbm value-noise tongue shader as the old GLSL, term
// for term, but built as a node graph so it compiles to WGSL on WebGPU and
// GLSL on the WebGL2 fallback from one source.
const hash2 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise2 = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  return mix(
    mix(hash2(i), hash2(i.add(vec2(1, 0))), u.x),
    mix(hash2(i.add(vec2(0, 1))), hash2(i.add(vec2(1, 1))), u.x), u.y);
});
const fbm2 = Fn(([pIn]) => {
  const p = pIn.toVar();
  const v = float(0).toVar();
  const a = float(0.5).toVar();
  Loop(4, () => {
    v.addAssign(a.mul(noise2(p)));
    p.mulAssign(2.03);
    a.mulAssign(0.5);
  });
  return v;
});

// Volumetric pool fire adapted from typeWolffo/THREE.Fire's MIT-licensed TSL
// ray-marching approach. It replaces the two intersecting cards whose flat
// silhouette was obvious from doorways. We keep one shared 12-step/2-octave
// graph and a generated 128px profile, avoiding a dependency, network texture,
// or per-ignition shader build. Attribution: engine/vendor/three-fire-NOTICE.txt.
let _fireProfile = null, _flameMat = null;
function fireProfileTexture() {
  if (_fireProfile) return _fireProfile;
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const h = 1 - y / (size - 1);
    for (let x = 0; x < size; x++) {
      const radius = x / (size - 1);
      const envelope = Math.max(0, 1 - radius * (1.05 + h * 1.35));
      const base = Math.min(1, h / 0.08);
      const tip = Math.min(1, (1 - h) / 0.18);
      const density = Math.pow(envelope, 1.45) * base * tip;
      const heat = Math.min(1, density * 1.7 + (1 - h) * 0.2);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = Math.round(45 + heat * 190);
      image.data[i + 2] = Math.round(4 + heat * heat * 105);
      image.data[i + 3] = Math.round(density * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  _fireProfile = new THREE.CanvasTexture(canvas);
  _fireProfile.colorSpace = THREE.SRGBColorSpace;
  _fireProfile.minFilter = THREE.LinearFilter;
  _fireProfile.magFilter = THREE.LinearFilter;
  _fireProfile.wrapS = _fireProfile.wrapT = THREE.ClampToEdgeWrapping;
  return _fireProfile;
}

function flameMaterial() {
  if (_flameMat) return _flameMat;
  const seed = userData('fireSeed', 'float');
  const profile = fireProfileTexture();
  const turbulence = Fn(([pIn]) => {
    const p = vec3(pIn).toVar();
    const sum = float(0).toVar();
    const freq = float(1).toVar();
    const amp = float(1).toVar();
    Loop(2, () => {
      sum.addAssign(abs(mx_noise_float(p.mul(freq))).mul(amp));
      freq.mulAssign(2.0);
      amp.mulAssign(0.5);
    });
    return sum;
  });
  const sampleFire = Fn(([local]) => {
    const st = vec2(sqrt(dot(local.xz, local.xz)), local.y).toVar();
    const p = vec3(local).toVar();
    p.y.subAssign(seed.add(time).mul(0.42));
    p.assign(p.mul(vec3(1.1, 2.1, 1.1)));
    st.y.addAssign(sqrt(st.y.max(0)).mul(1.24).mul(turbulence(p)));
    const outside = st.x.lessThanEqual(0).or(st.x.greaterThanEqual(1))
      .or(st.y.lessThanEqual(0)).or(st.y.greaterThanEqual(1));
    const sample = texture(profile, st).toVar();
    // The generated profile stores bright RGB even where density/alpha is
    // zero. Premultiply each march sample or the empty box walls glow.
    return select(outside, vec4(0), vec4(sample.rgb.mul(sample.a), sample.a));
  });
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false,
  });
  mat.colorNode = Fn(() => {
    const ray = vec3(positionWorld).toVar();
    // Start on the box's back faces and march toward the viewer, through the
    // flame. Marching away from the viewer exited the box immediately, which
    // left crash-site flames invisible while their lights kept glowing.
    const direction = normalize(cameraPosition.sub(ray));
    const step = float(0.045).mul(length(modelScale));
    const color = vec4(0).toVar();
    Loop(12, () => {
      ray.addAssign(direction.mul(step));
      const local = modelWorldMatrixInverse.mul(vec4(ray, 1)).xyz.toVar();
      local.x.mulAssign(2.0); local.z.mulAssign(2.0);
      // The profile is sampled from a premultiplied canvas texture. A low
      // accumulation factor made the volume technically present but almost
      // invisible on dark scenes, leaving only the additive ember sprites
      // readable. Keep the same twelve-step budget and restore the intended
      // solid flame body by accumulating enough density for one visible pass.
      color.addAssign(sampleFire(local).mul(0.42));
    });
    return vec4(color.rgb, clamp(color.a, 0, 0.98));
  })();
  _flameMat = mat;
  return mat;
}

// billboard-quad scratch (embers/sparks are instanced quads now — the node
// renderer draws point primitives at a fixed 1px, so THREE.Points sprites
// silently vanished on both backends)
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _IDENT_Q = new THREE.Quaternion();

export class FireFX {
  constructor(scene, lightPool = null) {
    this.scene = scene;
    this.pool = lightPool; // fire light goes through the global pool (perf)
    this.camera = null;    // main.js sets this; embers billboard to its quaternion
    this.fires = new Map();
    this._volumeGeo = new THREE.BoxGeometry(1, 1, 1);
    this._volumeGeo.translate(0, 0.5, 0); // pivot at the pool on the deck
    this._scorchTex = FireFX._makeScorchTex();
    this._spotTex = FireFX._makeSpotTex();
    // shared across fires: ember quad + material, scorch geometry + material
    this._emberGeo = new THREE.PlaneGeometry(1, 1);
    this._emberMat = new THREE.MeshBasicMaterial({
      color: 0xffb45c, map: this._spotTex, alphaMap: this._spotTex,
      transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    });
    this._scorchGeo = new THREE.PlaneGeometry(1, 1);
    this._scorchMat = new THREE.MeshBasicMaterial({
      map: this._scorchTex, transparent: true, depthWrite: false,
    });
  }

  static _makeSpotTex() {
    // soft round sprite for embers/sparks — points stop rendering as squares
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(16, 16, 1, 16, 16, 15);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  static _makeScorchTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 6, 64, 64, 62);
    g.addColorStop(0, 'rgba(4,3,2,0.9)');
    g.addColorStop(0.55, 'rgba(8,6,4,0.55)');
    g.addColorStop(1, 'rgba(10,8,6,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    // charred flecks
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 52;
      x.fillStyle = `rgba(2,2,2,${0.2 + Math.random() * 0.4})`;
      x.fillRect(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 2 + Math.random() * 3, 1 + Math.random() * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  add(key, x, z, elev, scale = 1) {
    if (this.fires.has(key)) return;
    const group = new THREE.Group();
    const volume = new THREE.Mesh(this._volumeGeo, flameMaterial());
    volume.userData.fireSeed = Math.abs((x * 7.3 + z * 3.1) % 19.19);
    volume.scale.set(1.55 * scale, 2.25 * scale, 1.55 * scale);
    volume.position.set(x, elev + 0.02, z);
    volume.renderOrder = 4;
    group.add(volume);
    // embers: a sparse fountain of hot instanced billboard quads
    const N = 26;
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) seeds[i] = (i * 0.61803398) % 1;
    // per-fire geometry CLONE so this mesh can carry its own bounding
    // sphere (instance matrices are world-space; the shared quad geo has no
    // meaningful bounds) — a fire behind the camera then frustum-culls
    // instead of encoding 26 instances every frame (perf pass 4)
    const emberGeo = this._emberGeo.clone();
    emberGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(x, elev + 2, z), 2.5 + 2.5 * scale);
    const embers = new THREE.InstancedMesh(emberGeo, this._emberMat, N);
    _scl.setScalar(0.085 * scale);
    for (let i = 0; i < N; i++) {
      _m4.compose(_pos.set(x, elev, z), _IDENT_Q, _scl);
      embers.setMatrixAt(i, _m4);
    }
    embers.renderOrder = 4;
    group.add(embers);
    // scorch burned into the deck under the fire (shared geo/mat, scaled)
    const scorch = new THREE.Mesh(this._scorchGeo, this._scorchMat);
    scorch.scale.setScalar(2.4 * scale);
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(x, elev + 0.012, z);
    scorch.renderOrder = 1;
    group.add(scorch);
    this.scene.add(group);
    this.fires.set(key, {
      group, volume, scorch, embers, x, z, elev, scale,
      t: (x * 7 + z * 3) % 10, seeds, lum: 5 * scale, // pooled guttering light
    });
  }

  // A live stream continually refines its contact point. Moving the pooled
  // render object is cheap and, critically, keeps the visible pool on the same
  // coordinates used by damage instead of freezing at its first frame.
  move(key, x, z, elev, scale = 1) {
    const f = this.fires.get(key);
    if (!f) return;
    f.x = x; f.z = z; f.elev = elev; f.scale = scale;
    f.volume.position.set(x, elev + 0.02, z);
    f.volume.scale.set(1.55 * scale, 2.25 * scale, 1.55 * scale);
    f.scorch.position.set(x, elev + 0.012, z);
    f.scorch.scale.setScalar(2.4 * scale);
    f.embers.geometry.boundingSphere?.center.set(x, elev + 2, z);
  }

  remove(key) {
    const f = this.fires.get(key);
    if (!f) return;
    this.scene.remove(f.group);
    // volume/scorch use shared material+geometry (never disposed); the only
    // per-fire GPU resource is the ember instance buffer (review swarm: the
    // old remove() leaked ember/scorch geometry and materials)
    f.embers.dispose();
    this.fires.delete(key);
  }

  // nearest burning site to a point (for the crackle audio)
  nearest(px, pz, deckElev) {
    let best = null, bestD = Infinity;
    for (const f of this.fires.values()) {
      if (Math.abs(f.elev - deckElev) > 1) continue;
      const d = Math.hypot(f.x - px, f.z - pz);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best ? { x: best.x, z: best.z, d: bestD } : null;
  }

  update(dt, px, pz, pElev = null) {
    for (const f of this.fires.values()) {
      f.t += dt;
      // gutter: incommensurate sines + a fast spit read as real fire-light —
      // declared to the pool; only the fires near you burn real light slots
      f.lum = Math.max(0.5,
        (5.2 + Math.sin(f.t * 11) * 1.7 + Math.sin(f.t * 23.7) * 1.2
          + Math.sin(f.t * 47.3) * 0.5) * f.scale);
      this.pool?.add(f.x, f.elev + 0.9, f.z, 0xff7a28, f.lum, 10 + 6 * f.scale, 1.7);
      const dx = f.x - px, dz = f.z - pz;
      const d2 = dx * dx + dz * dz;
      // far or 2+ decks away: the pooled light above still glows through
      // stairwells, but the cards/embers/scorch leave the render list
      // entirely (perf pass 4 — they used to stay live render objects).
      // ±1 deck stays visible: wells and hatch holes give real sightlines.
      // f.t keeps advancing, so a fire re-entering range doesn't rewind.
      const vis = d2 <= 55 * 55 && (pElev === null || Math.abs(f.elev - pElev) < 6.3);
      f.group.visible = vis;
      if (!vis) continue;
      // embers rise and die — instanced quads billboarded to the camera
      const q = this.camera?.quaternion ?? _IDENT_Q;
      _scl.setScalar(0.085 * f.scale);
      for (let i = 0; i < f.embers.count; i++) {
        const s = f.seeds[i];
        const life = (f.t * (0.35 + s * 0.5) + s * 7) % 1;
        const ang = s * 6.283 + f.t * (s - 0.5) * 1.6;
        const r = 0.4 * f.scale * (0.3 + s * 0.7) * (0.5 + life * 0.8);
        _m4.compose(_pos.set(
          f.x + Math.cos(ang) * r,
          f.elev + 0.15 + life * (1.9 + s) * f.scale,
          f.z + Math.sin(ang) * r), q, _scl);
        f.embers.setMatrixAt(i, _m4);
      }
      f.embers.instanceMatrix.needsUpdate = true;
    }
  }
}

// FLAME JET (the flamethrower had no visual identity at all — the one weapon
// that permanently destroys a downed form was invisible). This is NOT FireFX
// with a different transform: a pool fire is a column that rises off a fixed
// base, and everything about its shader — turbulence scrolling DOWN so tongues
// rise, an envelope that is wide at the bottom and licks to a point — is that
// column. Pressurised fuel is the opposite: it is thrown ALONG an axis, it is
// tightest at the nozzle and widens as it decelerates, and it burns out rather
// than tapering. So the axis here is the quad's U, the turbulence scrolls
// OUTWARD along it, and the envelope opens instead of closing.
//
// Two crossed cards containing the jet axis, rolled about that axis so one of
// them is face-on to the camera — the same trick FireFX uses to make a flat
// quad read as volume, applied to a horizontal stream. Pooled: rigs are built
// once and re-aimed, because a flamethrower fires in bursts and building a
// mesh per burst would hitch.
let _jetMat = null;
function jetMaterial() {
  if (_jetMat) return _jetMat;
  const uT = userData('jetT', 'float');
  const uSeed = userData('jetSeed', 'float');
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
  });
  mat.colorNode = Fn(() => {
    const u = uv().x;                          // 0 at the nozzle, 1 at the reach
    const v = uv().y.sub(0.5).mul(2.0);        // -1..1 across the stream
    // THREE turbulence layers, all travelling OUTWARD down the axis and all at
    // different speeds — the shear between them is the one term that separates
    // a jet from a puff. One layer alone slides as a single texture and reads
    // as a lit cigar, which is exactly what the first pass looked like.
    const n1 = fbm2(vec2(u.mul(3.0).sub(uT.mul(6.0)).add(uSeed.mul(13.0)), uv().y.mul(2.6)));
    const n2 = fbm2(vec2(u.mul(7.0).sub(uT.mul(10.0)).add(uSeed.mul(7.0)), uv().y.mul(5.5)));
    const n3 = fbm2(vec2(u.mul(15.0).sub(uT.mul(17.0)).add(uSeed.mul(3.0)), uv().y.mul(11.0)));
    // the cone: a tight throat at the nozzle opening out as the fuel slows.
    // pow < 1 flares it early and keeps it spreading, which is what pressurised
    // fuel does once it loses the barrel. CAPPED below 1 so the ragged edge can
    // never reach the quad's own boundary — uncapped, the noise pushed the
    // envelope past it and you could see the rectangle.
    const cone = float(0.045).add(u.pow(0.75).mul(0.86)).min(0.82);
    const edge = cone.mul(n1.mul(1.0).add(0.45));
    const r = clamp(abs(v).div(edge.max(0.02)), 0.0, 1.0);
    // ...and a fade well inside the quad rim on top of the cap, so the card can
    // have no silhouette of its own under ANY noise value. Without it the thin
    // outer haze survived to |v| = 1 and cut off square: from inside the plume
    // you could see the rectangle ruled across the compartment.
    const core = r.oneMinus().pow(1.45).mul(smoothstep(0.66, 0.97, abs(v)).oneMinus());
    // SLUGS. Fuel does not leave a nozzle at a constant rate — it comes in
    // gouts, and the density pulsing along the axis is most of what makes this
    // read as something being PUSHED rather than a static cone that is on.
    const slug = n2.mul(1.3).add(0.35);
    // the hot core survives; the skirt shreds. Restricting the fine octave to
    // the outside is what keeps the middle looking dense instead of noisy.
    const shred = mix(float(1.0), n3.mul(1.9), smoothstep(0.15, 0.95, r));
    // ignites just off the nozzle and burns itself out towards the reach, with
    // the tail broken up so the far end sheds detached puffs
    const lit = smoothstep(0.0, 0.07, u)
      .mul(smoothstep(0.66, 1.06, u.add(n2.sub(0.5).mul(0.5))).oneMinus())
      // and a guaranteed stop at the quad's far end — the noise term above can
      // leave a third of the density alive at u = 1, which cuts off square
      .mul(smoothstep(0.88, 1.0, u).oneMinus());
    const f = clamp(core.mul(slug).mul(shred).mul(lit).mul(1.25), 0.0, 1.0);
    // black-body along the burn: white-hot where the fuel is still dense,
    // cooling to sooty red as it spends itself down the axis
    const heat = clamp(f.mul(float(1.25).sub(u.mul(0.55))), 0.0, 1.0);
    const col = mix(
      mix(vec3(0.55, 0.06, 0.0), vec3(1.0, 0.42, 0.03), smoothstep(0.10, 0.55, heat)),
      vec3(1.0, 0.90, 0.62), smoothstep(0.70, 1.0, heat));
    // THE THROAT. Unburnt fuel leaving the nozzle is blue, and that hard blue
    // root — tight, and only in the first tenth — is most of what reads as
    // "under pressure" rather than "on fire".
    const throat = smoothstep(0.0, 0.11, u).oneMinus().mul(r.oneMinus().pow(3.0));
    return vec4(col.add(vec3(0.34, 0.58, 1.0).mul(throat).mul(1.1)),
      clamp(f.mul(0.8).add(throat.mul(0.55)), 0.0, 1.0));
  })();
  _jetMat = mat;
  return mat;
}

const _xA = new THREE.Vector3(), _yA = new THREE.Vector3(), _zA = new THREE.Vector3();
const _nY = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _mBasis = new THREE.Matrix4();

export class FlameJetFX {
  // `n` rigs is the hard cap on simultaneous jets. The ship carries two
  // flamethrowers, so 4 is slack, not a budget.
  constructor(scene, lightPool = null, n = 4) {
    this.scene = scene;
    this.pool = lightPool;
    this.camera = null;  // main.js sets this; the droplets billboard to it
    this.t = 0;
    this._n = 0;         // jets declared this frame
    this._live = [];
    this.rigs = [];
    this._max = n;
    this._quadGeo = new THREE.PlaneGeometry(1, 1);
    this._quadGeo.translate(0.5, 0, 0);  // pivot at the NOZZLE, +X down the jet
    this._dropGeo = new THREE.PlaneGeometry(1, 1);
    this._dropTex = FireFX._makeSpotTex();
    this._dropMat = new THREE.MeshBasicMaterial({
      color: 0xffa040, map: this._dropTex, alphaMap: this._dropTex,
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    });
  }

  _rig(i) {
    if (this.rigs[i]) return this.rigs[i];
    const group = new THREE.Group();
    const cards = [];
    for (let k = 0; k < 2; k++) {
      const c = new THREE.Mesh(this._quadGeo, jetMaterial());
      c.userData.jetT = 0;
      c.userData.jetSeed = k * 0.37;
      c.frustumCulled = false;
      c.renderOrder = 5;
      group.add(c);
      cards.push(c);
    }
    // BURNING DROPLETS. Fuel that fails to atomise gets thrown down the axis
    // and falls out of the stream still alight — the detail that says liquid
    // rather than gas, and it is what puts fire on the deck short of the target.
    const N = 22;
    const drops = new THREE.InstancedMesh(this._dropGeo, this._dropMat, N);
    drops.frustumCulled = false;
    drops.renderOrder = 5;
    group.add(drops);
    group.visible = false;
    this.scene.add(group);
    const rig = {
      group, cards, drops,
      seeds: Array.from({ length: N }, (_, j) => (j * 0.6180339887) % 1),
    };
    this.rigs[i] = rig;
    return rig;
  }

  // declare a jet for THIS frame (light-pool style — nothing persists, so a
  // burst that ends simply stops being declared and the rig goes dark)
  frame() { this._n = 0; }

  emit(ox, oy, oz, dx, dy, dz, len, seed = 0) {
    if (this._n >= this._max) return;
    const r = this._live[this._n] ?? (this._live[this._n] = {});
    r.ox = ox; r.oy = oy; r.oz = oz;
    r.dx = dx; r.dy = dy; r.dz = dz;
    r.len = len; r.seed = seed;
    this._n++;
  }

  update(dt, camX, camY, camZ) {
    this.t += dt;
    for (let i = 0; i < this.rigs.length; i++) {
      if (i >= this._n && this.rigs[i]) this.rigs[i].group.visible = false;
    }
    for (let i = 0; i < this._n; i++) {
      const j = this._live[i];
      const rig = this._rig(i);
      rig.group.visible = true;
      const L = j.len;
      // ROLL THE CARDS ABOUT THE JET AXIS so one of them presents its face to
      // the eye. A flame card seen edge-on is a line; billboarding the pair
      // about the axis (rather than freely, which would swing the jet off its
      // own aim) keeps the stream pointing where the barrel points and still
      // gives it a face.
      _xA.set(j.dx, j.dy, j.dz).normalize();
      _toCam.set(camX - j.ox, camY - j.oy, camZ - j.oz);
      _yA.crossVectors(_toCam, _xA);
      if (_yA.lengthSq() < 1e-8) _yA.set(0, 1, 0).cross(_xA); // dead-on: any perpendicular
      _yA.normalize();
      _zA.crossVectors(_xA, _yA);
      // width grows with reach — a 3 m squirt and an 8 m gout are not the same
      // stream scaled up; the far end of a long one has spread much further
      const W = 0.55 + L * 0.20;
      _nY.copy(_yA).negate();
      for (let k = 0; k < 2; k++) {
        const c = rig.cards[k];
        c.userData.jetT = this.t;
        c.userData.jetSeed = j.seed * 0.019 + k * 0.41;
        // card 0 faces the camera; card 1 is the same quad rolled 90° about
        // the axis, so the pair crosses through the stream. (xA, zA, -yA) and
        // not (xA, zA, yA): the latter is left-handed and setFromRotationMatrix
        // has no rotation to give back for a mirrored basis.
        _mBasis.makeBasis(_xA, k === 0 ? _yA : _zA, k === 0 ? _zA : _nY);
        c.quaternion.setFromRotationMatrix(_mBasis);
        c.position.set(j.ox, j.oy, j.oz);
        c.scale.set(L, W, 1);
      }
      // droplets: launched down the axis, decelerating, falling out of it
      const q = this.camera?.quaternion ?? _IDENT_Q;
      for (let d = 0; d < rig.drops.count; d++) {
        const s = rig.seeds[d];
        const life = (this.t * (0.9 + s * 0.7) + s * 5.3) % 1;
        const run = L * life * (0.55 + s * 0.6);
        const fall = 2.6 * life * life * (0.4 + s);
        const lat = (s - 0.5) * W * life * 1.6;
        _scl.setScalar(0.05 + s * 0.05);
        _m4.compose(_pos.set(
          j.ox + _xA.x * run + _yA.x * lat,
          j.oy + _xA.y * run + _yA.y * lat - fall,
          j.oz + _xA.z * run + _yA.z * lat), q, _scl);
        rig.drops.setMatrixAt(d, _m4);
      }
      rig.drops.instanceMatrix.needsUpdate = true;
      // LIGHT. Burning fuel thrown across a room is a moving source, and it is
      // three sources, not one — a hard white root at the nozzle and a broad
      // orange body down the stream, so the near wall and the far wall are lit
      // differently. Guttered on incommensurate sines, as the pool fires are.
      const g = 1 + Math.sin(this.t * 27) * 0.22 + Math.sin(this.t * 51.3) * 0.13;
      this.pool?.add(j.ox + _xA.x * 0.3, j.oy + _xA.y * 0.3, j.oz + _xA.z * 0.3,
        0xffd9a0, 20 * g, 8, 2.0);
      this.pool?.add(j.ox + _xA.x * L * 0.45, j.oy + _xA.y * L * 0.45, j.oz + _xA.z * L * 0.45,
        0xff8a30, 26 * g, 11 + L, 1.7);
      this.pool?.add(j.ox + _xA.x * L * 0.9, j.oy + _xA.y * L * 0.9 + 0.2, j.oz + _xA.z * L * 0.9,
        0xff6a20, 18 * g, 10 + L, 1.7);
    }
  }
}

// BLOOD MARKS (user: rooms should tell their own story): a dark pool with
// drag streaks stamped onto the deck where someone was taken or fell.
// Render-only, ring-buffered so a long run can't accumulate unbounded
// decals — old marks fade under new ones. One shared texture + material.
export class BloodFX {
  constructor(scene) {
    this.scene = scene;
    this.idx = 0;
    this.max = 44;
    this._geo = new THREE.PlaneGeometry(1, 1);
    // decals are floor-flat; bake the lie-down into the geometry once so the
    // per-instance matrix carries only the deck-normal spin (was rotation.z
    // pre-rotate; the same seed spins about Y now — identical visual)
    this._geo.rotateX(-Math.PI / 2);
    // Several baked VARIANTS, picked per mark: one shared texture made every
    // pool in the ship a rotated copy of the same perfect circle, which read
    // as a decal sticker rather than something that bled out of a body.
    this._mats = [0, 1, 2, 3].map((v) => {
      const tex = new THREE.CanvasTexture(BloodFX._bake(v));
      tex.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    });
    // FOUR INSTANCED MESHES, ONE PER VARIANT (perf pass 5, adversarially
    // verified) — the old pool allocated one transparent Mesh PER DECAL, up
    // to 44 individual object passes late-game. Instances write their matrix
    // on add() and never per frame; zero-scale slots are degenerate triangles
    // the rasterizer drops. Do NOT mark these static (the ring recycles
    // slots — a static object skips the binding update and a recycled decal
    // would render at its previous position), and do NOT deck-gate via count
    // (ring slots for one deck are not contiguous; measured worth ~4 calls).
    this._slotVar = new Int8Array(this.max).fill(-1);
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._meshes = this._mats.map((mat) => {
      const im = new THREE.InstancedMesh(this._geo, mat, this.max);
      for (let i = 0; i < this.max; i++) im.setMatrixAt(i, this._zero);
      im.renderOrder = 1;
      im.frustumCulled = false; // instance matrices are world-space
      this.scene.add(im);
      return im;
    });
  }

  // One pool: overlapping off-centre blobs for a lumpy silhouette, a dark
  // settled centre, drag smears, and a scatter of satellite droplets. The
  // PRNG is seeded per variant, so the bake is byte-identical every boot.
  static _bake(variant) {
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    let s = (0x9e3779b9 ^ Math.imul(variant + 1, 0x85ebca6b)) >>> 0;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const cx = S / 2, cy = S / 2;
    // An organic outline, not a circle: a base radius modulated by a few
    // harmonics with per-variant phase. Stacked radial gradients (the first
    // attempt) read as fuzzy overlapping clouds — liquid needs a DEFINED
    // edge with the soft stain outside it.
    const ph = [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283];
    const lobe = (a, R) => R * (1 + 0.17 * Math.sin(a * 2 + ph[0])
      + 0.11 * Math.sin(a * 3 + ph[1]) + 0.07 * Math.sin(a * 5 + ph[2]));
    const outline = (R, ox = 0, oy = 0) => {
      x.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2, r = lobe(a, R);
        const px = cx + ox + Math.cos(a) * r, py = cy + oy + Math.sin(a) * r;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
      x.closePath();
    };
    const R = 0.30 * S;

    // STAIN — soaked-in halo around the pool, well outside its edge
    const halo = x.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.6);
    halo.addColorStop(0, 'rgba(36,5,7,0.42)');
    halo.addColorStop(1, 'rgba(30,4,6,0)');
    x.fillStyle = halo;
    x.fillRect(0, 0, S, S);

    // POOL — hard-edged liquid body, plus a couple of lobes spilling off it
    // (drawn in the same pass so they UNION instead of ringing each other)
    x.fillStyle = 'rgb(44,5,8)';
    outline(R); x.fill();
    const spills = 2 + ((variant + 1) % 2);
    for (let i = 0; i < spills; i++) {
      const a = rnd() * Math.PI * 2, d = (0.18 + rnd() * 0.14) * S;
      outline((0.10 + rnd() * 0.07) * S, Math.cos(a) * d, Math.sin(a) * d);
      x.fill();
    }

    // DEPTH — darkest where it pooled deepest, clipped to the liquid so the
    // gradient can never bleed past the edge
    x.save();
    outline(R); x.clip();
    const dg = x.createRadialGradient(cx - R * 0.15, cy - R * 0.1, 0, cx, cy, R * 1.05);
    dg.addColorStop(0, 'rgba(18,2,3,0.85)');
    dg.addColorStop(0.55, 'rgba(30,3,5,0.35)');
    dg.addColorStop(1, 'rgba(62,8,11,0)');
    x.fillStyle = dg;
    x.fillRect(0, 0, S, S);
    x.restore();

    // SMEARS — tapered drags pulled out of the rim (a body was moved here)
    const smears = 5 + ((variant * 3) % 4);
    for (let i = 0; i < smears; i++) {
      const a = rnd() * Math.PI * 2;
      // start AT the rim, not inside it — a smear that begins at the centre
      // draws as a needle laid across the pool instead of a drag out of it
      const r0 = lobe(a, R) * 0.94, r1 = r0 + R * (0.25 + rnd() * 0.75);
      const bend = (rnd() - 0.5) * 0.5;   // smears curve; they aren't rays
      const steps = 8;
      const at = (t) => {
        const rr = r0 + (r1 - r0) * t, aa = a + bend * t * t;
        return [cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr];
      };
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        x.strokeStyle = `rgba(40,4,7,${(0.55 * (1 - t0) ** 1.5).toFixed(3)})`;
        x.lineWidth = (1 - t0) * (2.4 + rnd() * 2.2) + 0.35;
        x.lineCap = 'round';
        x.beginPath();
        x.moveTo(...at(t0));
        x.lineTo(...at(t1));
        x.stroke();
      }
    }

    // SPATTER — thrown droplets, crisp (surface tension) and smaller further out
    const drops = 18 + ((variant * 5) % 12);
    for (let i = 0; i < drops; i++) {
      const a = rnd() * Math.PI * 2;
      const t = rnd();
      const d = R * (1.05 + t * 0.55);
      const rr = (1 - t) * 2.2 + 0.55;
      const dx = cx + Math.cos(a) * d, dy = cy + Math.sin(a) * d;
      x.fillStyle = `rgba(40,4,7,${(0.9 - t * 0.35).toFixed(3)})`;
      x.beginPath();
      x.ellipse(dx, dy, rr, rr * (0.6 + rnd() * 0.5), a, 0, Math.PI * 2); // elongated along the throw
      x.fill();
    }
    return c;
  }

  // `sizeMul` lets the caller mark a heavier event (a body dragging itself
  // back up leaves more than a clean fall).
  add(wx, wz, elev, seed = 0, sizeMul = 1) {
    const v = (seed >>> 3) % this._meshes.length;
    const prev = this._slotVar[this.idx];
    if (prev >= 0 && prev !== v) { // ring reuse across variants: clear the old home
      this._meshes[prev].setMatrixAt(this.idx, this._zero);
      this._meshes[prev].instanceMatrix.needsUpdate = true;
    }
    this._q.setFromEuler(this._e.set(0, (seed * 2.399) % (Math.PI * 2), 0));
    this._scl.setScalar((1.1 + ((seed * 97) % 10) / 8) * sizeMul);
    this._pos.set(
      // the jitter used to be ±0.42 m, which threw the mark clear of the body
      // it belonged to; now the sim hands us the exact spot, so this is only
      // enough wobble to keep repeat marks from stacking perfectly
      wx + (((seed * 31) % 7) - 3) * 0.05,
      elev + 0.014 + (this.idx % 7) * 0.0005, // tiny y-stagger kills z-fighting between marks
      wz + (((seed * 17) % 7) - 3) * 0.05);
    this._m4.compose(this._pos, this._q, this._scl);
    this._meshes[v].setMatrixAt(this.idx, this._m4);
    this._meshes[v].instanceMatrix.needsUpdate = true;
    this._slotVar[this.idx] = v;
    this.idx = (this.idx + 1) % this.max;
  }
}

// SPARKING PANELS (user: better damage effects through the ship): a damaged
// junction spits a burst of sparks at random intervals — a crackle of hot
// points and a hard blue-white stab of light, then dark again. Sites are
// seeded per run by the game. Render-only.
export class SparkFX {
  constructor(scene, lightPool = null) {
    this.scene = scene;
    this.pool = lightPool;
    this.camera = null; // main.js sets this; sparks billboard to its quaternion
    this.sites = [];
    this._n = 18;
    this._spotTex = FireFX._makeSpotTex();
    this._quadGeo = new THREE.PlaneGeometry(1, 1);
  }

  add(x, y, z) {
    // instanced billboard quads (Points render 1px under the node renderer);
    // material cloned per site because opacity animates per burst — standard
    // materials share their compiled program regardless
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcfe4ff, transparent: true, opacity: 0,
      map: this._spotTex, alphaMap: this._spotTex,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const pts = new THREE.InstancedMesh(this._quadGeo, mat, this._n);
    _scl.setScalar(0.06);
    for (let i = 0; i < this._n; i++) {
      _m4.compose(_pos.set(x, y, z), _IDENT_Q, _scl);
      pts.setMatrixAt(i, _m4);
    }
    pts.renderOrder = 4;
    pts.frustumCulled = false;
    pts.visible = false;
    this.scene.add(pts);
    this.sites.push({
      x, y, z, pts,
      next: 2 + ((x * 13.7 + z * 7.3) % 9),  // staggered first burst
      burst: -1, seeds: Array.from({ length: this._n }, (_, i) => (i * 0.754877) % 1),
    });
  }

  update(dt, t, px, pz, pElev = null) {
    for (const s of this.sites) {
      if (s.burst < 0) {
        s.next -= dt;
        // vertical gate matches FireFX (perf pass 4): no bursts 2+ decks
        // away — s.y is elev + 1.7 (see add() callers)
        if (s.next <= 0 && Math.hypot(s.x - px, s.z - pz) < 60
          && (pElev === null || Math.abs(s.y - 1.7 - pElev) < 6.3)) {
          s.burst = 0;
          s.pts.visible = true;
          s.next = 4 + Math.random() * 11; // interval to the NEXT burst
        }
        continue;
      }
      s.burst += dt;
      const p = s.burst / 0.45;
      if (p >= 1) { s.burst = -1; s.pts.material.opacity = 0; s.pts.visible = false; continue; }
      // hard stab of light with a fast flicker, sparks arcing down under gravity
      this.pool?.add(s.x, s.y, s.z, 0x9fc8ff, (1 - p) * (7 + Math.sin(t * 90) * 4), 7, 2.0);
      s.pts.material.opacity = 1 - p;
      const q = this.camera?.quaternion ?? _IDENT_Q;
      _scl.setScalar(0.06);
      for (let i = 0; i < s.pts.count; i++) {
        const sd = s.seeds[i];
        const ang = sd * 6.283, v = 1.4 + sd * 2.4;
        _m4.compose(_pos.set(
          s.x + Math.cos(ang) * v * p,
          s.y + (sd - 0.2) * 1.2 * p - 3.2 * p * p, // ballistic fall
          s.z + Math.sin(ang) * v * p * 0.6), q, _scl);
        s.pts.setMatrixAt(i, _m4);
      }
      s.pts.instanceMatrix.needsUpdate = true;
    }
  }
}
