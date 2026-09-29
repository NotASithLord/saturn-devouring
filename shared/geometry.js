// shared/geometry.js — the deck-stacking geometry that BOTH the render
// (game/world.js) and the deterministic sim (sim.js leap peak) read, so
// "how tall is this room" has exactly ONE source. Pure math: no THREE, no DOM,
// no Math.random — imports cleanly in Node for the headless sim + harness.

export const DECK_H = 4.2;   // normal deck-to-deck spacing (matches ship data)
export const CLEAR_H = 3.0;  // standard floor-to-ceiling clear height

// The HANGAR DECK (deck 5, the ventral bay) is a TALL hold. Rather than cut
// holes in the deck above it, we lift every deck ABOVE deck 5 by this much, so
// the deck-5 volume opens up to (DECK_H + HANGAR_LIFT) of clear air with no
// deck-4 floor sitting low over the hangar. Every OTHER deck gap stays DECK_H.
// why: a combat form leaping across the hangar needs real vertical space, and
// a ~4 m ceiling reads as no taller than a corridor in a 50 m-wide bay.
export const HANGAR_LIFT = 4.0;

// world Y of a deck's floor. Deck 5 (hangar) sits at 0; decks above are lifted
// so the hangar bay is tall. Deck number DECREASES going up (deck 1 = top).
export function elevOf(deck) {
  return (5 - deck) * DECK_H + (deck < 5 ? HANGAR_LIFT : 0);
}

// Attribute world geometry to the floor band it physically occupies. This
// must use elevOf rather than dividing by DECK_H: the expanded hangar makes
// the deck-5→4 gap non-uniform, and the old division mislabeled deck-4 walls
// as deck 3 until a climber completed the transition.
export function floorBandOf(worldY, tolerance = 0.15) {
  for (let deck = 1; deck < 5; deck++) {
    if (worldY + tolerance >= elevOf(deck)) return deck;
  }
  return 5;
}

// The big open volumes the Flood bounds across — hangars, cargo, vehicle bay,
// the flank weapon batteries + magazines, the grand stairwell, wide
// berthing/mess. Keyed off sim node type/roles so the sim and render agree.
const TALL_ROLES = ['hangar', 'large', 'battery', 'magazine', 'stairwell', 'vehicles'];
export function isTallRoom(node) {
  return node.type === 'open' || (node.roles ?? []).some((r) => TALL_ROLES.includes(r));
}

// Per-room clear height (floor to ceiling). A tall hold opens to the FULL gap
// under the deck above (so the deck-5 hangars become genuinely tall — ~8 m);
// everything else keeps the standard CLEAR_H, leaving any extra gap as hidden
// void overhead. The 0.3 m keeps the ceiling just under the next deck's floor.
export function clearHeightOf(node) {
  if (!isTallRoom(node)) return CLEAR_H;
  const gap = elevOf(node.deck - 1) - elevOf(node.deck);
  return Math.min(gap - 0.3, 8);
}

// --- GRAND STAIRWELL WELL -------------------------------------------------
// The switchback well cut into a stairwell room, shared by the renderer
// (game/world.js _stairGeom / _switchbackY), the sim's walked traversal
// (sim.js _stairWaypoints), the graph's stair-run measure (sim/graph.js) and
// the sim harness view (sim/viz.js). This used to live twice — once in world
// coords, once in sim coords, kept in sync by a comment — and the two copies
// drifting is exactly the kind of thing that teleports a body off the treads.
// Pure functions of the room's half-extents; the well is offset a little aft
// (+x) so the fore corridor doorway stays clear.

export const STAIR_LAND_D = 3.2; // mid-landing depth (m) — a real platform to
                                 // turn 180 on, not a tread-wide strip

export function stairWellDims(hx, hz) {
  const wellHx = Math.min(6.5, hx * 0.42), wellHz = Math.min(6, hz * 0.34);
  return {
    ox: hx * 0.12,                            // well centre offset from room centre
    wellHx, wellHz,
    landD: Math.min(STAIR_LAND_D, wellHz),    // never deeper than half the well
  };
}

// Floor height on the switchback at LOCAL (lx, lz) relative to the well
// centre (+lz = aft, where the landing is), or null outside the well. Flight
// A (lx < 0) descends hi -> mid front-to-back, flight B (lx > 0) descends
// mid -> lo back-to-front; the aft landD band is one FLAT landing at mid
// height across both flights — the turn happens on level floor.
export function switchbackElev(hi, lo, wellHx, wellHz, landD, lx, lz) {
  if (lx < -wellHx || lx > wellHx || lz < -wellHz || lz > wellHz) return null;
  const mid = (hi + lo) / 2;
  if (lz >= wellHz - landD) return mid;       // the landing
  const t = (lz + wellHz) / (2 * wellHz - landD); // 0 fore -> 1 at the landing edge
  if (lx < 0) return hi - (hi - mid) * t;     // flight A: top -> mid
  return lo + (mid - lo) * t;                 // flight B: mid -> bottom
}
