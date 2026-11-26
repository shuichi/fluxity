import { describe, expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { Navigation } from '../simulation/Navigation';
import { SidewalkPassing } from '../simulation/SidewalkPassing';
import { SpatialGrid } from '../simulation/SpatialGrid';

function rectangle(minX: number, maxX: number, minZ: number, maxZ: number) {
  return [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
}

function sidewalkEncounter(wall = false) {
  const bounds = { minX: -12, maxX: 12, minZ: -4, maxZ: 4 };
  const rings = [rectangle(-12, 12, -4, 4)];
  if (wall) rings.push(rectangle(0.7, 1, -1.2, 1.2));
  const surface = [{ rings }];
  const nav = new Navigation({ ...shibuya, bounds, obstacles: [], navigationCellSize: 0.5,
    urbanMap: { ...shibuya.urbanMap!, walkable: surface, sidewalks: surface },
    targets: [{ x: 8, z: 0 }], targetTransitions: undefined, spawnTargets: undefined,
    spawnZones: [{ x: -8, z: 0, width: 1, depth: 1 }] });
  const a = new AgentData(3), g = new SpatialGrid(bounds, a.count);
  a.radius.fill(0.25); a.targetX.fill(8);
  a.current.x.set([0.1, 1.35, 2.1]); a.current.vx.set([1, -1, -1]);
  g.rebuild(a.current.x, a.current.z, a.count);
  const passing = new SidewalkPassing(nav, g, a);
  const route = { x: 1, z: 0 };
  return { a, nav, passing, route };
}

describe('passing a slow or opposing stream on a sidewalk', () => {
  it('starts a walkable sidestep before contact and releases it when the encounter ends', () => {
    const { a, nav, passing, route } = sidewalkEncounter();
    passing.guide(0, 0, route);
    expect(route.x).toBeGreaterThan(0);
    expect(Math.abs(route.z)).toBeGreaterThan(0.3);
    expect(nav.urban!.sidewalks.lineInside(0.1, 0, 0.1 + route.x * 1.6, route.z * 1.6, 0.265)).toBe(true);
    passing.reset(0);
    route.x = 1; route.z = 0;
    passing.guide(0, 1, route);
    expect(route).toEqual({ x: 1, z: 0 });
    a.current.vx.fill(1);
    passing.guide(0, 15, route);
    expect(route).toEqual({ x: 1, z: 0 });
  });

  it('keeps the route when the approaching people are behind a wall', () => {
    const { passing, route } = sidewalkEncounter(true);
    passing.guide(0, 0, route);
    expect(route).toEqual({ x: 1, z: 0 });
  });
});
