import { describe, expect, it } from 'vitest';
import { parseSignalMode, SIGNAL_CYCLE_SECONDS, TrafficSignal } from '../simulation/TrafficSignal';
import type { PedestrianSignal, VehicleSignal } from '../types';

describe('Shibuya intersection signal controller', () => {
  it('normalizes the original saved signal names before initializing a scene', () => {
    expect(parseSignalMode('green')).toBe('pedestrian');
    expect(parseSignalMode('red')).toBe('eastWest');
    expect(parseSignalMode('yellow')).toBe('allRed');
    expect(parseSignalMode('invalid')).toBeUndefined();
  });

  it('repeats the observed 140-second cycle with independent indications', () => {
    expect(SIGNAL_CYCLE_SECONDS).toBe(140);
    const signal = new TrafficSignal();
    const changes: [number, PedestrianSignal, VehicleSignal, VehicleSignal, number][] = [
      [0, 'green', 'red', 'red', 37],
      [37, 'flashingGreen', 'red', 'red', 10],
      [47, 'red', 'red', 'red', 4],
      [51, 'red', 'green', 'red', 44],
      [95, 'red', 'yellow', 'red', 3],
      [98, 'red', 'red', 'red', 3],
      [101, 'red', 'red', 'green', 33],
      [134, 'red', 'red', 'yellow', 3],
      [137, 'red', 'red', 'red', 3],
    ];
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [start, pedestrian, eastWest, northSouth, duration] of changes) {
        const time = cycle * SIGNAL_CYCLE_SECONDS + start;
        signal.update(time);
        expect(signal.state).toMatchObject({ pedestrian, eastWest, northSouth, remaining: duration });
        signal.update(time + duration - 0.001);
        expect(signal.state).toMatchObject({ pedestrian, eastWest, northSouth });
      }
    }
  });

  it('delays both vehicle waves and the next crossing until the last occupant has left', () => {
    const signal = new TrafficSignal();
    signal.update(51, false, true);
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: null });
    signal.update(71, false, false);
    expect(signal.state).toMatchObject({ eastWest: 'green', remaining: 44 });
    signal.update(121, true, false);
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: null });
    signal.update(124, false, false);
    expect(signal.state).toMatchObject({ northSouth: 'green', remaining: 33 });
    signal.update(163, true, false);
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: null });
    signal.update(183, false, false);
    expect(signal.state).toMatchObject({ pedestrian: 'green', remaining: 37 });
  });

  it('applies only the latest manual request after full warning and clearance', () => {
    const signal = new TrafficSignal('eastWest');
    signal.setMode('pedestrian', 20);
    expect(signal.state).toMatchObject({ mode: 'pedestrian', eastWest: 'yellow', remaining: 3 });
    signal.setMode('allRed', 20);
    signal.setMode('eastWest', 21);
    signal.setMode('northSouth', 22);
    signal.update(23);
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: 3 });
    signal.setMode('northSouth', 24);
    signal.setMode('allRed', 25);
    signal.update(26);
    expect(signal.state.remaining).toBeNull();
    signal.setMode('northSouth', 90, true);
    expect(signal.state.northSouth).toBe('red');
    signal.update(91);
    expect(signal.state).toMatchObject({ northSouth: 'green', remaining: null });
    signal.setMode('auto', 100);
    expect(signal.state).toMatchObject({ northSouth: 'green', remaining: 33 });
    signal.update(133);
    expect(signal.state).toMatchObject({ northSouth: 'yellow', remaining: 3 });
  });

  it('preserves the full pedestrian flashing time even when requests arrive on a paused tick', () => {
    const signal = new TrafficSignal('pedestrian');
    signal.setMode('eastWest', 0);
    signal.setMode('allRed', 0);
    signal.setMode('northSouth', 0);
    expect(signal.state).toMatchObject({ pedestrian: 'flashingGreen', eastWest: 'red', northSouth: 'red', remaining: 10 });
    signal.update(10);
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: 4 });
    signal.update(14, false, true);
    expect(signal.state.northSouth).toBe('red');
    signal.update(20);
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'green', remaining: null });
  });

  it('can start on all-red and admit its first request when the new scene is clear', () => {
    const signal = new TrafficSignal('allRed');
    expect(signal.state).toMatchObject({ pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: null });
    signal.setMode('pedestrian', 0, true);
    expect(signal.state.pedestrian).toBe('red');
    signal.update(1);
    expect(signal.state).toMatchObject({ pedestrian: 'green', remaining: null });
  });
});
