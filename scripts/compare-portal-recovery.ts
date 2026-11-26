// From the repository root: node --import tsx scripts/compare-portal-recovery.ts [none|northwest|all] [seed]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { legacyShibuya } from '../src/scenarios/shibuya';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';

const modes = ['none', 'northwest', 'all'] as const;
type Mode = typeof modes[number];
const requested = process.argv[2] as Mode | undefined;
const seed = Number(process.argv[3] ?? 42);
if (process.argv.length > 4 || (requested !== undefined && !modes.includes(requested))
  || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || process.argv[3]?.trim() === '') {
  throw new Error('Usage: node --import tsx scripts/compare-portal-recovery.ts [none|northwest|all] [unsigned-32-bit-seed]');
}

const config = { ...DEFAULT_CONFIG, scenario: 'shibuya' as const, seed, count: 1000,
  signalMode: 'auto' as const, walkingSpeed: 1.35, avoidanceStrength: 1 };
const duration = 1109, stepsPerSecond = Math.round(1 / FIXED_DT);
const fromSecond = 12 * 60, toSecond = 17 * 60, dwellSeconds = 300, dwellRadius = 12;

function compare(mode: Mode) {
  const sim = new Simulation(config, undefined, legacyShibuya);
  sim.setPortalDeadlockRecovery(mode !== 'none', mode === 'northwest' ? 'northwest-shop' : undefined);
  const a = sim.agents, portals = sim.scenario.portals!, surface = sim.navigation.scramble!;
  const hash = createHash('sha256');
  for (const field of [a.current.x, a.current.z, a.current.vx, a.current.vz, a.current.heading,
    a.generation, a.targetId, a.targetX, a.targetZ]) {
    hash.update(Buffer.from(field.buffer, field.byteOffset, field.byteLength));
  }
  const initialStateHash = hash.digest('hex');
  // Keep the historical facade-centered measurement. A street's inner end lies
  // outside the map, so observe its public-side mouth where people can queue.
  const centers = portals.map(p => p.kind === 'door' ? p.end : p.approach);
  const life = a.generation.slice(), since = new Int32Array(a.count).fill(-1);
  const intervalStart = new Uint32Array(portals.length);
  const metrics = portals.map(p => ({ id: p.id, kind: p.kind, completedTrips: 0, completed12to17min: 0,
    longDwellAtEnd: 0, interventions: 0 }));
  const active = new Uint8Array(portals.length);
  for (let second = 1; second <= duration; second++) {
    for (let step = 0; step < stepsPerSecond; step++) {
      sim.step();
      for (let i = 0; i < portals.length; i++) {
        const intervening = sim.isPortalDeadlockActive(i);
        if (intervening && !active[i]) metrics[i].interventions++;
        active[i] = Number(intervening);
      }
    }
    // Match the original once-per-second observation and reset on life replacement.
    for (let id = 0; id < a.count; id++) {
      const target = a.targetId[id], center = centers[target], x = a.current.x[id], z = a.current.z[id];
      if ((x - center.x) ** 2 + (z - center.z) ** 2 >= dwellRadius ** 2 || !surface.isSidewalk(x, z)) {
        since[id] = -1;
      } else {
        if (since[id] < 0 || life[id] !== a.generation[id]) since[id] = second;
        if (second === duration && second - since[id] >= dwellSeconds) metrics[target].longDwellAtEnd++;
      }
      life[id] = a.generation[id];
    }
    if (second === fromSecond || second === toSecond || second === duration) {
      for (let i = 0; i < portals.length; i++) {
        const entered = sim.completedPortalTrips(i);
        if (second === fromSecond) intervalStart[i] = entered;
        if (second === toSecond) metrics[i].completed12to17min = entered - intervalStart[i];
        if (second === duration) metrics[i].completedTrips = entered;
      }
    }
  }
  assert.equal(metrics.reduce((n, p) => n + p.completedTrips, 0), sim.arrivals);
  return { mode, seed: config.seed, population: a.count, duration, initialStateHash, dwellSeconds,
    dwellRadius, allDestinationArrivals: sim.arrivals, portals: metrics };
}

const results = (requested ? [requested] : modes).map(compare);
assert.ok(results.every(result => result.initialStateHash === results[0].initialStateHash));
console.log(JSON.stringify(results, null, 2));
