import { describe, expect, it } from 'vitest';
import { CrossingClearance } from '../simulation/CrossingClearance';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { SIGNAL_GREEN_SECONDS, SIGNAL_RED_SECONDS } from '../simulation/TrafficSignal';
import { DEFAULT_CONFIG, FIXED_DT } from '../types';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';

function northbound(count = 1): Simulation {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count, signalMode: 'green' }, undefined, syntheticShibuya);
  const a = sim.agents;
  a.current.x[0] = -27; a.current.z[0] = -19;
  a.current.vx[0] = 0; a.current.vz[0] = a.preferredSpeed[0];
  a.current.heading[0] = 0;
  a.targetId[0] = 2; a.targetX[0] = -27; a.targetZ[0] = 52;
  return sim;
}

function approachOnGreen(sim: Simulation, z: number): void {
  for (let step = 0; step < 1500 && sim.agents.current.z[0] < z; step++) sim.step();
  expect(sim.agents.current.z[0]).toBeGreaterThanOrEqual(z);
  expect(sim.signal!.crossing).toBe(1);
}

function onSidewalk(sim: Simulation, id = 0): boolean {
  const a = sim.agents;
  return sim.navigation.scramble!.isSidewalk(a.current.x[id], a.current.z[id], a.radius[id] + 0.015);
}

