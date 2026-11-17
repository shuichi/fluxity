import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../types';
import { shibuya } from '../scenarios/shibuya';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import { Steering } from '../simulation/Steering';

function invalidPositions(simulation: Simulation): number {
  const a = simulation.agents;
  let invalid = 0;
  for (let i = 0; i < a.count; i++) {
    if (!simulation.navigation.isFree(a.current.x[i], a.current.z[i], a.radius[i])) invalid++;
    if (!Number.isFinite(a.current.x[i] + a.current.z[i] + a.current.heading[i])) invalid++;
    if (Math.hypot(a.current.vx[i], a.current.vz[i]) > a.preferredSpeed[i] * 1.12 + 0.01) invalid++;
  }
  return invalid;
}

describe('PLATEAU Shibuya pedestrian map', () => {
  it('connects every active cell to every destination and keeps spawn cells on sidewalks', () => {
    const navigation = new Navigation(shibuya);
    expect(shibuya.urbanMap?.statistics.lod2Buildings).toBeGreaterThan(0);
    expect(navigation.spawnCells.length).toBeGreaterThan(1000);
    expect(navigation.fields.length).toBe(shibuya.targets.length);
    for (const target of shibuya.targets) expect(navigation.isSpawnable(target.x, target.z, 0.3)).toBe(true);
    let disconnected = 0;
    for (const field of navigation.fields) for (let cell = 0; cell < navigation.walkable.length; cell++) {
      if (navigation.walkable[cell] && !Number.isFinite(field.costs[cell])) disconnected++;
    }
    expect(disconnected).toBe(0);
  });

  it('holds 1,000 pedestrians on sidewalks at red and releases real crossing flows on green', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1000, signalMode: 'red' });
    const a = simulation.agents, geometry = simulation.navigation.scramble!;
    for (let step = 0; step < 120; step++) simulation.step();
    let incursions = 0;
    for (let i = 0; i < a.count; i++) if (!geometry.isSidewalk(a.current.x[i], a.current.z[i], a.radius[i])) incursions++;
    expect(incursions).toBe(0); expect(invalidPositions(simulation)).toBe(0);
    expect(simulation.signal?.waiting).toBeGreaterThan(0);
    simulation.updateSettings({ signalMode: 'green' });
    for (let step = 0; step < 180; step++) simulation.step();
    expect(simulation.signal?.crossing).toBeGreaterThan(10);
    expect(simulation.stats.meanSpeed).toBeGreaterThan(0.3);
    expect(invalidPositions(simulation)).toBe(0);
  }, 15000);

  it('reaches real destinations through repeated five-zone transitions', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 5, signalMode: 'green' });
    for (let step = 0; step < 6000; step++) {
      simulation.step();
      if (step % 100 === 0) expect(invalidPositions(simulation)).toBe(0);
    }
    expect(simulation.arrivals).toBeGreaterThanOrEqual(5);
    expect(Math.max(...simulation.agents.stalledTime)).toBeLessThan(10);
  }, 10000);

  it('initializes 20,000 agents without invalid fallback positions and bounds local work', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 20000, signalMode: 'red' });
    const a = simulation.agents, geometry = simulation.navigation.scramble!;
    let invalid = 0;
    for (let i = 0; i < a.count; i++) {
      if (!geometry.isSidewalk(a.current.x[i], a.current.z[i], a.radius[i])
        || !simulation.navigation.isReachable(a.current.x[i], a.current.z[i], a.targetId[i])) invalid++;
    }
    expect(invalid).toBe(0);
    for (let step = 0; step < 3; step++) simulation.step();
    expect(simulation.signal?.crossing).toBe(0);
    simulation.updateSettings({ signalMode: 'green' });
    for (let step = 0; step < 3; step++) simulation.step();
    expect(invalidPositions(simulation)).toBe(0);
    expect((simulation.avoidance as Steering).candidateChecks).toBeLessThanOrEqual(20000 * 96);
  }, 20000);
});
