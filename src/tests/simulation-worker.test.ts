import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, SNAPSHOT_STRIDE } from '../types';
import type { SnapshotMessage, WorkerInput, WorkerOutput } from '../types';

describe('worker transfer ownership and clock', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('publishes while paused, reuses a bounded pool, and rejects buffers from an old generation', async () => {
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
    expect(received.length).toBe(1); expect(received[0].step).toBe(0);
    expect(received[0].buffer.byteLength).toBe(10 * SNAPSHOT_STRIDE * 4);
    vi.advanceTimersByTime(200); expect(received.length).toBe(1);
    send({ type: 'pause', paused: false });
    vi.advanceTimersByTime(1000);
    // The consumer has retained all four buffers: simulation continues without allocating more.
    expect(received.length).toBe(4);
    const firstBuffer = received[0].buffer;
    send({ type: 'recycle', buffer: firstBuffer, generation: 1 });
    vi.advanceTimersByTime(40);
    expect(received.length).toBe(5); expect(received[4].step).toBeGreaterThanOrEqual(30);
    expect(firstBuffer.byteLength).toBe(0); // The reused allocation was transferred again.
    const oldBuffer = received[1].buffer;
    send({ type: 'init', config: { ...DEFAULT_CONFIG, count: 10 }, generation: 2, paused: false });
    expect(received[5].generation).toBe(2); expect(received[5].step).toBe(0);
    send({ type: 'recycle', buffer: oldBuffer, generation: 1 });
    vi.advanceTimersByTime(1000);
    expect(received.length).toBe(9); // Exactly four fresh-generation allocations.
    expect(oldBuffer.byteLength).toBe(10 * SNAPSHOT_STRIDE * 4);
  });
});
