// Human & marine AI (§5). Civilian FSM with panic contagion and unreliable
// radio; armed humans that fight only from strength or desperation; marine
// squads with a shared blackboard, the automatic first sweep, distress-call
// convergence, morale, and cautious shaft use.

import { FACTION } from '../shared/agentBuffer.js';
import { STATE } from './init.js';
import { humanPass, marinePass } from './graph.js';

export function updateHumansTick(sim, dt) {
  for (const a of sim.agents) {
    if (a.dead || a.hp <= 0) continue;
    if (a.isPlayer) continue; // the player thinks for themselves
    // last-stand fallback: survivors who heard the call make for the command
    // deck whenever they aren't actively fighting or fleeing something seen
    if (a.fallbackNode !== undefined && a.node !== a.fallbackNode
      && (a.faction !== FACTION.MARINE || (!a.garrison && sim.squads[a.squad]?.broken))
      && a.state !== STATE.FIGHT && !a.move && !a.path.length
      && floodThreatVisible(sim, a) === 0) {
      if (sim.setPathTo(a, a.fallbackNode, ['std'], humanPass)) a.state = STATE.MOVE;
    } else if (a.armingUp !== undefined && a.fallbackNode === undefined
      && a.faction === FACTION.CIVILIAN && a.state !== STATE.FIGHT
      && !a.move && !a.path.length && floodThreatVisible(sim, a) === 0) {
      // panic-driven armory run (user note): reach the rack, take a rifle
      if (a.node === a.armingUp) {
        const took = (sim.armoryStock ?? 0) > 0;
        a.armingUp = undefined;
        if (took) {
          sim.armoryStock--;
          a.faction = FACTION.ARMED;
          a.hp = a.maxHp = Math.max(a.hp, sim.P.combat.armed.hp);
          a.hasRadio = true;
          sim.log('combat', `a civilian arms up at the armory (${sim.armoryStock} rifles left)`);
        }
      } else if (sim.setPathTo(a, a.armingUp, ['std'], humanPass)) a.state = STATE.MOVE;
      else a.armingUp = undefined; // no safe route — give it up
    }
    if (a.faction === FACTION.CIVILIAN) updateCivilian(sim, a, dt);
    else if (a.faction === FACTION.ARMED) updateArmed(sim, a, dt);
    else if (a.faction === FACTION.MARINE) updateMarineTick(sim, a, dt);
  }
}

function floodThreatVisible(sim, a) {
  // LINE OF SIGHT, not room membership (user: the per-room model was a dated
  // early-dev thing): the threat a human reacts to is the flood it can SEE —
  // its own compartment plus whatever shows through real openings (open
  // doorways and the grand stairwell's open volume). Closed doors block both
  // acquisition and fire; sim.losClear walks the actual geometry.
  return sim.losFloodThreat(a);
}

function hearsTrouble(sim, a) {
  return sim.heardGunfire(a.node) || sim.heardScreams(a.node);
}

// Only trouble within a hop or two rattles an idle civilian into moving —
// distant commotion elsewhere on the ship shouldn't send everyone running
// (user note: crew running around too much before panicking).
function closeTrouble(sim, a) {
  for (const n of sim.nodesNear(a.node, sim.P.civilian.fleeHearingHops)) {
    if (sim.floodStrengthAt(n) > 0) return true;
    if (sim.tickCount - sim.gunfireTick[n] < 30) return true;
  }
  return false;
}

function maybeDistressCall(sim, a, reliability) {
  if (a.calledOut || !a.hasRadio) return;
  a.calledOut = true; // one attempt per agent
  if (sim.rng.chance(reliability)) sim.emitCall(a);
}

// --- civilians (§5.1) ---
function updateCivilian(sim, a, dt) {
  const P = sim.P;
  if (a.helpless) {
    // wounded/prisoners can scream for help but cannot move
    if (floodThreatVisible(sim, a) > 0) maybeDistressCall(sim, a, P.radio.civilianCallReliability);
    return;
  }
  const threat = floodThreatVisible(sim, a);

  // Panic EXPIRES (user note: no more running back and forth forever). Being
  // panicked is a burst, not a permanent state — it lasts a few seconds past
  // the last thing that scared them, then they go to ground.
  if (threat > 0 && a.panicked) a.panicUntil = sim.t + 8;
  if (a.panicked && sim.t > (a.panicUntil ?? 0) && threat === 0) a.panicked = false;

  // panic contagion: SEEING a panicked neighbor can panic you — and it makes
  // you bolt ONCE, right now, not stand up and jog laps later
  if (!a.panicked && !a.stayPut) {
    for (const n of sim.visibleNodes(a.node)) {
      if (sim.panickedAt(n) && sim.rng.chance(0.06 * dt * 15)) {
        a.panicked = true;
        a.panicUntil = sim.t + 8;
        if (a.state === STATE.IDLE || a.state === STATE.HIDE) {
          a.state = STATE.FLEE; a.hideTimer = 0; a.fleeSteps = 0;
        }
        break;
      }
    }
  }

  // flood in the SAME node = immediate danger, react even from HIDE
  const floodHere = sim.floodStrengthAt(a.node) > 0;

  switch (a.state) {
    case STATE.IDLE:
    case STATE.HIDE:
      // A calm civilian stays put. They move only when they actually SEE the
      // Flood (or a fresh panic bolts them, handled above). No idle wandering,
      // and NO re-bolting from a hiding spot on stale panic.
      if (threat > 0) {
        // ALWAYS RUN (user rule): an unarmed human that SEES the Flood turns
        // and runs, full stop — no dwell, no weighing whether the next room
        // is meaningfully safer. The old 0.3 s alert beat plus fleeStep's
        // "only move if it improves things" gate had them standing in a
        // doorway watching a combat form walk at them.
        a.state = STATE.ALERT; a.alertTimer = 0;
        if (sim.rng.chance(floodHere ? 0.9 : 0.4)) { a.panicked = true; a.panicUntil = sim.t + 8; }
        // point-blank contact you SCREAM (local noise), you don't calmly get
        // a coherent call out; a doorway sighting still radios normally
        maybeDistressCall(sim, a, P.radio.civilianCallReliability * (floodHere ? 0.25 : 1));
      } else if (a.worker && a.fallbackNode === undefined && !sim.lastStand
        && !a.move && !a.path.length
        && sim.rng.chance(P.civilian.workMoveChancePerSec * (sim.floodKnown ? 0.5 : 1) * dt)) {
        // the ~20% still working the ship move with purpose — occasionally,
        // not constantly; half as often once the outbreak is common knowledge,
        // and not at all once the fallback call has gone out
        workerRelocate(sim, a);
      }
      break;
    case STATE.ALERT:
      a.alertTimer -= dt;
      if (a.alertTimer <= 0) {
        // stay-put officers hold their compartment and cower; everyone else
        // runs from what they've seen
        a.state = a.stayPut ? STATE.COWER : STATE.FLEE;
        a.hideTimer = 0; a.fleeSteps = 0;
      }
      break;
    case STATE.FLEE: {
      if (!a.move && !a.path.length) {
        const next = fleeStep(sim, a);
        if (next === -1) { a.state = STATE.COWER; break; }
        if (next === null) { a.state = STATE.HIDE; a.panicked = false; break; } // safest spot is right here
        sim.setPath(a, [next]);
        a.lastFledFrom = a.node;
        a.fleeSteps = (a.fleeSteps || 0) + 1;
      }
      // once clear of any visible Flood, stop running and go to ground —
      // don't keep trotting around the ship (this is what made them wander
      // in and out of danger). A short settle, then a sticky HIDE.
      if (threat === 0 && !a.move && !a.path.length) {
        a.hideTimer += dt;
        // going to ground ENDS the episode: hide and calm down, so the same
        // scare can't keep them jogging laps (panic also expires on its own)
        if (a.hideTimer > 1.5 || a.fleeSteps >= 3) { a.state = STATE.HIDE; a.panicked = false; }
      } else a.hideTimer = 0;
      break;
    }
    case STATE.COWER:
      // pinned with no safe exit: keep screaming, bolt only if a way opens
      if (floodHere) maybeDistressCall(sim, a, P.radio.civilianCallReliability);
      if (threat === 0) a.state = STATE.HIDE;
      else if (!floodHere && fleeStep(sim, a) !== -1) { a.state = STATE.FLEE; a.fleeSteps = 0; }
      break;
    case STATE.MOVE:
      // a worker in transit still reacts the instant it sees the Flood
      if (threat > 0) {
        a.path = []; a.state = STATE.ALERT; a.alertTimer = floodHere ? 0 : 0.3;
        if (sim.rng.chance(floodHere ? 0.9 : 0.4)) a.panicked = true;
        maybeDistressCall(sim, a, P.radio.civilianCallReliability * (floodHere ? 0.25 : 1));
      } else if (!a.move && !a.path.length) a.state = STATE.IDLE; // arrived
      break;
  }
}

