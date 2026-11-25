import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Obstacle, type PedestrianPortal, type Scenario } from '../types';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { DoorwayCourtesy } from '../simulation/DoorwayCourtesy';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import { SpatialGrid } from '../simulation/SpatialGrid';

const door: PedestrianPortal = {
  id: 'shop', kind: 'door', approach: { x: 0, z: 4 }, end: { x: 0, z: 0 }, width: 1,
};

function encounter(emerging = 0, obstacles: Obstacle[] = [], count = 2) {
  const scene: Scenario = {
    id: 'plaza', name: 'Shop entrance', description: '', obstacles,
    bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
    targets: [door.approach], spawnZones: [{ x: 0, z: 4, width: 2, depth: 2 }],
  };
  const a = new AgentData(count), outside = 1 - emerging;
  const grid = new SpatialGrid(scene.bounds, count);
  const courtesy = new DoorwayCourtesy(a, new Navigation(scene), grid, [door]);
  a.radius.fill(0.25); a.preferredSpeed.fill(1.35);
  a.current.z[emerging] = 1.1; a.current.vz[emerging] = 1;
  a.current.x[outside] = 0.18; a.current.z[outside] = 2.7;
  a.current.vz[outside] = -1; a.current.heading[outside] = Math.PI;
  function review(time: number) {
    grid.rebuild(a.current.x, a.current.z, count);
    courtesy.update(time);
  }
  return { a, emerging, outside, review, courtesy };
}

describe('visible right of way at a doorway', () => {
  it.each([0, 1])('steps aside for the person visibly emerging, in slot %i', slot => {
    const { a, emerging, outside, review, courtesy } = encounter(slot);
    // Their assigned goal and preferred velocity currently point back into the shop.
    // The observable movement out through the opening is what the other person sees.
    a.targetZ[emerging] = -5; a.preferredVZ[emerging] = -1.35;
    review(0);
    expect(courtesy.yielding(emerging)).toBe(false);
    expect(courtesy.yielding(outside)).toBe(true);
    const direction = { x: 0, z: 0 };
    courtesy.guide(outside, direction);
    expect(direction.x).toBeGreaterThan(0);

    a.current.z[emerging] = 3.6;
    review(0.7);
    expect(courtesy.yielding(outside)).toBe(false);
  });

  it('uses the facing direction of stopped walkers and ignores a peer behind them', () => {
    const { a, outside, review, courtesy } = encounter();
    a.current.vz.fill(0);
    a.current.heading[outside] = 0;
    review(0);
    expect(courtesy.yielding(outside)).toBe(false);
    a.current.heading[outside] = Math.PI;
    review(0.4);
    expect(courtesy.yielding(outside)).toBe(true);
  });

  it('never makes a pair wait for each other when their order at the entrance changes', () => {
    const { a, review, courtesy } = encounter();
    // The walkers approach from opposite sides along the facade.
    a.current.x.set([-0.65, 0.65]); a.current.z.set([3.12, 3]);
    a.current.vx.set([1, -1]); a.current.vz.fill(0);
    a.current.heading.set([Math.PI / 2, -Math.PI / 2]);
    review(0);
    expect(courtesy.yielding(0)).toBe(true);
    expect(courtesy.yielding(1)).toBe(false);

    // The first walker edges closer to the opening during the held encounter.
    a.current.x.set([-0.46, 0.45]); a.current.z.set([2.94, 3.16]);
    review(0.4);
    expect(courtesy.yielding(0)).toBe(false);
    expect(courtesy.yielding(1)).toBe(true);
  });

  it('does not yield through a wall', () => {
    const wall: Obstacle = { x: 0, z: 1.9, width: 3, depth: 0.2, height: 2, kind: 'building' };
    const { outside, review, courtesy } = encounter(0, [wall]);
    review(0);
    expect(courtesy.yielding(outside)).toBe(false);
  });

  it('reacts once an intervening walker moves out of the line of sight', () => {
    const { a, outside, review, courtesy } = encounter(0, [], 3);
    a.current.x[2] = 0.09; a.current.z[2] = 1.9;
    a.current.heading[2] = -Math.PI / 2; a.current.vx[2] = -1;
    review(0);
    expect(courtesy.yielding(outside)).toBe(false);
    a.current.x[2] = -2;
    review(0.4);
    expect(courtesy.yielding(outside)).toBe(true);
  });

  it.each([0, 1])('clears the encounter immediately when slot %i becomes a new person', replaced => {
    const { a, outside, review, courtesy } = encounter();
    review(0);
    expect(courtesy.yielding(outside)).toBe(true);
    a.generation[replaced]++;
    expect(courtesy.yielding(outside)).toBe(false);
  });

  it('uses the opposite side when a visible bystander occupies the preferred step across a grid boundary', () => {
    const { a, outside, review, courtesy } = encounter(0, [], 3);
    a.current.x.set([0.5, 0.68, 1.7]);
    a.current.z[2] = 2.62;
    // The preferred step is at x=1.45 and the next spatial cell starts at x=1.6.
    review(0);
    expect(courtesy.yielding(outside)).toBe(true);
    const direction = { x: 0, z: 0 };
    courtesy.guide(outside, direction);
    expect(direction.x).toBeLessThan(0);
  });

  it('pauses briefly when neither side is walkable, then releases the hold', () => {
    const walls: Obstacle[] = [-0.65, 0.65].map(x => ({
      x, z: 2, width: 0.15, depth: 5, height: 2, kind: 'building',
    }));
    const { outside, review, courtesy } = encounter(0, walls);
    review(0);
    expect(courtesy.yielding(outside)).toBe(true);
    const direction = { x: 1, z: 1 };
    courtesy.guide(outside, direction);
    expect(direction).toEqual({ x: 0, z: 0 });
    review(2);
    expect(courtesy.yielding(outside)).toBe(false);
  });

  it('applies the sidestep in a normal Shibuya step when local avoidance is enabled', () => {
    const index = shibuya.portals!.findIndex(p => p.id === 'northwest-shop');
    const { approach, end } = shibuya.portals![index];
    const scenario = { ...shibuya, spawnTargets: shibuya.spawnZones.map(() => index) };
    const length = Math.hypot(approach.x - end.x, approach.z - end.z);
    const nx = (approach.x - end.x) / length, nz = (approach.z - end.z) / length;
    function step(avoidanceStrength: number) {
      const sim = new Simulation({ ...DEFAULT_CONFIG, count: 2, seed: 42, signalMode: 'green', avoidanceStrength },
        undefined, scenario);
      const a = sim.agents;
      // Both start on the real sidewalk. One is moving outward along the facade
      // normal, and the other approaches from just to one side of that path.
      for (const [id, depth, side, sign] of [[0, 2.5, 0, 1], [1, 4.1, 0.25, -1]]) {
        a.current.x[id] = end.x + depth * nx + side * nz;
        a.current.z[id] = end.z + depth * nz - side * nx;
        a.current.vx[id] = sign * nx; a.current.vz[id] = sign * nz;
        a.current.heading[id] = Math.atan2(sign * nx, sign * nz);
      }
      sim.step();
      return a.preferredVX[1] * nx + a.preferredVZ[1] * nz;
    }
    expect(step(0)).toBeLessThan(0);
    expect(step(1)).toBeGreaterThan(0);
  });
});
