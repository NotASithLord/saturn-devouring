import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import { makeAgent } from './init.js';
import { FACTION } from '../shared/agentBuffer.js';
import { TASK } from './hive.js';
import { updateFloodTick } from './floodExec.js';
import { hurtFloodForm } from './combat.js';

function fixture() {
  const sim = new Sim('swarm-recovery');
  for (const a of sim.agents) a.dead = true;
  sim.t = 401;
  sim.hive.opening = false;
  sim.hive.beliefs.clear();
  sim.hive.believedHardness.fill(0);
  sim.hive.believedHumanStr.fill(0);
  sim._refreshOccupancy();
  const forms = Array.from({length:15}, (_,i) => {
    const a = makeAgent(FACTION.COMBAT, sim.graph.byId.get('medbay'), sim.graph);
    a.hp = a.maxHp = 90;
    sim.spawn(a);
    return a;
  });
  sim._refreshOccupancy();
  return {sim, forms};
}

{
  const {sim, forms} = fixture();
  const seed = forms[0];
  seed.task = {kind:TASK.GUARD, node:seed.node, seed:true};
  updateFloodTick(sim, sim.dt);
  assert.equal(seed.task?.kind, TASK.TRANSFORM, 'arrived carrier seed must root instead of guarding forever');
  for (let i=0; i<Math.ceil(sim.P.carrier.transformSec/sim.dt)+2; i++) {
    sim.t += sim.dt; updateFloodTick(sim,sim.dt);
  }
  assert.ok(sim.agents.some(a=>!a.dead && a.faction===FACTION.CARRIER), 'seed must actually become a carrier');
  const gestation = sim.P.carrier.firstIncubationSec
    + sim.P.carrier.incubationIntervalSec * sim.P.carrier.maxInfectionForms + 5;
  for (let i=0; i<Math.ceil(gestation/sim.dt); i++) {
    sim.t += sim.dt; updateFloodTick(sim,sim.dt);
    if (sim.agents.some(a=>!a.dead && a.faction===FACTION.INFECTION)) break;
  }
  assert.ok(sim.agents.some(a=>!a.dead && a.faction===FACTION.INFECTION),
    'recovered carrier must complete gestation and release infection forms');
}
{
  const {sim, forms} = fixture();
  const seed=forms[0];
  seed.task={kind:TASK.GUARD,node:sim.graph.byId.get('cic'),seed:true,seedSince:sim.t-31};
  updateFloodTick(sim,sim.dt);
  assert.equal(seed.task?.kind,TASK.TRANSFORM,'overdue seed roots at its safe current position');
}
{
  const {sim, forms}=fixture();
  for (const c of forms) c.task={kind:TASK.GUARD,node:c.node};
  sim.hive.steadyState([],forms,[],[],0,15,0,4);
  assert.ok(forms.some(c=>c.task?.kind===TASK.TRANSFORM),'15 passive combat forms restart reproduction');
  assert.ok(forms.some(c=>(c.task?.kind===TASK.SCOUT || c.task?.kind===TASK.ATTACK)
    && c.task.node !== c.node),'spare forms leave empty rooms to hunt or scout');
}
{
  const {sim,forms}=fixture();
  for(const c of forms)c.task={kind:TASK.GUARD,node:c.node,muster:sim.graph.byId.get('cic'),until:sim.t+90};
  sim.hive.steadyState([],forms,[],[],0,15,0,4);
  assert.ok(forms.some(c=>c.task?.kind===TASK.TRANSFORM),'an empty production line reserves one seed even from a stalled muster');
}
{
  const {sim,forms}=fixture();
  const seed=forms[0];
  seed.task={kind:TASK.GUARD,node:seed.node,seed:true};
  seed.fromPlayer=true;
  updateFloodTick(sim,sim.dt);
  assert.equal(seed.task,null,'player-derived combat forms cannot seed carriers');
}
{
  const {sim,forms}=fixture();
  const seed=forms[0];
  seed.task={kind:TASK.GUARD,node:seed.node,seed:true};
  sim.hive.believedHardness[seed.node]=10;
  updateFloodTick(sim,sim.dt);
  assert.equal(seed.task,null,'unsafe destination releases the seed reservation for replanning');
}
{
  const sim = new Sim('late-game-contact-rally');
  for (const a of sim.agents) a.dead = true;
  sim.hive.beliefs.clear();
  sim.hive.opening = false;
  sim.hive.marinesBelieved = 8;
  sim.t = 900;
  const contact = sim.graph.byId.get('medbay');
  const distant = sim.graph.nodes.find((n) => sim.graph.hops(n.idx, contact, ['std'], () => true) > 3)?.idx;
  assert.notEqual(distant, undefined, 'contact fixture needs a remote Flood pocket');
  const squad = Array.from({ length: 8 }, () => makeAgent(FACTION.MARINE, contact, sim.graph));
  const player = makeAgent(FACTION.ARMED, contact, sim.graph);
  player.isPlayer = true;
  const witness = makeAgent(FACTION.COMBAT, contact, sim.graph);
  witness.hp = witness.maxHp = 90;
  const distantForms = Array.from({ length: 150 }, () => {
    const form = makeAgent(FACTION.COMBAT, distant, sim.graph);
    form.hp = form.maxHp = 90;
    return form;
  });
  for (const a of [...squad, player, witness, ...distantForms]) sim.spawn(a);
  sim._refreshOccupancy();
  hurtFloodForm(sim, witness, 100, false, player.id);
  assert.equal(witness.downed, true, 'the sole local witness is downed before hive planning');
  assert.equal(sim.hive.beliefs.get(player.id)?.node, contact,
    'the shot itself must report the squad room to the shared hive');
  assert.equal(squad.filter((marine) => sim.hive.beliefs.get(marine.id)?.node === contact).length, 8,
    'the fallen witness must report the nearby squad, not only its killer');
  sim._computeInfluence();
  sim.hive.strategicTick();
  assert.equal(sim.hive.allIn, true, 'an overwhelming force with a known contact must converge');
  assert.ok(distantForms.filter((f) => f.task?.node === contact || f.task?.muster === contact).length > 100,
    'most remote combat forms must join the assault on the reported room');
  updateFloodTick(sim, sim.dt);
  assert.ok(distantForms.filter((f) => f.move || f.path.length).length > 100,
    'the summoned forms must have actual routes toward the contact');
  sim.t += 60;
  sim.hive.updateBeliefs();
  assert.ok(sim.hive.believedHumanStr[contact] > 0,
    'the attack report must last long enough for distant forms to converge');
  sim.t += 61;
  sim.hive.updateBeliefs();
  assert.equal(sim.hive.beliefs.get(player.id)?.conf, 0,
    'an unverified battle report must expire instead of tracking the player forever');
  sim.hive.noteHumanAttack(player, witness);
  const remoteRoom = sim.graph.node(distant);
  for (const marine of [...squad, player]) {
    marine.node = marine.pnode = distant;
    marine.x = remoteRoom.x; marine.y = remoteRoom.y; marine.deck = remoteRoom.deck;
  }
  for (const form of distantForms.slice(1)) form.dead = true;
  const contactRoom = sim.graph.node(contact);
  distantForms[0].node = distantForms[0].pnode = contact;
  distantForms[0].x = contactRoom.x;
  distantForms[0].y = contactRoom.y;
  distantForms[0].deck = contactRoom.deck;
  sim._refreshOccupancy();
  sim.hive.updateBeliefs();
  assert.equal(sim.hive.beliefs.get(player.id)?.conf, 0,
    'a Flood scout finding the reported room empty must clear the stale contact');
}
console.log('swarm recovery: arrived and overdue seeds, actual carrier birth, 15-form idle pocket and breeding-starved muster ✓');
