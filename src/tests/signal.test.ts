import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SNAPSHOT_STRIDE } from '../types';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import type { SignalMode } from '../types';

function pedestrian(mode: SignalMode, z = -19): Simulation {
  const simulation = new Simulation({ ...DEFAULT_CONFIG, scenario: 'shibuya', count: 1, signalMode: mode }, undefined, syntheticShibuya);
  const a = simulation.agents;
  a.current.x[0] = -27; a.current.z[0] = z;
  a.current.vx[0] = 0; a.current.vz[0] = 1.35;
  a.current.heading[0] = 0;
  a.targetId[0] = 2; a.targetX[0] = -27; a.targetZ[0] = 52;
  return simulation;
}

describe('scramble pedestrian signal', () => {
  it('stops new road entry through flashing green and red and releases the queue on green', () => {
    const simulation = pedestrian('pedestrian'), a = simulation.agents;
    simulation.updateSettings({ signalMode: 'allRed' });
    expect(simulation.signal?.pedestrian).toBe('flashingGreen');
    for (let i = 0; i < 450; i++) {
      simulation.step();
      expect(simulation.navigation.scramble!.isSidewalk(a.current.x[0], a.current.z[0], a.radius[0])).toBe(true);
    }
    expect(simulation.signal?.pedestrian).toBe('red');
    expect(simulation.signal?.waiting).toBe(1);
    expect(simulation.signal?.crossing).toBe(0);
    expect(Math.hypot(a.current.vx[0], a.current.vz[0])).toBeLessThan(0.04);
    const stoppedZ = a.current.z[0];
    simulation.updateSettings({ signalMode: 'pedestrian' });
    expect(simulation.signal?.pedestrian).toBe('green');
    expect(simulation.signal?.waiting).toBe(0);
    for (let i = 0; i < 60; i++) simulation.step();
    expect(a.current.z[0]).toBeGreaterThan(stoppedZ + 1);
    expect(simulation.signal?.crossing).toBe(1);
  });
  it('returns a slow recent entrant to the nearer curb as soon as green flashes', () => {
    const simulation = pedestrian('pedestrian', -8), a = simulation.agents;
    simulation.updateSettings({ walkingSpeed: 1 });
    simulation.step();
    expect(simulation.signal?.crossing).toBe(1);
    simulation.updateSettings({ signalMode: 'eastWest' });
    const initialZ = a.current.z[0];
    for (let i = 0; i < 90; i++) simulation.step();
    expect(simulation.signal?.pedestrian).toBe('flashingGreen');
    expect(a.current.z[0]).toBeLessThan(initialZ - 1);
    expect(simulation.signal?.eastWest).toBe('red');
    for (let i = 0; i < 450; i++) {
      simulation.step();
      expect(simulation.navigation.isFree(a.current.x[0], a.current.z[0], a.radius[0])).toBe(true);
    }
    expect(simulation.signal?.eastWest).toBe('green');
    expect(a.current.z[0]).toBeLessThan(-18);
    expect(simulation.signal?.crossing).toBe(0);
  });
  it('gives a displaced Shibuya crosser a route to the curb on flashing green outside the painted route', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1, signalMode: 'pedestrian' });
    simulation.updateSettings({ signalMode: 'allRed' });
    const a = simulation.agents, geometry = simulation.navigation.urban!;
    // Observed on the southwest approach in the 5,000-person seed-42 run.
    a.current.x[0] = -22.4514904; a.current.z[0] = 20.2842464;
    a.current.vx[0] = a.current.vz[0] = 0;
    a.radius[0] = 0.2733424;
    a.targetId[0] = 58; a.targetX[0] = -39.53966; a.targetZ[0] = 45.93388;
    const radius = a.radius[0] + 0.015;
    expect(geometry.isWalkable(a.current.x[0], a.current.z[0], radius)).toBe(false);
    simulation.step();
    expect(Math.hypot(a.preferredVX[0], a.preferredVZ[0])).toBeCloseTo(1.25 * a.preferredSpeed[0]);
    for (let i = 0; i < 300 && simulation.signal!.crossing; i++) simulation.step();
    expect(geometry.isSidewalk(a.current.x[0], a.current.z[0], radius)).toBe(true);
  });
  it('lets a waiting pedestrian yield while another pedestrian clears the curb', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 2, signalMode: 'allRed' }, undefined, syntheticShibuya);
    const a = simulation.agents;
    a.current.x.fill(-27); a.current.z.set([17.6, 18.5]);
    a.current.vx.fill(0); a.current.vz.set([1.3, 0]);
    a.targetId.set([2, 0]); a.targetX.fill(-27); a.targetZ.set([52, -52]);
    for (let step = 0; step < 240; step++) {
      simulation.step();
      expect(simulation.navigation.scramble!.isSidewalk(a.current.x[1], a.current.z[1], a.radius[1])).toBe(true);
    }
    expect(a.current.z[0]).toBeGreaterThan(23);
    expect(simulation.signal?.crossing).toBe(0);
    expect(simulation.signal?.waiting).toBe(1);
  });
  it('is deterministic across signal cycles and has no red incursions in a dense queue', () => {
    const first = new Simulation({ ...DEFAULT_CONFIG, count: 240, signalMode: 'allRed' }, undefined, syntheticShibuya);
    const second = new Simulation({ ...DEFAULT_CONFIG, count: 240, signalMode: 'allRed' }, undefined, syntheticShibuya);
    for (let step = 0; step < 300; step++) { first.step(); second.step(); }
    const left = new Float32Array(first.agents.count * SNAPSHOT_STRIDE), right = new Float32Array(left.length);
    first.writeSnapshot(left); second.writeSnapshot(right);
    expect(left).toEqual(right);
    for (let i = 0; i < first.agents.count; i++) {
      expect(first.navigation.scramble!.isSidewalk(first.agents.current.x[i], first.agents.current.z[i], first.agents.radius[i])).toBe(true);
    }
    expect(first.signal?.waiting).toBeGreaterThan(0);
  });
});

