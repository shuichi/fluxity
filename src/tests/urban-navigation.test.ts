import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Point2, type Polygon2, type Scenario, type UrbanMap } from '../types';
import { Navigation } from '../simulation/Navigation';
import { PolygonRegion, UrbanGeometry } from '../simulation/UrbanGeometry';
import { Simulation } from '../simulation/Simulation';

const angle = 0.47, c = Math.cos(angle), s = Math.sin(angle);
const point = (u: number, v: number): Point2 => ({ x: c * u - s * v, z: s * u + c * v });
const along = (p: Point2): number => p.x * c + p.z * s;
const ring = (points: number[][]): Point2[] => points.map(([u, v]) => point(u, v));
const rectangle = (u0: number, v0: number, u1: number, v1: number): Point2[] => ring([[u0,v0],[u1,v0],[u1,v1],[u0,v1]]);
const hole = rectangle(-11, 2, -9, 4);
const left: Polygon2 = { rings: [rectangle(-15,-5,-3,5), hole] };
const right: Polygon2 = { rings: [rectangle(3,-5,15,5)] };
const courtyard: Polygon2 = { rings: [rectangle(18,-2,22,2)] };
const walkable: Polygon2 = { rings: [ring([[-15,-5],[-3,-5],[-3,-2],[3,-2],[3,-5],[15,-5],[15,5],[3,5],[3,2],[-3,2],[-3,5],[-15,5]]), hole] };
const map: UrbanMap = {
  schemaVersion: 1, origin: { latitude: 0, longitude: 0, crs: 'local test meters' },
  renderBounds: { minX: -25, maxX: 25, minZ: -25, maxZ: 25 },
  sidewalks: [left, right, courtyard], walkable: [walkable, courtyard], roads: [], buildingFootprints: [{ rings: [hole] }],
  mesh: { vertices: '', indices: '', vertexCount: 0, indexCount: 0, vertexSha256: '0'.repeat(64), indexSha256: '0'.repeat(64) },
  statistics: { buildings: 1, lod2Buildings: 1, lod1Buildings: 0, triangles: 0 },
};
const testScenario: Scenario = {
  id: 'shibuya', name: 'Rotated map fixture', description: '', bounds: map.renderBounds,
  obstacles: [], urbanMap: map, navigationCellSize: 0.75,
  spawnZones: [{ ...point(-10,0), width: 4, depth: 4 }, { ...point(10,0), width: 4, depth: 4 }],
  targets: [point(-11,0), point(11,0)], spawnTargets: [1,0], targetTransitions: [1,0], targetSpread: 0,
};
function pedestrian(mode: 'red' | 'green', u: number): Simulation {
  const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1, signalMode: mode }, undefined, testScenario);
  const p = point(u,0), target = point(11,0), a = simulation.agents;
  a.current.x[0] = p.x; a.current.z[0] = p.z; a.current.vx[0] = c * 1.35; a.current.vz[0] = s * 1.35;
  a.targetId[0] = 1; a.targetX[0] = target.x; a.targetZ[0] = target.z;
  return simulation;
}