// A working civilian walks to a system that needs tending, or back to a
// habitable space, staying clear of anywhere it currently sees the Flood.
function workerRelocate(sim, a) {
  if (!a._workNodes) {
    a._workNodes = sim.graph.nodes
      .filter((n) => ['systems', 'power', 'engineering', 'medbay', 'armed', 'quarters', 'soft', 'command'].some((r) => n.roles.includes(r))
        || (a.lowerDecks && ['maintenance', 'cargo', 'vehicles', 'hangar'].some((r) => n.roles.includes(r))))
      .filter((n) => !a.lowerDecks || n.deck >= 4) // lower-deck crew stay below
      .map((n) => n.idx);
  }
  const dest = sim.rng.pick(a._workNodes);
  if (dest === a.node) return;
  if (sim.floodStrengthAt(dest) > 0) return; // don't stroll into a den
  const path = sim.graph.path(a.node, dest, ['std'], humanPass);
  // avoid routing through a compartment that currently holds the Flood
  if (path && !path.some((s) => sim.floodStrengthAt(s.to) > 0)) {
    a.path = path;
    a.state = STATE.MOVE;
  }
}

// Step to the safest neighbor, NEVER toward a node that has Flood in it.
// Returns -1 when every exit is into the Flood or blocked (→ cower), and
// null when staying put is at least as safe as any move — a civilian who can
// merely SEE the Flood through a doorway goes to ground where they are
// instead of ping-ponging between two rooms (user note).
function fleeStep(sim, a) {
  const floodHere = sim.floodStrengthAt(a.node) > 0;
  const safe = [];
  for (const { to } of sim.graph.neighbors(a.node, ['std'], humanPass)) {
    if (sim.floodStrengthAt(to) > 0) continue; // never flee into the Flood
    if (to === a.lastFledFrom && !floodHere) continue; // no backtracking laps
    safe.push(to);
  }
  if (!safe.length) return floodHere ? -1 : null; // trapped: cower / hide here
  if (a.panicked && sim.rng.chance(0.4)) return sim.rng.pick(safe); // blind panic
  let best = null, bestScore = Infinity;
  for (const to of safe) {
    const score = sim.influence.floodStr[to] * 4 + sim.rng.range(0, 0.3);
    if (score < bestScore) { bestScore = score; best = to; }
  }
  // (the old "only run if it improves things" gate is gone — user rule: they
  // always run the other way. lastFledFrom already stops two-room laps, and
  // FLEE still ends in HIDE once nothing is visible.)
  return best;
}

function nearestRoom(sim, from) {
  const targets = sim.graph.nodes.filter((n) => n.type === 'room' && !sim.graph.hasRole(n.idx, 'command')).map((n) => n.idx);
  const ff = sim.graph.flowField(targets, ['std'], humanPass);
  if (ff.dist[from] === -1) return -1;
  let cur = from;
  while (ff.dist[cur] !== 0) cur = ff.next[cur];
  return cur;
}

// Human morale reads the same visible bodies their weapons can acquire. A
// threshold never makes a nearby form disappear from either the count or the
// distance check.
function visibleFloodForms(sim, a) {
  return sim.lineOfSightAgents(a, (o) => !o.downed
    && (o.faction === FACTION.INFECTION || o.faction === FACTION.COMBAT || o.faction === FACTION.CARRIER));
}
function nearestFloodDist(sim, a) {
  let best = Infinity;
  for (const o of visibleFloodForms(sim, a)) {
    const d = Math.hypot(o.x - a.x, o.y - a.y);
    if (d < best) best = d;
  }
  return best;
}

function nearestVisibleFlood(sim, a) {
  let best = null, bestDistance = Infinity;
  for (const form of visibleFloodForms(sim, a)) {
    const distance = Math.hypot(form.x - a.x, form.y - a.y);
    if (distance < bestDistance) { best = form; bestDistance = distance; }
  }
  return best;
}

function reportDeckSighting(sim, a, contact) {
  const contactNode = contact ? (contact.pnode ?? contact.node) : undefined;
  // Re-arm when sight is lost, and report again when the contact crosses into
  // another room. emitCall coalesces different sentries seeing that incident.
  if (contactNode !== undefined && contactNode !== a.deckContactNode && a.hasRadio) {
    sim.emitCall(a, { node: contactNode, deckSighting: true });
  }
  a.deckContactNode = contactNode;
}

