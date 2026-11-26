// node --import tsx scripts/compare-shibuya-destinations.ts [all|five-north|five-all|expanded-north|expanded-all] [seed]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createShibuyaScenario } from '../src/scenarios/shibuya';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';

const conditions = [
  { shops: 'five', streets: 'north' }, { shops: 'five', streets: 'all' },
  { shops: 'expanded', streets: 'north' }, { shops: 'expanded', streets: 'all' },
] as const;
const requested = process.argv[2] ?? 'all', seed = Number(process.argv[3] ?? 42);
const selected = conditions.filter(({ shops, streets }) => requested === 'all' || requested === `${shops}-${streets}`);
if (!selected.length || process.argv.length > 4 || !Number.isInteger(seed)
    || seed < 0 || seed > 0xffffffff || process.argv[3]?.trim() === '') {
  throw new Error('Expected a comparison condition (or all) and an optional unsigned 32-bit seed.');
}

const durationSeconds = 1109, stepsPerSecond = Math.round(1 / FIXED_DT);
const dwellSeconds = 300, dwellRadiusMetres = 12;
const config = { ...DEFAULT_CONFIG, scenario: 'shibuya' as const, count: 1000, seed,
  signalMode: 'auto' as const, walkingSpeed: 1.35, avoidanceStrength: 1 };

function hashFields(...fields: ArrayBufferView[]): string {
  const hash = createHash('sha256');
  for (const field of fields) hash.update(Buffer.from(field.buffer, field.byteOffset, field.byteLength));
  return hash.digest('hex');
}

function compare(condition: typeof conditions[number]) {
  const { shops, streets } = condition;
  const scenario = createShibuyaScenario(shops, streets);
  const sim = new Simulation(config, undefined, scenario);
  sim.setPortalDeadlockRecovery(false);
  const a = sim.agents, portals = scenario.portals!, surface = sim.navigation.scramble!;
  const initialPositionHash = hashFields(a.current.x, a.current.z);
  const initialTraitHash = hashFields(a.id, a.scale, a.speedFactor, a.appearance);
  const initialRouteHash = hashFields(a.targetId, a.targetX, a.targetZ, a.current.vx, a.current.vz, a.current.heading);
  // Storefront end points and public-side street mouths match the preceding citywide benchmark.
  const centers = portals.map(p => p.kind === 'door' ? p.end : p.approach);
  const points = portals.map(p => ({ id: p.id, kind: p.kind, initial: 0, assigned: 0, completed: 0,
    longDwellEver: 0, longDwellAtEnd: 0 }));
  const life = a.generation.slice(), since = new Int32Array(a.count).fill(-1);
  const alreadyCounted = new Uint8Array(a.count);
  for (const target of a.targetId) {
    points[target].initial++;
    points[target].assigned++;
  }
  function observeDwell(second: number): void {
    for (let id = 0; id < a.count; id++) {
      const target = a.targetId[id], center = centers[target], x = a.current.x[id], z = a.current.z[id];
      if ((x - center.x) ** 2 + (z - center.z) ** 2 >= dwellRadiusMetres ** 2 || !surface.isSidewalk(x, z)) {
        since[id] = -1;
        continue;
      }
      if (since[id] === -1) since[id] = second;
      if (second - since[id] < dwellSeconds) continue;
      if (!alreadyCounted[id]) {
        points[target].longDwellEver++;
        alreadyCounted[id] = 1;
      }
      if (second === durationSeconds) points[target].longDwellAtEnd++;
    }
  }
  observeDwell(0);
  let previousCompleted = 0;
  for (let second = 1; second <= durationSeconds; second++) {
    for (let step = 0; step < stepsPerSecond; step++) {
      sim.step();
      if (sim.arrivals === previousCompleted) continue;
      let started = 0;
      for (let id = 0; id < a.count; id++) {
        if (life[id] === a.generation[id]) continue;
        points[a.targetId[id]].assigned++;
        started++;
        life[id] = a.generation[id];
        since[id] = -1;
        alreadyCounted[id] = 0;
      }
      assert.equal(started, sim.arrivals - previousCompleted);
      previousCompleted = sim.arrivals;
    }
    observeDwell(second);
    if (second % 300 === 0 || second === durationSeconds) {
      console.error(`${shops}/${streets}: ${second}/${durationSeconds} simulated seconds, ${sim.arrivals} completed trips`);
    }
  }
  const active = new Uint32Array(points.length);
  for (const target of a.targetId) active[target]++;
  const total = { assigned: 0, completed: 0, longDwellEver: 0, longDwellAtEnd: 0 };
  for (const [i, point] of points.entries()) {
    point.completed = sim.completedPortalTrips(i);
    assert.equal(point.assigned, point.completed + active[i], point.id);
    assert.ok(point.longDwellAtEnd <= active[i] && point.longDwellAtEnd <= point.longDwellEver
      && point.longDwellEver <= point.assigned, point.id);
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += point[key];
  }
  assert.equal(total.completed, sim.arrivals);
  assert.equal(total.assigned, config.count + sim.arrivals);
  return { shops, streets, initialPositionHash, initialTraitHash, initialRouteHash, total, points };
}

const results = selected.map(compare);
for (const result of results) {
  assert.equal(result.initialPositionHash, results[0].initialPositionHash);
  assert.equal(result.initialTraitHash, results[0].initialTraitHash);
}
console.log(JSON.stringify({ seed, population: config.count, durationSeconds, stepsPerSecond,
  signalMode: config.signalMode, walkingSpeed: config.walkingSpeed, avoidanceStrength: config.avoidanceStrength,
  metaAI: false, dwellSeconds, dwellRadiusMetres, dwellSampleIntervalSeconds: 1,
  conditions: results }, null, 2));