describe('polygon ground geometry', () => {
  it('handles rotated rings and holes regardless of ring winding', () => {
    for (const polygon of [walkable, { rings: walkable.rings.map(r => [...r].reverse()) }]) {
      const region = new PolygonRegion([polygon]);
      for (const [u,v,expected] of [[0,0,true],[-10,3,false],[-12,0,true],[0,3,false]] as const) {
        const p = point(u,v); expect(region.contains(p.x,p.z,0.25)).toBe(expected);
      }
      const p = point(-11.1,3); expect(region.contains(p.x,p.z,0.25)).toBe(false);
    }
  });
  it('rejects sweeps across a hole even when both endpoints are valid', () => {
    const region = new PolygonRegion([walkable]), a = point(-12,3), b = point(-8,3);
    expect(region.contains(a.x,a.z,0.25)).toBe(true); expect(region.contains(b.x,b.z,0.25)).toBe(true);
    expect(region.lineInside(a.x,a.z,b.x,b.z,0.25)).toBe(false);
    const result = { x: 0, z: 0 };
    region.constrain(a.x,a.z,b.x,b.z,0.25,result);
    expect(region.contains(result.x,result.z,0.25)).toBe(true);
    expect(along(result)).toBeLessThan(-11.24);
  });
  it('slides along a rotated crossing edge without increasing the integration distance', () => {
    const geometry = new UrbanGeometry(testScenario), a = point(0,1.74), b = point(0.06,1.8), result = { x: 0, z: 0 };
    geometry.constrain(a.x,a.z,b.x,b.z,0.25,false,result);
    expect(geometry.isWalkable(result.x,result.z,0.25)).toBe(true);
    expect(along(result)).toBeGreaterThan(0.05);
    expect(Math.hypot(result.x-a.x,result.z-a.z)).toBeLessThanOrEqual(Math.hypot(b.x-a.x,b.z-a.z)+1e-7);
  });
  it('keeps a Float32 curb slide inside after clipping consumes the numerical tolerance', () => {
    const strip: Polygon2 = { rings: [rectangle(-200,-2,200,2)] };
    const geometry = new UrbanGeometry({ ...testScenario, urbanMap: { ...map, sidewalks: [strip], walkable: [strip] } });
    const a = point(-129.5,1.75), b = point(-129.44,1.755), raw = { x: 0, z: 0 };
    a.x = Math.fround(a.x); a.z = Math.fround(a.z);
    geometry.walkable.constrain(a.x,a.z,b.x,b.z,0.25,raw);
    // This valid double-precision result becomes invalid when stored in AgentData.
    expect(geometry.isWalkable(raw.x,raw.z,0.25)).toBe(true);
    expect(geometry.isWalkable(Math.fround(raw.x),Math.fround(raw.z),0.25)).toBe(false);
    for (const sidewalkOnly of [false, true]) {
      const result = { x: a.x, z: a.z };
      for (let step = 0; step < 40; step++) {
        const oldX = result.x, oldZ = result.z;
        const next = point(along(result) + 0.06,1.755);
        geometry.constrain(oldX,oldZ,next.x,next.z,0.25,sidewalkOnly,result);
        expect(result.x).toBe(Math.fround(result.x)); expect(result.z).toBe(Math.fround(result.z));
        expect(geometry.isSidewalk(result.x,result.z,0.25)).toBe(true);
        expect(along(result) - along({ x: oldX, z: oldZ })).toBeGreaterThan(0.05);
        expect(Math.hypot(result.x-oldX,result.z-oldZ)).toBeLessThanOrEqual(Math.hypot(next.x-oldX,next.z-oldZ));
      }
    }
  });
  it('recovers a rounded starting position within the motion budget', () => {
    const strip = { rings: [[{ x: 90, z: -2 }, { x: 100, z: -2 }, { x: 100, z: 2 }, { x: 90, z: 2 }]] };
    const geometry = new UrbanGeometry({ ...testScenario, urbanMap: { ...map, sidewalks: [strip], walkable: [strip] } });
    // The stored coordinate is about half a micrometre beyond the allowed clearance.
    const x = Math.fround(99.750031), radius = 0.25, result = { x, z: 0 };
    expect(geometry.isWalkable(x, 0)).toBe(true);
    expect(geometry.isWalkable(x, 0, radius)).toBe(false);
    for (const sidewalkOnly of [false, true]) {
      geometry.constrain(x, 0, x, 0, radius, sidewalkOnly, result);
      expect(result).toEqual({ x, z: 0 });
      geometry.constrain(x, 0, x, 1e-8, radius, sidewalkOnly, result);
      expect(result).toEqual({ x, z: 0 });
      geometry.constrain(x, 0, x, 0.01, radius, sidewalkOnly, result);
      expect(geometry.isSidewalk(result.x, result.z, radius)).toBe(true);
      expect(x - result.x).toBeGreaterThan(0);
      expect(Math.hypot(result.x - x, result.z)).toBeLessThanOrEqual(0.01);
      for (const invalidX of [Math.fround(99.751), Math.fround(100.25)]) {
        geometry.constrain(invalidX, 0, invalidX - 1, 0, radius, sidewalkOnly, result);
        expect(result).toEqual({ x: invalidX, z: 0 });
      }
    }
  });
});