// --- armed humans (§5.2) ---
function updateArmed(sim, a, dt) {
  const P = sim.P;
  const threat = floodThreatVisible(sim, a);
  const cornered = fleeStep(sim, a) === -1 && threat > 0;

  if (a.state === STATE.FIGHT) {
    if (threat === 0) { a.givingGround = false; a.state = a.stayPut ? STATE.IDLE : STATE.FLEE; return; }
    // RETREATING FIRE (user rule: "armed ones run backwards while shooting").
    // A crewman with a sidearm does not turn his back on the Flood and he does
    // not stand still either — he walks backwards putting rounds into it.
    // Officers on a post hold their ground and never give it.
    a.givingGround = !a.stayPut;
    if (a.givingGround && !cornered && nearestFloodDist(sim, a) < P.morale.breakContactM) {
      // backed into claw range with room behind him: break contact through
      // the nearest safe door rather than die swinging a pistol
      const next = fleeStep(sim, a);
      if (next !== null && next !== -1) {
        sim.setPath(a, [next]); a.state = STATE.MOVE;
        a.givingGround = false; a.lastFledFrom = a.node;
      }
    }
    return; // combat resolution handles the shooting
  }
  if (threat > 0) {
    maybeDistressCall(sim, a, P.radio.civilianCallReliability * 1.5);
    // an armed crewman ALWAYS answers with his weapon — he just answers it
    // walking backwards (above). Only the helpless-unarmed path below runs.
    a.state = STATE.FIGHT; a.path = []; a.move = null;
    a.givingGround = !a.stayPut;
    return;
  }
  a.givingGround = false;
  updateCivilian(sim, a, dt); // nothing in sight: behave like anyone else
}

// MARINE FRAGS (user: two each, thrown occasionally). A marine lobs one at a
// CLUSTER he can see — never at a single form, never at his own feet, never
// where a friendly is standing. The throw is a sim event with a real fuse;
// sim._grenadeTick detonates it through the same explodeAt the player's frag
// uses, so the blast damages Flood, crew and corpses by the same rules.
export function marineThrowFragAt(sim, a, node, x, y, chance = 1, targetRoomOnly = false) {
  const G = sim.P.grenade;
  if (a.frags <= 0 || a.state === STATE.DEAD || a.hp <= 0) return false;
  if (sim.t < (a.nextFragAt ?? 0)) return false;
  const target = sim.graph.node(node);
  // Blasts are room-contained, so only friendlies physically in the target
  // compartment can be endangered. This also makes a downward ladder throw
  // safe for the squad waiting one deck above without special-case geometry.
  for (const other of sim.agents) {
    if (other.dead || other.hp <= 0) continue;
    if (other.faction !== FACTION.CIVILIAN && other.faction !== FACTION.ARMED
      && other.faction !== FACTION.MARINE) continue;
    if (targetRoomOnly) {
      if ((other.pnode ?? other.node) !== node) continue;
    } else if (other.deck !== target.deck && other.id !== a.id) continue;
    if (Math.hypot(other.x - x, other.y - y) < G.minSafeM) return false;
  }
  if (chance < 1 && !sim.rng.chance(chance)) return false;
  a.frags--;
  a.nextFragAt = sim.t + G.cooldownSec;
  (sim.grenades ??= []).push({
    at: sim.t + G.fuseSec, deck: target.deck, x, y, by: a.id,
  });
  // callsign is a {rank, name} RECORD, not a string — interpolating it raw
  // printed "[object Object] throws a frag" in the radio log (playtest)
  sim.log('combat', `${a.callsign ? `${a.callsign.rank} ${a.callsign.name}` : 'a marine'} throws a frag into ${target.name}`, node, x, y);
  return true;
}

function maybeThrowFrag(sim, a, dt) {
  const G = sim.P.grenade;
  if (a.frags <= 0 || a.state === STATE.DEAD || a.hp <= 0) return;
  if (sim.t < (a.nextFragAt ?? 0)) return;
  const visible = sim.lineOfSightAgents(a, (o) => !o.downed
    && (o.faction === FACTION.INFECTION || o.faction === FACTION.COMBAT || o.faction === FACTION.CARRIER), G.rangeM);
  let best = null, bestN = G.minTargets - 1;
  for (const target of visible) {
    let count = 0;
    for (const other of visible) {
      if (Math.hypot(other.x - target.x, other.y - target.y) <= G.radiusM) count++;
    }
    if (count > bestN) { best = target; bestN = count; }
  }
  if (!best) return;
  const bx = best.x, by = best.y;
  const bestNode = best.pnode ?? best.node;
  // Safety is checked before the roll inside the helper, preserving both the
  // original decision order and the deterministic RNG stream.
  if (dt > 0) marineThrowFragAt(sim, a, bestNode, bx, by, G.chancePerSec * dt);
}

