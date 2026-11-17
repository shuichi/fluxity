import { FIXED_DT, SNAPSHOT_STRIDE } from '../types';
import type { WorkerInput, WorkerOutput } from '../types';
import { Simulation } from './Simulation';

// Keep the simulation package itself independent of DOM/worker global types.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInput>) => void) | null;
  postMessage(message: WorkerOutput, transfer?: Transferable[]): void;
};
let simulation: Simulation | undefined;
let generation = 0;
let paused = false;
let accumulator = 0;
let lastTime = performance.now();
let lastStepMs = 0;
let buffers: ArrayBuffer[] = [];
let expectedBytes = 0;
let pendingPublish = false;

function publish(): void {
  if (!simulation) return;
  if (buffers.length === 0) { pendingPublish = true; return; }
  pendingPublish = false;
  const buffer = buffers.pop()!;
  simulation.writeSnapshot(new Float32Array(buffer));
  scope.postMessage({
    type: 'snapshot', generation, buffer, count: simulation.agents.count,
    step: simulation.stepCount, simulationTime: simulation.time, stepMs: lastStepMs,
    meanSpeed: simulation.stats.meanSpeed, congestion: simulation.stats.congestion,
    signal: simulation.signal,
  }, [buffer]);
}

scope.onmessage = (event: MessageEvent<WorkerInput>): void => {
  try {
    const message = event.data;
    switch (message.type) {
      case 'init':
        generation = message.generation;
        simulation = new Simulation(message.config);
        paused = message.paused; accumulator = 0; lastStepMs = 0; pendingPublish = false;
        expectedBytes = simulation.agents.count * SNAPSHOT_STRIDE * Float32Array.BYTES_PER_ELEMENT;
        buffers = Array.from({ length: 4 }, () => new ArrayBuffer(expectedBytes));
        lastTime = performance.now(); publish();
        break;
      case 'settings':
        simulation?.updateSettings(message.settings);
        // Signal changes are visible immediately, even when no numerical step is running.
        if (message.settings.signalMode !== undefined) publish();
        break;
      case 'pause':
        paused = message.paused; accumulator = 0; lastTime = performance.now();
        break;
      case 'recycle':
        if (message.generation === generation && message.buffer.byteLength === expectedBytes && buffers.length < 4) buffers.push(message.buffer);
        if (pendingPublish && buffers.length > 0) publish();
        break;
    }
  } catch (error) {
    paused = true;
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(0.1, Math.max(0, (now - lastTime) / 1000)); lastTime = now;
  if (!simulation || paused) return;
  // Keep dt fixed; time scaling changes the number of steps, never their numerical size.
  // Drop overdue time instead of growing an unbounded catch-up queue after stalls.
  accumulator = Math.min(accumulator + elapsed * simulation.settings.simulationSpeed, FIXED_DT * 3);
  let steps = 0, totalMs = 0;
  try {
    while (accumulator + 1e-9 >= FIXED_DT && steps < 3) {
      const start = performance.now(); simulation.step(FIXED_DT); totalMs += performance.now() - start;
      accumulator -= FIXED_DT; steps++;
    }
    if (steps > 0) { lastStepMs = totalMs / steps; publish(); }
  } catch (error) {
    paused = true;
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}, 8);