describe('shared scramble navigation geometry', () => {
  it('preserves forward motion when avoidance pushes a pedestrian against a zebra edge', () => {
    const geometry = new Navigation(syntheticShibuya).scramble!;
    const result = { x: 0, z: 0 };
    geometry.constrain(-22.26, 0, -22.20, 0.06, 0.25, false, result);
    expect(geometry.isWalkable(result.x, result.z, 0.25)).toBe(true);
    expect(result.x).toBeCloseTo(-22.25);
    expect(result.z).toBeCloseTo(0.06);
    geometry.constrain(-27, -18.26, -26.94, -18.20, 0.25, true, result);
    expect(geometry.isSidewalk(result.x, result.z, 0.25)).toBe(true);
    expect(result.x).toBeCloseTo(-26.94);
    expect(result.z).toBeCloseTo(-18.25);
  });
  it('admits only sidewalks and the five zebra corridors, including the diagonal', () => {
    const navigation = new Navigation(syntheticShibuya);
    expect(navigation.isFree(0, 70)).toBe(false);
    expect(navigation.isFree(70, 0)).toBe(false);
    expect(navigation.isFree(-27, 0)).toBe(true);
    expect(navigation.isFree(0, -27)).toBe(true);
    expect(navigation.isFree(0, 0)).toBe(true);
    expect(navigation.lineOfSight(-27, 27, 27, -27)).toBe(true);
    expect(navigation.lineOfSight(-27, -27, 27, 27)).toBe(false);
    for (const field of navigation.fields) for (let cell = 0; cell < navigation.walkable.length; cell++) {
      if (navigation.walkable[cell]) expect(Number.isFinite(field.costs[cell])).toBe(true);
    }
  });
  it('routes between opposite corners without walking outside painted road crossings', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1, signalMode: 'pedestrian' }, undefined, syntheticShibuya);
    const a = simulation.agents;
    a.current.x[0] = -27; a.current.z[0] = -27; a.current.vx[0] = 0; a.current.vz[0] = 0;
    a.targetId[0] = 3; a.targetX[0] = 52; a.targetZ[0] = 52;
    for (let step = 0; step < 5000 && simulation.arrivals === 0; step++) {
      simulation.step();
      expect(simulation.navigation.isFree(a.current.x[0], a.current.z[0], a.radius[0])).toBe(true);
    }
    expect(simulation.arrivals).toBe(1);
  });
  it('keeps 20,000 initialized pedestrians on sidewalks and constrains large green flows', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 20000, signalMode: 'allRed' }, undefined, syntheticShibuya);
    const a = simulation.agents, geometry = simulation.navigation.scramble!;
    for (let i = 0; i < a.count; i++) expect(geometry.isSidewalk(a.current.x[i], a.current.z[i], a.radius[i])).toBe(true);
    for (let step = 0; step < 8; step++) simulation.step();
    expect(simulation.signal?.crossing).toBe(0);
    simulation.updateSettings({ signalMode: 'pedestrian' });
    for (let step = 0; step < 45; step++) simulation.step();
    for (let i = 0; i < a.count; i++) {
      expect(simulation.navigation.isFree(a.current.x[i], a.current.z[i], a.radius[i])).toBe(true);
      expect(Number.isFinite(a.current.x[i] + a.current.z[i])).toBe(true);
      expect(Math.hypot(a.current.vx[i], a.current.vz[i])).toBeLessThanOrEqual(a.preferredSpeed[i] * 1.12 + 0.01);
    }
  }, 20000);
});