// --- marines (§5.3) ---
function updateMarineTick(sim, a, dt) {
  const P = sim.P;
  // The corridor garrison is a fixed strongpoint. Deck-room sentries are also
  // garrison for force accounting, but their one-Marine squads may answer a
  // same-deck distress call and therefore continue through normal squad AI.
  if (a.garrison && !a.deckGuard) {
    const contact = nearestVisibleFlood(sim, a);
    a.state = contact ? STATE.FIGHT : STATE.IDLE;
    a.path = []; a.move = null;
    reportDeckSighting(sim, a, contact);
    return;
  }

  // ODST reserve sealed in the armory (user rule): until the seal releases
  // they hold the room — posted at the racks, killing anything that crawls
  // in through the ducts, taking no orders and answering no calls.
  if (a.odst && sim.armoryLocked) {
    a.state = sim.losFloodThreat(a) > 0 ? STATE.FIGHT : STATE.IDLE;
    a.path = []; a.move = null;
    return;
  }

  const squad = sim.squads[a.squad];
  if (!squad || squad.broken) { updateArmed(sim, a, dt); return; }
  // Arrival is a physical event, so record it here rather than waiting for
  // the slower strategic cadence. This makes the full security interval
  // load-bearing even when contact begins at the crash-room doorway.
  if (squad.phase1 && squad.reachedBreachAt === undefined
    && (a.pnode ?? a.node) === sim.graph.breachNode) {
    squad.reachedBreach = true;
    squad.reachedBreachAt = sim.t;
    sim.log('sweep', `squad ${squad.id + 1} reaches the crash site`);
  }

  const threat = floodThreatVisible(sim, a);
  maybeThrowFrag(sim, a, dt);
  // The same sightline both updates the squad blackboard and starts the
  // firefight. There is no detection-only state that can park the squad at an
  // opening while its rifles consider the exact same form untargetable.
  if (threat > 0) {
    const contact = nearestThreat(sim, a, squad);
    squad.contactNode = contact ? (contact.pnode ?? contact.node) : (a.pnode ?? a.node);
    squad.contactTick = sim.tickCount;
    // A withdrawal is tactical information while the form remains visible,
    // not hive omniscience after it vanishes. Remember only its last-seen
    // room so the squad follows through the doorway instead of parking where
    // the firefight ended. Once a squad starts this chase it keeps refreshing
    // the same target even if the form switches tasks while under fire.
    if (contact && (contact.task?.retreat || squad.pursuitTargetId === contact.id)) {
      squad.pursuitTargetId = contact.id;
      squad.pursuitNode = squad.contactNode;
      squad.pursuitTick = sim.tickCount;
    }
    sim.floodKnown = true;
    if (squad.deckGuard) {
      // Command-deck room sentries are the reliable local alarm network. A
      // live sighting always redirects the two nearest available floaters.
      reportDeckSighting(sim, a, contact);
    } else if (a.hasRadio && !squad.calledContact) {
      squad.calledContact = true;
      if (sim.rng.chance(sim.P.radio.marineCallReliability)) sim.emitCall(a);
    }
  } else if (squad.deckGuard) {
    reportDeckSighting(sim, a, null);
  }
  if (threat > 0) {
    // stand and fight ON CONTACT, where you physically are — a marine does
    // not keep walking to the middle of the hangar with a form on the deck
    a.state = STATE.FIGHT; a.path = []; a.move = null;
    a.heldCombatGround = true;
    // HOLD OR WITHDRAW (user rule): one or two forms is a firefight a marine
    // wins standing. A real pack is not — he keeps shooting and gives ground,
    // and once they are in his face with room behind him he breaks for the
    // next compartment and re-forms the line there.
    const visible = visibleFloodForms(sim, a);
    const forms = visible.length;
    a.givingGround = forms > P.morale.marineHoldForms;
    if (a.givingGround && nearestFloodDist(sim, a) < P.morale.breakContactM) {
      const next = fleeStep(sim, a);
      if (next !== null && next !== -1) {
        sim.setPath(a, [next]); a.state = STATE.MOVE;
        a.givingGround = false; a.lastFledFrom = a.node;
      }
    }
    return;
  }
  a.givingGround = false;
  if (a.state === STATE.FIGHT) a.state = STATE.MOVE;
  // Start the chase on the first clear tick, before the next strategic round.
  // Standing player orders and the last-stand line remain authoritative.
  const pursuitFresh = squad.pursuitNode !== undefined
    && sim.tickCount - squad.pursuitTick <= P.marineDoctrine.pursuitMemorySec * P.sim.tickHz;
  const guardMayPursue = !squad.deckGuard || squad.objective?.kind === 'distress'
    || squad.pursuitResume?.kind === 'distress';
  if (pursuitFresh && sim.tickCount > squad.contactTick && !squad.order
    && !squad.lastStandBound && !securingCrash(sim, squad) && guardMayPursue) {
    setPursuitObjective(squad, squad.pursuitNode, squad.pursuitTargetId);
  }
  // a marine standing in a clear room has swept it — timestamp it so the
  // squad's sweep planner expands into unswept ground instead of doubling back
  if (sim.graph.node(a.node).type !== 'corridor' && threat === 0) sim.sweptAt[a.node] = sim.t;

  // FOLLOW THE PLAYER LIVE (user: fireteam bad at following + deck nav). For an
  // escort order, chase the player's CURRENT node and re-path the MOMENT they
  // move to a new room — don't wait ~2.5 s for the strategic tick or for a
  // stale path to drain. ['std'] already includes the lift/ladder/stairwell
  // edges, so this follows across decks too.
  if (squad.order?.kind === 'order:escort') {
    a.closeFollow = false;
    const lead = sim.byId.get(squad.order.entityId);
    if (lead && !lead.dead) {
      if (lead.node !== a.node && !a.move && lead.node !== a.followNode) {
        a.followNode = lead.node;
        a.path = [];
        if (sim.setPathTo(a, lead.node, ['std'], humanPass)) a.state = STATE.MOVE;
      } else if (lead.node === a.node && !a.move && sim.floodStrengthAt(a.node) === 0) {
        // COVERAGE POSTS (user: "they should take up standing positions per
        // room to cover it, not respond so granularly to you that they are
        // constantly running around even with little movement").
        //
        // The old slot was recomputed every tick from the player's LIVE
        // position AND heading, so a single step — or just turning on the
        // spot — slid the whole ring and sent four marines jogging. A post is
        // claimed ONCE and then held. It is only re-claimed when the player
        // genuinely changes where they are in the room: crossing into a
        // different SECTOR of it (so a hangar or cargo hold gets different
        // posts per half, while a normal compartment is one sector and never
        // re-posts at all), or drifting past the leash.
        const E = sim.P.escort;
        const room = sim.graph.node(lead.node);
        const sxi = Math.floor((lead.x - (room.x - room.w / 2)) / E.sectorM);
        const syi = Math.floor((lead.y - (room.y - room.d / 2)) / E.sectorM);
        const key = `${lead.node}|${sxi}|${syi}`;
        const stale = a.postKey !== key || a.postX === undefined
          || Math.hypot(a.postX - lead.x, a.postY - lead.y) > E.repostLeashM;
        if (stale) {
          a.postKey = key;
          const mi = Math.max(0, squad.members.indexOf(a.id));
          // golden spacing, anchored on the room rather than on which way the
          // player happens to be looking — the arc each marine covers stays
          // put while you move around inside the sector
          const ang = mi * 2.399963 + lead.node * 0.7;
          const off = Math.min(E.maxRadiusM, 3.2 + (mi % 3) * 1.4);
          a.postX = Math.max(room.x - room.w / 2 + 0.8,
            Math.min(room.x + room.w / 2 - 0.8, lead.x + Math.cos(ang) * off));
          a.postY = Math.max(room.y - room.d / 2 + 0.8,
            Math.min(room.y + room.d / 2 - 0.8, lead.y + Math.sin(ang) * off));
          a.postFace = ang; // face OUT from the anchor: each man covers his arc
        }
        const tx = a.postX, ty = a.postY;
        const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
        a.followSpeed = 0; // drives the render clip (walk/run) — see _clipFor
        if (d > 0.5) {
          // human speeds (user: they moved too fast): jog to catch up, walk in
          const mps = d > 6 ? 5.4 : d > 2.5 ? 4 : 2.0;
          const step = Math.min(d, mps * dt);
          a.x += (dx / d) * step; a.y += (dy / d) * step;
          sim._clampToRoom(a, sim.graph.node(a.node));
          a.followSpeed = step / dt;
        }
        // walking in, look where you're going; on station, cover your arc
        a.heading = d > 0.8 ? Math.atan2(dy, dx) : a.postFace;
        a.animTime += sim._gaitDt(a, dt, a.followSpeed);
        a.closeFollow = true; // _advanceMovement won't park-drift it off station
      }
    }
  }

  // follow the squad objective
  if (!a.move && !a.path.length && squad.objective) {
    const target = squad.objective.node;
    if (a.node !== target) {
      // cautious doctrine: corridors first, shafts only when there is no
      // other way (or when in hot pursuit — squad.pursuing)
      const guardPass = squad.deckGuard ? deckOnePass(sim) : humanPass;
      let ok = sim.setPathTo(a, target, ['std'], guardPass);
      if (!ok && !squad.deckGuard) ok = sim.setPathTo(a, target, ['std'], marinePass);
      if (ok) {
        a.state = STATE.MOVE;
      } else {
        // One separated rifleman must never cancel the shared assignment for
        // everybody. Only the point marine can release an unreachable task;
        // laggards instead try to rejoin the point and the patrol keeps moving.
        const leader = squad.members.map((id) => sim.byId.get(id))
          .find((member) => member && !member.dead && member.hp > 0);
        if (leader?.id !== a.id) {
          if (leader && a.node !== leader.node
            && sim.setPathTo(a, leader.node, ['std'], guardPass)) a.state = STATE.MOVE;
        } else {
          releaseUnreachableObjective(sim, squad);
        }
      }
    }
  }

  // flamethrower economy denial (§7): burn corpse caches once the outbreak
  // is known and the node is quiet
  if (a.flamer && a.fuel > 0 && sim.floodKnown && sim.floodStrengthAt(a.node) === 0) {
    const nd = sim.graph.node(a.node);
    if (nd.roles.includes('corpse_cache') || a.node === sim.graph.breachNode || a.node === sim.burnOrderNode) {
      a.burnTimer = (a.burnTimer || 0) + dt;
      if (a.burnTimer >= 2) {
        a.burnTimer = 0;
        const corpse = sim.agents.find((c) => !c.dead && c.faction === FACTION.CORPSE && c.node === a.node && c.damage < 100);
        if (corpse) {
          corpse.damage = 100;
          a.fuel -= sim.P.flamethrower.fuelPerCorpse;
          sim.stats.corpsesBurned++;
          // the fuel goes onto THAT body, not into the middle of the room —
          // and the trigger is down for the length of the squirt (see FLAMING)
          sim.igniteFlame(a.node, corpse.x, corpse.y, `marine:${a.id}`, 0.85);
          a.heading = Math.atan2(corpse.y - a.y, corpse.x - a.x);
          a.flameAimX = corpse.x; a.flameAimY = corpse.y; a.flameAimDeck = corpse.deck;
          a.flamingT = sim.t;
          if (sim.stats.corpsesBurned % 10 === 1) sim.log('burn', `flamethrower burning bodies in ${nd.name} (fuel ${a.fuel.toFixed(0)})`, a.node);
        }
      }
    }
  }
}

