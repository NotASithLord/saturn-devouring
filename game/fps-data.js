// FPS mechanics constants — ported from the first-strike vertical slice
// (js/data.js), tuned for Saturn Devouring. Decoupling contract preserved:
// mechanics read these rows, nothing hardcodes a name.

export const MA5 = {
  name: 'MA5 ASSAULT RIFLE', // what every marine aboard carries
  rpm: 900,
  damage: 8,
  mag: 60,
  reserve: 360,
  reloadS: 2.3,
  spreadBaseDeg: 1.35,
  spreadMaxDeg: 6.2,
  bloomPerShotDeg: 0.38,
  spreadDecayDegS: 4.4,
  kickDeg: 0.2,
  meleeDamage: 45,
  meleeRange: 2.2,
  meleeCooldownS: 0.9,
};

export const ODST = {
  // "an ODST with extra life": ballistic armor over meat — the armor layer
  // soaks damage and recovers when you break contact; the health under it
  // does not.
  armor: 50,
  health: 45,
  armorDelayS: 4.2,
  armorRegenPerS: 22,
  // movement (first-strike player feel — the old 2.4 m/s walk read as mud)
  walkSpeed: 5.6,
  sprintSpeed: 7.6,
  accel: 14,
  airControl: 0.35,
  gravity: 24,
  jumpVel: 8.2,
  eyeHeight: 1.62,
  climbSpeed: 2.6,
  // how fast a knockback bleeds off (see FpsController.shoveX). 7/s puts a
  // A claw hit moves the capsule about a metre, then returns control promptly.
  // The wall sweep still spends the impulse harmlessly against solid geometry.
  shoveDecayPerSec: 6,
};

export const FRAG = {
  count: 4,          // you board with four
  max: 12,           // how many you can carry (resupply at the armory)
  throwSpeed: 24,    // m/s out of the hand — a real hard throw, reaches across a bay
  upBoost: 4.2,      // lofted arc so it carries down a long corridor
  gravity: 20,
  fuseS: 2.04,       // 15% shorter fuse; still long enough for the full throw arc
  bounce: 0.42,      // velocity kept on impact
  radiusM: 8,        // heavy blast — clears a room, not just a corner
  damage: 135,       // sim explodeAt payload (falls off to ~40% at the edge)
};
