import { expect, it } from 'vitest';
import type { Point2, Polygon2, Scenario } from '../types';
import { CrossingExits } from '../simulation/CrossingExits';
import { Navigation } from '../simulation/Navigation';
import { SpatialGrid } from '../simulation/SpatialGrid';

function polygon(vertices: [number, number][]): Polygon2 {
  return { rings: [vertices.map(([x, z]) => ({ x, z }))] };
}

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
