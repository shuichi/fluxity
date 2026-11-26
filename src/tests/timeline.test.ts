import { describe, expect, it, vi } from 'vitest';
import { SnapshotTimeline } from '../app/SnapshotTimeline';
import { SNAPSHOT_STRIDE, VEHICLE_SNAPSHOT_STRIDE, type SnapshotMessage } from '../types';

function snapshot(step: number, count = 2, vehicleCapacity = 0): SnapshotMessage {
  return { type: 'snapshot', generation: 1, step, count, vehicleCapacity, buffer: new ArrayBuffer((count * SNAPSHOT_STRIDE + vehicleCapacity * VEHICLE_SNAPSHOT_STRIDE) * 4),
    simulationTime: step / 30, stepMs: 1, meanSpeed: 1, congestion: 0 };
}

describe('transferable snapshot timeline', () => {
  it('retains two states, recycles every older buffer exactly once', () => {
    const recycle = vi.fn();
    const timeline = new SnapshotTimeline(recycle);
    const states = [snapshot(0), snapshot(1), snapshot(2), snapshot(3)];
    states.forEach((state, i) => timeline.accept(state, i * 1000 / 30));
    expect(recycle.mock.calls.map(call => call[0])).toEqual(states.slice(0, 2));
    expect(timeline.previous?.message).toBe(states[2]);
    expect(timeline.current?.message).toBe(states[3]);
    timeline.clear();
    expect(recycle.mock.calls.map(call => call[0])).toEqual(states);
    timeline.clear();
    expect(recycle).toHaveBeenCalledTimes(4);
  });
  it('interpolates between fixed ticks and respects simulation speed', () => {
    const timeline = new SnapshotTimeline(() => {});
    timeline.accept(snapshot(0), 0);
    expect(timeline.alpha(0, 1)).toBe(1);
    timeline.accept(snapshot(1), 100);
    expect(timeline.alpha(100, 1)).toBe(0);
    expect(timeline.alpha(100 + 1000 / 60, 1)).toBeCloseTo(0.5);
    expect(timeline.alpha(100 + 1000 / 60, 2)).toBeCloseTo(1);
    expect(timeline.alpha(200, 1)).toBe(1);
  });
  it('rejects a broken binary layout and out-of-order snapshots', () => {
    const recycle = vi.fn();
    const timeline = new SnapshotTimeline(recycle);
    const valid = snapshot(2);
    timeline.accept(valid, 100);
    timeline.accept(snapshot(1), 120);
    expect(timeline.current?.message).toBe(valid);
    expect(recycle).toHaveBeenCalledOnce();
    expect(() => timeline.accept({ ...snapshot(3), count: 3 }, 130)).toThrow(/layout/);
  });
  it('displays verified positions immediately when either vehicle signal changes or pedestrians start flashing', () => {
    const timeline = new SnapshotTimeline(() => {});
    const indications = { mode: 'auto', pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: 3, waiting: 0, crossing: 0 } as const;
    const frames = [indications, { ...indications, eastWest: 'green' }, indications,
      { ...indications, northSouth: 'yellow' }, indications, { ...indications, pedestrian: 'green' },
      { ...indications, pedestrian: 'flashingGreen' }] as const;
    frames.forEach((signal, step) => {
      timeline.accept({ ...snapshot(step, 1, 1), signal }, step * 100);
      expect(timeline.alpha(step * 100, 1)).toBe(1);
    });
  });
  it('samples both streams at a verified step when traffic frames skip or a slot changes life', () => {
    const timeline = new SnapshotTimeline(() => {});
    const frame = (step: number, personLife = 1, carLife = 1) => {
      const message = snapshot(step, 1, 1);
      const packed = new Float32Array(message.buffer);
      packed[11] = personLife;
      packed[SNAPSHOT_STRIDE + 3] = carLife;
      return message;
    };
    timeline.accept(frame(0), 0);
    timeline.accept(frame(1), 100);
    expect(timeline.alpha(100, 1)).toBe(0);
    expect(timeline.current?.data.length).toBe(SNAPSHOT_STRIDE);
    expect(timeline.current?.vehicles[3]).toBe(1);
    timeline.accept(frame(4), 200);
    expect(timeline.alpha(200, 1)).toBe(1);
    timeline.accept(frame(5, 2), 300);
    expect(timeline.alpha(300, 1)).toBe(1);
    timeline.accept(frame(6, 2, 2), 400);
    expect(timeline.alpha(400, 1)).toBe(1);
    timeline.accept({ ...frame(0), generation: 2 }, 500);
    expect(timeline.alpha(500, 1)).toBe(1);
    expect(timeline.current?.message.generation).toBe(2);
  });
});
