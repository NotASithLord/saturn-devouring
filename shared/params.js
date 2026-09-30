// Tuning parameters (§10) and Flood decision-math constants (§13.10).
// Stated values are fixed by design; PLACEHOLDER values are starting guesses.
// The three MASTER DIALS (radio.marineCallReliability, belief.decayRatePerSec,
// belief.predictionQuality) are exposed live in the debug UI.

export const PARAMS = {
  sim: {
    tickHz: 15,               // movement/sense tick
    strategicTickSec: 2.5,    // one "infection round"
  },
  // WHAT YOU SET IS WHAT YOU GET (user note): force composition is explicit
  // counts — squads, squad sizes, civilians, bodies — no fractions to decode.
  // Only WHERE everyone starts (plus which doors jam, which vents collapse,
  // which rooms lose power) rolls fresh each run.
  crew: {
    civilians: 96,            // unarmed crew sheltering / working the ship
    armedCrew: 21,            // crew carrying sidearms (not marines)
    lowerMaintenance: 44,     // unarmed repair crew AT WORK in the lower-deck machinery
                              // spaces (engineering/reactor/life support) from the start
                              // (user note: "way more souls alive in the lower levels")
    brigPrisoners: 2,
    medbayWounded: 6,
    radio: { civilian: 0.35, armed: 0.7, marine: 1.0 }, // hasRadio fraction
  },
  marines: {
    squads: 4,                // line squads
    squadSize: 4,             // marines per line squad
    patrols: 3,               // roaming pair patrols walking the whole ship
    patrolSize: 2,
    garrison: 6,              // permanent Command Corridor guard detail
    deckGuardPerRoom: 1,      // one mobile Deck 1 sentry in every actual room
  },
  // open flame on the deck (breach blaze + burning broken doors): real
  // environmental damage inside the radius, and every NPC steers clear
  fire: { dps: 10, radiusM: 2.1 },
  bodies: {
    eventCorpses: 69,         // portal-event dead scattered evenly through the ship
                              // (user note: +15% more bodies, evenly spread)
    breachMin: 5, breachMax: 7, // fresh dead at the breach, uniform per run (user tuning)
    // the vast majority of the dead were NOT carrying weapons (user rule):
    // a form raised from them fights with claws alone — sprint, leap, swipe
    armedFraction: 0.08,
  },
  // DIFFICULTY LEVERS (user direction): without the player in the loop the
  // flood should win most runs — the marines alone can't hold the ship. Tune
  // difficulty with the initial swarm size and comms quality, not squad nerfs.
  flood: {
    initialInfectionForms: 12, // solo base when the breach is above the lower two decks
    lowerDeckInitialInfectionForms: 10,
    initialInfectionFormsPerAdditionalPlayer: 3,
    dormantVentReserves: 2,   // final extinction wakes at most two isolated pods already hidden in the duct network
    weakHiveReserveDelaySec: 90, // a near-extinct hive with no producers may wake one before the last pod dies
    initialCombatForms: 0,     // a pure infection swarm; combat forms + carriers
    initialCarriers: 0,        // are EARNED through conversions, not handed out at t=0
  },
  // GAME-ACCURATE CARRIER (user note): forms accumulate INSIDE the swelling
  // carrier and only spill out when it RUPTURES — under fire, or at the top
  // limit. Gestation starts the moment the carrier forms.
  carrier: {
    incubationIntervalSec: 8.409375, // +15% gestation reins in protected-carrier snowballs
    firstIncubationSec: 4.485,   // the quick first form pays the same +15%
    maxInfectionForms: 8,      // top limit — the skin can't hold more; it ruptures
    seekOrExplodeFraction: 0.85, // near-full: waddle toward prey so the pop lands on someone
    explodeDamage: 20,         // to humans within the rupture radius
    explodeRadiusM: 7,         // real blast reach — a rupture across a hangar misses you
    transformSec: 4,           // time for a combat form to root into a carrier
    productionBackpressure: 130, // pause minting above this many live infection forms
  },
  combatForm: {
    selfReviveChance: 0.25,    // stated
    selfReviveWindowSec: 10,   // stated
    damageMax: 100,            // maxed = permanently useless
    reviveIntegrityFrac: 0.5,
    reanimateIntegrityFrac: 0.6,
    reanimateTimeSec: 2,
  },
  flamethrower: {
    fuelUnits: 100, dps: 50, fuelPerSec: 2, fuelPerCorpse: 1,
    rangeM: 9, burnNodeSec: 15,
    // IN YOUR HANDS (user: "make the flamethrower something the player can
    // use"). Deliberately NOT the NPC numbers. A marine's flamer is an
    // abstraction that ticks a dps pool into a room; yours is aimed, so it
    // needs a reach, a cone, and a tank that runs dry fast enough that
    // carrying it is a decision. dps is 2x the line rate, the same
    // player-vs-NPC parity the rifle already has.
    //
    // The tank is the whole balance: 8 units/s against 100 units is 12.5 s of
    // held trigger. That is two rooms cleared, not a deck.
    player: {
      dps: 100,
      fuelPerSec: 8,
      rangeM: 9,          // the stream reaches this far and stops
      coneDeg: 24,        // half-angle it bites inside
      ignhitS: 0.10,      // igniter catch before the stream is live
      tankUnits: 100,
      armoryRefill: 55,   // a spare tank off the rack, not a full swap
    },
  },
  // DECK LINK (user: "depending on the floor you're on, the status of the other
  // floors in your map may be unreachable... it might be offline for a whole
  // minute at a time. You current floor always shows fine. We're aiming other
  // floors to show status only 60% of the time.")
  //
  // This is NOT the existing per-team sitrep dice (game/map.js _rep) and not
  // the tracker's ragged static. Those model one report failing. This models
  // the RELAY for a whole deck going down: while it is out you get nothing
  // from that deck at all — no contacts, no marine positions, no room status.
  //
  // The duty cycle is the mean up-dwell over the mean cycle: 75 / (75 + 50) =
  // Outages are FREQUENT BLIPS (user: less continuous outage, more frequent
  // shorter ones) — a relay hiccups every half minute or so and comes back
  // before you can plan around it; the map shows no countdown, so each drop
  // reads as genuine uncertainty rather than a timer to wait out.
  tacnet: {
    linkUpMinSec: 20, linkUpMaxSec: 50,     // mean 35
    linkDownMinSec: 6, linkDownMaxSec: 18,  // mean 12
  },
  // lockedFraction: per-run graph mutation (visible variety run to run).
  // MALFUNCTIONING DOORS ARE ALIVE (user): every faulty door runs its own
  // deterministic stuck/open timeline. A door with a way around it dwells
  // 1-10 min per state; a door that would CUT the ship (no route around at
  // the moment it tries to close) reopens in 30-90s and skips half its
  // close opportunities. latentFraction of healthy doors carry the fault
  // too — they seize for the first time mid-session.
  // bust*Sec: a dedicated flood charge breaks a closed door PERMANENTLY —
  // form-seconds of battering (two forms halve it), blast doors hold longer.
  door: {
    lockedFraction: 0.25,
    // Sliding panels are simulation state, not render dressing: LOS and rifle
    // damage stay blocked until the same panel the player sees is clear.
    openRadiusM: 2.6,
    slideSpeedMps: 4.5,
    ajarFraction: 0.22,
    sightOpenFraction: 0.92,
    // the ship graph is nearly a tree (52 of 53 doors are sole-route), so
    // closures are almost always the short choke kind — a fatter latent
    // population keeps the ship visibly alive without ever caging anyone
    latentFraction: 0.2,
    dwellMinSec: 60, dwellMaxSec: 600,
    chokeClosedMinSec: 30, chokeClosedMaxSec: 90,
    chokeSkipClose: 0.5,
    bustHatchSec: 8, bustBlastSec: 20,
  },
  ambush: { firstStrikeMult: 3.0 }, // PLACEHOLDER, applies to both sides
  motionTracker: { rangeHops: 1 },  // reveals a moving infection form in a vent
  power: { unstableFraction: 0.20 },// PLACEHOLDER
  sensor: {
    losHops: 1,        // same node + adjacent through open/unlocked standard edge
    hearingHops: 2,    // footsteps/screams
    gunfireHops: 3,    // gunfire carries further
  },
  radio: {
    marineCallReliability: 0.5,   // MASTER DIAL — CROSS-DECK receipt odds (same-deck calls always land)
                                  // (0.95 = intact comms; the portal event damaged them.
                                  //  Raise it and the response snuffs most outbreaks —
                                  //  re-tuned down after adding the top-deck garrison,
                                  //  armed officers, and lower-deck maintenance crew.)
    civilianCallReliability: 0.35,// PLACEHOLDER
    callFadeSec: 60,
    deckSightingDedupeSec: 3, // one Deck 1 net report per contact area, not one per sentry
  },
  rampage: {
    localReserve: 1.5,   // min local flood mass in a region before it rampages
    marineCap: 0.6,      // if believed marine strength in the region exceeds this, hide instead
  },
  swarm: {
    overwhelmRatio: 2.0,   // weighted flood:shooter ratio at which grabs work THROUGH gunfire
    dominationRatio: 2.0,  // active combat forms per believed marine that ends caution globally
    attackRatio: 1.5,      // one ratio for an unprovoked assault, muster, and local rampage
    dominationMinForms: 8, // zero/near-zero marine beliefs still require a real fighting mass
    // One attack ratio (user tuning): the hive spends forms against a marine
    // line once its local muster clears this number. Provoked or cornered
    // forms still attack at even odds; the ratio only governs planned pressure.
    musterHops: 3,         // how far the hive gathers forms for a squad-wipe
    maxMusterForms: 45,    // a wave this size flattens any line — stop waiting
    isolationHops: 3,      // no friendly squad within this = isolated
    reserveForms: 8,       // only trade forms for marines while this pool (or a carrier) remains
    escortPer: 3,          // 1 combat-form escort per ~3 infection forms in a pack
  },
  // HOW HUMANS GIVE GROUND (user rules): unarmed crew always run the other
  // way; armed crew back away firing; marines hold against one or two forms
  // and fight a withdrawal against a real pack.
  // PLAYER ARMOR, IN THE SIM (co-op: "he died on my end but was still alive
  // on his"). This lived only in the client's Player controller, which
  // intercepted its own agent's hp drops and wrote them BACK UP — so a peer
  // healed itself out of the damage the host had already applied, and the two
  // ends disagreed about whether it was alive. The authority owns it now, so
  // both players get the same buffer and the same death. Mirrors fps-data's
  // old ODST numbers exactly.
  // NO AUTO-REGEN (user: shields replaced by armor) — armor soaks damage
  // before health and comes back ONLY from armor packs found in the world.
  player: {
    armor: 50,
    respawnSec: 30,
  },
  // racked in the armory + scattered through the ship, per boarder — same
  // machinery as med packs: seed-stable pools, issued as players attach,
  // used on the spot with E, restores armor to full.
  armorpacks: {
    perPlayerArmory: 3,
    perPlayerScatter: 5,
    useRadiusM: 2.0,
  },
  morale: {
    marineHoldForms: 2,    // stand your ground at this many forms or fewer
    backpedalMps: 1.0,     // retreating fire is a walk backwards, not a sprint
    giveGroundM: 7.0,      // standoff a withdrawing shooter tries to keep
    breakContactM: 2.9,    // backed into claw range with nowhere left: break for the door
  },
  // MARINE FRAGS (user: two each, thrown occasionally). Deliberately NOT the
  // player's frag: an NPC lobs it at a CLUSTER it can see, never at its own
  // feet, and never where a friendly is standing.
  grenade: {
    perMarine: 2,
    pickupRadiusM: 2.2,
    playerMax: 12,
    minTargets: 3,         // not worth a frag for one form
    rangeM: 20,
    minSafeM: 6.0,         // never throw closer than this to yourself or a friendly
    cooldownSec: 14,       // per marine
    chancePerSec: 0.55,    // "occasionally", once the shot is actually there
    fuseSec: 1.275,      // same 15% fuse reduction as the player's frag
    damage: 120,
    radiusM: 6.5,
  },
  lastStand: {
    marineFraction: 0.3,   // when squad marines drop below this of start, fall back
    hearChance: 0.65,      // per-survivor roll to hear the fallback call
    officerJoinChance: 0.6,// stay-put officers who step out into the corridor line
    armedJoinFraction: 0.8,// armed civilians who stand WITH the marines on the line
  },
  armory: {
    selfArmChance: 0.25,   // chance an unarmed civilian runs for the armory once panic breaks out
    stock: 16,             // rifles racked — first come, first served (once unsealed)
    // THE SEALED RESERVE (user rule): the armory starts LOCKED. Inside: the
    // racked rifles + grenade crates, one flamethrower, and an ODST squad
    // standing by with more armor than a line marine. Each seed assigns its
    // own release time without consulting marine or Flood strength.
    odstSquadSize: 5,
    odstHp: 85,                // vs line marine 45 — hardened ODST plate
    releaseMinSec: 6.5 * 60,
    releaseMaxSec: 9.5 * 60,
  },
  // MED PACKS (user: "a classic halo edition ... two per player in the med
  // bay, and 2 per player randomly scattered throughout the ship as part of
  // the seed"). Used on the spot with E — never carried — and a use restores
  // to FULL regardless of how low you were.
  medkits: {
    perPlayerMedbay: 2,
    perPlayerScatter: 2,
    useRadiusM: 2.0,        // same reach as ammo/flamer scavenging
  },
  belief: {
    decayRatePerSec: 0.1,   // MASTER DIAL (lambda) — smart vs unfair
    predictionQuality: 0.7, // MASTER DIAL (q) — how well it guesses your route
    humanSpeedHops: 0.35,   // hops/s for predicted spread radius
  },
  // §13 decision math
  hive: {
    // Re-anchored from the spec's 40 (user note: "always hoarding makes no
    // sense") — in the current economy forms are MEANT to be spent on bodies
    // immediately and carriers replace them, so a modest pool is healthy,
    // not an emergency. Scarcity 1.0 at ~15 forms.
    I_ref: 15,
    kS: 1.5,
    scarcityMin: 0.5,
    scarcityMax: 4,
    riskBase: 1.0,
    militaryValue: 1.5,
    values: {                  // targetValue weights for grabs
      helpless: 3.0,
      corpse: 1.2,             // convert corpse -> combat form (plus militaryValue)
      civilianNoRadio: 2.5,
      civilianRadio: 2.0,
      armed: 1.2,
      distressPenalty: 2.5,    // grab likely to trigger a call
    },
    searchMinPool: 45,         // won't spend forms searching below this pool
    openingSweepMargin: 12,    // sec of safety margin vs estimated sweep ETA
    openingVentFraction: null, // null: spawn-aware; keep one form per crash-site body
    openingVentFromStart: 'spawn-aware', // port capacitor feeds briefly first; other sites dispatch before local corpse reflex
    openingCountUsableBodies: false, // experiment: burned bodies cannot feed local pods
  },
  // FIRETEAM COVERAGE POSTS (user: escorts should hold standing positions
  // that cover the room instead of re-shuffling every time you take a step).
  // A post is claimed once and held; it is only re-claimed when the player
  // crosses into a different SECTOR of the room, or drifts past the leash.
  // sectorM is deliberately larger than a normal compartment, so ordinary
  // rooms are a single sector and never re-post — only the big spaces
  // (hangars, cargo holds) get per-half posts.
  escort: { sectorM: 16, maxRadiusM: 7, repostLeashM: 9 },
  // Combat model (§7 support numbers, all PLACEHOLDER)
  combat: {
    // Weighted (§7 support) so a combat form is a serious threat: 1 marine
    // almost certainly loses, 2 trade roughly even (one marine down for the
    // kill), 3 win reliably.
    // HALO-STANDARD COMBAT (user note): open-room fights are DISCRETE
    // deterministic events, not damage drizzle — each shooter fires aimed
    // shots on its own cadence and ROLLS to hit (accuracy drops past
    // rifleFalloffM); each combat form lands heavy SWIPES on a cooldown.
    // All rolls go through the seeded sim RNG, so lockstep holds.
    // The bare `dps` numbers are the NOMINAL sustained rates — they still
    // drive the hive's planning estimates and the cramped shaft/ambush
    // pools, and the gun/swing numbers below are tuned to average out to
    // them (e.g. marine 3 rof x 6.5 dmg x 0.72 acc ~= 14 dps).
    marine:   { hp: 45, dps: 14, stompPerSec: 0.4,   // stomp = infection-form kills/s
                gun: { rof: 3, dmg: 6.5, accNear: 0.72, accFar: 0.32 } },
    armed:    { hp: 30, dps: 9, stompPerSec: 0.2,
                gun: { rof: 2, dmg: 6.5, accNear: 0.70, accFar: 0.30 } },
    civilian: { hp: 20 },
    // HALO-DURABLE (user rule: difficulty lives in damage/health and hive
    // tactics, not starting headcount — and the player gets NO special
    // multiplier): ~1/3 of an MA5 mag on target drops one, a marine PAIR now
    // trades a man for a form more often than not, 3 marines win clean.
    // swing: 18 dmg / 0.9 s = the same 20 dps sustained, delivered in chunks.
    combatForm: { hp: 90, dps: 20, hpJitter: 0.18,   // spawn hp varies ±18%
                  crowdRadiusScale: 1.15, // slightly looser combat-form rushes; pair separation only
                  attackersPerTarget: 3, // spread a charge across the human line instead of dogpiling one body
                  leapCooldownSec: 5, // begins on landing; ordinary charge movement continues
                  swing: {
                    dmg: 18, cooldownSec: 0.9, animSec: 0.74,
                    // A grounded whip drops a body nearby. A running strike
                    // carries farther; an airborne pounce can clear a room.
                    standSpeed: 5.5, chargeBonus: 3.5, jumpBonus: 7.0,
                    standUp: 2.5, jumpUp: 5.2, standSpin: 10, jumpSpin: 17,
                    standKick: 9, jumpKick: 15,
                    // KNOCKBACK ON A LIVING TARGET (user: the flood's melee
                    // "should shove you backwards some"). The numbers above
                    // are RAGDOLL launch speeds — they only ever fired when a
                    // swing KILLED, because hurtHuman used the impulse solely
                    // to seed a corpse's death throw. Surviving a hit moved
                    // you not at all. These are the living-body versions:
                    // enough to break your stride and your aim, not enough to
                    // fling you across the compartment.
                    shoveMps: 3.6,        // an NPC on its feet
                    shovePlayerMps: 7.0,  // ~1 m of visible displacement before the controller damps it
                  } },
    hostWeaponDps: 5,          // nominal (shaft pools / hive estimates)
    // the armed MINORITY of forms spray the host's weapon one-handed and
    // wildly (lore) — suppressive noise more than marksmanship
    hostGun: { rof: 2, dmg: 5, accNear: 0.35, accFar: 0.15 },
    carrierHp: 40,
    // THE LATCH KILLS IN 3 (user: "when an infection form latches onto an
    // alive human, it kills them within 3 seconds and immediately starts the
    // same process") — same clock for everyone: armor decides whether the pod
    // REACHES you, not how long the spike takes once it is in.
    infectionGrabSec: 3,       // armed crew/marines
    civilianGrabSec: 3,        // civilians
    // HALO-3 CONVERSION (user): the turn is three visible phases, not one
    // timer. The pod must be RIGHT ON TOP of the body (seatRangeM) before
    // anything starts; then it BURROWS in — pod visible, digging, still
    // shootable (kill it and the corpse is spared); then the pod is spent
    // and the body IS a combat form already (user: counts, health, effects —
    // everything but movement): it thrashes where it lies for thrashSec,
    // shootable at full combat-form HP, before it stands and fights.
    seatRangeM: 0.12,          // "on top" means on top — the old gate was 0.35 m + a snap
    burrowSec: 1.4,            // pod digging into the corpse (interruptible)
    thrashSec: 4.0,            // the transforming body convulsing before it stands
    // POINT-BLANK RISK (user rule): letting an infection form get this close
    // is always a mistake, marine or not — it lunges for the latch
    lungeRiskM: 3.0,
    latchDps: 4,               // the embedded spike works while it burrows (user: pods
                               // were too unlethal to marines)
    grabPins: true,            // a grabbed target is held in place (can't flee)
    armedBraveryStrength: 0.9, // fights only if visible flood strength below this
    // REAL SPACE COMBAT (user note): claws and grabs land at arm's reach,
    // measured in actual meters — not "anywhere inside the same room record"
    meleeRangeM: 2.2,          // combat-form claws/lunge reach
    grabRangeM: 1.4,           // an infection form must actually reach the body (a short leap latches)
    // POUNCE (user: "when they get within 2 meters of a live target the
    // infection forms should leap through the air at him in an arc, locking
    // the arc into the place they were standing"). The OPPOSITE shape to the
    // combat form's long committed charge (sim.js LEAP_MIN): a short hop that
    // launches just outside grabRangeM, so the pod lands ON the spot its
    // target was standing and the next tick's latch takes them there.
    pounce: {
      rangeM: 2.0,   // launch radius — and only at a LIVE target: a form crossing
                     // to a body walks onto it, jumping would carry it past the
                     // corpse it came to burrow into
      peakM: 0.8,    // apex of the hop. Not the long leap's 25%-of-distance rule:
                     // that gives 0.5 m over 2 m, and the renderer eases hoverY
                     // with a ~0.07 s time constant against a ~0.25 s hop, so a
                     // lower apex smooths away to a body that never left the deck
      clearM: 1.2,   // pod body + margin that must fit above the apex. The apex is
                     // CLAMPED under this, never GATED on it — gating a 2 m hop on
                     // a tall hold (what the long leap does) would mean pods only
                     // ever pounce in the hangars, never in the corridors where
                     // they actually get within 2 m of you
      landM: 0.15,   // "landed" tolerance. The long leap's 0.35 m is 18% of a 2 m
                     // hop — it would end the arc with the pod still a quarter of
                     // a metre up, and it would snap to the deck
    },
    stompRangeM: 4.0,          // boots/point-fire kill skittering forms only up close
    podAccMult: 0.45,          // a skittering pod is a small fast rifle target
    rifleFalloffM: 12,         // full NPC rifle effect inside this — beyond it, a dark
    rifleFarFactor: 0.5,       // ship and a sprinting target halve effective fire
    // Geometric acquisition envelope. Darkness and fog reduce accuracy below;
    // they do not create a second, contradictory definition of visibility.
    sightM: 26,
    // Staggered human reaction on a FRESH acquisition (>lull since a target
    // was last in sight): base + per-roll scatter, plus a big penalty when
    // the contact appears outside the shooter's ~70° facing cone (they have
    // to hear it, turn, and re-acquire).
    reactBaseSec: 0.35, reactScatterSec: 0.75, reactBehindSec: 0.9,
    reactLullSec: 4, reactConeRad: 1.2,
    // per-marine marksmanship spread: acc multiplier in [1-spread, 1+spread]
    // hashed off the agent id — squads have a good shot and a poor one
    marksmanSpread: 0.25,
    // FRIENDLY FIRE (user): rifles are dangerous to everyone downrange.
    // A squadmate inside the tight lane corridor BLOCKS the shot — the
    // shooter holds and side-steps for a clear line instead of firing
    // through him — and a MISSED shot with a squadmate hugging the lane
    // (inside grazeHalfM but outside laneHalfM) can clip him.
    ff: {
      laneHalfM: 0.55,       // a friendly this close to the fire lane blocks it
      grazeHalfM: 1.1,       // missed shots can clip friendlies inside this
      grazeChance: 0.08,     // per missed shot with a friendly in the graze band
      blockedHitChance: 0.1, // firing anyway THROUGH a man in the lane
      dmgMult: 0.65,         // a graze, not a center-mass kill shot
      holdMaxSec: 1.6,       // a marine who still has no lane after this fires
                             // anyway — discipline loses to the thing charging
                             // him, and suppression stays bounded
      callCooldownSec: 18,   // radio discipline: one "check your fire" per burst
    },
  },
  // FLOOD DARKNESS (user rule): a room the flood holds ALONE goes dark at
  // 60 s (biomass overgrows the fixtures) and fills with spore fog at
  // 120 s. Humans fight in it by flashlight — accuracy suffers, more in
  // fog. If no flood is present the room recovers at double speed.
  darkness: {
    soloDarkSec: 60,
    fogSec: 120,
    maxHoldSec: 150,
    // FOG PERSISTENCE (user rule): once a room fogs, the murk does NOT fade
    // on its own. It burns off only after the last flood inside is eliminated
    // AND the player or an ODST holds the room for this long — and any flood
    // re-entry before that mark restarts the clock in full.
    fogLingerSec: 120,
    darkAccMult: 0.75,   // flashlight fighting (flood-darkened room)
    fogAccMult: 0.8,     // stacked on top in spore fog (net ~0.6)
    // fixture-state penalties (user rule): shooters in a DEAD-lit room fight
    // by flashlight; in a flickering one their lead is thrown off a little
    unlitAccMult: 0.7,
    flickerAccMult: 0.9,
    fogViewM: 8,         // how far the player's flashlight cuts into the fog
  },
  marineDoctrine: {
    firstSweepDelaySec: 10,    // muster time before the crash sweep launches (§5.3)
    crashCommitSec: 45,        // stop concentrating on a hot crash and fan out
    crashSecureSec: 15,        // minimum time on site, counted from actual arrival
    pursuitMemorySec: 20,      // keep pushing toward a retreating contact's last seen room
    officers: 4,               // officer civilians who stay put in Officer Country
    bridgeOfficers: 3,         // captain + officers who never leave the bridge
    radarMemorySec: 3.5,       // one shared room-level paint, long enough to survive the strategic cadence
    radarCooldownSec: 6,       // finish checking one paint before chasing another
    ladderBlastSettleSec: 0.75,// pause after a frag clears the far ladder mouth
  },
  civilian: {
    fleeHearingHops: 1,        // only bolt from trouble this close (was ship-wide)
    workerFraction: 0.2,       // fraction still working the ship — they move with purpose
    workMoveChancePerSec: 0.03,// a work trip every ~30s, not constant lapping; halved once the outbreak is known
  },
  speed: { // multipliers on movement.baseMps (relative ratios are user-set)
    // a scared human RUNS (user: they fled at a jog) — 4.2 m/s, a real
    // panicked sprint. The lunge (~6.6) and charge (~6.3) still beat it.
    civilian: 1.0, civilianFlee: 3.0, armed: 1.0, marine: 1.0,
    // pods SKITTER at full tilt ALWAYS (user: they read fast when attacking
    // and slow otherwise — one speed now). 3.76 is 20% below the former 4.7,
    // still faster than a panicked human sprint without dominating every
    // open-room pursuit.
    infection: 3.76, combatForm: 1.25,
    carrier: 0.55, // lore: a slow, blundering waddle — people underestimate it
    drag: 0.5,
    // lore: combat forms don't jog at prey — they SPRINT, as fast as a
    // sprinting Spartan (~6.3 m/s at this multiplier). Real-space combat
    // made the approach cost real seconds of incoming fire, so the charge
    // must be game-fast or every open-room assault dies crossing the floor.
    chargeMult: 3.6,
    // lore: an infection form closing on a host doesn't walk — it SKITTERS
    // and leaps. Must comfortably beat civilianFlee or no grab ever lands
    // in open space (grabs now require physical reach). The old 3.5 burst
    // was folded into the base multiplier (user: pods looked fast attacking
    // and slow otherwise — they move at the fast speed ALL the time now);
    // the plumbing stays so the charging flag still drives the sprint anim.
    infectionLunge: 1.0,
    // ...and once the 2 m pounce commits (combat.pounce) it goes faster still.
    // Deliberately small: the hop is only ~4 sim ticks long at 15 Hz as it is,
    // and a bigger burst leaves the render's arc smoothing nothing to draw.
    infectionPounce: 1.2,
  },
  // REAL DISTANCES (user note): the map is laid out in meters and travel
  // time = distance / speed — the foundation for the navigable 3D map.
  // baseMps is a purposeful walk; the speed multipliers above scale it.
  movement: {
    baseMps: 1.4,             // human purposeful walk
    doorDelaySec: { hatch: 0.8, blastdoor: 2.5, lift: 0, ladder: 0 },
    liftSec: 10,              // call + ride, distance-independent
    ladderClimbMps: 1.2,      // vertical speed on ladder runs — a deck in ~3.5s;
                              // with one-body-at-a-time ladders (user rule), the
                              // old 0.5 crawl turned every queue into minutes
    // FLOOD DUCT HIGHWAY (user: vent travel ~3x faster) — the ducts are the
    // flood's fast private network; a form rips through them far quicker than
    // it crosses open floor, which is what makes them worth using.
    shaftMps: 2.1,            // crawl pace in cross-deck ducts (was 0.7)
    // the duct network is the pod's HIGHWAY: straight grate-to-grate runs at
    // a hard scuttle. Effective ~1.9 m/s after winding — about walking pace
    // per meter, but with zero corridor detours and zero guns, so any real
    // distance is decisively faster (and safer) through the walls.
    ventMps: 2.55,
    crawlWindingFactor: 1.35, // shafts/vents are never straight lines
    // grate transfer: prying in at one end and dropping out at the other.
    // Paid twice per transit — it is what keeps a next-door hop cheaper
    // through the DOOR while a cross-ship run stays far faster in the walls
    // (travel time ∝ real grate-to-grate distance — the map's own dimensions)
    ventTransferSec: 1.2,
  },
  // command path (companion spec §0/§3.4). In single-player the producer
  // stamps orders this many ticks ahead; the same knob is net.inputDelayTicks
  // (~3-5) once lockstep transport slots underneath the queue.
  net: { inputDelayTicks: 1 },
  command: { linkReliability: 0.9 }, // per-deck order delivery (companion §2.4), tunable
  // CLASSIC-HALO RAGDOLL (cosmetic; physics/ragdoll.js). Feel knobs for the
  // death flop — the whole block is render-only and never touches sim state
  // (docs/DESIGN-RAPIER-STACK.md's "ragdoll flourish lives outside the
  // authoritative set"). Tune here, not in the solver. Distances in meters,
  // speeds m/s, damping per-second, angles radians.
  ragdoll: {
    enabled: true,
    maxActive: 48,          // concurrent physics ragdolls; deaths past this render as static corpses
    gravity: 22,            // matches the game's frag-throw gravity, so a flop reads at the same weight
    bodyLen: 1.7, bodyRadius: 0.3, comY: 0.9,   // torso capsule + centre of mass (feet at y=0);
                                                // a flat body rests with its centreline ~radius off
                                                // the deck, matching the legacy corpse's 0.25 lift

    restitution: 0.18,      // bodies thud, maybe bounce once — not rubber
    groundFriction: 6.0, groundAngFriction: 5.0, // slide/tumble bleed-off while touching the deck
    linDamp: 0.1, angDamp: 1.0,                  // air damping (per second, exp)
    maxLinSpeed: 24, maxAngSpeed: 28,            // hard clamps — the stability backstop
    sleepLin: 0.16, sleepAng: 0.4, sleepSec: 0.5,// settle → freeze the resting pose
    inertia: 1.2,           // scalar rotational inertia for contact response
    driftLimitM: 1.5,       // if the sim moves the body this far (dragged/relocated), drop the ragdoll
    // launch off the killing blow (PLAN-ANIM-POLISH "hit-direction deaths").
    // Punchier than the first pass (user: "more drama, more punch to the bullet
    // force") — a shot body jolts back and tumbles harder.
    launchSpeed: 6.5, launchUp: 3.2, spin: 9.0,
    chargeBonus: 4.5,       // a charging/leaping form that dies carries its momentum into the tumble
    corpseKnockSpeed: 4.0, corpseHostileRangeM: 4.0, // a human corpse is thrown off the nearest hostile
    // GRENADE / EXPLOSION deaths (user: "grenades should launch folks in a
    // flailing manner"). Radial off the blast centre, scaled by proximity: big
    // air, a violent tumble, and limbs whipping (blastKick >> limbKick). A blast
    // also re-flings bodies already on the deck. blastRadiusPad extends the
    // "caught in it" reach past the sim blast (cosmetic only); blastTtl keeps the
    // blast live long enough for the deaths it causes to register; blastFalloff
    // is the edge-vs-centre drop.
    blastSpeed: 13, blastUp: 6.0, blastSpin: 17, blastKick: 14,
    blastFalloff: 0.55, blastRadiusPad: 1.5, blastTtl: 0.5,
    // limbs (the floppy flail about the JMS joint pivots)
    limbGrav: 9, limbBind: 2.5, limbDamp: 3.0, limbLimit: 1.4, limbKick: 7.0,
    // limb-tip contact (user: limbs folded into the torso / clipped into the
    // deck): tips ride a limbRadius above the floor and outside a keep-out
    // cylinder of limbKeepOut x bodyRadius around the torso axis
    limbRadius: 0.08, limbKeepOut: 0.8,
    // internal fixed step: 1/120, the tuned reference (a 1/60 experiment
    // halved the cost but coincided with folded-looking settles in play —
    // user report — so the flop keeps its authored integration rate)
    subDt: 0.008333333, maxSubSteps: 8, dtCap: 0.05,
  },
};

// Deep-clone params so a run can mutate its own copy (live dials) without
// touching the defaults.
export function cloneParams() {
  return JSON.parse(JSON.stringify(PARAMS));
}
