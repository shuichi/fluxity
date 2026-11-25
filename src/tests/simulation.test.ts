import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG as APP_DEFAULT_CONFIG, FIXED_DT, SNAPSHOT_STRIDE } from '../types';
import type { ScenarioId } from '../types';
import { Simulation } from '../simulation/Simulation';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { Navigation } from '../simulation/Navigation';
import { Steering } from '../simulation/Steering';
import { getScenario } from '../scenarios';

// These are legacy non-signal model regressions; the app's default stage may change independently.
const DEFAULT_CONFIG = { ...APP_DEFAULT_CONFIG, scenario: 'plaza' as const };

function snapshot(simulation: Simulation): Float32Array {
  const data = new Float32Array(simulation.agents.count * SNAPSHOT_STRIDE); simulation.writeSnapshot(data); return data;
}

describe('deterministic, finite SoA simulation', () => {
  it('accumulates elapsed time when callers use different valid step sizes', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1 });
    simulation.step(1 / 30); simulation.step(1 / 60); simulation.step(0.05);
    expect(simulation.stepCount).toBe(3);
    expect(simulation.time).toBeCloseTo(0.1, 12);
  });
  it('produces identical state for the same seed and different state for a new seed', () => {
    const first = new Simulation({ ...DEFAULT_CONFIG, count: 100, seed: 1234 });
    const second = new Simulation({ ...DEFAULT_CONFIG, count: 100, seed: 1234 });
    const different = new Simulation({ ...DEFAULT_CONFIG, count: 100, seed: 4321 });
    for (let step = 0; step < 60; step++) { first.step(); second.step(); }
    expect(snapshot(first)).toEqual(snapshot(second));
    expect(first.agents.current.x).not.toEqual(different.agents.current.x);
  });
  it.each<ScenarioId>(['plaza', 'corridor', 'bottleneck', 'crossing'])('keeps %s agents on the floor or inside their assigned passage', scenario => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, scenario, count: 500 });
    for (let step = 0; step < 180; step++) simulation.step();
    const a = simulation.agents, state = a.current;
    for (let i = 0; i < a.count; i++) {
      expect(Number.isFinite(state.x[i] + state.z[i] + state.heading[i] + state.phase[i])).toBe(true);
      expect(Math.hypot(state.vx[i], state.vz[i])).toBeLessThanOrEqual(a.preferredSpeed[i] * 1.12 + 0.001);
      expect(simulation.navigation.isFree(state.x[i], state.z[i], a.radius[i]) || simulation.isInPortalLane(i)).toBe(true);
    }
    expect(simulation.stats.meanSpeed).toBeGreaterThan(0.3);
  });
  it('packs a consistent snapshot with life generations, opacity, appearance and actual velocity', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 32 }); simulation.step();
    const data = snapshot(simulation), a = simulation.agents;
    expect(() => simulation.writeSnapshot(new Float32Array(10))).toThrow(RangeError);
    for (let i = 0; i < a.count; i++) {
      const offset = i * SNAPSHOT_STRIDE;
      expect(data[offset]).toBe(a.current.x[i]); expect(data[offset + 1]).toBe(a.current.z[i]);
      expect(data[offset + 3]).toBeCloseTo(Math.hypot(a.current.vx[i], a.current.vz[i]), 5);
      expect(data[offset + 5]).toBe(a.appearance[i]);
      expect(data[offset + 11]).toBe(0); expect(data[offset + 12]).toBe(1);
      expect(data[offset + 6]).toBeGreaterThan(0.8);
    }
  });
  it('stops phase progression at rest and accelerates smoothly after a speed update', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 20, walkingSpeed: 0 });
    const initial = new Float32Array(simulation.agents.current.phase);
    for (let step = 0; step < 30; step++) simulation.step();
    expect(simulation.agents.current.phase).toEqual(initial);
    simulation.updateSettings({ walkingSpeed: 2 });
    const oldVX = new Float32Array(simulation.agents.current.vx), oldVZ = new Float32Array(simulation.agents.current.vz);
    simulation.step();
    for (let i = 0; i < simulation.agents.count; i++) {
      const state = simulation.agents.current;
      expect(Math.hypot(state.vx[i] - oldVX[i], state.vz[i] - oldVZ[i])).toBeLessThanOrEqual(3.8 * FIXED_DT + 1e-4);
    }
    expect(simulation.stats.meanSpeed).toBeGreaterThan(0);
  });
  it('turns through the shorter arc and respects angular-rate limits', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 100 });
    const previous = new Float32Array(simulation.agents.current.heading);
    simulation.step();
    for (let i = 0; i < previous.length; i++) expect(Math.abs(simulation.agents.current.heading[i] - previous[i])).toBeLessThanOrEqual(3.5 * FIXED_DT + 1e-5);
  });
  it('passes oncoming pedestrians on consistent sides without overlapping', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 2, scenario: 'corridor' });
    const a = simulation.agents;
    a.current.x.set([-3, 3]); a.current.z.fill(0); a.current.vx.set([1.35, -1.35]); a.current.vz.fill(0);
    a.targetId.set([1, 0]); a.targetX.set([110, -110]); a.targetZ.fill(0);
    let minimumSeparation = Infinity;
    for (let step = 0; step < 200; step++) {
      simulation.step();
      minimumSeparation = Math.min(minimumSeparation, Math.hypot(a.current.x[0] - a.current.x[1], a.current.z[0] - a.current.z[1]));
    }
    expect(minimumSeparation).toBeGreaterThan(a.radius[0] + a.radius[1]);
    expect(a.current.x[0]).toBeGreaterThan(3); expect(a.current.x[1]).toBeLessThan(-3);
    expect(a.current.z[0]).toBeLessThan(0); expect(a.current.z[1]).toBeGreaterThan(0);
  });
  it('supports all requested population sizes with bounded local work', () => {
    for (const count of [1000, 5000, 10000, 20000]) {
      const simulation = new Simulation({ ...DEFAULT_CONFIG, count }); simulation.step();
      expect(simulation.agents.count).toBe(count);
      expect(snapshot(simulation).length).toBe(count * SNAPSHOT_STRIDE);
      expect((simulation.avoidance as Steering).candidateChecks).toBeLessThanOrEqual(count * 96);
      expect(Number.isFinite(simulation.stats.meanSpeed)).toBe(true);
    }
  }, 15000);
});

