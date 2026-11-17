import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT, SNAPSHOT_STRIDE } from '../src/types';
import type { ScenarioId, SignalMode } from '../src/types';
import { scenarios } from '../src/scenarios';

const options: Record<string, string | undefined> = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/, '').split('=')));
const scenario = (options.scenario ?? 'plaza') as ScenarioId;
const signalMode = (options.signal ?? 'green') as SignalMode;
const steps = Number(options.steps ?? 120);
const counts = (options.counts ?? '1000,5000,10000,20000').split(',').map(Number);
if (!(scenario in scenarios) || !['red', 'green', 'auto'].includes(signalMode)
  || !Number.isInteger(steps) || steps < 1 || steps > 10000
  || counts.some(count => !Number.isInteger(count) || count < 1 || count > 20000)) {
  throw new Error('Use --scenario=shibuya|plaza|corridor|bottleneck|crossing --signal=green|red|auto --steps=120 --counts=1000,5000');
}

/** CPU-only, deterministic workload. Browser benchmark separately measures actual rendering. */
console.log(`Fluxity CPU simulation benchmark — ${scenarios[scenario].name}, ${signalMode} signal, seed 42, fixed 30 Hz`);
console.log(`Node ${process.version} / ${process.platform} ${process.arch}`);
console.log(`30 warmup steps + ${steps} measured steps; rendering and Worker transfer excluded.`);
const rows = [];
for (const count of counts) {
  const simulation = new Simulation({ ...DEFAULT_CONFIG, scenario, signalMode, count });
  const snapshot = new Float32Array(count * SNAPSHOT_STRIDE);
  for (let step = 0; step < 30; step++) simulation.step(FIXED_DT);
  const measurements = [];
  for (let step = 0; step < steps; step++) {
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
