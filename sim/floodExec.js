// Flood form actuation: executes hive tasks each movement tick, plus carrier
// production (§6.6) and the self-revive/reanimation timers (§7).

import { FACTION } from '../shared/agentBuffer.js';
import { STATE, makeAgent } from './init.js';
import { TASK } from './hive.js';

export function updateFloodTick(sim, dt) {
  const hive = sim.hive;
  for (const a of sim.agents) {
    if (a.dead) continue;
    if (a.faction === FACTION.CARRIER) { updateCarrier(sim, a, dt); continue; }
    if (a.faction !== FACTION.INFECTION && a.faction !== FACTION.COMBAT) continue;

    // HALO-3 TURN, PHASE 2 — THRASH AND RISE (user: "when a body starts
    // thrashing it's already a combat form in count and effects, health
    // etc"). The corpse died at burrow completion and THIS agent — a real
    // combat form, in the hive's numbers, targetable at full combat-form HP
    // — convulses rooted on the spot until transformingUntil, then stands
    // and fights. Shooting it down mid-thrash is killing a combat form,
    // self-revive rules and all.
    if (a.faction === FACTION.COMBAT && a.transformingUntil !== undefined) {
      if (sim.t >= a.transformingUntil) {
        a.transformingUntil = undefined;
        sim.log('convert', `the body rises as a combat form in ${sim.graph.node(a.node).name}`, a.node, a.x, a.y);
      } else {
        a.move = null; a.path = [];
        a.animTime += dt;
        continue; // rooted: no tasks, no movement, no swings until it rises
      }
    }

    // self-revive (§7)
    if (a.downed) {
      if (a.reviveAt >= 0 && sim.t >= a.reviveAt && a.damage < 100) {
        a.downed = false; a.reviveAt = -1;
        a.hp = a.maxHp * sim.P.combatForm.reviveIntegrityFrac;
        sim.reviveWitnessed(a.node);
        a.state = STATE.IDLE;
        sim.log('revive', `a downed combat form drags itself back up in ${sim.graph.node(a.node).name}`);
      }
      continue;
    }
    if (a.hp <= 0) continue;

    // safety: GRABBING is only legal while a GRAB task is live
    if (a.state === STATE.GRABBING && a.task?.kind !== TASK.GRAB) { a.state = STATE.IDLE; a.grabTimer = 0; }

    // survival reflex: an infection form standing among shooters dives for
    // the safest opening NOW instead of waiting for the 2.5 s strategic
    // brain — the currency is too precious to stand in a fire lane
    // COMMITTED (user rule): once a form has begun burrowing — into a corpse,
    // a downed form, or a live host — it CANNOT stop. It ignores the survival
    // reflex entirely; the only way off is killing it.
    if (a.faction === FACTION.INFECTION && !a.move && a.state !== STATE.GRABBING
      && a.task?.kind !== TASK.CONVERT && a.task?.kind !== TASK.REANIMATE
      && (sim.hive.lastScarcity ?? 3) > 0.8) {
      const pn = a.pnode ?? a.node;
      const roomies = sim.occupants(pn);
      const hot = roomies.some((h) => h.hp > 0 && !h.dead &&
        (h.faction === FACTION.MARINE || (h.faction === FACTION.ARMED && h.state === STATE.FIGHT)));
      // …but a form that has already gotten CLOSE to a human doesn't bolt —
      // it lunges (the point-blank branch below takes it)
      const inLunge = roomies.some((h) => h.hp > 0 && !h.dead &&
        (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE)
        && Math.hypot(h.x - a.x, h.y - a.y) <= sim.P.combat.lungeRiskM);
      // A pod that surfaced into an otherwise empty room can sense rifles on
      // the other side of its doors. It only bails if its NEXT step would
      // cross that threshold: a nearby marine does not make every empty vent
      // exit unusable, but walking straight into the rifle line still is.
      const localPrize = roomies.some((occupant) =>
        (!occupant.dead && occupant.hp > 0
          && (occupant.faction === FACTION.CIVILIAN || occupant.faction === FACTION.ARMED))
        || (occupant.faction === FACTION.CORPSE && !occupant.dead
          && occupant.damage < 100 && !occupant.claimed));
      const nextStep = nextInfectionStep(sim, hive, a);
      const crossingSensedGuns = !localPrize && nextStep?.layer === 'std'
        && hive.infectionArmedContact(nextStep.to);
      if ((hot || crossingSensedGuns) && !inLunge) {
        // danger where we STAND, for comparison — bolting only makes sense
        // into a strictly safer room. Without this, a form whose exits were
        // all covered would "flee" INTO the next room's marines (user
        // report: pods seemingly charging the guns for no reason).
        let hereDanger = 0;
        for (const h of roomies) {
          if (h.hp > 0 && !h.dead && (h.faction === FACTION.MARINE
            || (h.faction === FACTION.ARMED && h.state === STATE.FIGHT))) hereDanger += 2;
        }
        let best = null, bestDanger = Infinity;
        for (const { to, link } of sim.graph.neighbors(a.node, ['std'],
          (l) => !l.locked)) {
          if (sim.graph.burningUntil[to] > sim.t) continue;
          let danger = 0;
          for (const h of sim.occupants(to)) {
            if (h.hp > 0 && (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED)) danger += 2;
          }
          if (danger < bestDanger) { bestDanger = danger; best = { to, link }; }
        }
        // THE GRATE BREAKS PURSUIT OUTRIGHT (user model): no marine follows a
        // pod into the walls. The room's own vent beats any door unless a
        // truly empty room is right there — the pod dives in and surfaces in
        // the quietest room the hive believes empty anywhere on the ship.
        if (bestDanger > -0.5) {
          const safe = hive.ventBoltTarget(a.node);
          if (safe !== -1) {
            const link = sim.graph.ventLink(a.node, safe);
            best = { to: safe, link };
            bestDanger = -0.5;
          }
        }
        if (best && bestDanger < hereDanger) {
          // fleeing for its life = the errand is OFF. Keeping the old task
          // pulled the form straight back through the vent into the guns it
          // just escaped (user report: pointless vent double-backs). The
          // next strategic round retasks it from wherever it lands — and if
          // it lands among unclaimed corpses, the arrive-and-eat rule roots
          // it there on the spot. (Committed burrowers never reach this
          // branch — they're excluded above.)
          if (a.task?.corpseId !== undefined) {
            const b = sim.byId.get(a.task.corpseId);
            if (b && !b.dead) b.claimed = false;
          }
          a.task = null; a.taskProgress = 0;
          a.path = [];
          sim.setPath(a, [{ to: best.to, link: best.link, layer: best.link.kind }]);
          a.state = STATE.MOVE;
          continue;
        }
        if (hereDanger > 0) {
          // CORNERED = COMMITTED (user rule: when forced, they engage and
          // latch): no safer room to dive for, so the pod turns and goes
          // for the nearest throat instead of milling in the fire lane
          let close = null, closeD = Infinity;
          for (const h of roomies) {
            if (h.hp <= 0 || h.dead) continue;
            if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
            const d = Math.hypot(h.x - a.x, h.y - a.y);
            if (d < closeD - 1e-9 || (Math.abs(d - closeD) <= 1e-9 && h.id < (close?.id ?? Infinity))) { closeD = d; close = h; }
          }
          if (close && a.task?.targetId !== close.id) {
            hive.assign(a, { kind: TASK.GRAB, targetId: close.id });
          }
        }
      }
    }

    // OPPORTUNISTIC INFECTION: a live human standing in a form's own node is
    // a free conversion and a silenced witness — take them immediately,
    // whatever the form was told to do. Guns normally make it a fight for
    // combat.js instead of a grab — BUT a big enough pack overwhelms the
    // guns (user note): when local flood strength outweighs the shooters
    // ~2:1, grabs work THROUGH the gunfire and even marines get taken. The
    // swarm eats stomp losses; that's the price of the pile-on.
    // (not mid-edge — yanking a form already in transit off a node back to a
    // corpse behind it created an eating carousel. A queued-but-not-departed
    // path does NOT block eating: standing in a corpse room beats walking.)
    if (a.faction === FACTION.INFECTION && !a.downed && a.hp > 0 && a.state !== STATE.GRABBING
      && !a.move
      && a.task?.kind !== TASK.CONVERT && a.task?.kind !== TASK.REANIMATE) {
      const here = sim.occupants(a.pnode ?? a.node);
      let gunsW = 0;
      for (const h of here) {
        if (h.hp <= 0 || h.dead) continue;
        if (h.faction === FACTION.MARINE) gunsW += 1;
        else if (h.faction === FACTION.ARMED && h.state === STATE.FIGHT) gunsW += 0.6;
      }
      const overwhelmed = gunsW > 0 && sim.floodStrengthAt(a.pnode ?? a.node) >= gunsW * sim.P.swarm.overwhelmRatio;
      // POINT-BLANK RISK (user rule): a form that has gotten within
      // lungeRiskM of ANY human — marine included, guns or not — lunges for
      // the latch right now. Letting one skitter up to you is always a
      // mistake, and a live host turns FASTER than a corpse.
      let close = null, closeD = Infinity;
      for (const h of here) {
        if (h.hp <= 0 || h.dead) continue;
        if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
        const d = Math.hypot(h.x - a.x, h.y - a.y);
        if (d < closeD - 1e-9 || (Math.abs(d - closeD) <= 1e-9 && h.id < (close?.id ?? Infinity))) { closeD = d; close = h; }
      }
      if (close && closeD <= sim.P.combat.lungeRiskM) {
        if (a.task?.targetId !== close.id) hive.assign(a, { kind: TASK.GRAB, targetId: close.id });
      } else if (gunsW === 0 || overwhelmed) {
        const prey = here.find((h) => h.hp > 0 && !h.dead &&
          (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED
            || (overwhelmed && h.faction === FACTION.MARINE)));
        if (prey && a.task?.targetId !== prey.id) {
          hive.assign(a, { kind: TASK.GRAB, targetId: prey.id });
        } else if (!prey) {
          // Local feeders infect bodies in the room IMMEDIATELY and IN
          // PARALLEL — each form claims its
          // own corpse, the 3s conversions all run at once, and every form
          // that can't claim a body flees. One fast wave, then gone. No
          // serial grazing window (that read as "sitting on the crash site").
          // An opening vent runner must leave the crash site before feeding.
          // It may still seize a live host; only the abundant local corpses
          // would silently cancel the deliberately dispersed opening.
          const corpse = sim.openingVentFromStart && a.task?.spread && a.node !== a.task.node ? null
            : here.find((c) => c.faction === FACTION.CORPSE && !c.dead && c.damage < 100 && !c.claimed);
          if (corpse) {
            corpse.claimed = true;
            hive.assign(a, { kind: TASK.CONVERT, corpseId: corpse.id });
          }
        }
      }
    }

    const t = a.task;
    if (!t) continue;
    switch (t.kind) {
      case TASK.MOVE:
      case TASK.SCOUT:
      case TASK.GUARD:
        // A seed is a production order, not a permanent sentry. Finish the
        // trip by rooting; if the route stalls, use safe ground after 30s.
        if (t.seed) {
          t.seedSince ??= sim.t;
          if (a.faction !== FACTION.COMBAT || a.fromPlayer) { a.task = null; break; }
          if (!a.move && (a.node === t.node || sim.t - t.seedSince >= 30)) {
            if (hive.localThreat(a.node) < 0.5) hive.assign(a, { kind: TASK.TRANSFORM });
            else { a.task = null; a.path = []; } // unsafe den: let the planner choose again
            break;
          }
        }
        moveToward(sim, a, t.node, t.kind === TASK.SCOUT && t.sweep
          && a.faction === FACTION.COMBAT
          ? (from, to) => hive.searchPath(from, to)
          : null);
        if (a.node === t.node && !a.move && (t.kind === TASK.MOVE || t.kind === TASK.SCOUT)) a.task = null;
        break;

      case TASK.ATTACK:
        // A measured assault still routes around unrelated gun lines. All-in
        // and forced breaches do the opposite: the whole point is to punch
        // through the line that otherwise makes the survivors unreachable.
        moveToward(sim, a, t.node, (from, to) => (t.force || hive.allIn
          ? sim.graph.path(from, to, ['std'], hive.bigPass)
          : hive.safeAssaultPath(from, to)));
        // Open aggression follows a visible body, not a room occupant list.
        // The movement layer owns the shared surge/retreat decision later in
        // this tick, so execution only keeps the objective current.
        if (a.node === t.node && !a.move) {
          const prey = hive.lockedCombatTarget(a)
            ?? hive.visibleHumanTarget(a, t.surge ? a.lastHurtBy : -1);
          if (!prey) a.task = null;
          else t.node = prey.pnode ?? prey.node;
        }
        break;

      case TASK.GRAB: {
        const target = sim.byId.get(t.targetId);
        if (!target || target.dead || target.hp <= 0) {
          a.task = null;
          if (a.state === STATE.GRABBING) { a.state = STATE.IDLE; a.grabTimer = 0; }
          break;
        }
        const believed = hive.beliefs.get(t.targetId);
        const goal = sim.floodSenses(a.node).includes(target.node) ? target.node : (believed?.node ?? target.node);
        const samePhys = (a.pnode ?? a.node) === (target.pnode ?? target.node) && a.deck === target.deck;
        // ...but NOT while it is still in the air. A pounce (sim.js
        // _commitLeap, combat.pounce) launches from ~2 m, which means it
        // crosses the 1.4 m grab gate mid-flight; latching there clamps the
        // pod onto the target's back and kills the arc after ~0.6 m. It lands
        // on the spot it committed to and latches on the NEXT tick — which is
        // also what lets you side-step the pounce and be missed.
        if (samePhys && !a.leaping && Math.hypot(target.x - a.x, target.y - a.y) <= sim.P.combat.grabRangeM) {
          // it has physically REACHED the body (user note: real space logic —
          // no pinning someone from across a hangar): latch on, pin them, and
          // take them. An unarmed civilian is converted almost instantly; an
          // armed target takes a little longer. Marines/armed-in-a-fight are
          // still resolved by combat.js (a grab there gets the form stomped),
          // so this only sticks against the overwhelmed.
          a.state = STATE.GRABBING;
          a.move = null; a.path = [];
          if (sim.P.combat.grabPins) target.held = sim.tickCount;
          sim.hurtHuman(target, sim.P.combat.latchDps * dt, a.id); // the spike works while it burrows
          a.grabTimer += dt;
          // RIDE THE HOST (user rule: the latch cannot be broken) — the host
          // runs screaming in circles, and the form stays ON them, clamped
          // to their back, so no amount of running opens the gap. Only
          // shooting the attached form ends it.
          a.x = target.x - Math.cos(target.heading) * 0.45;
          a.y = target.y - Math.sin(target.heading) * 0.45;
          a.heading = target.heading;
          const need = target.faction === FACTION.CIVILIAN ? sim.P.combat.civilianGrabSec : sim.P.combat.infectionGrabSec;
          if (a.grabTimer >= need && !target.dead) convertHuman(sim, a, target);
        } else if (samePhys && !a.leaping && a.grabTimer > 0) {
          // latched but momentarily out of the range gate (host spun away
          // this same tick): stay committed — snap back onto them.
          // NOT while airborne. Adding !a.leaping to the latch above made this
          // the fall-through for a pouncing form, and it writes the pod onto
          // the target's back unconditionally — i.e. it teleports a body
          // mid-flight, which is the exact "forms steering in the air" the
          // user has reported twice. Every exit from GRABBING zeroes
          // grabTimer today, so this is one missing reset away from live.
          a.x = target.x - Math.cos(target.heading) * 0.45;
          a.y = target.y - Math.sin(target.heading) * 0.45;
        } else if (samePhys) {
          // same open space, not yet in reach: _spatialSteer closes the gap
          // straight at the victim's live position
          a.state = STATE.MOVE; a.grabTimer = 0;
        } else if (target.faction === FACTION.MARINE) {
          // a marine who broke contact is rejoining his squad's guns — the
          // pod does NOT corridor-chase him into massed fire (user report:
          // forms "charging marines in the next room"). Marines are only
          // ever grabbed point-blank or under an overwhelm, and both of
          // those are same-room conditions; if he strays close again the
          // lunge rule retakes him.
          a.task = null; a.state = STATE.IDLE; a.grabTimer = 0;
        } else {
          a.state = STATE.MOVE; a.grabTimer = 0;
          moveToward(sim, a, goal, hive.safeInfectionPath.bind(hive));
          if (!a.move && !a.path.length && a.node !== goal) a.task = null; // unreachable
        }
        break;
      }

      case TASK.CONVERT: {
        const body = sim.byId.get(t.corpseId);
        if (!body || body.dead || body.damage >= 100) { a.task = null; break; }
        if (a.node === body.node && !a.move) {
          // RIGHT ON TOP (user: "they need to get right on top of the bodies
          // to start the turning cycle"). The old approach eased proportionally
          // — fast at range, glacial up close — then SNAPPED the last 0.35 m,
          // so the pod visibly started converting from beside the body. Now it
          // scuttles the whole way at its real speed and nothing starts until
          // it is within seatRangeM (12 cm — physically astride the corpse).
          const gap = Math.hypot(body.x - a.x, body.y - a.y);
          if (a.taskProgress === 0 && gap > sim.P.combat.seatRangeM) {
            const aim = sim._stairSteerTarget(a, sim.graph.node(a.node), body.x, body.y);
            const dx = aim.x - a.x, dy = aim.y - a.y;
            const d = Math.hypot(dx, dy);
            const mps = sim.P.movement.baseMps * sim.P.speed.infection;
            const step = Math.min(d, mps * dt);
            if (d > 1e-9) { a.x += (dx / d) * step; a.y += (dy / d) * step; }
            a.heading = Math.atan2(dy, dx); a.animTime += dt;
            break; // still crawling onto the body — not burrowing yet
          }
          // HALO-3 TURN, PHASE 1 — BURROW (user): seated dead-centre on the
          // corpse, the pod digs in. It stays a live, shootable body the
          // whole burrow: kill it here and the corpse is spared. The
          // renderer reads FLAG.BURROWING and sinks the pod into the chest.
          a.x = body.x; a.y = body.y;
          a.taskProgress += dt;
          a.animTime += dt;
          if (a.taskProgress >= sim.P.combat.burrowSec) {
            // PHASE 2 — the pod is INSIDE and spent, and the body is a
            // COMBAT FORM from this instant (user: counts, health, effects):
            // it spawns rooted, thrashing where the corpse lay, and stands
            // at transformingUntil. The corpse leaves the roster now.
            body.dead = true;
            const cf = spawnCombatForm(sim, body.node, body);
            cf.hostArmed = body.wasArmed === true; // the host's weapon comes up with it
            cf.transformingUntil = sim.t + sim.P.combat.thrashSec;
            if (body.playerSourceId >= 0) {
              cf.fromPlayer = true;
              cf.playerSourceId = body.playerSourceId;
              cf.bodyType = body.bodyType;
              const player = sim.byId.get(body.playerSourceId);
              if (player) player.afterlifeId = cf.id;
            }
            sim.stats.conversions++; sim.stats.conversionsRound++;
            sim.removeAgent(a);
            sim.log('convert', `an infection form burrows into a corpse in ${sim.graph.node(body.node).name} — the body begins to convulse`, body.node, body.x, body.y);
          }
        } else moveToward(sim, a, body.node, hive.safeInfectionPath.bind(hive));
        break;
      }

      case TASK.TRANSFORM: {
        // a combat form roots itself into a carrier (user economy: carriers
        // are converted combat forms, and the hive picks the ratio). Do it in
        // place — the hive only assigns this to a form already in a safe den.
        // A form raised from the PLAYER never becomes a carrier (game rule).
        if (a.faction !== FACTION.COMBAT || a.downed || a.fromPlayer) { a.task = null; break; }
        if (a.move) break;
        a.taskProgress += dt;
        if (a.taskProgress >= sim.P.carrier.transformSec) {
          const carrier = makeAgent(FACTION.CARRIER, a.node, sim.graph);
          carrier.hp = carrier.maxHp = sim.P.combat.carrierHp;
          carrier.state = STATE.INCUBATING;
          // incubation began the moment the transformation started (user
          // note) — the rooting time counts toward the first mint
          carrier.mintTimer = a.taskProgress;
          sim.spawn(carrier);
          sim.removeAgent(a); // the combat form BECOMES the carrier
          sim.stats.carriersSeated++;
          sim.log('carrier', `a combat form roots into a carrier in ${sim.graph.node(a.node).name} — incubation begins`);
        }
        break;
      }

      case TASK.REANIMATE: {
        const target = sim.byId.get(t.targetId);
        if (!target || target.dead || !target.downed || target.damage >= 100) { a.task = null; break; }
        if (a.node === target.node && !a.move) {
          // sit ON the downed form (same right-on-top rule as CONVERT):
          // constant-speed scuttle to within seatRangeM, no ease-out snap
          const gap = Math.hypot(target.x - a.x, target.y - a.y);
          if (a.taskProgress === 0 && gap > sim.P.combat.seatRangeM) {
            const aim = sim._stairSteerTarget(a, sim.graph.node(a.node), target.x, target.y);
            const dx = aim.x - a.x, dy = aim.y - a.y;
            const d = Math.hypot(dx, dy);
            const mps = sim.P.movement.baseMps * sim.P.speed.infection;
            const step = Math.min(d, mps * dt);
            if (d > 1e-9) { a.x += (dx / d) * step; a.y += (dy / d) * step; }
            a.heading = Math.atan2(dy, dx); a.animTime += dt;
            break;
          }
          a.x = target.x; a.y = target.y;
          a.taskProgress += dt;
          if (a.taskProgress >= sim.P.combatForm.reanimateTimeSec) {
            target.downed = false; target.reviveAt = -1;
            target.hp = target.maxHp * sim.P.combatForm.reanimateIntegrityFrac;
            sim.reviveWitnessed(target.node);
            sim.removeAgent(a); // costs 1 infection form (§7)
            sim.log('reanimate', `the hive spends a form to reanimate a body in ${sim.graph.node(target.node).name}`, target.node, target.x, target.y);
          }
        } else moveToward(sim, a, target.node, hive.safeInfectionPath.bind(hive));
        break;
      }

      case TASK.DRAG: {
        const body = sim.byId.get(t.corpseId);
        if (!body || body.dead || body.damage >= 100) { a.task = null; a.dragging = -1; break; }
        if (a.dragging !== body.id && a.node === body.node && !a.move) a.dragging = body.id;
        if (a.dragging === body.id) {
          body.node = body.pnode = a.pnode ?? a.node;
          body.deck = a.deck; body.x = a.x; body.y = a.y - 4;
          if (a.node === t.node && !a.move) { a.dragging = -1; a.task = null; body.claimed = false; }
          else moveToward(sim, a, t.node);
        } else moveToward(sim, a, body.node);
        break;
      }


      case TASK.DECOY: {
        // stage 0: run to the show node and be conspicuous until a human
        // sees us (their calls now point AWAY from the dens); stage 1: evade
        // to quiet ground — job done, time bought.
        if (t.stage === 0) {
          if (a.node !== t.show) moveToward(sim, a, t.show);
          else {
            const seen = sim.occupantsNear(a.node, 1).some((h) => !h.dead && h.hp > 0 &&
              (h.faction === FACTION.MARINE || h.faction === FACTION.ARMED));
            if (seen) {
              t.stage = 1;
              const quiet = hive.quietNodeNear(a.node, 'big');
              t.hide = quiet !== -1 ? quiet : a.node;
              sim.log('bait', 'the decoy has been spotted — it melts away');
            }
          }
        } else {
          if (a.node !== t.hide) moveToward(sim, a, t.hide);
          else if (!a.move) a.task = null; // gone to ground; hive re-tasks
        }
        break;
      }

      case TASK.DART: {
        // DOOR BAIT, the runner's half (user tactic): step through the door
        // into the defended room — one committed, visible, tracker-painting
        // move — then double straight back and rejoin the motionless pack.
        if (t.stage === 0) {
          if (a.node !== t.into) moveToward(sim, a, t.into,
            (from, to) => sim.graph.path(from, to, ['std'], (l) => !l.locked));
          else if (!a.move) t.stage = 1; // seen enough — turn around
        } else {
          if (a.node !== t.back) moveToward(sim, a, t.back,
            (from, to) => sim.graph.path(from, to, ['std'], (l) => !l.locked));
          else if (!a.move) {
            // back with the pack: re-stage and hold dead still again
            hive.assign(a, { kind: TASK.GUARD, node: t.back, muster: t.muster, until: sim.t + 90 });
          }
        }
        break;
      }

    }
  }
}

