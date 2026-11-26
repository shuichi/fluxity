// node --import tsx scripts/check-shibuya-approaches.ts
import assert from 'node:assert/strict';
import { shibuya } from '../src/scenarios/shibuya';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';

const seed = 467, setbackMetres = 1.65, limitSeconds = 60;
const portals = shibuya.portals!;

function probe(target: number) {
  // A fresh simulation reproduces the same person and lane draw used in the original probe.
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1, seed, signalMode: 'green' }, undefined, shibuya);
  sim.setPortalDeadlockRecovery(false);
  const portal = portals[target], agents = sim.agents, flow = sim['portals']!;
  flow.assignTarget(0, target);
  const mouth = flow.assignedArrivalMouth(0);
  const dx = portal.end.x - portal.approach.x, dz = portal.end.z - portal.approach.z;
  const length = Math.hypot(dx, dz), ux = dx / length, uz = dz / length;
  const x = mouth.x - setbackMetres * ux, z = mouth.z - setbackMetres * uz;
  assert.ok(sim.navigation.isSpawnable(x, z, 0.34) && sim.navigation.isReachable(x, z, target)
    && sim.navigation.urban!.sidewalks.lineInside(x, z, mouth.x, mouth.z, 0.30),
  `Invalid starting point for ${portal.id}`);
  for (const state of [agents.current, agents.next]) {
    state.x[0] = x; state.z[0] = z;
    state.vx[0] = 0; state.vz[0] = 0;
    state.heading[0] = Math.atan2(ux, uz);
  }
  agents.preferredVX[0] = ux * agents.preferredSpeed[0];
  agents.preferredVZ[0] = uz * agents.preferredSpeed[0];

  const generation = agents.generation[0], maxSteps = Math.round(limitSeconds / FIXED_DT);
  for (let step = 1; step <= maxSteps; step++) {
    assert.equal(agents.targetId[0], target);
    sim.step();
    if (agents.generation[0] === generation) continue;
    assert.equal(agents.generation[0], generation + 1);
    assert.equal(sim.completedPortalTrips(target), 1, portal.id);
    return { id: portal.id, kind: portal.kind, completionStep: step };
  }
  assert.equal(sim.completedPortalTrips(target), 0, portal.id);
  return { id: portal.id, kind: portal.kind, completionStep: null };
}

const results = portals.map((_, target) => probe(target));
const completed = results.filter(r => r.completionStep !== null).length;
console.log(JSON.stringify({ seed, setbackMetres, limitSeconds, stepsPerSecond: Math.round(1 / FIXED_DT),
  signalMode: 'green', population: 1, metaAI: false, completed, results }, null, 2));
if (completed !== portals.length) process.exitCode = 1;