function nearestThreat(sim, a, squad) {
  let best = null, bestDistance = Infinity;
  for (const form of visibleFloodForms(sim, a)) {
    const distance = Math.hypot(form.x - a.x, form.y - a.y);
    const priority = form.id === squad.pursuitTargetId ? 0 : form.task?.retreat ? 1 : 2;
    const bestPriority = best
      ? best.id === squad.pursuitTargetId ? 0 : best.task?.retreat ? 1 : 2
      : Infinity;
    if (priority < bestPriority || (priority === bestPriority && distance < bestDistance)) {
      best = form; bestDistance = distance;
    }
  }
  return best;
}

function setPursuitObjective(squad, node, targetId) {
  const kind = squad.objective?.kind;
  // Crash response and distress work resume after the chase; routine sweep
  // targets are cheap and will be freshly selected from the squad's new room.
  if (kind !== 'pursuit' && (kind === 'breach' || kind === 'distress')) {
    squad.pursuitResume = squad.objective;
  }
  squad.objective = { kind: 'pursuit', node, targetId };
}

function releaseUnreachableObjective(sim, squad) {
  const kind = squad.objective?.kind;
  if (kind === 'motion') {
    squad.objective = squad.radarResume ?? null;
    squad.radarResume = null;
    squad.radarSeenTick = undefined;
    squad.radarCooldownUntil = sim.t + sim.P.marineDoctrine.radarCooldownSec;
    return;
  }
  if (kind === 'pursuit') {
    endPursuit(squad);
  } else {
    squad.objective = null;
  }
  if (kind === 'distress') squad.respondingTo = null;
}

function endPursuit(squad) {
  squad.objective = squad.pursuitResume ?? null;
  squad.pursuitResume = undefined;
  squad.pursuitNode = undefined;
  squad.pursuitTargetId = undefined;
  squad.pursuitTick = undefined;
  squad.contactNode = undefined;
  squad.contactTick = undefined;
}

function securingCrash(sim, squad) {
  return squad.phase1 && squad.reachedBreachAt !== undefined
    && sim.t - squad.reachedBreachAt < sim.P.marineDoctrine.crashSecureSec;
}

function deckOnePass(sim) {
  // Stable function identity keeps graph caches bounded while guaranteeing a
  // sentry never takes a cross-deck shortcut between two command rooms.
  return sim._deckOneMarinePass ??= (link, from, to) => humanPass(link)
    && sim.graph.node(from).deck === 1 && sim.graph.node(to).deck === 1;
}

// Translate a standing player order (companion spec §2.2/§2.3) into the
// squad objective the movement code already understands. Returns true if the
// order is holding the squad (skip autonomous re-planning this round).
function applySquadOrder(sim, squad, leader) {
  const o = squad.order;
  switch (o.kind) {
    case 'order:move':
      if (leader.node === o.node) {
        // arrived. RESPOND/FALL_BACK are one-shot; plain MOVE_TO holds.
        if (o.respond !== undefined || o.fallback) { squad.order = null; return false; }
        squad.objective = { kind: 'hold', node: o.node };
      } else {
        squad.objective = { kind: 'order', node: o.node };
      }
      return true;
    case 'order:guard':
      squad.objective = { kind: 'order', node: o.node };
      return true;
    case 'order:patrol': {
      const route = o.route;
      if (leader.node === route[o.leg]) o.leg = (o.leg + 1) % route.length;
      squad.objective = { kind: 'order', node: route[o.leg] };
      return true;
    }
    case 'order:escort': {
      const target = sim.byId.get(o.entityId);
      if (!target || target.dead) { squad.order = null; return false; }
      squad.objective = { kind: 'order', node: target.node };
      return true;
    }
    default:
      return false;
  }
}

