// Reproduce the frozen 116-person Shibuya comparison from docs/validation.md.
// node --import tsx scripts/compare-shop-recovery.ts [baseline|recovery]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CrossingExits } from '../src/simulation/CrossingExits';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';

const historicalCommit = '14741389390c008e472b0e52eed13e23592c65fb';
const expectedSnapshot = '2a0647eef7c0936df911784b856d809b49c92d767a2dfaff72a34025269ad2f6';
const expectedCohort = 'ad514c09c4a66c9a610426026826d3bf38236c87c46a4d98bc5b8cc6d3a56763';
const stepsPerSecond = Math.round(1 / FIXED_DT);
const mode = process.argv[2] ?? 'both';
if (process.argv.length > 3 || !['baseline', 'recovery', 'both'].includes(mode)) {
  throw new Error('Usage: node --import tsx scripts/compare-shop-recovery.ts [baseline|recovery|both]');
}

// Read the exact historical curb algorithm from Git without modifying the checkout.
async function historicalExits(): Promise<typeof CrossingExits> {
  const directory = mkdtempSync(join(tmpdir(), 'fluxity-cohort-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    for (const name of ['CrossingExits', 'UrbanGeometry']) {
      const path = 'src/simulation/' + name + '.ts';
      writeFileSync(join(directory, name + '.ts'), execFileSync('git', ['show', historicalCommit + ':' + path], { cwd: root }));
    }
    return (await import(pathToFileURL(join(directory, 'CrossingExits.ts')).href)).CrossingExits;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function warmUp(sim: Simulation, previous: typeof CrossingExits) {
  // Freeze only the historical warmup behaviors. The existing simulation carries its
  // full trip reservations, RNG, and local perception state across the split at 300 s.
  sim.setShopDeadlockRecovery(false);
  const exits = sim['crossings']!['exits'], headway = sim['headway']!, portals = sim['portals']!;
  const currentPrototype = Object.getPrototypeOf(exits);
  Object.setPrototypeOf(exits, previous.prototype);
  Object.assign(headway, { limit() {} });
  Object.assign(portals, { conflictingEmergence: () => -1, slideInBank: () => false });
  for (let i = 0; i < 300 * stepsPerSecond; i++) sim.step();
  Object.setPrototypeOf(exits, currentPrototype);
  Reflect.deleteProperty(headway, 'limit');
  Reflect.deleteProperty(portals, 'conflictingEmergence');
  Reflect.deleteProperty(portals, 'slideInBank');
}

function compare(enabled: boolean, previous: typeof CrossingExits) {
  const sim = new Simulation({ ...DEFAULT_CONFIG, scenario: 'shibuya', count: 1000, seed: 42,
    signalMode: 'auto', walkingSpeed: 1.35, avoidanceStrength: 1 });
  warmUp(sim, previous);
  const a = sim.agents, p = a.current;
  const hash = createHash('sha256');
  for (const field of [p.x, p.z, p.vx, p.vz, p.heading, a.portalStage, a.generation, a.targetId, a.targetX, a.targetZ]) {
    hash.update(Buffer.from(field.buffer, field.byteOffset, field.byteLength));
  }
  const snapshotHash = hash.digest('hex');
  assert.equal(snapshotHash, expectedSnapshot, 'Warmup must reproduce the recorded position, velocity, heading, and trip state.');
  const target = sim.scenario.portals!.findIndex(portal => portal.id === 'northwest-shop');
  const shop = sim.scenario.portals![target];
  const cohort = new Map<number, number>();
  for (let id = 0; id < a.count; id++) {
    if (a.targetId[id] === target && a.portalStage[id] === 0 && a.stalledTime[id] > 5
      && Math.hypot(p.x[id] - shop.end.x, p.z[id] - shop.end.z) <= 12) cohort.set(id, a.generation[id]);
  }
  const cohortHash = createHash('sha256').update(JSON.stringify([...cohort])).digest('hex');
  assert.equal(cohortHash, expectedCohort, 'The same 116 original trips must be followed in both arms.');
  const remaining = new Map(cohort);
  const completedAtSplit = sim['portals']!.completedTrips[target], arrivalsAtSplit = sim.arrivals;
  sim.setShopDeadlockRecovery(enabled);
  let activeSteps = 0, episodes = 0, wasActive = false;
  const samples = [];
  for (let step = 1; step <= 300 * stepsPerSecond; step++) {
    sim.step();
    if (sim.shopDeadlockActive) {
      activeSteps++;
      if (!wasActive) episodes++;
    }
    wasActive = sim.shopDeadlockActive;
    for (const [id, life] of remaining) {
      if (a.generation[id] === life) {
        assert.equal(a.targetId[id], target, 'A tagged person must retain the original destination.');
      } else {
        // The last position of a replaced walker must be inside the original doorway.
        const distance = Math.hypot(a.next.x[id] - shop.end.x, a.next.z[id] - shop.end.z);
        assert.ok(distance <= shop.width / 2 + 0.10, 'A tagged trip completed away from the shop.');
        remaining.delete(id);
      }
    }
    if (step === 120 * stepsPerSecond || step === 300 * stepsPerSecond) {
      let remainingWithin12m = 0;
      for (const id of remaining.keys()) {
        if (Math.hypot(a.current.x[id] - shop.end.x, a.current.z[id] - shop.end.z) <= 12) remainingWithin12m++;
      }
      samples.push({ elapsedSeconds: step / stepsPerSecond, taggedShopEntries: cohort.size - remaining.size,
        remainingWithin12m, allShopEntries: sim['portals']!.completedTrips[target] - completedAtSplit,
        allDestinationArrivals: sim.arrivals - arrivalsAtSplit, interventionEpisodes: episodes,
        interventionSeconds: Number((activeSteps * FIXED_DT).toFixed(2)) });
    }
  }
  return { mode: enabled ? 'recovery' : 'baseline', seed: 42, splitSecond: 300, snapshotHash,
    cohortHash, cohortSize: cohort.size, samples };
}

const previous = await historicalExits();
const runs = mode === 'both' ? [false, true] : [mode === 'recovery'];
for (const enabled of runs) console.log(JSON.stringify(compare(enabled, previous), null, 2));
