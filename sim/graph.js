// Ship graph: three traversal layers (§3.2), adjacency, flow fields (§6.3),
// and the schematic layout used both for the debug view and for agent
// position interpolation.

import { elevOf, stairWellDims } from '../shared/geometry.js';

export const LAYER = { STD: 'std', SHAFT: 'shaft', VENT: 'vent' };

// identity tags for pass predicates (hops-cache keys) — see hops() below
let _ffSeq = 0;
const EDGE_PREFIX = { hatch: 'H', blastdoor: 'B', lift: 'L', ladder: 'K', stairwell: 'T' };

export class ShipGraph {
  constructor(data) {
    this.data = data;
    // global hull scale (user tuning: a bigger ship) — room footprints and
    // the playable length stretch together; everything downstream is meters
    const S = data.sizeScale ?? 1;
    this.nodes = data.nodes.map((n, i) => ({
      ...n, idx: i, w: (n.w ?? 10) * S, d: (n.d ?? 8) * S,
    }));
    this.byId = new Map(this.nodes.map((n) => [n.id, n.idx]));
    this.n = this.nodes.length;

    const idx = (id) => {
      const i = this.byId.get(id);
      if (i === undefined) throw new Error(`unknown node ${id}`);
      return i;
    };

    this.edges = data.edges.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), type: e.type, lockable: e.lockable,
      locked: false, kind: LAYER.STD,
      // malfunction rotation (sim._doorFlipTick) + flood door-busting state —
      // pre-declared so every edge keeps one hidden class. `commanded`: the
      // crew forced this door (SET_DOOR) — the override outranks the fault.
      malfunction: false, flipAt: -1, busted: false, bustAcc: 0, commanded: false,
      // strict connection designation for the map (user note): H=hatch,
      // B=blastdoor, L=lift, K=ladder, numbered in load order
      label: EDGE_PREFIX[e.type] + '-' + String(i + 1).padStart(2, '0'),
    }));
    this.shafts = data.maintShafts.map((e, i) => ({
      i, a: idx(e.a), b: idx(e.b), ambushCorners: e.ambushCorners,
      kind: LAYER.SHAFT, label: 'S-' + String(i + 1).padStart(2, '0'),
      // occupants lying in wait per end: corner key `${shaftIdx}:${endNode}`
    }));
    // ONE VENT NETWORK (user redesign): the ducting is a single ship-wide
    // system, not a bag of pairwise runs. Every room has exactly ONE grate
    // (placed by _placeGrates as far from the room's doors as physics
    // allows), and an infection form entering ANY grate can emerge from ANY
    // other — combat forms and carriers are too big, humans never fit, and
    // door locks are irrelevant inside the walls. There are no persistent
    // vent edges: a transit is a virtual link synthesized on demand by
    // ventLink(a, b), with travel time proportional to the real distance
    // between the two grates (see sim.travelSec) — crossing the whole ship
    // through the ducts costs what the ship's size says it should.
    this.vents = [];
    this._ventLinks = new Map(); // (lo * 4096 + hi) -> synthesized link

    // adjacency: adj[node] = [{to, link}] where link is an edge/shaft record
    // (the vent layer is intentionally EMPTY — vent transits never appear in
    // hop/flow-field queries; they are routed explicitly via ventLink)
    this.adj = { std: this._buildAdj(this.edges), shaft: this._buildAdj(this.shafts), vent: this._buildAdj(this.vents) };

    // GRAND STAIRWELLS: cross-deck edges that open into one two-storey volume.
    // The upper (catwalk) and lower rooms see and shoot across the opening —
    // stored as {upper, lower} node idx so the sim can wire the sightline.
    this.stairwells = this.edges.filter((e) => e.type === 'stairwell').map((e) => {
      const upper = this.nodes[e.a].deck < this.nodes[e.b].deck ? e.a : e.b;
      const lower = upper === e.a ? e.b : e.a;
      return { upper, lower, edge: e };
    });

    this.unpowered = new Uint8Array(this.n);
    // per-room fixture state, rolled in init (0 steady / 1 soft flicker /
    // 2 harsh strobe / 3 dead). SIM state, not render dressing: marine
    // accuracy reads it (combat.js) and the 3D game lights rooms from it.
    this.lightMode = new Uint8Array(this.n);
    this.breachNode = -1;
    this.burningUntil = new Float64Array(this.n); // sim-time until which node burns
    // WHERE IN THE ROOM IT IS BURNING. Written at every site that writes
    // burningUntil, and only meaningful while that timer is live. Without it
    // the renderer had nothing but the node, so it lit the fire at the room's
    // geometric CENTRE — in a hangar that is a bulkhead thirty metres from the
    // body the fuel actually landed on.
    this.burnX = new Float32Array(this.n);
    this.burnY = new Float32Array(this.n);
    // Reserved for post-POC body-gathering blood trails (companion spec §5.4):
    // a decaying per-node/per-edge marker the hive lays while hauling corpses
    // and humans can follow. Left allocated so the mechanic drops in without
    // touching the graph structure; nothing writes these yet.
    this.trailNode = new Float32Array(this.n);
    this.trailEdge = new Float32Array(this.edges.length);
    // carrier hub queries (companion spec §5.4) go through the agent list;
    // corpses already carry stable ids + node, so no extra structure needed.

    this._layout();
  }

  _buildAdj(links) {
    const adj = Array.from({ length: this.n }, () => []);
    for (const l of links) {
      adj[l.a].push({ to: l.b, link: l });
      adj[l.b].push({ to: l.a, link: l });
    }
    return adj;
  }

  _layout() {
    // A REAL DECK PLAN (user note): all coordinates are METERS, and the
    // layout is a contiguous floor plan, not a node diagram. Row hints in
    // the ship data place every space FLUSH against the space it opens into
    // (row 0 = the corridor/bay spine, ±1 = flanking rooms sharing the
    // spine's wall, ±2 = the row behind those). Doors are openings cut into
    // genuinely shared walls; only spaces that can't touch get a short
    // connector throat. This is the plan the 3D world extrudes.
    const S = this.data?.sizeScale ?? 1;
    const LEN = (this.data?.playableLengthM ?? 220) * S;
    this.deckHeightM = this.data?.deckHeightM ?? 4.2;
    // BAND widened (user: the decks should be WIDE — substantial battery bays
    // on both flanks, not a thin spine). Room now for a third athwartships
    // tier (row ±3) of outboard weapon/machinery halls without the 2D deck
    // plans overlapping. (3D is unaffected: each deck sits at its own Y.)
    const BAND = 88 * S, TOP = 18, PADX = 12;
    this.lengthM = LEN;
    this.height = TOP + 5 * BAND + 8;
    this.deckBands = [];
    const stdNeighbors = (idx) => this.edges
      .filter((e) => e.a === idx || e.b === idx)
      .map((e) => this.nodes[e.a === idx ? e.b : e.a]);
    for (let d = 1; d <= 5; d++) {
      const band = this.nodes.filter((n) => n.deck === d);
      const y0 = TOP + (d - 1) * BAND;
      this.deckBands.push({ y0, y1: y0 + BAND });
      const yC = y0 + BAND / 2;
      for (const n of band) { n.w = n.w ?? 10; n.d = n.d ?? 8; n.row = n.row ?? 1; }

      // 1. the spine (row 0): corridors and bay chains on the centerline.
      //    Directly-connected consecutive spine spaces are snapped FLUSH so
      //    a corridor run or the hangar chain is one continuous volume.
      const spine = band.filter((n) => n.row === 0).sort((a, b) => a.foreAft - b.foreAft);
      for (const n of spine) { n.x = PADX + n.foreAft * LEN; n.y = yC; }
      for (let i = 1; i < spine.length; i++) {
        const prev = spine[i - 1], n = spine[i];
        const connected = stdNeighbors(n.idx).some((m) => m.idx === prev.idx);
        if (connected) n.x = prev.x + prev.w / 2 + n.w / 2; // flush, shared wall
        else n.x = Math.max(n.x, prev.x + prev.w / 2 + n.w / 2 + 3); // separate segment
      }

      // 2. rows ±1, ±2, ±3: each room sits flush against the parent it opens
      //    into, x clamped so the shared wall genuinely overlaps. Tier 3 is
      //    the outboard flank — the big port/starboard battery & magazine
      //    halls that give each deck real width (user note).
      for (const tier of [1, 2, 3]) {
        for (const side of [1, -1]) {
          const row = band.filter((n) => n.row === side * tier).sort((a, b) => a.foreAft - b.foreAft);
          for (const n of row) {
            const parents = stdNeighbors(n.idx).filter((m) => m.deck === d
              && (tier === 1 ? m.row === 0 : Math.abs(m.row) === tier - 1));
            const p = parents[0] ?? spine[0];
            n.x = PADX + n.foreAft * LEN;
            if (p) {
              n._parent = p; // squeeze-back below needs it
              n.y = p.y + side * (p.d / 2 + n.d / 2);
              // keep the shared wall real: center within the parent's span
              const lo = p.x - p.w / 2 + Math.min(n.w, p.w) / 2;
              const hi = p.x + p.w / 2 - Math.min(n.w, p.w) / 2;
              n.x = Math.max(lo, Math.min(hi, n.x));
            } else {
              n.y = yC + side * (4 + n.d / 2);
            }
          }
          // de-overlap along x (deterministic left-to-right push, zero gap)
          row.sort((a, b) => a.x - b.x);
          for (let i = 1; i < row.length; i++) {
            const minX = row[i - 1].x + row[i - 1].w / 2 + row[i].w / 2;
            if (row[i].x < minX) row[i].x = minX;
          }
          // SQUEEZE-BACK (sealed-room fix — user: the galley/brig doors had
          // no wall to open through): the rightward push above can shove the
          // tail of a row past its parent corridor's end, leaving a door
          // between rects that never touch. Walk back right-to-left pulling
          // each room to keep >= 2.5m of shared span with its parent,
          // shoving predecessors left as needed.
          for (let i = row.length - 1; i >= 0; i--) {
            const n = row[i], p = n._parent;
            if (!p) continue;
            const ov = Math.min(2.5, n.w, p.w);
            const maxX = p.x + p.w / 2 + n.w / 2 - ov;
            if (n.x > maxX) n.x = maxX;
            for (let j = i - 1; j >= 0; j--) {
              const limit = row[j + 1].x - (row[j + 1].w + row[j].w) / 2;
              if (row[j].x > limit) row[j].x = limit; else break;
            }
          }
        }
      }
      for (const n of band) n.r = Math.max(2, Math.min(n.w, n.d) / 2 - 1);
    }
    this.width = Math.max(...this.nodes.map((n) => n.x + n.w / 2)) + PADX;
    // per-link real distances: horizontal walk + vertical climb components.
    // Same-deck links measure center-to-center in the deck plane; cross-deck
    // links measure real fore-aft offset plus the deck-height climb (the
    // stacked-band y distance is a drawing artifact, not geometry).
    const measure = (l) => {
      const a = this.nodes[l.a], b = this.nodes[l.b];
      if (a.deck === b.deck) {
        // With the plan contiguous, most connections are an opening cut in a
        // GENUINELY SHARED WALL: find the wall two flush rects share and put
        // the door at the middle of the overlap. Only spaces that don't touch
        // fall back to a short connector throat between their footprints.
        const eps = 0.6, minOv = 1.4;
        const xOv = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const yOv = Math.min(a.y + a.d / 2, b.y + b.d / 2) - Math.max(a.y - a.d / 2, b.y - b.d / 2);
        const yGap = Math.abs(a.y - b.y) - (a.d + b.d) / 2; // negative = overlapping
        const xGap = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
        let door = null;
        if (xOv >= minOv && Math.abs(yGap) < eps) {
          // horizontal shared wall (rooms stacked in depth)
          const wallY = a.y < b.y ? (a.y + a.d / 2 + b.y - b.d / 2) / 2 : (a.y - a.d / 2 + b.y + b.d / 2) / 2;
          const cx = (Math.max(a.x - a.w / 2, b.x - b.w / 2) + Math.min(a.x + a.w / 2, b.x + b.w / 2)) / 2;
          door = { x: cx, y: wallY };
        } else if (yOv >= minOv && Math.abs(xGap) < eps) {
          // vertical shared wall (rooms side by side)
          const wallX = a.x < b.x ? (a.x + a.w / 2 + b.x - b.w / 2) / 2 : (a.x - a.w / 2 + b.x + b.w / 2) / 2;
          const cy = (Math.max(a.y - a.d / 2, b.y - b.d / 2) + Math.min(a.y + a.d / 2, b.y + b.d / 2)) / 2;
          door = { x: wallX, y: cy };
        }
        if (door) {
          l.door = door;
          l.doorA = { ...door };
          l.doorB = { ...door };
          l.shared = true; // a real opening, no throat needed
          const lenA = Math.max(0.5, Math.hypot(a.x - door.x, a.y - door.y));
          const lenB = Math.max(0.5, Math.hypot(b.x - door.x, b.y - door.y));
          l.flipT = lenA / (lenA + lenB);
          l.horizM = Math.max(2, lenA + lenB);
          l.vertM = 0;
        } else {
          // no shared wall: a short throat spans the gap (as before)
          const dx = b.x - a.x, dy = b.y - a.y;
          const L = Math.max(0.001, Math.hypot(dx, dy));
          const ux = Math.abs(dx) / L, uy = Math.abs(dy) / L;
          const exitA = Math.min(ux > 1e-6 ? (a.w / 2) / ux : Infinity, uy > 1e-6 ? (a.d / 2) / uy : Infinity);
          const entryB = Math.min(ux > 1e-6 ? (b.w / 2) / ux : Infinity, uy > 1e-6 ? (b.d / 2) / uy : Infinity);
          let doorDist = (exitA + (L - entryB)) / 2;
          if (exitA + entryB >= L) doorDist = L / 2;
          doorDist = Math.min(L - 0.5, Math.max(0.5, doorDist));
          l.door = { x: a.x + dx / L * doorDist, y: a.y + dy / L * doorDist };
          const tA = Math.min(exitA, doorDist), tB = Math.max(L - entryB, doorDist);
          l.doorA = { x: a.x + dx / L * tA, y: a.y + dy / L * tA };
          l.doorB = { x: a.x + dx / L * tB, y: a.y + dy / L * tB };
          l.shared = false;
          const lenA = doorDist, lenB = L - doorDist;
          l.flipT = lenA / (lenA + lenB);
          l.horizM = Math.max(3, lenA + lenB);
          l.vertM = 0;
        }
      } else {
        l.horizM = Math.max(2, Math.abs(a.x - b.x));
        l.vertM = Math.abs(a.deck - b.deck) * this.deckHeightM;
        l.flipT = 0.5; // handover halfway up/down the trunk
        if (l.type === 'stairwell') {
          // the grand stairwell is WALKED, not ridden: measure the real
          // switchback — two sloped flights spanning the true two-storey
          // drop (elevOf knows the hangar lift; deckHeightM undersold it by
          // half) plus crossing the mid landing. This is what travelSec and
          // linkCost charge, so the stairs stop being the cheapest "portal"
          // on the ship and a traversal takes as long as actually walking it.
          const U = a.deck < b.deck ? a : b;
          const { wellHx, wellHz, landD } = stairWellDims(U.w / 2, U.d / 2);
          const drop = Math.abs(elevOf(a.deck) - elevOf(b.deck));
          l.vertM = drop;
          l.stairRunM = 2 * Math.hypot(2 * wellHz - landD, drop / 2) + wellHx;
        }
      }
    };
    for (const l of this.edges) measure(l);
    for (const l of this.shafts) measure(l);
    // LOS OPENINGS (per-room combat retirement): every same-deck doored edge
    // records the wall it pierces as a line (axis + coordinate) and the
    // opening's centre along that wall. sim.losClear() walks a sight segment
    // room to room through these; the opening half-width is decided at query
    // time (full doorway when unlocked, the sealed door's ajar slot when not).
    for (const l of this.edges) {
      if (!l.door) { l.losOpen = null; continue; }
      const A = this.nodes[l.a], B = this.nodes[l.b];
      if (A.deck !== B.deck) { l.losOpen = null; continue; }
      const xOv = Math.min(A.x + A.w / 2, B.x + B.w / 2) - Math.max(A.x - A.w / 2, B.x - B.w / 2);
      const yOv = Math.min(A.y + A.d / 2, B.y + B.d / 2) - Math.max(A.y - A.d / 2, B.y - B.d / 2);
      // rooms overlapping in x are stacked in y: the shared wall is HORIZONTAL
      // (y = const) and the opening spans x — and vice versa
      l.losOpen = xOv >= yOv
        ? { axis: 'y', at: l.door.y, c: l.door.x }
        : { axis: 'x', at: l.door.x, c: l.door.y };
    }
    // mean std-edge length: the hive's ETA guesses are hop-based
    this.avgStdLenM = this.edges.reduce((s, l) => s + l.horizM + l.vertM, 0) / this.edges.length;
    this._placeGrates();
    this._placeTrunks();
  }

  // LADDER/LIFT WELLS ARE SIM TRUTH (user: "NPCs traversing ladders should
  // come right out of those ladder holes exactly"). The well position used to
  // be picked twice — the renderer scored door clearance in world space while
  // the sim pinned climbers to a clamped room-centre-line pad — so a body
  // surfaced meters from the drawn hatch and the renderer had to fudge it.
  // Now the GRAPH picks each trunk's position once (same clearance scoring,
  // run in deck-local coordinates, which differ from world space only by the
  // per-deck band shift) and stores it on the edge as padA/padB (sim coords
  // per side). The sim climbs through those exact points; the renderer draws
  // collars, rungs and kiosks AT them; the emergence mouths equal the pads.
  _placeTrunks() {
    const bandC = (deck) => {
      const b = this.deckBands[deck - 1];
      return (b.y0 + b.y1) / 2; // world.bandCenter — keep identical
    };
    // door openings of a room, deck-local
    const doorPtsL = (roomIdx, deck) => {
      const pts = [];
      for (const l of this.edges) {
        if (l.a !== roomIdx && l.b !== roomIdx) continue;
        if (this.nodes[l.a].deck !== this.nodes[l.b].deck) continue;
        const d = (l.a === roomIdx ? l.doorA : l.doorB) ?? l.door;
        if (d) pts.push([d.x, d.y - bandC(deck)]);
      }
      return pts;
    };
    const grateL = (n) => n.grate ? [[n.grate.x, n.grate.y - bandC(n.deck)]] : [];
    const placed = []; // {deck, x, z} deck-local — no two pads on top of each other
    const avoidPts = (deck) => placed.filter((s) => s.deck === deck).map((s) => [s.x, s.z]);
    // the renderer's pickSpot, verbatim: N=6 grid over the rect, clearance
    // from every avoid point (capped at 6 m) minus a mild pull to the
    // preferred spot; keep-first on ties so the choice is deterministic
    const pickSpot = (x0, x1, z0, z1, pts, prefX, prefZ, prefW = 0.1) => {
      let bx = (x0 + x1) / 2, bz = (z0 + z1) / 2, bestScore = -Infinity;
      const N = 6;
      for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
        const cx = x0 + (x1 - x0) * i / N, cz = z0 + (z1 - z0) * j / N;
        let dMin = Infinity;
        for (const [qx, qz] of pts) dMin = Math.min(dMin, Math.hypot(cx - qx, cz - qz));
        const score = Math.min(dMin, 6) - Math.hypot(cx - prefX, cz - prefZ) * prefW;
        if (score > bestScore + 1e-9) { bestScore = score; bx = cx; bz = cz; }
      }
      return [bx, bz];
    };
    for (const e of this.edges) {
      const a = this.nodes[e.a], b = this.nodes[e.b];
      if (a.deck === b.deck) continue;
      // grand stairwells have their own walkable ramp + waypoints — no trunk
      if (e.type === 'stairwell') continue;
      const upper = a.deck < b.deck ? a : b; // smaller deck number = higher up
      const lower = upper === a ? b : a;
      const uz = upper.y - bandC(upper.deck), lz = lower.y - bandC(lower.deck);
      const ox0 = Math.max(upper.x - upper.w / 2, lower.x - lower.w / 2) + 1.1;
      const ox1 = Math.min(upper.x + upper.w / 2, lower.x + lower.w / 2) - 1.1;
      const oz0 = Math.max(uz - upper.d / 2, lz - lower.d / 2) + 1.1;
      const oz1 = Math.min(uz + upper.d / 2, lz + lower.d / 2) - 1.1;
      if (ox1 - ox0 >= 0.2 && oz1 - oz0 >= 0.2) {
        // rooms overlap in plan: ONE true vertical well through the deck
        const [x, z] = pickSpot(ox0, ox1, oz0, oz1,
          [...doorPtsL(lower.idx, lower.deck), ...doorPtsL(upper.idx, upper.deck),
            ...avoidPts(lower.deck), ...avoidPts(upper.deck),
            ...grateL(lower), ...grateL(upper)],
          (ox0 + ox1) / 2, (oz0 + oz1) / 2);
        placed.push({ deck: lower.deck, x, z }, { deck: upper.deck, x, z });
        e.trunkVertical = true;
        e.padA = { x, y: z + bandC(this.nodes[e.a].deck) };
        e.padB = { x, y: z + bandC(this.nodes[e.b].deck) };
      } else {
        // offset rooms: an enclosed trunk kiosk at each end. Upper first,
        // then lower — the renderer placed them in that order, and the
        // avoid-list interplay must stay identical.
        const mk = (n, other) => {
          const nz = n.y - bandC(n.deck);
          const natural = Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x));
          const [sx, sz] = pickSpot(
            n.x - n.w / 2 + 1.2, n.x + n.w / 2 - 1.2,
            nz - n.d / 2 + 1.2, nz + n.d / 2 - 1.2,
            [...doorPtsL(n.idx, n.deck), ...avoidPts(n.deck), ...grateL(n)],
            natural, nz, 0.08);
          placed.push({ deck: n.deck, x: sx, z: sz });
          return { x: sx, y: sz + bandC(n.deck) };
        };
        const pu = mk(upper, lower), pl = mk(lower, upper);
        e.trunkVertical = false;
        e.padA = this.nodes[e.a] === upper ? pu : pl;
        e.padB = this.nodes[e.b] === upper ? pu : pl;
      }
    }
  }

  // ONE GRATE PER ROOM, AS FAR FROM THE DOORS AS THE WALLS ALLOW (user rule:
  // "there should never be a vent at a door entrance — vents should be as far
  // from the door(s) in a room as possible"). Candidate points march along
  // all four walls at a fixed pitch; the winner maximizes its distance to the
  // NEAREST door opening of that room. Fully deterministic: fixed candidate
  // order, ties keep the first. Stored per node as n.grate:
  //   x/y   — where a crawler stands to use it (0.55 m off the wall)
  //   wx/wy — the point ON the wall (the visible grille)
  //   nx/ny — the wall's inward normal (grille facing, for the renderer)
  _placeGrates() {
    for (const n of this.nodes) {
      // every real opening into this room: same-deck door points, plus the
      // pads cross-deck trunks land on (a lift/ladder mouth is a doorway too)
      const doors = [];
      for (const { link } of this.adj.std[n.idx] ?? []) {
        const pt = (link.a === n.idx ? link.doorA : link.doorB) ?? link.door;
        if (pt) doors.push(pt);
        else {
          // cross-deck link: bodies approach a wall pad near the far room's x
          const other = this.nodes[link.a === n.idx ? link.b : link.a];
          if (other.deck !== n.deck) doors.push({
            x: Math.max(n.x - n.w / 2 + 1.2, Math.min(n.x + n.w / 2 - 1.2, other.x)), y: n.y,
          });
        }
      }
      const inset = 0.55;
      const hw = n.w / 2 - inset, hd = n.d / 2 - inset;
      let best = null, bestD = -1;
      const consider = (wallX, wallY, nx, ny) => {
        let dMin = Infinity;
        for (const d of doors) {
          const dd = Math.hypot(wallX - d.x, wallY - d.y);
          if (dd < dMin) dMin = dd;
        }
        if (doors.length === 0) dMin = 0; // no doors: any wall point works
        if (dMin > bestD + 1e-9) {
          bestD = dMin;
          best = { x: wallX + nx * inset, y: wallY + ny * inset, wx: wallX, wy: wallY, nx, ny };
        }
      };
      // walk each wall at ~1.2 m pitch (min 3 samples), corners inset 0.8 m
      const pitch = 1.2;
      const spanX = Math.max(0.1, n.w - 1.6), spanY = Math.max(0.1, n.d - 1.6);
      const kx = Math.max(2, Math.ceil(spanX / pitch));
      const ky = Math.max(2, Math.ceil(spanY / pitch));
      for (let i = 0; i <= kx; i++) {
        const x = n.x - spanX / 2 + (spanX * i) / kx;
        consider(x, n.y - n.d / 2, 0, 1);  // north wall, faces +y
        consider(x, n.y + n.d / 2, 0, -1); // south wall, faces -y
      }
      for (let i = 0; i <= ky; i++) {
        const y = n.y - spanY / 2 + (spanY * i) / ky;
        consider(n.x - n.w / 2, y, 1, 0);  // west wall, faces +x
        consider(n.x + n.w / 2, y, -1, 0); // east wall, faces -x
      }
      // degenerate rooms (tiny closets) still get a grate at the far corner
      if (!best) best = { x: n.x, y: n.y, wx: n.x, wy: n.y - n.d / 2, nx: 0, ny: 1 };
      // keep the stand point inside the footprint whatever the math above did
      best.x = Math.max(n.x - hw, Math.min(n.x + hw, best.x));
      best.y = Math.max(n.y - hd, Math.min(n.y + hd, best.y));
      n.grate = best;
    }
  }

  // The synthesized transit link between two rooms' grates. Interchangeable
  // with a real link everywhere the movement machinery looks: kind/doorA/
  // doorB/horizM/vertM/flipT. Cached per pair; deterministic (pure geometry).
  // i is unique per pair and disjoint from real link indices, so combat.js's
  // per-duct grouping keys and the duct-noise throttle both keep working.
  ventLink(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * 4096 + hi;
    let l = this._ventLinks.get(key);
    if (!l) {
      const A = this.nodes[lo], B = this.nodes[hi];
      const ga = A.grate, gb = B.grate;
      // real geometry, not the stacked drawing: same-deck runs measure in the
      // deck plane; cross-deck runs measure fore-aft plus the climb (the
      // deck-band y offset is a schematic artifact — see measure())
      const horizM = A.deck === B.deck
        ? Math.max(2, Math.hypot(ga.wx - gb.wx, ga.wy - gb.wy))
        : Math.max(2, Math.abs(ga.wx - gb.wx));
      const vertM = Math.abs(A.deck - B.deck) * this.deckHeightM;
      l = {
        i: 100000 + key, a: lo, b: hi, kind: LAYER.VENT, virtual: true,
        breakable: false, blocked: false, lockable: false, locked: false,
        doorA: { x: ga.x, y: ga.y }, doorB: { x: gb.x, y: gb.y },
        horizM, vertM, flipT: 0.5, label: 'V-NET',
      };
      this._ventLinks.set(key, l);
    }
    return l;
  }

  // One-step path through the duct network (for sim.setPath consumers).
  ventRoute(from, to) {
    return [{ to, link: this.ventLink(from, to), layer: LAYER.VENT }];
  }

  node(i) { return this.nodes[i]; }
  hasRole(i, role) { return this.nodes[i].roles.includes(role); }
  nodesWithRole(role) { return this.nodes.filter((n) => n.roles.includes(role)).map((n) => n.idx); }

  // Neighbors across a set of layers, filtered by a passability predicate.
  // passFn(link, from, to) -> bool. Layers: array of 'std'|'shaft'|'vent'.
  *neighbors(nodeIdx, layers, passFn) {
    for (const layer of layers) {
      for (const { to, link } of this.adj[layer][nodeIdx]) {
        if (!passFn || passFn(link, nodeIdx, to)) yield { to, link, layer };
      }
    }
  }

  // Multi-source BFS flow field toward `targets`. Returns { dist, next, nextLink }
  // where next[i] is the neighbor one hop closer to a target (-1 if unreachable).
  flowField(targets, layers, passFn) {
    const dist = new Int32Array(this.n).fill(-1);
    const next = new Int32Array(this.n).fill(-1);
    const nextLink = new Array(this.n).fill(null);
    const q = [];
    for (const t of targets) if (dist[t] === -1) { dist[t] = 0; q.push(t); }
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      for (const { to, link } of this.neighbors(cur, layers, passFn)) {
        if (dist[to] === -1) {
          dist[to] = dist[cur] + 1;
          next[to] = cur;       // moving from `to` toward target goes via `cur`
          nextLink[to] = link;
          q.push(to);
        }
      }
    }
    return { dist, next, nextLink, targets: new Set(targets) };
  }

  // Reference walking seconds to cross a link (faction-agnostic, 1.4 m/s).
  // Pathing MUST weigh real time, not hops: with authored distances a
  // "one-hop" 48 m maintenance shaft is a 90-second crawl that hop-count
  // BFS preferred over two 15-second corridor hops — which marched whole
  // packs into shafts and read as "the flood spawns and never moves".
  linkCost(l) {
    const run = l.horizM + l.vertM;
    // shafts stay a fast flood highway (only flood pathing reads shaft costs;
    // humans are std-only, so this never affects the crew)
    if (l.kind === 'shaft') return run * 1.35 / 2.1 * 0.92;
    // vent transits never appear in Dijkstra (the vent adjacency is empty) —
    // this branch prices a synthesized network link when a caller compares a
    // duct run against a walk: crawl time plus the two grate transfers
    if (l.kind === 'vent') return run * 1.35 / 1.65 + 2.4;
    if (l.type === 'lift') return l.horizM / 1.4 + 10;
    if (l.type === 'ladder') return 1.0 + l.vertM / 1.2; // mount + climb (matches travelSec)
    if (l.type === 'stairwell') return (l.stairRunM ?? run) / 1.4 + 0.8; // real switchback meters (matches travelSec)
    return run / 1.4 + (l.type === 'blastdoor' ? 2.5 : 0.8);
  }

  // Fastest path from -> to as [{to, link, layer}] steps, or null.
  // Dijkstra over real travel time (deterministic: min-cost, ties by index).
  // PERF (user: M2 stutter): the hive's opening plan runs 100+ path queries
  // in one strategic tick. The old linear-scan selection was O(n²) and every
  // call allocated four arrays plus a generator object per edge — the tick
  // spiked 25-30ms mostly on garbage. Now: a lazy-deletion binary heap
  // ordered (dist, node) — which pops in EXACTLY the order the linear scan
  // selected (min dist, ties by lowest index), so routes are bit-identical —
  // over reused scratch buffers and inlined adjacency iteration.
  path(from, to, layers, passFn) {
    if (from === to) return [];
    const n = this.n;
    const S = (this._pathScratch ??= {
      dist: new Float64Array(n), done: new Uint8Array(n),
      next: new Int32Array(n), nextLink: new Array(n),
      hd: [], hn: [],
    });
    const { dist, done, next, nextLink, hd, hn } = S;
    dist.fill(Infinity); done.fill(0); next.fill(-1); nextLink.fill(null);
    hd.length = 0; hn.length = 0;
    const push = (d, v) => {
      let i = hd.length;
      hd.push(d); hn.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hd[p] < d || (hd[p] === d && hn[p] < v)) break;
        hd[i] = hd[p]; hn[i] = hn[p];
        i = p;
      }
      hd[i] = d; hn[i] = v;
    };
    const pop = () => {
      const topV = hn[0];
      const ld = hd.pop(), lv = hn.pop();
      const m = hd.length;
      if (m > 0) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let s = -1;
          if (l < m) s = l;
          if (r < m && (hd[r] < hd[l] || (hd[r] === hd[l] && hn[r] < hn[l]))) s = r;
          if (s === -1) break;
          if (hd[s] < ld || (hd[s] === ld && hn[s] < lv)) {
            hd[i] = hd[s]; hn[i] = hn[s];
            i = s;
          } else break;
        }
        hd[i] = ld; hn[i] = lv;
      }
      return topV;
    };
    dist[to] = 0;
    push(0, to);
    for (;;) {
      let u = -1;
      while (hd.length) {
        const d0 = hd[0], v0 = pop();
        if (!done[v0] && d0 === dist[v0]) { u = v0; break; }
      }
      if (u === -1) break;
      done[u] = 1;
      if (u === from) break;
      const du = dist[u];
      for (const layer of layers) {
        const arr = this.adj[layer][u];
        for (let i = 0; i < arr.length; i++) {
          const e = arr[i];
          const v = e.to, link = e.link;
          if (passFn && !passFn(link, u, v)) continue;
          const c = du + this.linkCost(link);
          if (c < dist[v] - 1e-9) { dist[v] = c; next[v] = u; nextLink[v] = link; push(c, v); }
        }
      }
    }
    if (!Number.isFinite(dist[from])) return null;
    const steps = [];
    let cur = from;
    while (cur !== to) {
      const nxt = next[cur];
      const link = nextLink[cur];
      if (nxt === -1) return null;
      steps.push({ to: nxt, link, layer: link.kind });
      cur = nxt;
    }
    return steps;
  }

  // PERF (user: M2 stutter): hops() ran a full-graph BFS per call, and the
  // hive's strategic tick asks for distances in forms×bodies loops — thousands
  // of identical BFS in one tick, 30-40ms main-thread spikes. Fields are now
  // cached per (target, layers, predicate) and the cache is dropped whenever
  // ANYTHING affecting passability mutates (locks, burning nodes, hive belief
  // maps, and every tick boundary — the predicates read sim.t). Same inputs →
  // same field, so behavior is bit-identical; only the CPU time changes.
  // NOTE: hive predicates are direction-dependent (burning blocks ENTRY), so
  // there is deliberately no symmetric from/to lookup.
  invalidatePathCache() {
    this.pathVersion = (this.pathVersion ?? 0) + 1;
    if (this._hopsCache?.size) this._hopsCache.clear();
  }

  // BURN BOOKKEEPING (perf pass 3): the cache used to be wiped at the top of
  // EVERY tick because burning-node predicates compare burningUntil against
  // sim.t, and expiry is implicit. Now every burningUntil writer also calls
  // noteBurn(), and sweepBurns(t) — called once per tick — invalidates only
  // when a node actually ENTERS or LEAVES the burning set. Fields survive
  // across strategic rounds while passability genuinely holds still.
  noteBurn(node) {
    const s = (this._burning ??= new Set());
    if (!s.has(node)) { s.add(node); this._burnDirty = true; }
  }
  sweepBurns(t) {
    let changed = this._burnDirty === true;
    this._burnDirty = false;
    const s = this._burning;
    if (s) for (const n of s) {
      if (this.burningUntil[n] <= t) { s.delete(n); changed = true; }
    }
    if (changed) this.invalidatePathCache();
  }

  hops(from, to, layers, passFn) {
    const c = (this._hopsCache ??= new Map());
    if (c.size > 512) c.clear(); // bound the field store (63-node graph: never hit in practice)
    const key = to + '|' + layers.join(',') + '|' + (passFn ? (passFn._ffid ??= ++_ffSeq) : 0);
    let ff = c.get(key);
    if (!ff) {
      ff = this.flowField([to], layers, passFn);
      c.set(key, ff);
    }
    return ff.dist[from];
  }

  // All nodes within `maxHops` of `from`.
  nodesWithin(from, maxHops, layers, passFn) {
    const dist = new Int32Array(this.n).fill(-1);
    dist[from] = 0;
    const q = [from];
    const out = [from];
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      if (dist[cur] >= maxHops) continue;
      for (const { to, link } of this.neighbors(cur, layers, passFn)) {
        if (dist[to] === -1) { dist[to] = dist[cur] + 1; q.push(to); out.push(to); }
      }
    }
    return out;
  }
}

