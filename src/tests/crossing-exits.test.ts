import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import type { Point2, Polygon2, Scenario } from '../types';
import { CrossingExits } from '../simulation/CrossingExits';
import { Navigation } from '../simulation/Navigation';
import { SpatialGrid } from '../simulation/SpatialGrid';

function polygon(vertices: [number, number][]): Polygon2 {
  return { rings: [vertices.map(([x, z]) => ({ x, z }))] };
}

it('finishes a stalled crossing in one stride when a shoulder is still over the curb', () => {
  const nav = new Navigation(shibuya), exits = new CrossingExits(nav, new SpatialGrid(shibuya.bounds, 1));
  const x = 19.23, z = 16.08, radius = 0.27;
  const landing = { x: 16.375, z: 14.125 }, next = { x: 0, z: 0 };
  expect(nav.scramble!.isSidewalk(x, z)).toBe(true);
  expect(nav.scramble!.isSidewalk(x, z, radius)).toBe(false);
  expect(exits.reselect(x, z, radius, landing.x, landing.z, next)).toBe(true);
  expect(Math.hypot(next.x - x, next.z - z)).toBeLessThan(1);
  expect(nav.lineOfSight(x, z, next.x, next.z, radius)).toBe(true);
  expect(nav.scramble!.isSidewalk(next.x, next.z, radius)).toBe(true);
  // The walker is still in the same spot at the next stalled-progress review.
  const alternate = { x: 0, z: 0 };
  expect(exits.reselect(x, z, radius, next.x, next.z, alternate)).toBe(true);
  expect(Math.hypot(alternate.x - next.x, alternate.z - next.z)).toBeGreaterThan(0.6);
  expect(nav.lineOfSight(x, z, alternate.x, alternate.z, radius)).toBe(true);
  expect(nav.scramble!.isSidewalk(alternate.x, alternate.z, radius)).toBe(true);
});

it('reaches the far sidewalk around a bend that conceals every landing at the first red step', () => {
  const bounds = { minX: -3, minZ: -3, maxX: 12, maxZ: 12 };
  const scenario: Scenario = {
    id: 'shibuya', name: 'Bent crossing', description: '', bounds, obstacles: [], navigationCellSize: 0.5,
    targets: [{ x: -1, z: 0 }, { x: 8, z: 10 }], spawnZones: [{ x: -1, z: 0, width: 1, depth: 1 }],
    urbanMap: {
      schemaVersion: 1, renderBounds: bounds, origin: { latitude: 0, longitude: 0, crs: 'local' },
      walkable: [polygon([[-2,-1],[9,-1],[9,11],[7,11],[7,1],[-2,1]])],
      sidewalks: [polygon([[-2,-1],[0,-1],[0,1],[-2,1]]), polygon([[7,8],[9,8],[9,11],[7,11]])],
      roads: [], buildingFootprints: [], statistics: { buildings: 0, lod1Buildings: 0, lod2Buildings: 0, triangles: 0 },
      mesh: { vertices: '', indices: '', vertexCount: 0, indexCount: 0, vertexSha256: '', indexSha256: '' },
    },
  };
  const nav = new Navigation(scenario), exits = new CrossingExits(nav, new SpatialGrid(bounds, 1));
  const landing: Point2 = { x: 0, z: 0 }, waypoint = { x: 0, z: 0 };
  const radius = 0.25;
  let x = 3, z = 0;
  expect(exits.choose(x, z, radius, 1, 0, -0.75, 0, false, landing, waypoint)).toBe(true);
  expect(landing.z).toBeGreaterThan(8);
  expect(nav.lineOfSight(x, z, landing.x, landing.z, radius)).toBe(false);
  for (let leg = 0; leg < 6; leg++) {
    expect(nav.lineOfSight(x, z, waypoint.x, waypoint.z, radius)).toBe(true);
    x = waypoint.x; z = waypoint.z;
    if (x === landing.x && z === landing.z) break;
    expect(exits.waypoint(x, z, radius, landing.x, landing.z, waypoint)).toBe(true);
  }
  expect({ x, z }).toEqual(landing);
  expect(nav.scramble!.isSidewalk(x, z, radius)).toBe(true);
});