function moveToward(sim, a, node, pathFn = null) {
  if (a.move || a.path.length || a.node === node) return;
  const hive = sim.hive;
  let path;
  if (pathFn) path = pathFn(a.node, node);
  else if (a.faction === FACTION.INFECTION) path = hive.safeInfectionPath(a.node, node);
  // combat forms route AROUND remembered gun lines — the plain shortest path
  // marched every form transiting near the last stand straight through it,
  // one at a time. NO VENTS for the big forms (user rule: the in-wall
  // ducting is infection-only now) — corridors and the cross-deck
  // stairs, ladders and lifts are all they get.
  else path = hive.safeAssaultPath(a.node, node)
    ?? sim.graph.path(a.node, node, ['std'], hive.combatPass);
  if (path && path.length) sim.setPath(a, path);
  else if (!path) a.task = null; // believed-unreachable; hive will reassign
}

function nextInfectionStep(sim, hive, form) {
  if (form.path.length) return form.path[0];
  const task = form.task;
  let target = -1;
  if (task?.kind === TASK.MOVE || task?.kind === TASK.SCOUT || task?.kind === TASK.GUARD) {
    target = task.node;
  } else if (task?.kind === TASK.GRAB) {
    const victim = sim.byId.get(task.targetId);
    target = victim?.pnode ?? victim?.node ?? -1;
  }
  if (target < 0 || target === form.node) return null;
  return hive.safeInfectionPath(form.node, target)?.[0] ?? null;
}