// --- passability predicates ---

// Humans NEVER use the ducts (user rule): standard edges only, blocked by
// locks. The vent/shaft network is the flood's alone.
export function humanPass(link) {
  return link.kind === LAYER.STD ? !link.locked : false;
}
export const marinePass = humanPass; // marines use the standard methods too
// Flood, ground truth (user redesign): the VENT NETWORK IS INFECTION-ONLY —
// combat forms are far too big for the in-wall ducting; they walk and squeeze
// the cross-deck maintenance shafts like the carriers do. Infection walking
// layers are std+shaft; the vent network is routed explicitly (ventLink), so
// the vent case here only arises when a pop-time re-check probes a
// synthesized link — which is never blocked.
export function infectionPass(link) {
  if (link.kind === LAYER.STD) return !link.locked;
  return link.kind === LAYER.VENT; // the duct network is always open
}
export function bigFormPass(link) {
  return link.kind === LAYER.STD && !link.locked;
}
export function layersFor(kind) {
  switch (kind) {
    case 'human': return ['std'];
    case 'marine': return ['std'];               // humans never use the ducts
    case 'infection': return ['std'];   // walking; the vent net is routed explicitly
    case 'big': return ['std'];         // stairs and ladders, like everyone else
    default: return ['std'];
  }
}
