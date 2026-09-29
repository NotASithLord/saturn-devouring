// Combat and damage model (§7): node-local exchanges, integrity vs damage,
// downed/self-revive gating, shaft ambush first strikes, vent exposure kills,
// the flamethrower as an economy weapon.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE, makeAgent } from './init.js';
import { TASK } from './hive.js';
import { explodeCarrier } from './floodExec.js';

// deterministic per-agent marksmanship in [1-spread, 1+spread] — squads have
// a good shot and a poor one, hashed off the id so replay/lockstep hold
function marksman01(id) {
  let h = (id | 0) ^ 0x2c1b3c6d;
  h = Math.imul(h ^ (h >>> 15), 0x297a2d39);
  h ^= h >>> 13;
  return (h >>> 0) / 0xffffffff;
}

// Keep a shooter on the closest target it already acquired. A different form
// only earns the retarget when it is physically closer; equal range does not
// make aim flicker between bodies from one shot to the next.
export function selectRifleTarget(currentId, candidates) {
  let current = null, nearest = null;
  for (const candidate of candidates) {
    if (candidate.target.id === currentId) current = candidate;
    if (!nearest || candidate.range < nearest.range - 1e-9
      || (Math.abs(candidate.range - nearest.range) <= 1e-9
        && candidate.target.id < nearest.target.id)) nearest = candidate;
  }
  if (!current || (nearest && nearest.range < current.range - 1e-9)) return nearest;
  return current;
}

// The physical payload of a Flood whip. Kept pure so headless verification
// can pin the standing/running/jumping ordering independently of the ragdoll
// renderer. Direction is in sim X/Y; Agents3D maps sim Y directly to world Z.
export function combatMeleeImpulse(attacker, target, swing) {
  let dx = target.x - attacker.x, dy = target.y - attacker.y;
  const d = Math.hypot(dx, dy);
  if (d > 1e-6) { dx /= d; dy /= d; }
  else { dx = Math.cos(attacker.heading || 0); dy = Math.sin(attacker.heading || 0); }
  const jumping = !!attacker.leaping || (attacker.hoverY || 0) > 0.05;
  const charging = !!attacker.charging;
  return {
    kind: 'melee', dirX: dx, dirY: dy,
    speed: swing.standSpeed + (charging ? swing.chargeBonus : 0) + (jumping ? swing.jumpBonus : 0),
    up: jumping ? swing.jumpUp : swing.standUp,
    spin: jumping ? swing.jumpSpin : swing.standSpin,
    kick: jumping ? swing.jumpKick : swing.standKick,
    jumping,
  };
}

