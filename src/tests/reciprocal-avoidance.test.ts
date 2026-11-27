import { describe, expect, it } from 'vitest';
import { AgentData } from '../simulation/AgentData';
import { EncounterState } from '../simulation/EncounterState';
import { collisionTime, PEDESTRIAN_ACCELERATION, ReciprocalAvoidance } from '../simulation/ReciprocalAvoidance';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { Steering } from '../simulation/Steering';
import { DEFAULT_CONFIG, FIXED_DT, type Scenario } from '../types';

const path: Scenario = {
  id: 'corridor', name: 'Open path', description: '', bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 },
  obstacles: [], spawnZones: [], targets: [],
};

function encounter(speeds: [number, number], separation: number, stationary = new Uint8Array(2)) {
  const agents = new AgentData(2), e = new EncounterState(2, 42), grid = new SpatialGrid(path.bounds, 2);
  agents.radius.fill(0.25);
  agents.current.x.set([0, separation]); agents.current.vx.set(speeds);
  agents.preferredSpeed.set(speeds.map(Math.abs));
  const steering = new Steering(path, undefined, undefined, e);
  function tick() {
    const { current, next } = agents;
    grid.rebuild(current.x, current.z, 2);
    for (let id = 0; id < 2; id++) {
      const v = { x: 0, z: 0 };
      if (!stationary[id]) {
        e.advance(id, FIXED_DT);
        steering.compute(id, agents, grid, { x: Math.sign(speeds[id]), z: 0 }, DEFAULT_CONFIG, v, 1, false,
          { reciprocal: true, stationary });
        expect(steering.resolvedNextVelocity).toBe(true);
        expect(Math.hypot(v.x - current.vx[id], v.z - current.vz[id])).toBeLessThanOrEqual(PEDESTRIAN_ACCELERATION * FIXED_DT + 1e-6);
      }
      next.vx[id] = v.x; next.vz[id] = v.z;
      next.x[id] = current.x[id] + v.x * FIXED_DT; next.z[id] = current.z[id] + v.z * FIXED_DT;
    }
    agents.swap();
    return Math.hypot(agents.current.x[0] - agents.current.x[1], agents.current.z[0] - agents.current.z[1]);
  }
  return { agents, tick, e, grid, steering };
}

describe('finite-horizon pedestrian avoidance', () => {
  it('locates first body contact within the horizon, including a tangential encounter and overlap at rest', () => {
    expect(collisionTime(3, 0, 2, 0, 0.5, 2)).toBeCloseTo(1.25);
    expect(collisionTime(3, 0, 2, 0, 0.5, 1)).toBe(Infinity);
    expect(collisionTime(3, 0.5, 2, 0, 0.5, 2)).toBeCloseTo(1.5);
    expect(collisionTime(3, 0, -2, 0, 0.5, 8)).toBe(Infinity);
    expect(collisionTime(0.1, 0, 0, 0, 0.5, 1)).toBe(0);
  });

  it('shares a head-on correction, keeps the same passing side, and clears both bodies', () => {
    const { tick, agents } = encounter([1.35, -1.35], 4);
    let minimum = 4;
    for (let i = 0; i < 90; i++) {
      minimum = Math.min(minimum, tick());
      if (i === 10) {
        expect(agents.current.z[0]).toBeLessThan(-0.01);
        expect(agents.current.z[1]).toBeGreaterThan(0.01);
      }
    }
    expect(minimum).toBeGreaterThan(0.50);
    expect(agents.current.x[0]).toBeGreaterThan(agents.current.x[1]);
  });

  it('anticipates a runner passing a stationary photographer before the baseline search radius', () => {
    const { agents, tick, e, grid } = encounter([3, 0], 3.8, new Uint8Array([0, 1]));
    tick();
    expect(agents.current.x[1] - agents.current.x[0]).toBeGreaterThan(grid.cellSize);
    expect(e.gazeTarget[0]).toBe(1);
    let minimum = 3.8;
    for (let i = 0; i < 90; i++) minimum = Math.min(minimum, tick());
    expect(minimum).toBeGreaterThan(0.50);
    expect(agents.current.x[0]).toBeGreaterThan(6);
    expect(agents.current.x[1]).toBeCloseTo(3.8); expect(agents.current.z[1]).toBe(0);
  });

  it('lets a runner overtake a slower walker while both keep moving down the street', () => {
    const { agents, tick, e } = encounter([3.05, 1.05], 3.2);
    tick();
    expect(e.gazeTarget[0]).toBe(1);
    let minimum = 3.2;
    for (let i = 0; i < 100; i++) minimum = Math.min(minimum, tick());
    expect(minimum).toBeGreaterThan(0.50);
    expect(agents.current.x[0]).toBeGreaterThan(agents.current.x[1] + 1);
    expect(agents.current.x[1]).toBeGreaterThan(5);
  });

  it('assigns the whole correction to the walker when the other person is stationary', () => {
    const { agents } = encounter([1.2, 0], 2), solver = new ReciprocalAvoidance();
    const lateral = (fixed: number) => {
      solver.reset(); solver.consider(1, 2, 1.25, 2);
      const out = { x: 0, z: 0 };
      solver.solve(0, agents, 1.2, 0, 1.8, 0.1, 2, 0, new Uint8Array([0, fixed]), 1, out);
      return Math.abs(out.z);
    };
    expect(lateral(1)).toBeCloseTo(2 * lateral(0), 5);
  });

  it('lets the reachable solution control braking without applying a held legacy yield twice', () => {
    const go = encounter([1.35, -1.35], 3.4), yielding = encounter([1.35, -1.35], 3.4);
    for (const run of [go, yielding]) {
      run.agents.current.z[1] = 0.48;
      run.e.reconsiderIn[0] = 1;
      run.e.hold(0);
    }
    yielding.e.yielding[0] = 1;
    go.tick(); yielding.tick();
    expect(yielding.e.gazeTarget[0]).toBe(1);
    expect(yielding.agents.current.vx[0]).toBe(go.agents.current.vx[0]);
    expect(yielding.agents.current.vz[0]).toBe(go.agents.current.vz[0]);
  });

  it('keeps infeasible corrections deterministic and attainable while the speed limit falls', () => {
    const agents = new AgentData(3), solver = new ReciprocalAvoidance();
    agents.current.x.set([0, 0.15, -0.15]); agents.current.vx[0] = 2; agents.radius.fill(0.25);
    const run = () => {
      solver.reset(); solver.consider(1, 0.15, 0, 1); solver.consider(2, 0.15, 0, 1);
      const out = { x: 0, z: 0 };
      solver.solve(0, agents, 0, 0, 0, FIXED_DT, 1.5, 0, undefined, 1, out);
      return out;
    };
    const v = run();
    expect(run()).toEqual(v);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(2 - PEDESTRIAN_ACCELERATION * FIXED_DT, 5);
    expect(Math.hypot(v.x - 2, v.z)).toBeCloseTo(PEDESTRIAN_ACCELERATION * FIXED_DT, 5);
  });
});
