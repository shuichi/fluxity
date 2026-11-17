import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../types';
import type { SnapshotMessage, WorkerInput, WorkerOutput } from '../types';

describe('paused signal publication', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
  it('publishes same-step overrides and eventually sends the latest override after pool exhaustion', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const received: SnapshotMessage[] = [];
    vi.stubGlobal('postMessage', (message: WorkerOutput, transfer: Transferable[] = []) => {
      const copy = structuredClone(message, { transfer });
      if (copy.type === 'snapshot') received.push(copy);
      else throw new Error(copy.message);
    });
    await import('../simulation/SimulationWorker');
    const scope = globalThis as unknown as { onmessage(event: { data: WorkerInput }): void };
    const send = (data: WorkerInput): void => scope.onmessage({ data });
    send({ type: 'init', config: { ...DEFAULT_CONFIG, count: 10 }, generation: 1, paused: true });
    expect(received[0].signal?.phase).toBe('red');
    send({ type: 'settings', settings: { signalMode: 'green' } });
    send({ type: 'settings', settings: { signalMode: 'red' } });
    send({ type: 'settings', settings: { signalMode: 'green' } });
    expect(received.length).toBe(4);
    expect(received[3].signal?.phase).toBe('green');
    send({ type: 'settings', settings: { signalMode: 'red' } });
    expect(received.length).toBe(4);
    vi.advanceTimersByTime(2000);
    expect(received.length).toBe(4);
    send({ type: 'recycle', buffer: received[0].buffer, generation: 1 });
    expect(received.length).toBe(5);
    expect(received[4].signal?.phase).toBe('red');
    expect(received[4].step).toBe(0); expect(received[4].simulationTime).toBe(0);
  });
});
