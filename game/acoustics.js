// Room boundaries and steel decks absorb high frequencies before distance
// attenuation. Read door state on every cue, so opening a door is audible.
export function roomTransmission(graph, from, to) {
  if (from === to && from >= 0) return { gain: 1, cutoff: 20000 };
  const a = graph.nodes[from], b = graph.nodes[to];
  if (!a || !b) return { gain: 0.12, cutoff: 550 };
  const decks = Math.abs(a.deck - b.deck);
  if (decks) {
    const openStair = graph.adj.std[from].some(({ to: n, link }) => n === to && link.type === 'stairwell');
    return openStair ? { gain: 0.4, cutoff: 1800 }
      : { gain: 0.16 ** decks, cutoff: decks === 1 ? 350 : 180 };
  }
  // Find the least obstructed route through up to four compartments. A
  // longer open route can carry more sound than the nearest closed hatch.
  let frontier = [{ node: from, gain: 1, cutoff: 20000 }];
  let best = { gain: 0.025, cutoff: 260 };
  const seen = new Map([[from, 1]]);
  for (let hop = 0; hop < 4; hop++) {
    const next = [];
    for (const path of frontier) for (const { to: n, link } of graph.adj.std[path.node]) {
      if (graph.nodes[n].deck !== a.deck) continue;
      const open = link.busted ? 1 : link.locked ? 0 : Math.max(0, Math.min(1, link.open01 ?? 0));
      const gain = path.gain * (0.10 + 0.45 * open);
      const cutoff = Math.min(path.cutoff, 450 + 1950 * open) * (hop ? 0.8 : 1);
      if (n === to && gain > best.gain) best = { gain, cutoff };
      if (gain <= (seen.get(n) ?? 0) || gain < 0.02) continue;
      seen.set(n, gain); next.push({ node: n, gain, cutoff });
    }
    frontier = next;
  }
  return best;
}