// --- squad strategic re-planning (§5.3, runs each infection round) ---
export function strategicSquads(sim) {
  const P = sim.P;
  // phase 2 can't wait on a breach CLEAR that may never come — if the crash
  // site is known-hot and hasn't been secured within a couple of minutes,
  // the ship goes to general deck sweeps anyway (this is what left every
  // squad holding position forever while the lower decks rotted)
  const crashMinimumMet = sim.squads
    .filter((squad) => squad.phase1 && squad.reachedBreachAt !== undefined && !squad.odst)
    .every((squad) => sim.t - squad.reachedBreachAt >= P.marineDoctrine.crashSecureSec);
  if (!sim.firstSweepCleared && sim.floodKnown
    && sim.t > P.marineDoctrine.crashCommitSec && crashMinimumMet) {
    sim.firstSweepCleared = true;
    sim.log('sweep', 'crash site is hot and holding — squads begin general deck sweeps');
    for (const s of sim.squads) {
      if (!s.phase1 || s.odst) continue;
      s.phase1 = false;
      if (s.objective?.kind === 'breach') s.objective = null; // stop besieging, start sweeping
      if (s.pursuitResume?.kind === 'breach') s.pursuitResume = undefined;
    }
  }

  mergeThinSquads(sim);
  for (const squad of sim.squads) {
    const members = squad.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    // morale: heavy losses break the squad (§5.3)
    if (!squad.broken && members.length > 0 && members.length < Math.ceil(squad.size0 / 2)) {
      squad.broken = true;
      sim.log('morale', `squad ${squad.id + 1} broken — survivors fall back to individual behavior`);
      continue;
    }
    if (squad.broken || members.length === 0) continue;
    if (squad.odst && sim.armoryLocked) continue; // the sealed reserve takes no taskings
    const leader = members[0];

    // engaged squads don't re-plan
    if (members.some((m) => m.state === STATE.FIGHT)) continue;

    // roaming pair patrols run their own doctrine: circuit + distress response
    if (squad.patrol) { patrolPlan(sim, squad, leader); continue; }

    // Deck 1 sentries never join ship-wide sweeps or command tasking. They
    // answer only same-deck distress traffic, then return to their room posts.
    if (squad.deckGuard) { deckGuardPlan(sim, squad, leader); continue; }

    // launch the mustered crash sweep once the delay elapses (user note)
    if (squad.pendingSweep && sim.t >= sim.P.marineDoctrine.firstSweepDelaySec) {
      squad.pendingSweep = false;
      squad.objective = { kind: 'breach', node: sim.graph.breachNode };
      squad.phase1 = true;
      sim.log('sweep', `squad ${squad.id + 1} moves out to the crash site`);
    }
    if (squad.pendingSweep) continue; // still mustering — hold

    // player command override (companion spec §2.3): a standing order sets
    // the squad's objective and suppresses autonomy until it completes or is
    // RELEASEd. Self-defense and morale still apply (handled per-tick).
    if (squad.order && applySquadOrder(sim, squad, leader)) continue;

    // last stand: a squad that heard the call binds to the corridor line and
    // stops sweeping/responding — it fights its way home and holds
    if (squad.lastStandBound) {
      squad.objective = { kind: 'order', node: sim.graph.byId.get('d1corr') };
      continue;
    }

    // a squad set to ignore calls (SET_CALL_POLICY) skips the call scan
    const callPolicy = squad.callPolicy ?? 'auto';

    // distress calls: roll reliability once per squad per call (§5.3);
    // this is the MASTER DIAL for coordination efficiency
    // during the initial muster the squads are still kitting up — no distress
    // dispatch until the ship's reflex response has actually stood up
    const mustering = sim.t < P.marineDoctrine.firstSweepDelaySec;
    for (const call of (mustering || callPolicy === 'ignore' ? [] : sim.calls)) {
      if (sim.t - call.t > P.radio.callFadeSec) continue;
      if (call.rolled.has(squad.id)) continue;
      call.rolled.add(squad.id);
      // deck-based receipt (user): same-deck broadcasts always land; anything
      // cross-deck fights the dying net — the same rule the player's feed
      // lives by, so marine coordination degrades exactly like your own intel
      const sameDeck = sim.graph.node(call.node).deck === sim.graph.node(leader.node).deck;
      if (!sameDeck && !sim.rng.chance(P.radio.marineCallReliability)) {
        sim.log('radio', `squad ${squad.id + 1} missed a distress call (comms damage)`);
        continue;
      }
      if (squad.objective?.kind === 'breach') continue; // first sweep is not diverted
      // dispatch doctrine: the two nearest squads take a call, the rest
      // keep sweeping — otherwise every call empties the whole ship
      const responders = sim.squads.filter((s) => !s.broken && s.respondingTo === call.id).length;
      if (responders >= 2) continue;
      const cur = squad.objective?.kind === 'distress'
        ? sim.graph.hops(leader.node, squad.objective.node, ['std'], humanPass) : Infinity;
      const d = sim.graph.hops(leader.node, call.node, ['std'], marinePass);
      if (d !== -1 && d < cur) {
        squad.objective = { kind: 'distress', node: call.node, callId: call.id };
        squad.respondingTo = call.id;
        sim.log('radio', `squad ${squad.id + 1} responding to distress in ${sim.graph.node(call.node).name}`);
      }
    }

    // make the crash-response convergence visible in the log
    if (squad.objective?.kind === 'breach' && !squad.reachedBreach && leader.node === sim.graph.breachNode) {
      squad.reachedBreach = true;
      squad.reachedBreachAt = sim.t;
      sim.log('sweep', `squad ${squad.id + 1} reaches the crash site`);
    }

    // A visibly retreating contact is a mandatory chase. Ordinary contact
    // reports retain the existing judgment roll, so a squad does not blindly
    // pursue every possible hive feint.
    const pursuitFresh = squad.pursuitNode !== undefined
      && sim.tickCount - squad.pursuitTick <= P.marineDoctrine.pursuitMemorySec * P.sim.tickHz;
    const contactFresh = squad.contactNode !== undefined
      && sim.tickCount - squad.contactTick < 15 * 10;
    const pursueReportedContact = contactFresh && squad.objective?.kind !== 'breach'
      && sim.rng.chance(0.6);
    if ((pursuitFresh || pursueReportedContact) && !securingCrash(sim, squad)) {
      setPursuitObjective(
        squad,
        pursuitFresh ? squad.pursuitNode : squad.contactNode,
        pursuitFresh ? squad.pursuitTargetId : undefined,
      );
    }

    // Every marine reads the same cheap room paint. It can interrupt routine
    // sweeping, but not a player order, active pursuit, a distress call, or
    // the last stand. The interrupted task resumes after the check.
    if (applyMotionRadar(sim, squad, leader, members)) continue;

    // objective reached & clear -> next objective
    const objNode = squad.objective?.node;
    // The point marine owns arrival. Requiring every scattered survivor to
    // get within one hop let a single cut-off laggard pin the whole squad to a
    // cleared pursuit room indefinitely, even though nobody had a target.
    const arrived = objNode !== undefined && leader.node === objNode && !leader.move;
    // Completion follows what the squad can actually see. Ground-truth Flood
    // mass in a large room or beyond an opening used to pin an otherwise idle
    // squad to an objective it had no target with which to engage.
    const clear = objNode !== undefined
      && members.every((member) => floodThreatVisible(sim, member) === 0);
    if (!squad.objective || (arrived && clear)) {
      if (squad.objective?.kind === 'breach') {
        // Count the security interval from actual arrival. A firefight on the
        // deck counts; only a fast, quiet clear spends the remainder posted.
        const secureAt = (squad.reachedBreachAt ?? sim.t) + P.marineDoctrine.crashSecureSec;
        if (sim.t < secureAt) continue;
        if (!sim.firstSweepCleared) {
          sim.firstSweepCleared = true;
          sim.log('sweep', `first sweep cleared the breach region (${sim.graph.node(sim.graph.breachNode).name})`);
        }
        // The minimum security interval is complete; fan out immediately.
        squad.phase1 = false;
        squad.objective = null;
      } else if (squad.objective?.kind === 'pursuit') {
        endPursuit(squad);
        if (squad.objective) continue;
      }
      if (sim.firstSweepCleared) {
        // Continuous sweep: reaching a clear room immediately selects the
        // next one. Tactical holds still come from contact, radar, orders,
        // morale, and the last stand rather than an arbitrary room timer.
        const target = pickSweepTarget(sim, leader);
        squad.objective = target !== -1
          ? { kind: 'sweep', node: target }
          : { kind: 'hold', node: leader.node };
      } else if (!squad.objective) {
        // before phase 2, non-sweep squads hold near spawn
        squad.objective = { kind: 'hold', node: leader.node };
      }
    }
  }
}

