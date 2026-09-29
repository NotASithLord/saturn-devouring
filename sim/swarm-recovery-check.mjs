import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import { makeAgent } from './init.js';
import { FACTION } from '../shared/agentBuffer.js';
import { TASK } from './hive.js';
import { updateFloodTick } from './floodExec.js';

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
console.log('swarm recovery: arrived and overdue seeds, actual carrier birth, 15-form idle pocket and breeding-starved muster ✓');