describe('crossing clearance after the light turns red', () => {
  it('returns a recent entrant to the original curb, holds them there, and resumes their trip on green', () => {
    const sim = northbound(), a = sim.agents;
    approachOnGreen(sim, -17.65);
    sim.updateSettings({ signalMode: 'red' });
    for (let step = 0; step < 120 && !onSidewalk(sim); step++) {
      sim.step();
      expect(sim.signal!.crossing).toBe(Number(!onSidewalk(sim)));
    }
    expect(onSidewalk(sim)).toBe(true);
    expect(a.current.z[0]).toBeLessThan(-18);
    for (let step = 0; step < 120; step++) {
      sim.step();
      expect(onSidewalk(sim)).toBe(true);
    }
    expect(a.targetId[0]).toBe(2);
    expect(sim.arrivals).toBe(0);
    sim.updateSettings({ signalMode: 'green' });
    approachOnGreen(sim, -16);
  });

  it('finishes a decision to return even if green resumes mid-turn', () => {
    const sim = northbound();
    approachOnGreen(sim, -17.65);
    sim.updateSettings({ signalMode: 'red' });
    for (let step = 0; step < 60 && sim.agents.current.vz[0] >= 0; step++) sim.step();
    expect(sim.agents.current.vz[0]).toBeLessThan(0);
    expect(onSidewalk(sim)).toBe(false);
    sim.updateSettings({ signalMode: 'green' });
    for (let step = 0; step < 100 && !onSidewalk(sim); step++) sim.step();
    expect(onSidewalk(sim)).toBe(true);
    expect(sim.agents.current.z[0]).toBeLessThan(-18);
    approachOnGreen(sim, -16);
  });

  it('returns a recent entrant at the automatic green-to-red boundary', () => {
    const sim = northbound(), a = sim.agents;
    sim.updateSettings({ signalMode: 'auto', walkingSpeed: 0 });
    a.current.vz[0] = 0;
    const cycleSteps = Math.round((SIGNAL_RED_SECONDS + SIGNAL_GREEN_SECONDS) / FIXED_DT);
    for (let step = 0; step < cycleSteps - 30; step++) sim.step();
    sim.updateSettings({ walkingSpeed: 1.35 });
    for (let step = 0; step < 29; step++) sim.step();
    expect(sim.signal!.phase).toBe('green');
    expect(sim.signal!.crossing).toBe(1);
    sim.step();
    expect(sim.signal!.phase).toBe('red');
    for (let step = 0; step < 120 && !onSidewalk(sim); step++) sim.step();
    expect(onSidewalk(sim)).toBe(true);
    expect(a.current.z[0]).toBeLessThan(-18);
  });

  it('accelerates gradually in the open middle and returns to walking on the far sidewalk', () => {
    const sim = northbound(), a = sim.agents;
    approachOnGreen(sim, -2);
    const walking = a.preferredSpeed[0];
    sim.updateSettings({ signalMode: 'red' });
    let previousSpeed = Math.hypot(a.current.vx[0], a.current.vz[0]), topSpeed = previousSpeed;
    for (let step = 0; step < 600 && !onSidewalk(sim); step++) {
      sim.step();
      const speed = Math.hypot(a.current.vx[0], a.current.vz[0]);
      expect(speed - previousSpeed).toBeLessThanOrEqual(3.8 * FIXED_DT + 0.001);
      topSpeed = Math.max(topSpeed, speed);
      previousSpeed = speed;
    }
    expect(topSpeed).toBeGreaterThan(1.25 * walking);
    expect(onSidewalk(sim)).toBe(true);
    expect(a.current.z[0]).toBeGreaterThan(18);
    for (let step = 0; step < 60; step++) sim.step();
    expect(Math.hypot(a.current.vx[0], a.current.vz[0])).toBeLessThanOrEqual(1.12 * walking + 0.001);
    expect(a.preferredSpeed[0]).toBe(walking);
  });

  it('keeps a stationary pedestrian stationary when walking speed is set to zero', () => {
    const sim = northbound(), a = sim.agents;
    approachOnGreen(sim, -2);
    sim.updateSettings({ walkingSpeed: 0, signalMode: 'red' });
    for (let step = 0; step < 60; step++) sim.step();
    const x = a.current.x[0], z = a.current.z[0];
    for (let step = 0; step < 60; step++) sim.step();
    expect(a.current.x[0]).toBe(x);
    expect(a.current.z[0]).toBe(z);
    expect(sim.signal!.crossing).toBe(1);
  });

  it('continues to the far sidewalk when red starts one step from the exit', () => {
    const sim = northbound();
    approachOnGreen(sim, 17.8);
    sim.updateSettings({ signalMode: 'red' });
    for (let step = 0; step < 60 && !onSidewalk(sim); step++) sim.step();
    expect(onSidewalk(sim)).toBe(true);
    expect(sim.agents.current.z[0]).toBeGreaterThan(18);
    expect(sim.signal!.crossing).toBe(0);
  });

  it('keeps a landing while making progress but changes it if only lateral motion is possible', () => {
    const nav = new Navigation(syntheticShibuya), grid = new SpatialGrid(syntheticShibuya.bounds, 1);
    const clearance = new CrossingClearance(nav, grid, 1);
    const x = new Float32Array([-27]), z = new Float32Array([0]);
    const direction = { x: 0, z: 1 }, radius = 0.27;
    const guide = () => {
      grid.rebuild(x, z, 1);
      clearance.guide(0, x[0], z[0], radius, FIXED_DT, 1.35, direction);
    };
    clearance.observeStep(0, -27, -18.3, radius, false);
    guide();
    const firstX = clearance.landingX[0], firstZ = clearance.landingZ[0];
    expect(firstX).toBeLessThan(-18);
    expect(firstZ).toBeGreaterThan(18);
    for (let step = 0; step < 90; step++) {
      z[0] += 1.35 * FIXED_DT;
      guide();
      expect(clearance.landingX[0]).toBe(firstX);
      expect(clearance.landingZ[0]).toBe(firstZ);
    }

    // Walk back and forth across the crossing, without getting any nearer the far curb.
    let changed = false;
    for (let step = 0; step < 180 && !changed; step++) {
      x[0] = -27 + 0.6 * Math.sin(step * FIXED_DT * 2);
      guide();
      changed = clearance.landingX[0] !== firstX || clearance.landingZ[0] !== firstZ;
    }
    const nextX = clearance.landingX[0], nextZ = clearance.landingZ[0];
    expect(changed).toBe(true);
    expect(nextX).toBeLessThan(-18);
    expect(nextZ).toBeGreaterThan(18);
    expect(nav.scramble!.isSidewalk(nextX, nextZ, radius)).toBe(true);
    expect(nav.lineOfSight(x[0], z[0], nextX, nextZ, radius)).toBe(true);
  });

  it('lets an exit queue make space for the crosser while staying on its own sidewalk', () => {
    const sim = northbound(6), a = sim.agents;
    a.current.z[0] = 15;
    for (let id = 1; id < a.count; id++) {
      a.current.x[id] = -27 + (id - 3) * 0.72; a.current.z[id] = 18.5;
      a.current.vx[id] = a.current.vz[id] = 0;
      a.targetId[id] = 0; a.targetX[id] = a.current.x[id]; a.targetZ[id] = -52;
    }
    const initialX = a.current.x.slice();
    sim.updateSettings({ signalMode: 'red' });
    let madeSpace = false;
    for (let step = 0; step < 240; step++) {
      sim.step();
      for (let id = 1; id < a.count; id++) {
        expect(onSidewalk(sim, id)).toBe(true);
        if (Math.abs(a.current.x[id] - initialX[id]) > 0.2 || a.current.z[id] > 18.7) madeSpace = true;
      }
    }
    expect(madeSpace).toBe(true);
    expect(a.current.z[0]).toBeGreaterThan(19);
    expect(sim.signal!.crossing).toBe(0);
  });
});