export function spawnCombatForm(sim, node, at = null) {
  const f = makeAgent(FACTION.COMBAT, node, sim.graph);
  const cf = sim.P.combat.combatForm;
  // ±hpJitter so 2-marine fights are a genuine coin-flip, not a fixed result
  const j = 1 + sim.rng.range(-cf.hpJitter, cf.hpJitter);
  f.hp = f.maxHp = cf.hp * j;
  // the form stands up WHERE THE BODY LAY (user rule: solid bodies, own
  // space) — not teleported to the room's center point
  if (at) { f.x = at.x; f.y = at.y; }
  sim.spawn(f);
  return f;
}

function updateCarrier(sim, a, dt) {
  const P = sim.P;
  if (a.hp <= 0 || a.dead) return;
  // GAME-ACCURATE CARRIER (user note): infection forms accumulate INSIDE the
  // swelling carrier. Nothing comes out until it RUPTURES — when it takes
  // fire, or when it hits its top limit. The gestation timer is independent
  // of movement, so a carrier dragged to safety keeps swelling.
  a.mintTimer += dt;
  // production backpressure: a hive drowning in forms pauses gestating
  // (also keeps the agent buffer within its 512 capacity)
  if (sim.agents.reduce((n, x) => n + (!x.dead && x.faction === FACTION.INFECTION ? 1 : 0), 0) >= P.carrier.productionBackpressure) return;
  // §6.6: the first form seats quickly, then ~1 per interval up to the limit
  const due = a.held === 0 ? P.carrier.firstIncubationSec : P.carrier.incubationIntervalSec;
  if (a.mintTimer >= due && a.held < P.carrier.maxInfectionForms) {
    a.mintTimer = 0;
    a.held++;
    if (a.held === 1) sim.log('carrier', `the carrier in ${sim.graph.node(a.node).name} begins to swell`);
  }
  // TOP LIMIT — the skin can't hold: it ruptures where it stands
  if (a.held >= P.carrier.maxInfectionForms) { explodeCarrier(sim, a); return; }
  // a near-full carrier waddles toward prey so the rupture lands on someone —
  // the pop itself still only comes from gunfire or the limit
  if (a.held >= P.carrier.maxInfectionForms * P.carrier.seekOrExplodeFraction) {
    const nearHumans = sim.occupantsNear(a.node, 1).filter((h) => h.hp > 0 &&
      (h.faction === FACTION.CIVILIAN || h.faction === FACTION.ARMED || h.faction === FACTION.MARINE));
    if (nearHumans.length && !a.move && !a.path.length && nearHumans[0].node !== a.node) {
      const path = sim.graph.path(a.node, nearHumans[0].node, ['std'], sim.hive.bigPass);
      if (path) sim.setPath(a, path);
    }
  }
}

