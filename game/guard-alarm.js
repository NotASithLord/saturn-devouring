import { FACTION } from '../shared/agentBuffer.js';

// Track the original command-deck guards, so movement, reinforcements and
// reanimated bodies cannot start the klaxon early or silence it afterward.
export function createGuardAlarm(sim) {
  const guards = sim.agents.filter((a) => a.garrison && a.deck === 1
    && a.faction === FACTION.MARINE).map((a) => a.id);
  return () => guards.length > 0 && guards.every((id) => {
    const a = sim.byId.get(id);
    return !a || a.dead || a.hp <= 0 || a.faction !== FACTION.MARINE;
  });
}