describe('spatial grid', () => {
  it('packs each agent exactly once and rebuilds after movement', () => {
    const grid = new SpatialGrid({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 5, 2);
    const x = new Float32Array([0.1, 1.1, 5, 9.9, 10]), z = new Float32Array([0.1, 1.1, 5, 9.9, 0]);
    grid.rebuild(x, z, x.length);
    expect(new Set(grid.indices).size).toBe(5);
    expect(grid.counts[0]).toBe(2);
    expect(grid.offsets[grid.offsets.length - 1]).toBe(5);
    x[0] = 6; grid.rebuild(x, z, x.length);
    expect(grid.counts[0]).toBe(1);
    expect(grid.cells[0]).toBe(grid.cellAt(6, 0.1));
  });
});

describe('flow-field routing', () => {
  it('brings an actual pedestrian to a destination behind a wall', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1, scenario: 'bottleneck' });
    const a = simulation.agents;
    a.current.x[0] = -30; a.current.z[0] = -30; a.current.vx[0] = 0; a.current.vz[0] = 0;
    let crossedOpening = false;
    for (let step = 0; step < 6500 && simulation.arrivals === 0; step++) {
      simulation.step();
      if (Math.abs(a.current.x[0]) < 2) {
        expect(Math.abs(a.current.z[0])).toBeLessThan(4 - a.radius[0]);
        crossedOpening = true;
      }
      expect(simulation.navigation.isFree(a.current.x[0], a.current.z[0], a.radius[0]) || simulation.isInPortalLane(0)).toBe(true);
    }
    expect(crossedOpening).toBe(true);
    expect(simulation.arrivals).toBe(1);
    expect(a.current.x[0]).toBeLessThan(simulation.scenario.bounds.minX);
    expect(a.targetId[0]).toBe(1);
  });
  it('routes around an obstructing wall through the bottleneck', () => {
    const navigation = new Navigation(getScenario('bottleneck'));
    expect(navigation.lineOfSight(-30, -30, 85, 0)).toBe(false);
    const direction = { x: 0, z: 0 };
    let x = -30, z = -30;
    for (let step = 0; step < 2200; step++) {
      navigation.direction(x, z, 1, 85, 0, direction);
      const nextX = x + direction.x * 0.1, nextZ = z + direction.z * 0.1;
      expect(navigation.isFree(nextX, nextZ, 0.25)).toBe(true);
      x = nextX; z = nextZ;
      if (Math.hypot(x - 85, z) < 1) break;
    }
    expect(Math.hypot(x - 85, z)).toBeLessThan(1);
  });
  it('does not allow a line to cut through an obstacle corner', () => {
    const navigation = new Navigation(getScenario('plaza'));
    expect(navigation.lineOfSight(-10, -10, 10, 10)).toBe(false);
    expect(navigation.lineOfSight(-20, -20, -20, 20)).toBe(true);
  });
  it('shares one field per destination and all traversable cells can reach each destination', () => {
    for (const id of ['plaza', 'corridor', 'bottleneck', 'crossing'] as const) {
      const scenario = getScenario(id), navigation = new Navigation(scenario);
      expect(navigation.fields.length).toBe(scenario.targets.length);
      for (const field of navigation.fields) for (let cell = 0; cell < navigation.walkable.length; cell++) {
        if (navigation.walkable[cell]) expect(Number.isFinite(field.costs[cell])).toBe(true);
      }
    }
  });
});
