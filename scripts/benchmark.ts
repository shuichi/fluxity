import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT, SNAPSHOT_STRIDE } from '../src/types';

/** CPU-only, deterministic workload. Browser benchmark separately measures actual rendering. */
console.log('Fluxity CPU simulation benchmark — City Plaza, seed 42, fixed 30 Hz');
console.log(`Node ${process.version} / ${process.platform} ${process.arch}`);
console.log('30 warmup steps + 120 measured steps; rendering and Worker transfer excluded.');
const rows = [];
for (const count of [1000, 5000, 10000, 20000]) {
  const simulation = new Simulation({ ...DEFAULT_CONFIG, scenario: 'plaza', count });
  const snapshot = new Float32Array(count * SNAPSHOT_STRIDE);
  for (let step = 0; step < 30; step++) simulation.step(FIXED_DT);
  const measurements = [];
  for (let step = 0; step < 120; step++) {
    const start = performance.now();
    simulation.step(FIXED_DT);
    measurements.push(performance.now() - start);
  }
  const packingStart = performance.now();
  simulation.writeSnapshot(snapshot);
  const packingMs = performance.now() - packingStart;
  measurements.sort((a, b) => a - b);
  rows.push({
    agents: count,
    'mean step ms': +(measurements.reduce((sum, ms) => sum + ms, 0) / measurements.length).toFixed(2),
    'p95 step ms': +measurements[Math.floor(measurements.length * 0.95)].toFixed(2),
    'snapshot ms': +packingMs.toFixed(2),
    'snapshot KiB': snapshot.byteLength / 1024,
  });
}
console.table(rows);
console.log('30 Hz budget: 33.33 ms/step. These numbers do not measure GPU performance or browser FPS.');