describe('real-map navigation and signal', () => {
  it('excludes disconnected courtyards and spawns only on reachable sidewalks', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 300 }, undefined, testScenario), n = simulation.navigation;
    const courtyardPoint = point(20,0);
    expect(n.isReachable(courtyardPoint.x,courtyardPoint.z)).toBe(false);
    for (let i = 0; i < simulation.agents.count; i++) {
      const x = simulation.agents.current.x[i], z = simulation.agents.current.z[i];
      expect(n.isSpawnable(x,z,simulation.agents.radius[i])).toBe(true);
    }
    for (const field of n.fields) for (let cell = 0; cell < n.walkable.length; cell++) {
      if (n.walkable[cell]) expect(Number.isFinite(field.costs[cell])).toBe(true);
    }
  });
  it('reports disconnected destinations and empty maps instead of entering a spawn loop', () => {
    expect(() => new Navigation({ ...testScenario, targets: [point(-10,0),point(20,0)] })).toThrow(/disconnected/);
    expect(() => new Navigation({ ...testScenario, urbanMap: { ...map, walkable: [], sidewalks: [] } })).toThrow(/walkable|sidewalk/);
  });
  it('stops at a rotated curb on red, releases on green, and clears the crossing after red', () => {
    const simulation = pedestrian('red',-4), a = simulation.agents, geometry = simulation.navigation.scramble!;
    for (let step = 0; step < 180; step++) {
      simulation.step();
      expect(geometry.isSidewalk(a.current.x[0],a.current.z[0],a.radius[0])).toBe(true);
    }
    expect(simulation.signal?.waiting).toBe(1);
    const before = along({ x: a.current.x[0], z: a.current.z[0] });
    simulation.updateSettings({ signalMode: 'green' });
    for (let step = 0; step < 100; step++) simulation.step();
    expect(along({ x: a.current.x[0], z: a.current.z[0] })).toBeGreaterThan(before+2);
    expect(simulation.signal?.crossing).toBe(1);
    simulation.updateSettings({ signalMode: 'red' });
    for (let step = 0; step < 200; step++) {
      simulation.step(); expect(simulation.navigation.isFree(a.current.x[0],a.current.z[0],a.radius[0])).toBe(true);
    }
    expect(along({ x: a.current.x[0], z: a.current.z[0] })).toBeGreaterThan(3 + a.radius[0]);
    expect(simulation.signal?.crossing).toBe(0);
  });

  it.each([-1, 1])('lets a just-landed crosser clear the exit curb on red (direction %s)', (sign) => {
    const simulation = pedestrian('green', 0), a = simulation.agents, geometry = simulation.navigation.scramble!;
    const start = point(sign * (3 + a.radius[0] + 0.007), 0), target = point(sign * 11, 0);
    a.current.x[0] = start.x; a.current.z[0] = start.z;
    a.current.vx[0] = sign * c * 1.35; a.current.vz[0] = sign * s * 1.35;
    a.targetId[0] = sign > 0 ? 1 : 0; a.targetX[0] = target.x; a.targetZ[0] = target.z;
    expect(geometry.isSidewalk(a.current.x[0], a.current.z[0], a.radius[0])).toBe(true);
    expect(geometry.isSidewalk(a.current.x[0], a.current.z[0], a.radius[0] + 0.015)).toBe(false);
    simulation.updateSettings({ signalMode: 'red' });
    for (let step = 0; step < 60; step++) {
      simulation.step();
      expect(geometry.isWalkable(a.current.x[0], a.current.z[0], a.radius[0] + 0.015)).toBe(true);
    }
    const end = { x: a.current.x[0], z: a.current.z[0] };
    expect(sign * (along(end) - along(start))).toBeGreaterThan(0.5);
    expect(simulation.signal?.crossing).toBe(0);
    expect(simulation.signal?.waiting).toBe(0);
  });
});
