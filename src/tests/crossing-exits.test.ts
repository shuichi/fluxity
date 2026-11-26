import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import type { Point2, Polygon2, Scenario } from '../types';
import { CrossingExits } from '../simulation/CrossingExits';
import { Navigation } from '../simulation/Navigation';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { PolygonRegion } from '../simulation/UrbanGeometry';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';

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

it('follows a bend when the only reachable sidewalk is hidden at the first red step', () => {
  const bounds = { minX: -3, minZ: -3, maxX: 12, maxZ: 12 };
  const scenario: Scenario = {
    id: 'shibuya', name: 'Bent crossing', description: '', bounds, obstacles: [], navigationCellSize: 0.5,
    targets: [{ x: -1, z: 0 }, { x: 8, z: 10 }], spawnZones: [{ x: -1, z: 0, width: 1, depth: 1 }],
    urbanMap: {
      schemaVersion: 1, renderBounds: bounds, origin: { latitude: 0, longitude: 0, crs: 'local' },
      walkable: [polygon([[-2,-1],[9,-1],[9,11],[7,11],[7,1],[-2,1]])],
      sidewalks: [polygon([[7,8],[9,8],[9,11],[7,11]])],
      roads: [], buildingFootprints: [], statistics: { buildings: 0, lod1Buildings: 0, lod2Buildings: 0, triangles: 0 },
      mesh: { vertices: '', indices: '', vertexCount: 0, indexCount: 0, vertexSha256: '', indexSha256: '' },
    },
  };
  const nav = new Navigation(scenario), exits = new CrossingExits(nav, new SpatialGrid(bounds, 1));
  const landing: Point2 = { x: 0, z: 0 }, waypoint = { x: 0, z: 0 };
  const radius = 0.25;
  let x = 3, z = 0;
  expect(exits.choose(x, z, radius, landing, waypoint)).toBe(true);
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

it('picks the nearer bank on a diagonal even a few centimeters from the midpoint', () => {
  const nav = new Navigation(syntheticShibuya), grid = new SpatialGrid(syntheticShibuya.bounds, 1);
  const exits = new CrossingExits(nav, grid), landing = { x: 0, z: 0 }, waypoint = { x: 0, z: 0 };
  for (const sign of [-1, 1]) {
    // A dense queue on the near bank must never send someone to the opposite bank.
    grid.counts.fill(0);
    grid.counts[grid.cellAt(18.28 * sign, -18.28 * sign)] = 100;
    expect(exits.choose(0.035 * sign, -0.035 * sign, 0.27, landing, waypoint)).toBe(true);
    expect(landing.x * sign).toBeGreaterThan(18);
    expect(landing.z * sign).toBeLessThan(-18);
    expect(waypoint).toEqual(landing);
  }
});

it("uses the closest adjacent curb on Shibuya's shared diagonal and straight crossing approach", () => {
  const nav = new Navigation(shibuya), exits = new CrossingExits(nav, new SpatialGrid(shibuya.bounds, 1));
  const x = 19.23, z = 16.08, radius = 0.27, landing = { x: 0, z: 0 }, waypoint = { x: 0, z: 0 };
  expect(exits.choose(x, z, radius, landing, waypoint)).toBe(true);
  expect(nav.scramble!.isSidewalk(landing.x, landing.z, radius)).toBe(true);
  expect(Math.hypot(landing.x - x, landing.z - z)).toBeLessThan(0.3);
});

it('lets a stalled walker use the open part of the same Shibuya bank past a packed corner', () => {
  const nav = new Navigation(shibuya), grid = new SpatialGrid(shibuya.bounds, 1);
  const exits = new CrossingExits(nav, grid), first = { x: 0, z: 0 }, alternate = { x: 0, z: 0 };
  const x = -18.9, z = 17.28, radius = 0.27;
  expect(exits.choose(x, z, radius, first, alternate)).toBe(true);
  const bank = shibuya.urbanMap!.sidewalks.map(p => new PolygonRegion([p])).find(p => p.contains(first.x, first.z, radius))!;
  for (let cz = 10; cz < 21; cz += 0.3) for (let cx = -22; cx < -18; cx += 0.3) {
    grid.counts[grid.cellAt(cx, cz)] = 85;
  }
  expect(exits.reselect(x, z, radius, first.x, first.z, alternate)).toBe(true);
  expect(bank.contains(alternate.x, alternate.z, radius)).toBe(true);
  expect(nav.lineOfSight(x, z, alternate.x, alternate.z, radius)).toBe(true);
  expect(grid.counts[grid.cellAt(alternate.x, alternate.z)]).toBe(0);
});

it('finds the near bank around an obstructed mouth after being pushed outside the Shibuya markings', () => {
  const nav = new Navigation(shibuya), exits = new CrossingExits(nav, new SpatialGrid(shibuya.bounds, 1));
  const x = -23.339244842529297, z = 20.530488967895508, radius = 0.24680432617664338;
  const old = { x: -22.82927131652832, z: 18.863954544067383 }, landing = { x: 0, z: 0 }, waypoint = { x: 0, z: 0 };
  const bank = shibuya.urbanMap!.sidewalks.map(p => new PolygonRegion([p])).find(p => p.contains(old.x, old.z))!;
  expect(nav.urban!.canPassOnCrossing(x, z, radius)).toBe(true);
  expect(nav.lineOfSight(x, z, old.x, old.z, radius, true)).toBe(false);
  expect(exits.choose(x, z, radius, landing, waypoint)).toBe(true);
  expect(bank.contains(landing.x, landing.z, radius)).toBe(true);
  expect(exits.recoverLanding(x, z, radius, old.x, old.z, landing, waypoint)).toBe(true);
  expect(bank.contains(landing.x, landing.z, radius)).toBe(true);
  expect(nav.lineOfSight(x, z, waypoint.x, waypoint.z, radius, true)).toBe(true);
  expect(Math.hypot(waypoint.x - x, waypoint.z - z)).toBeGreaterThan(0);
});
