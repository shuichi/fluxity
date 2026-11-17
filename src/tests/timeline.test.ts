import { describe, expect, it, vi } from 'vitest';
import { SnapshotTimeline } from '../app/SnapshotTimeline';
import { SNAPSHOT_STRIDE, type SnapshotMessage } from '../types';

function snapshot(step: number, count = 2): SnapshotMessage {
  return { type: 'snapshot', generation: 1, step, count, buffer: new ArrayBuffer(count * SNAPSHOT_STRIDE * 4),
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
});