function deckGuardPlan(sim, squad, leader) {
  const P = sim.P;
  const pass = deckOnePass(sim);

  if (squad.objective?.kind === 'distress') {
    const call = sim.calls.find((entry) => entry.id === squad.objective.callId);
    const arrived = (leader.pnode ?? leader.node) === squad.objective.node;
    const clear = floodThreatVisible(sim, leader) === 0;
    const active = call && sim.t - call.t <= P.radio.callFadeSec
      && sim.graph.node(call.node).deck === 1;
    if (active && (!arrived || !clear)) return;
    squad.respondingTo = null;
    squad.objective = null;
    leader.path = [];
  }

  // A last-stand call does not pull the room sentries into one corridor; they
  // are already the command deck's distributed fallback line.
  if (squad.lastStandBound) {
    squad.objective = { kind: 'guard', node: squad.postNode };
    return;
  }

  for (let index = sim.calls.length - 1; index >= 0; index--) {
    const call = sim.calls[index];
    if (sim.t - call.t > P.radio.callFadeSec) continue;
    if (sim.graph.node(call.node).deck !== 1 || call.rolled.has(squad.id)) continue;
    call.rolled.add(squad.id);
    const nearest = sim.squads
      .filter((candidate) => candidate.deckGuard && !candidate.broken
        && (candidate.objective?.kind !== 'distress'
          || candidate.objective.callId === call.id))
      .map((candidate) => {
        const point = candidate.members.map((id) => sim.byId.get(id))
          .find((member) => member && !member.dead && member.hp > 0
            && member.state !== STATE.FIGHT);
        const distance = point
          ? sim.graph.hops(point.pnode ?? point.node, call.node, ['std'], pass) : -1;
        return { id: candidate.id, distance };
      })
      .filter((candidate) => candidate.distance >= 0)
      .sort((a, b) => a.distance - b.distance || a.id - b.id)
      .slice(0, 2);
    if (!nearest.some((candidate) => candidate.id === squad.id)) continue;
    squad.objective = { kind: 'distress', node: call.node, callId: call.id };
    squad.respondingTo = call.id;
    leader.path = [];
    if (nearest[0]?.id === squad.id) {
      const noun = nearest.length === 1 ? 'sentry' : 'sentries';
      sim.log('radio', `Deck 1 net redirects ${nearest.length} ${noun} to ${sim.graph.node(call.node).name}`, call.node);
    }
    return;
  }

  squad.objective = { kind: 'guard', node: squad.postNode };
}

// Roaming pair patrols (user note): walk the whole ship on a fixed circuit,
// peel off to distress calls like any squad (sharing the 2-responder cap),
// then pick the round back up where it left off. A commander order overrides
function patrolPlan(sim, squad, leader) {
  const P = sim.P;
  if (squad.lastStandBound) {
    squad.objective = { kind: 'order', node: sim.graph.byId.get('d1corr') };
    return;
  }
  if (squad.order && applySquadOrder(sim, squad, leader)) return;

  const members = squad.members.map((id) => sim.byId.get(id))
    .filter((member) => member && !member.dead && member.hp > 0);
  // Patrols previously had no pursuit-completion branch. Their strategic
  // plan briefly resumed the circuit, then the still-live contact memory
  // reissued the already-cleared pursuit on the same tick, forever.
  if (squad.objective?.kind === 'pursuit') {
    const arrived = leader.node === squad.objective.node && !leader.move;
    const clear = members.every((member) => floodThreatVisible(sim, member) === 0);
    if (!arrived || !clear) return;
    endPursuit(squad);
  }

  const callPolicy = squad.callPolicy ?? 'auto';
  for (const call of (callPolicy === 'ignore' ? [] : sim.calls)) {
    if (sim.t - call.t > P.radio.callFadeSec) continue;
    if (call.rolled.has(squad.id)) continue;
    call.rolled.add(squad.id);
    // same deck-based receipt rule as the squads (and the player's feed)
    const sameDeckP = sim.graph.node(call.node).deck === sim.graph.node(leader.node).deck;
    if (!sameDeckP && !sim.rng.chance(P.radio.marineCallReliability)) continue;
    const responders = sim.squads.filter((s) => !s.broken && s.respondingTo === call.id).length;
    if (responders >= 2) continue;
    const cur = squad.objective?.kind === 'distress'
      ? sim.graph.hops(leader.node, squad.objective.node, ['std'], humanPass) : Infinity;
    const d = sim.graph.hops(leader.node, call.node, ['std'], marinePass);
    if (d !== -1 && d < cur) {
      squad.objective = { kind: 'distress', node: call.node, callId: call.id };
      squad.respondingTo = call.id;
      sim.log('radio', `patrol ${squad.patrolNo} responding to distress in ${sim.graph.node(call.node).name}`);
    }
  }
  if (applyMotionRadar(sim, squad, leader, members)) return;
  if (squad.objective?.kind === 'distress') {
    const objNode = squad.objective.node;
    const clear = members.every((member) => floodThreatVisible(sim, member) === 0);
    if (leader.node === objNode && clear) { squad.objective = null; squad.respondingTo = null; }
    else return;
  }

  // Keep a reachable patrol leg stable between strategic rounds, including a
  // temporary local detour when fog cuts the fixed ship-wide circuit.
  if (squad.objective?.kind === 'patrol' && leader.node !== squad.objective.node
    && sim.pathFor(leader, squad.objective.node, ['std'], marinePass)) return;

  // Walk the circuit, skipping legs the point marine cannot currently reach
  // under the exact same fog/door policy movement will enforce. If a fog bank
  // partitions the circuit, patrol the reachable component instead of idling.
  if (leader.node === squad.route[squad.leg]) squad.leg = (squad.leg + 1) % squad.route.length;
  let target = -1;
  for (let tries = 0; tries < squad.route.length; tries++) {
    const candidate = squad.route[squad.leg];
    if (candidate !== leader.node
      && sim.pathFor(leader, candidate, ['std'], marinePass)) {
      target = candidate;
      break;
    }
    squad.leg = (squad.leg + 1) % squad.route.length;
  }
  if (target === -1) target = pickSweepTarget(sim, leader);
  squad.objective = target === -1
    ? { kind: 'hold', node: leader.node }
    : { kind: 'patrol', node: target };
}