export function explodeCarrier(sim, a) {
  if (a.dead) return;
  a.dead = true;
  const P = sim.P;
  // real blast reach (user note: real space logic) — the rupture hurts
  // whoever is physically near it, not "everyone in the room record"; in a
  // hangar you can be thirty meters clear of the pop
  for (const h of sim.agents) {
    if (h.dead || h.hp <= 0 || h.deck !== a.deck) continue;
    if (h.faction !== FACTION.CIVILIAN && h.faction !== FACTION.ARMED && h.faction !== FACTION.MARINE) continue;
    if ((h.pnode ?? h.node) !== (a.pnode ?? a.node)) continue; // walls contain the burst
    if (Math.hypot(h.x - a.x, h.y - a.y) <= P.carrier.explodeRadiusM) {
      // attributed to the carrier so a marine killed by the burst ticks the
      // hive's marine counter down (a rupture is very much the hive's kill)
      sim.hurtHuman(h, P.carrier.explodeDamage, a.id);
    }
  }
  // everything it was carrying spills out at once, in a ring around the
  // rupture point — not teleported to the room's center
  const room = sim.graph.node(a.node);
  const n = a.held ?? 0;
  for (let i = 0; i < n; i++) {
    const f = makeAgent(FACTION.INFECTION, a.node, sim.graph);
    f.hp = f.maxHp = 1;
    const ang = i * 2.399963;
    const r = 0.6 + 0.22 * i;
    f.x = Math.max(room.x - room.w / 2 + 0.4, Math.min(room.x + room.w / 2 - 0.4, a.x + Math.cos(ang) * r));
    f.y = Math.max(room.y - room.d / 2 + 0.4, Math.min(room.y + room.d / 2 - 0.4, a.y + Math.sin(ang) * r));
    sim.spawn(f);
  }
  sim.stats.formsMinted += n;
  sim.log('carrier', `a carrier ruptures in ${sim.graph.node(a.node).name} — ${n} infection form${n === 1 ? '' : 's'} spill out`);
}