export function resolveCombat(sim, dt) {
  const P = sim.P;

  // --- group agents by PHYSICAL location (user note: real space logic) ---
  // A body is in the room its coordinates are in (a.pnode), the moment it's
  // through the door — not when its pathfinder finishes at the room center.
  // Vent crawlers and cross-deck shaft crawlers are inside the ship's
  // structure and resolve in their own duct/shaft groups; a same-deck shaft
  // crawl crosses open floor, so those movers count as physically present.
  const groups = new Map();
  for (const a of sim.agents) {
    if (a.dead) continue;
    let key;
    // only a body HIDDEN mid-crawl fights in its own duct/shaft group; one
    // walking to or climbing out of a grate is physically in the room and
    // engages (and is engaged) there (user: a visible form at a vent must be
    // hittable, not an un-killable ghost).
    if (a.move && a.move.layer === 'vent' && a.move.hidden) key = `Lvent${a.move.link.i}`;
    else if (a.move && a.move.layer === 'shaft' && a.move.hidden
      && sim.graph.node(a.move.link.a).deck !== sim.graph.node(a.move.link.b).deck) {
      key = `Lshaft${a.move.link.i}`;
    } else if (a.move && a.move.layer === 'std' && a.move.hidden) {
      // inside a ladder/lift trunk — out of every room's line of fire until
      // it climbs out the far hatch (same rule as the ducts)
      key = `Lclimb${a.move.link.i}`;
    } else key = `N${a.pnode ?? a.node}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(a);
  }

  // (Removed: the old "shot through a vent grating" exposure roll. In real
  // space nobody — the player included — can see into the ductwork, so
  // marines shooting unseeable forms was an artifact of the abstract-graph
  // era. Vents are blind transit now; the fight happens at the openings.)

  // --- shaft ambush first strikes (§7): whoever moves loses the corner ---
  for (const [key, group] of groups) {
    if (!key.startsWith('Lshaft')) continue;
    const linkIdx = Number(key.slice(6));
    const shaft = sim.graph.shafts[linkIdx];
    const ambushers = [...(shaft.ambushers ?? [])].map((id) => sim.byId.get(id))
      .filter((x) => x && !x.dead && x.hp > 0);
    for (const mover of group) {
      if (mover.firstStruckIn === linkIdx) continue;
      for (const amb of ambushers) {
        if (amb.faction === mover.faction) continue;
        const hostile = isFlood(amb) !== isFlood(mover);
        if (!hostile) continue;
        mover.firstStruckIn = linkIdx;
        const dps = amb.faction === FACTION.COMBAT ? P.combat.combatForm.dps : P.combat.marine.dps;
        const strike = dps * P.ambush.firstStrikeMult;
        sim.log('ambush', `ambush sprung in the ${sim.graph.node(shaft.a).name} ↔ ${sim.graph.node(shaft.b).name} shaft`);
        if (isFlood(mover)) hurtFloodForm(sim, mover, strike, false, amb.id);
        else sim.hurtHuman(mover, strike, amb.id);
      }
    }
    // an ambusher fights anything that survived into its segment
    for (const amb of ambushers) {
      const foes = group.filter((m) => isFlood(m) !== isFlood(amb) && m.hp > 0 && !m.dead);
      for (const foe of foes) {
        const dps = amb.faction === FACTION.COMBAT ? P.combat.combatForm.dps : P.combat.marine.dps;
        if (isFlood(foe)) hurtFloodForm(sim, foe, dps * dt, false);
        else sim.hurtHuman(foe, dps * dt);
      }
    }

    // --- PASSING COMBAT (user note): a shaft is a cramped crawlway, not a
    // "track" two hostiles can glide past each other on unnoticed — anyone
    // sharing the segment fights immediately, exactly like node combat,
    // even if neither side is a parked ambusher (that case, above, gets the
    // first-strike bonus instead; this is the general "we just met" case).
    const shooters = group.filter((a) => a.hp > 0 && !a.dead &&
      (a.faction === FACTION.MARINE || (a.faction === FACTION.ARMED && a.state === STATE.FIGHT)));
    const combatForms = group.filter((a) => a.faction === FACTION.COMBAT && !a.downed && a.hp > 0 && !a.dead);
    const carriers = group.filter((a) => a.faction === FACTION.CARRIER && a.hp > 0 && !a.dead);
    const humans = group.filter((a) => a.hp > 0 && !a.dead &&
      (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
    if (shooters.length && (combatForms.length || carriers.length)) {
      sim.gunfireAt(shaft.a); sim.gunfireAt(shaft.b);
      let pool = shooters.reduce((s, a) => s + (a.faction === FACTION.MARINE ? P.combat.marine.dps : P.combat.armed.dps), 0) * dt;
      for (const t of [...combatForms, ...carriers].sort((a, b) => a.id - b.id)) {
        if (pool <= 0) break;
        const d = Math.min(pool, t.hp);
        pool -= d;
        hurtFloodForm(sim, t, d, false);
      }
    }
    if (combatForms.length && humans.length) {
      let pool = combatForms.reduce((s, f) =>
        s + P.combat.combatForm.dps + (f.hostArmed ? P.combat.hostWeaponDps : 0), 0) * dt;
      for (const v of humans.sort((a, b) => (rank(a) - rank(b)) || (a.id - b.id))) {
        if (pool <= 0) break;
        const d = Math.min(pool, v.hp);
        pool -= d;
        sim.hurtHuman(v, d);
      }
    }
  }

  // --- node combat ---
  for (const [key, group] of groups) {
    if (!key.startsWith('N')) continue;
    const node = Number(key.slice(1));

    const shooters = group.filter((a) => a.hp > 0 && !a.dead &&
      ((a.faction === FACTION.MARINE && !sim.squads[a.squad]?.broken) ||
        (a.faction === FACTION.MARINE) ||
        (a.faction === FACTION.ARMED && a.state === STATE.FIGHT)));
    const combatForms = group.filter((a) => a.faction === FACTION.COMBAT && !a.downed && a.hp > 0 && !a.dead);
    const infForms = group.filter((a) => a.faction === FACTION.INFECTION && a.hp > 0 && !a.dead);
    const carriers = group.filter((a) => a.faction === FACTION.CARRIER && a.hp > 0 && !a.dead);
    const downedForms = group.filter((a) => a.faction === FACTION.COMBAT && a.downed && !a.dead && a.damage < 95);
    const anyFlood = combatForms.length + infForms.length + carriers.length > 0;
    if (!shooters.length && !anyFlood) continue;
    if (shooters.length) {
      // gunfire only rings when someone actually FIRES — with sight limits
      // and reaction delays, a form sharing a dark room no longer makes the
      // room sound like a range the instant it steps in
      let anyFire = false;
      // Flamethrower: finite-range LOS weapon. The carrier no longer burns
      // every target in a compartment from any distance; it closes through
      // the steering layer until a real contact is inside the stream.
      const flamer = shooters.find((s) => s.flamer && s.fuel > 0);
      const targets = flamer ? sim.lineOfSightAgents(flamer, (t) =>
        (t.faction === FACTION.COMBAT && !t.downed)
        || t.faction === FACTION.INFECTION || t.faction === FACTION.CARRIER,
      P.flamethrower.rangeM).sort((a, b) => {
        const ad = (a.x - flamer.x) ** 2 + (a.y - flamer.y) ** 2;
        const bd = (b.x - flamer.x) ** 2 + (b.y - flamer.y) ** 2;
        return ad - bd || a.id - b.id;
      }) : [];
      if (flamer && targets.length) {
        anyFire = true;
        flamer.fuel = Math.max(0, flamer.fuel - P.flamethrower.fuelPerSec * dt);
        const aim = targets[0];
        const aimNode = aim.pnode ?? aim.node;
        sim.igniteFlame(aimNode, aim.x, aim.y, `marine:${flamer.id}`, 1.0);
        flamer.flameAimX = aim.x; flamer.flameAimY = aim.y;
        flamer.flameAimDeck = sim.graph.node(aimNode).deck;
        // trigger down this tick — renderers hang the jet off it (see FLAMING)
        flamer.flamingT = sim.t;
        let flamePool = P.flamethrower.dps * dt;
        for (const t of targets) {
          if (flamePool <= 0) break;
          const d = Math.min(flamePool, t.hp);
          flamePool -= d;
          hurtFloodForm(sim, t, d, true);
        }
      }
      // HALO-STANDARD RIFLES (user note): each shooter fires DISCRETE aimed
      // shots on its own cadence and ROLLS to hit — accuracy drops past
      // rifleFalloffM (a sprinting form in a dark ship is a hard target).
      // Deterministic: cadence is sim-time, rolls come from the seeded RNG,
      // so lockstep multiplayer holds. Every Flood body is ranked by its real
    // distance from this shooter; target type never overrides proximity.
      // FRIENDLY FIRE (user): rifles are dangerous to everyone downrange —
      // a squadmate in the tight lane corridor blocks the shot (the shooter
      // holds and works a side-step for a clear line instead), and a MISS
      // with a squadmate hugging the lane can clip him. The player counts:
      // marines check their lane around you, and a stray round still bites.
      const FF = P.combat.ff;
      const mates = sim.agents.filter((a) => a.hp > 0 && !a.dead && a.deck === sim.graph.node(node).deck
        && (a.faction === FACTION.MARINE || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN));
      for (const s of shooters) {
        if (s === flamer) continue;
        if (sim.t < (s.nextShotAt ?? 0)) continue;
        const candidates = sim.lineOfSightAgents(s, (t) =>
          (t.faction === FACTION.COMBAT && !t.downed)
          || t.faction === FACTION.INFECTION || t.faction === FACTION.CARRIER)
          .map((target) => ({ target, range: Math.hypot(target.x - s.x, target.y - s.y) }));
        const selected = selectRifleTarget(s.fireTargetId, candidates);
        const best = selected?.target ?? null;
        const bestRange = selected?.range ?? 0;
        s.fireTargetId = best?.id;
        if (!best) continue; // sight ranges differ per shooter position — keep checking the rest
        // STAGGERED REACTION (user: every marine opened up the same instant,
        // like one organism): a FRESH acquisition — nothing in sight for the
        // last lull window — rolls a human reaction delay, anchored on facing:
        // a contact outside the shooter's forward cone costs extra time to
        // hear, turn, and re-acquire. During a sustained fight there's no
        // re-roll, so suppression stays continuous.
        if (sim.t - (s._sawThreatT ?? -99) > P.combat.reactLullSec) {
          const bearing = Math.atan2(best.y - s.y, best.x - s.x);
          let off = Math.abs(bearing - (s.heading ?? 0));
          if (off > Math.PI) off = 2 * Math.PI - off;
          const behind = off > P.combat.reactConeRad;
          s._reactUntil = sim.t + P.combat.reactBaseSec
            + sim.rng.range(0, P.combat.reactScatterSec)
            + (behind ? P.combat.reactBehindSec * (0.6 + 0.8 * (off / Math.PI)) : 0);
        }
        s._sawThreatT = sim.t;
        if (sim.t < (s._reactUntil ?? 0)) continue; // still turning / registering it
        // check the lane before the trigger: anyone friendly BETWEEN muzzle
        // and target, inside the corridor, blocks the shot outright; anyone
        // in the wider graze band becomes the victim a miss can find
        const ldx = best.x - s.x, ldy = best.y - s.y;
        const laneL = Math.hypot(ldx, ldy) || 1e-6;
        const lux = ldx / laneL, luy = ldy / laneL;
        let laneBlocked = false, blocker = null, graze = null, grazeD = Infinity;
        for (const h of mates) {
          if (h === s) continue;
          const hx = h.x - s.x, hy = h.y - s.y;
          const along = hx * lux + hy * luy;
          if (along < 0.4 || along > laneL - 0.2) continue; // behind the muzzle / past the target
          const perp = Math.abs(hy * lux - hx * luy);
          if (perp < FF.laneHalfM) { laneBlocked = true; blocker = h; break; }
          if (perp < FF.grazeHalfM && perp < grazeD) { grazeD = perp; graze = h; }
        }
        if (laneBlocked) {
          // WORK THE ANGLE. The side-step has to move the marine's POST, not
          // just its body: resolveCombat runs at the END of the tick, so a
          // raw position nudge is dragged straight back by _firingDrift on the
          // next tick and the marine oscillates in place, blocked forever
          // (measured: 71% of all shot opportunities suppressed). Displacing
          // firePost makes the steering layer walk him out of the lane at the
          // normal capped shuffle speed AND hold him there.
          if (s._ffFlipAt === undefined) s._ffFlipAt = sim.t + FF.flipSec;
          else if (sim.t >= s._ffFlipAt) {
            s._ffSide = -(s._ffSide ?? ((s.id & 1) ? 1 : -1));
            s._ffFlipAt = sim.t + FF.flipSec;
          }
          const side = s._ffSide ?? (s._ffSide = (s.id & 1) ? 1 : -1);
          const room = sim.graph.node(s.pnode ?? s.node);
          if (s.firePost) {
            const nx = s.firePost[0] - luy * side * FF.postShiftM;
            const ny = s.firePost[1] + lux * side * FF.postShiftM;
            s.firePost[0] = Math.max(room.x - room.w / 2 + 0.8, Math.min(room.x + room.w / 2 - 0.8, nx));
            s.firePost[1] = Math.max(room.y - room.d / 2 + 0.8, Math.min(room.y + room.d / 2 - 0.8, ny));
          }
          s.x += -luy * side * FF.sideStepMps * dt;
          s.y += lux * side * FF.sideStepMps * dt;
          sim._clampToRoom(s, room);
          if (sim.t - (sim._ffCallT ?? -999) > FF.callCooldownSec) {
            sim._ffCallT = sim.t;
            sim.log('radio', `check your fire — friendlies in the lane in ${sim.graph.node(node).name}`, node);
          }
          // HOLDING FIRE IS NOT FREE. A marine who can never find a lane —
          // pinned in a doorway, boxed in a corridor — does not stand there
          // politely until the ship falls; past holdMaxSec discipline loses to
          // the thing charging him and he fires through the gap anyway. That
          // bounds the suppression AND is exactly where blue-on-blue belongs.
          s._ffBlockedSince ??= sim.t;
          if (sim.t - s._ffBlockedSince < FF.holdMaxSec) continue;
          graze = blocker; grazeD = 0; // shooting past a man in the lane
        } else { s._ffFlipAt = undefined; s._ffBlockedSince = undefined; }
        // FIRETEAM AMMO ECONOMY (user): your escorts burn real magazines.
        // A dry marine keeps his boot (stomps below) but the rifle is out
        // until you hand him a mag (G key, sim.giveMag).
        if (s.escort && s.mags !== undefined) {
          if (s.rounds <= 0) {
            if (s.mags > 0) {
              s.mags--;
              s.rounds = 32;
              if (s.mags === 1 && !s.lowCalled) {
                s.lowCalled = true;
                sim.log('radio', `fireteam: ${s.callsign ? s.callsign.rank + ' ' + s.callsign.name : 'a marine'} is running dry — last mag`, s.node);
              }
            } else {
              if (!s.dryCalled) {
                s.dryCalled = true;
                sim.log('radio', `fireteam: ${s.callsign ? s.callsign.rank + ' ' + s.callsign.name : 'a marine'} is BLACK on ammo — pass a mag!`, s.node);
              }
              continue;
            }
          }
          s.rounds--;
        }
        const gun = s.faction === FACTION.MARINE ? P.combat.marine.gun : P.combat.armed.gun;
        s.nextShotAt = sim.t + 1 / gun.rof;
        anyFire = true;
        const range = bestRange;
        let acc = range <= P.combat.rifleFalloffM ? gun.accNear : gun.accFar;
        // per-marine marksmanship (user: every shot from every marine landed
        // like a laser) — each shooter is a better or worse shot for life
        acc *= 1 + (marksman01(s.id) * 2 - 1) * P.combat.marksmanSpread;
        if (best.faction === FACTION.INFECTION) acc *= P.combat.podAccMult;
        // FLOOD DARKNESS (user rule): humans fight the held rooms by
        // flashlight — accuracy suffers, and spore fog stacks on top.
        // The flood needs no light.
        const targetNode = best.pnode ?? best.node;
        if (sim.darkAt(targetNode)) acc *= P.darkness.darkAccMult;
        if (sim.fogAt(targetNode)) acc *= P.darkness.fogAccMult;
        // FIXTURE STATE (user rule): a room whose mains are DEAD is
        // flashlight-only shooting even before the flood touches it; a
        // flickering fixture throws the lead off a little. Flood darkness
        // above already prices in the worst case — don't stack both.
        if (!sim.darkAt(targetNode)) {
          const lm = sim.graph.lightMode[targetNode];
          if (lm === 3) acc *= P.darkness.unlitAccMult;
          else if (lm === 1 || lm === 2) acc *= P.darkness.flickerAccMult;
        }
        if (laneBlocked && blocker.hp > 0 && !blocker.dead && sim.rng.chance(FF.blockedHitChance)) {
          // he fired through an occupied lane: the round meant for the form
          // finds the man standing in it instead
          sim.hurtHuman(blocker, gun.dmg * FF.dmgMult, s.id);
          sim.stats.friendlyFireHits++;
          if (sim.t - (sim._ffHitCallT ?? -999) > 6) {
            sim._ffHitCallT = sim.t;
            sim.log('radio', `a stray round hits a friendly in ${sim.graph.node(node).name}`, node);
          }
        } else if (sim.rng.chance(acc)) {
          if (best.faction === FACTION.INFECTION) { sim.removeAgent(best); sim.stats.infectionFormsKilled++; }
          else hurtFloodForm(sim, best, gun.dmg, false, s.id);
        } else if (graze && graze.hp > 0 && !graze.dead && sim.rng.chance(FF.grazeChance)) {
          // the miss has to land SOMEWHERE — the squadmate hugging the lane
          // eats it (a graze, not a center-mass kill shot; hurtHuman still
          // handles the worst case, so blue-on-blue CAN drop a man)
          sim.hurtHuman(graze, gun.dmg * FF.dmgMult, s.id);
          sim.stats.friendlyFireHits++;
          if (sim.t - (sim._ffHitCallT ?? -999) > 6) {
            sim._ffHitCallT = sim.t;
            sim.log('radio', `a stray round hits a friendly in ${sim.graph.node(node).name}`, node);
          }
        }
      }
      // stomp infection forms (they're fragile, §6.6) — but only the ones
      // that have actually closed with a shooter (real space: you boot or
      // point-fire what's at your feet, not a form skittering 30m away)
      // a shooter with a form LATCHED ON is wrestling it, not aiming — half
      // effectiveness (the point-blank risk is real for a lone marine; a
      // squadmate's boot is what saves you)
      let stomps = shooters.reduce((s, a) => s +
        (a.faction === FACTION.MARINE ? P.combat.marine.stompPerSec : P.combat.armed.stompPerSec)
        * (a.held === sim.tickCount ? 0.5 : 1), 0) * dt;
      for (const f of [...infForms].sort((a, b) => a.id - b.id)) {
        if (stomps <= 0) break;
        if (!shooters.some((s) => Math.hypot(s.x - f.x, s.y - f.y) <= P.combat.stompRangeM)) continue;
        if (sim.rng.chance(Math.min(1, stomps))) { sim.removeAgent(f); sim.stats.infectionFormsKilled++; }
        stomps -= 1;
      }
      if (anyFire) sim.gunfireAt(node);
    } else if (sim.marinesKnowRevive && shooters.length && downedForms.length) {
      // no live threat: marines put confirming rounds into downed forms.
      // GATED (user): early on the marines don't know the downed get back
      // up — nobody wastes ammo on a dead thing. The first witnessed revive
      // (sim.reviveWitnessed) teaches the whole net the hard way.
      // ONLY FIRE DESTROYS (user rule): the rounds mangle the body (damage
      // caps at 95, slowing nothing but their own ammo) — the marines
      // BELIEVE they made sure, but without a flamethrower every one of
      // these gets back up. That's the horror working as intended.
      const marines = shooters.filter((s) => s.faction === FACTION.MARINE);
      if (marines.length) {
        const t = downedForms.sort((a, b) => a.id - b.id)[0];
        t.damage = Math.min(95, t.damage + 40 * dt * marines.length);
        if (t.damage >= 95 && !t.madeSure) {
          t.madeSure = true;
          sim.log('combat', `marines make sure of a downed form in ${sim.graph.node(node).name}`);
        }
      }
    }

    // flood attacks — REAL REACH (user note): claws only land on a victim
    // the form has physically closed with (meleeRangeM); a hosted weapon
    // fires across the room. Each form fights the nearest body regardless of
    // faction, so a nearby player cannot be ignored for a farther marine and
    // a pack spreads across a line instead of resolving at the room's center.
    if (combatForms.length) {
      let fired = false;
      for (const f of [...combatForms].sort((a, b) => a.id - b.id)) {
        // A fleeing form spends the tick escaping. If the route closes,
        // retreatOrFight replaces the task with a cornered attack before
        // combat resolves, so this never makes a trapped form passive.
        if (f.task?.retreat) continue;
        const victims = sim.lineOfSightAgents(f, (a) => a.faction === FACTION.MARINE
          || a.faction === FACTION.ARMED || a.faction === FACTION.CIVILIAN);
        if (victims.length) {
          const locked = sim.hive.lockedCombatTarget(f);
          // A sticky squad allocation stops oscillation at range, but direct
          // bodily contact wins. Otherwise a form can brush past the player
          // without swiping because a farther marine still owns its task lock.
          const immediate = sim.hive.immediateCombatTarget(f);
          // An allocated attacker hits only its chosen body. An overflow form
          // with a room-level ATTACK but no available slot waits for one; it
          // must not bypass the three-per-target cap in the damage layer.
          let best = immediate ?? (locked && victims.some((victim) => victim.id === locked.id)
            ? locked : null);
          if (f.task?.kind === TASK.ATTACK && !best) continue;
          let bestScore = Infinity;
          if (!best) {
            for (const v of victims) {
              if (v.hp <= 0 || v.dead) continue;
              const d = sim.agentDistance(f, v);
              const score = d + v.id * 1e-6;
              if (score < bestScore) { bestScore = score; best = v; }
            }
          }
          if (!best) break;
          const range = Math.hypot(best.x - f.x, best.y - f.y);
          // MELEE IS THE FLOOD'S WEAPON (user rule: >90% of hosts died
          // unarmed): sprint/leap to arm's reach, then a heavy SWIPE on a
          // cooldown — discrete hits that knock chunks off armor, with a
          // real recovery gap between swings to shoot it in
          // a transforming body is a target, never an attacker: it soaks fire
          // at full combat-form HP but throws no swipes and fires no host
          // weapon until it has actually risen
          if (f.transformingUntil !== undefined) continue;
          if (range <= P.combat.meleeRangeM && sim.t >= (f.nextSwingAt ?? 0)) {
            const swing = P.combat.combatForm.swing;
            f.nextSwingAt = sim.t + swing.cooldownSec;
            f.meleeUntil = sim.t + swing.animSec;
            f.animTime = 0; // the tentacle strike starts at contact, not mid-cycle
            f.heading = Math.atan2(best.y - f.y, best.x - f.x);
            sim.hurtHuman(best, swing.dmg, f.id, combatMeleeImpulse(f, best, swing));
          }
          // the armed minority spray the host's weapon one-handed (lore) —
          // discrete wild shots, mostly missing
          if (f.hostArmed && sim.t >= (f.nextHostShotAt ?? 0)) {
            f.nextHostShotAt = sim.t + 1 / P.combat.hostGun.rof;
            // Rendering must follow the shot that actually resolved. Inferring
            // a shooter from generic room gunfire made unrelated armed forms
            // appear to fire sideways while walking toward another objective.
            f.hostShotTick = sim.tickCount;
            f.hostShotTargetId = best.id;
            fired = true;
            const acc = range <= P.combat.rifleFalloffM ? P.combat.hostGun.accNear : P.combat.hostGun.accFar;
            if (sim.rng.chance(acc)) sim.hurtHuman(best, P.combat.hostGun.dmg, f.id);
          }
        }
      }
      // a hosted weapon firing is gunfire too — the ship hears it, and
      // renderers get a marked tick to show the flood visibly shooting
      if (fired) sim.gunfireAt(node);
    }
    // threatened carriers detonate early (§6.6)
    for (const c of carriers) {
      const shotThroughOpening = sim.tickCount - (c.lastHurtTick ?? -999) <= 1;
      if ((shooters.length || shotThroughOpening) && c.hp < c.maxHp * 0.5) explodeCarrier(sim, c);
    }
  }

  // --- GRAND STAIRWELL cross-level fire (user: PoA stairs) ---
  // The two levels share one open volume, so a shooter on the catwalk fires
  // DOWN onto the combat forms swarming the stairs (and a hosted weapon
  // sprays back UP). Ranged only — no melee reaches across a storey — and
  // the drop is long, so accFar applies: harassing fire, not a turkey shoot.
  for (const s of sim.graph.stairwells) {
    for (const [gunNode, floodNode] of [[s.upper, s.lower], [s.lower, s.upper]]) {
      const shooters = sim.occupants(gunNode).filter((a) => a.hp > 0 && !a.dead &&
        (a.faction === FACTION.MARINE || (a.faction === FACTION.ARMED && a.state === STATE.FIGHT)));
      if (!shooters.length) continue;
      const gn = sim.graph.node(gunNode);
      const targets = sim.occupants(floodNode).filter((a) => !a.dead && a.hp > 0 && !a.downed &&
        (a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER || a.faction === FACTION.INFECTION));
      if (!targets.length) continue;
      let stamped = false;
      for (const sh of shooters) {
        if (sim.t < (sh.nextShotAt ?? 0)) continue;
        // nearest live target (in the deck plane; the storey drop is the same
        // for all, so it just pushes everything past rifleFalloffM -> accFar)
        const selected = selectRifleTarget(sh.fireTargetId, targets.filter((target) =>
          sim.losClear(sh.x, sh.y, gunNode, target.x, target.y, floodNode)).map((target) => ({
          target, range: Math.hypot(target.x - sh.x, target.y - sh.y),
        })));
        const best = selected?.target ?? null;
        sh.fireTargetId = best?.id;
        if (!best) continue;
        if (!stamped) { stamped = true; sim.gunfireAt(gunNode); }
        const gun = sh.faction === FACTION.MARINE ? P.combat.marine.gun : P.combat.armed.gun;
        sh.nextShotAt = sim.t + 1 / gun.rof;
        let acc = gun.accFar; // always the long cross-level shot
        if (best.faction === FACTION.INFECTION) acc *= P.combat.podAccMult;
        if (sim.darkAt(gunNode) || sim.darkAt(floodNode)) acc *= P.darkness.darkAccMult;
        if (sim.fogAt(gunNode) || sim.fogAt(floodNode)) acc *= P.darkness.fogAccMult;
        if (sim.rng.chance(acc)) hurtFloodForm(sim, best, gun.dmg, false, sh.id);
      }
    }
  }
}

function rank(a) {
  // combat forms hit shooters first
  return a.faction === FACTION.MARINE ? 0 : a.faction === FACTION.ARMED ? 1 : 2;
}

export function isFlood(a) {
  return a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT || a.faction === FACTION.CARRIER;
}

// integrity -> downed -> (self-revive | reanimate | permanent) per §7.
// `by` (attacker agent id) feeds hit feedback: the FLINCH render flag and
// the form's shoot-back retargeting — getting shot is now a stimulus.
export function hurtFloodForm(sim, a, dmg, isFlame, by = -1, impact = null) {
  const P = sim.P;
  if (by >= 0 && dmg > 0) { a.lastHurtBy = by; a.lastHurtTick = sim.tickCount; }
  if (a.faction === FACTION.INFECTION) {
    if (isFlame) a.damage = 100;
    sim.removeAgent(a);
    sim.stats.infectionFormsKilled++;
    return;
  }
  a.hp -= dmg;
  // ONLY FIRE DESTROYS (user rule): bullets mangle a downed form but can
  // never take it out of the hive's economy — damage from anything that
  // isn't flame caps at 95, so every unburned downed form stays a
  // reanimation target. The flamethrower alone crosses 100.
  if (isFlame) a.damage = Math.min(100, a.damage + dmg * 2);
  else if (a.downed) a.damage = Math.min(95, a.damage + dmg);
  if (a.hp <= 0 && !a.downed) {
    if (impact) a.deathImpulse = impact;
    if (isFlame) a.damage = 100;
    if (a.faction === FACTION.CARRIER) { explodeCarrier(sim, a); return; }
    a.hp = 0;
    a.downed = true;
    a.state = STATE.DOWNED;
    a.task = null; a.path = []; a.move = null;
    if (a.inShaftAmbush !== undefined) clearAmbush(sim, a);
    sim.stats.combatFormsDowned++;
    // §7: a downed form is not safely dead
    if (a.damage < 100 && sim.rng.chance(P.combatForm.selfReviveChance)) {
      a.reviveAt = sim.t + sim.rng.range(0, P.combatForm.selfReviveWindowSec);
    }
    if (a.damage >= 100) a.dead = false; // stays as a burned husk marker
  }
}

function clearAmbush(sim, a) {
  const shaft = sim.graph.shafts[a.inShaftAmbush];
  shaft?.ambushers?.delete(a.id);
  a.inShaftAmbush = undefined;
}

// humans dying leave convertible bodies behind
export function humanDeathToCorpse(sim, a) {
  a.dead = true;
  const corpse = makeAgent(FACTION.CORPSE, a.node, sim.graph);
  corpse.state = STATE.DEAD;
  corpse.damage = 15; // shot up a little, still carrier food
  corpse.x = a.x; corpse.y = a.y; corpse.heading = a.heading;
  corpse.bodyType = a.bodyType;
  corpse.lastHurtBy = a.lastHurtBy;
  corpse.lastHurtTick = a.lastHurtTick;
  corpse.deathImpulse = a.deathImpulse ?? null;
  // the host's weapon falls with the body — a combat form raised from it
  // picks the weapon back up (lore)
  corpse.wasArmed = a.faction === FACTION.ARMED || a.faction === FACTION.MARINE;
  // Marines carry two recoverable magazines; armed crew keep the lighter
  // one-magazine drop. Store the actual yield on the corpse so pickup logic
  // does not have to infer the dead body's former faction later.
  if (corpse.wasArmed) corpse.ammoRounds = a.faction === FACTION.MARINE ? 120 : 60;
  // ...and so does the flamethrower, if he was the one carrying it. Recorded
  // under its OWN keys, never `flamer`/`fuel`: a corpse wearing those would be
  // picked up as a live flamer by the shooter scan above. This is inert data
  // that only the player's scavenge (game/player.js) reads.
  if (a.flamer && a.fuel > 0) { corpse.hadFlamer = true; corpse.flamerFuel = a.fuel; }
  // A marine's unused frags leave his belt as a real world pickup. Keep the
  // drop independent of the corpse so conversion, dragging, or body cleanup
  // cannot silently eat ammunition lying on the deck.
  if (a.faction === FACTION.MARINE && a.frags > 0) {
    sim.grenadeDrops.push({
      id: corpse.id, node: corpse.node, deck: corpse.deck,
      x: corpse.x, y: corpse.y, count: a.frags,
    });
  }
  sim.spawn(corpse);
  if (a.isPlayer) {
    corpse.playerSourceId = a.id;
    a.afterlifeId = corpse.id;
    a.respawnReadyAt = sim.t + sim.P.player.respawnSec;
  }
}