// Marine radar is a SQUAD decision over the Sim's once-per-tick room summary,
// never a per-marine scan. It therefore adds a few graph-neighbour reads per
// strategic round, independent of how many Flood forms exist.
function applyMotionRadar(sim, squad, leader, members) {
  if (squad.objective?.kind === 'motion') {
    const contact = sim.marineMotionAt(squad.objective.contactNode);
    const arrived = (leader.pnode ?? leader.node) === squad.objective.node;
    if (contact.fresh && (!arrived || squad.objective.hold)) return true;
    squad.objective = squad.radarResume ?? null;
    squad.radarResume = null;
    squad.radarSeenTick = undefined;
    squad.radarCooldownUntil = sim.t + sim.P.marineDoctrine.radarCooldownSec;
    return false;
  }
  const kind = squad.objective?.kind;
  if (kind && kind !== 'hold' && kind !== 'sweep' && kind !== 'patrol') return false;
  if (sim.t < (squad.radarCooldownUntil ?? -1)) return false;

  let best = null;
  for (const { to } of sim.graph.neighbors(leader.pnode ?? leader.node, ['std'], humanPass)) {
    const contact = sim.marineMotionAt(to);
    if (!contact.fresh) continue;
    // Prefer the stronger paint; keep the current target on a tie so two
    // equally busy doorways cannot make a squad flip-flop every round.
    const score = contact.count;
    if (!best || score > best.score || (score === best.score && to < best.node)) {
      best = { node: to, score, tick: contact.tick };
    }
  }
  if (best) {
    squad.radarResume = squad.objective;
    // Fog is information, too: line marines check its threshold but do not
    // repeatedly accept and fail an impossible radar path into the growth.
    const hold = best.score > members.length || sim.fogAt(best.node);
    squad.objective = {
      kind: 'motion', node: hold ? (leader.pnode ?? leader.node) : best.node,
      contactNode: best.node, hold,
    };
    // Finish the doorway already underfoot, but discard every stale leg
    // after it so the squad turns toward the contact immediately on arrival.
    for (const member of members) member.path = [];
    sim.log('radio', hold
      ? `squad ${squad.id + 1} picks up heavy movement in ${sim.graph.node(best.node).name} — holding the threshold`
      : `squad ${squad.id + 1} picks up movement in ${sim.graph.node(best.node).name} — checking it out`, best.node);
    squad.radarSeenTick = best.tick;
    return true;
  }
  return false;
}

// Thinned-out squads stick together (user note): survivors of a broken or
// 2-man squad who run into a healthier squad fold into it — one bigger squad
// instead of two dying ones. The receiving squad's morale baseline grows too.
function mergeThinSquads(sim) {
  for (const A of sim.squads) {
    const aliveA = A.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
    if (!aliveA.length) continue;
    if (A.deckGuard) continue;
    if (!A.broken && aliveA.length > 2) continue; // healthy enough on its own
    if (A.patrol && aliveA.length >= 2) continue; // a pair patrol is MEANT to be 2
    for (const B of sim.squads) {
      if (B === A || B.broken || B.deckGuard) continue;
      const aliveB = B.members.map((id) => sim.byId.get(id)).filter((m) => m && !m.dead && m.hp > 0);
      if (aliveB.length < 2) continue;
      const d = sim.graph.hops(aliveA[0].node, aliveB[0].node, ['std'], humanPass);
      if (d === -1 || d > 1) continue; // must actually run into each other
      for (const m of aliveA) { m.squad = B.id; B.members.push(m.id); }
      A.members = A.members.filter((id) => !aliveA.some((m) => m.id === id));
      B.size0 += aliveA.length;
      sim.log('morale', `survivors of squad ${A.id + 1} fold into squad ${B.id + 1} (${aliveB.length + aliveA.length} rifles)`);
      break;
    }
  }
}

// Nearest room the squad hasn't cleared recently, so sweeps expand outward
// instead of doubling back. Ties break toward the breach region — the known
// danger is down where the ship was holed, not up on the command decks.
function pickSweepTarget(sim, leader) {
  const g = sim.graph;
  // fan out: never pick a room another squad is already sweeping toward —
  // this is what splits the two crash squads in different directions
  const taken = new Set();
  for (const s of sim.squads) {
    if (!s.broken && (s.objective?.kind === 'sweep' || s.objective?.kind === 'order')) taken.add(s.objective.node);
  }
  let best = -1, bestScore = Infinity;
  let fallback = -1, fallbackScore = Infinity;
  for (const n of g.nodes) {
    if (n.type === 'corridor' || n.idx === leader.node) continue;
    if (n.roles.includes('command')) continue; // the garrison holds the bridge
    const staleness = sim.t - sim.sweptAt[n.idx];
    const path = sim.pathFor(leader, n.idx, ['std'], marinePass);
    if (!path) continue;
    const d = path.length;
    const breachDist = g.hops(n.idx, g.breachNode, ['std'], marinePass);
    // the danger is DOWN where the ship was holed: breach-proximity and the
    // lower decks dominate the pick, distance-from-squad only breaks ties —
    // otherwise nearest-first keeps squads grazing the upper decks forever
    const score = d * 0.5
      + (breachDist === -1 ? 8 : breachDist) * 0.9
      - (n.deck >= 4 ? 2.5 : 0)
      - Math.min(staleness, 300) * 0.01;
    // Prefer stale, untaken ground as before. If the whole reachable ship was
    // just checked, loop onto the oldest available room instead of stopping.
    const occupiedPenalty = taken.has(n.idx) ? 100 : 0;
    if (score + occupiedPenalty < fallbackScore) {
      fallbackScore = score + occupiedPenalty; fallback = n.idx;
    }
    if (staleness >= 40 && !taken.has(n.idx) && score < bestScore) {
      bestScore = score; best = n.idx;
    }
  }
  return best !== -1 ? best : fallback;
}

// Assign the automatic first sweep (§5.3 phase 1): the TWO squads with the
// shortest human-traversable paths to the breach respond (user note). They
// muster, investigate, then fan out continuously across the ship.
export function assignFirstSweep(sim) {
  const ranked = [];
  for (const squad of sim.squads) {
    const leader = sim.byId.get(squad.members[0]);
    squad.size0 = squad.members.length;
    if (squad.patrol || squad.deckGuard) continue; // autonomous details keep their own posts/rounds
    squad.objective = { kind: 'hold', node: leader.node };
    const d = sim.graph.hops(leader.node, sim.graph.breachNode, ['std'], humanPass);
    if (d !== -1) ranked.push({ squad, d });
  }
  ranked.sort((a, b) => a.d - b.d);
  for (const { squad, d } of ranked.slice(0, 2)) {
    squad.pendingSweep = true;
    sim.log('sweep', `squad ${squad.id + 1} mustering to investigate the crash (${sim.graph.node(sim.graph.breachNode).name}, ${d} hops) — moving out in ~${sim.P.marineDoctrine.firstSweepDelaySec}s`);
  }
}
