import { FACTION } from './agentBuffer.js';

// One definition for the HUD and the armory's parity release. Count active
// Flood bodies and the ship's living marines, including its sealed ODST
// reserve, while excluding player agents and player-origin marines.
export function shipForceCounts(agents) {
  let floodAlive = 0, marinesAlive = 0;
  for (const a of agents) {
    if (a.dead || a.hp <= 0) continue;
    if ((a.faction === FACTION.INFECTION || a.faction === FACTION.COMBAT)
      && !a.downed) floodAlive++;
    else if (a.faction === FACTION.CARRIER) floodAlive++;
    else if (a.faction === FACTION.MARINE && !a.isPlayer && !a.fromPlayer) marinesAlive++;
  }
  return { floodAlive, marinesAlive };
}