function convertHuman(sim, form, target) {
  // a grab that reaches a radio-haver may get a scream out (§6.5 penalty)
  if (target.hasRadio && !target.calledOut) {
    target.calledOut = true;
    if (sim.rng.chance(0.5)) sim.emitCall(target);
  }
  target.dead = true;
  // a TAKEN marine is the surest kill the hive knows about (user redesign)
  if (target.faction === FACTION.MARINE) sim.hive.noteMarineKill(target);
  const cf = spawnCombatForm(sim, target.node, target);
  cf.hostArmed = target.faction === FACTION.ARMED || target.faction === FACTION.MARINE;
  // "IMMEDIATELY STARTS THE SAME PROCESS" (user): a live host does not skip
  // the convulsion — the kill and the corpse-take are one continuous horror.
  // Latch 3 s, dead, and the body drops straight into the same rooted thrash
  // the burrow pipeline uses (soaks fire at full HP, throws nothing) before
  // it stands. Same flag, so the renderer's ragdoll writhe and the reanim
  // sound cue pick it up with zero extra plumbing.
  cf.transformingUntil = sim.t + sim.P.combat.thrashSec;
  if (target.isPlayer) {
    // The afterlife camera follows the physical thing wearing this player.
    // Per-player linkage matters in co-op; a single global converted id made
    // the last conversion steal every dead player's camera.
    cf.fromPlayer = true;
    cf.playerSourceId = target.id;
    cf.bodyType = target.bodyType;
    target.afterlifeId = cf.id;
    target.respawnReadyAt = sim.t + sim.P.player.respawnSec;
  }
  sim.removeAgent(form); // 1 infection form spent on a living host (§6.6)
  sim.stats.conversions++; sim.stats.conversionsRound++;
  sim.stats.humansConverted++;
  sim.log('convert', `${factionName(target.faction)} taken in ${sim.graph.node(target.node).name} — the body begins to convulse`, target.node, target.x, target.y);
}

function factionName(f) {
  return f === FACTION.CIVILIAN ? 'a civilian' : f === FACTION.ARMED ? 'an armed crewman' : 'a marine';
}
