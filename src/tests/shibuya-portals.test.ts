import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { createEnvironment } from '../renderer/Environment';
import { SCENE_MATERIAL } from '../renderer/ScrambleEnvironment';
import { Navigation } from '../simulation/Navigation';
import { PolygonRegion } from '../simulation/UrbanGeometry';

describe('Shibuya entrances', () => {
  it('routes both lanes across reachable sidewalks and only crosses a wall at an authored door', () => {
    const nav = new Navigation(shibuya), map = shibuya.urbanMap!;
    const buildings = new PolygonRegion(map.buildingFootprints), roads = new PolygonRegion(map.roads);
    const portals = shibuya.portals!;
    for (const [index, portal] of portals.entries()) {
      const { approach, end } = portal;
      if (portal.queueApproach) {
        const { x, z } = portal.queueApproach;
        expect(nav.isSpawnable(x, z, 0.42), portal.id).toBe(true);
        expect(nav.isReachable(x, z, index), portal.id).toBe(true);
      }
      const length = Math.hypot(end.x - approach.x, end.z - approach.z);
      const dx = (end.x - approach.x) / length, dz = (end.z - approach.z) / length;
      for (const lane of [0, -1, 1]) {
        const offset = lane * (portal.width / 2 - 0.34);
        const ax = approach.x - dz * offset, az = approach.z + dx * offset;
        expect(nav.isSpawnable(ax, az, 0.34), portal.id).toBe(true);
        expect(nav.isReachable(ax, az, index), portal.id).toBe(true);
        for (let depth = 0; depth <= length; depth += 0.2) {
          const x = ax + dx * depth, z = az + dz * depth;
          expect(roads.contains(x, z), portal.id).toBe(false);
          if (portal.kind === 'street' || depth < length - 0.85) expect(buildings.contains(x, z), portal.id).toBe(false);
        }
        const inside = buildings.contains(end.x - dz * offset, end.z + dx * offset, 0.34);
        expect(inside, portal.id).toBe(portal.kind === 'door');
      }
    }
    // Every destination is still served after the first wave of pedestrians has exited.
    expect(new Set(shibuya.targetTransitions)).toEqual(new Set(portals.map((_, i) => i)));
  });

  it('continues the exterior street lanes on actual rendered pavement outside the simulation bounds', () => {
    const floats = readFileSync('public/data/shibuya/vertices.bin'), ints = readFileSync('public/data/shibuya/indices.bin');
    const vertices = new Float32Array(floats.buffer, floats.byteOffset, floats.byteLength / 4);
    const indices = new Uint32Array(ints.buffer, ints.byteOffset, ints.byteLength / 4);
    for (const { approach, end, width } of shibuya.portals!.filter(p => p.kind === 'street')) {
      expect(Math.abs(end.x) > shibuya.bounds.maxX || Math.abs(end.z) > shibuya.bounds.maxZ).toBe(true);
      const length = Math.hypot(end.x - approach.x, end.z - approach.z);
      const dx = (end.x - approach.x) / length, dz = (end.z - approach.z) / length;
      const probes = [];
      for (let d = 0; d <= length; d += 0.5) for (const lane of [-0.5, 0, 0.5]) {
        probes.push({ x: approach.x + dx * d - dz * width * lane, z: approach.z + dz * d + dx * width * lane, paved: false });
      }
      for (let i = 0; i < indices.length; i += 3) {
        if (vertices[indices[i] * 10 + 9] !== SCENE_MATERIAL.mappedPaving) continue;
        const triangle = [indices[i] * 10, indices[i+1] * 10, indices[i+2] * 10];
        for (const p of probes) {
          if (p.paved) continue;
          const sides = triangle.map((a, j) => {
            const b = triangle[(j + 1) % 3];
            return (vertices[b] - vertices[a]) * (p.z - vertices[a+2])
              - (vertices[b+2] - vertices[a+2]) * (p.x - vertices[a]);
          });
          p.paved = sides.every(side => side >= -1e-5) || sides.every(side => side <= 1e-5);
        }
      }
      expect(probes.every(p => p.paved)).toBe(true);
    }
  });

  it('puts an opaque recessed entrance at each doorway in the photographic and plain city mesh', () => {
    for (const door of shibuya.portals!.filter(p => p.kind === 'door')) {
      const { vertices, indices } = createEnvironment({ ...shibuya, portals: [door], scramble: { ...shibuya.scramble!, signalPositions: [] } });
      expect(indices.length).toBeGreaterThan(0);
      const dx = door.approach.x - door.end.x, dz = door.approach.z - door.end.z, length = Math.hypot(dx,dz);
      const base = door.end.x * dx / length + door.end.z * dz / length;
      const depths = [], heights = [];
      for (let i = 0; i < vertices.length; i += 10) {
        depths.push((vertices[i] * dx + vertices[i+2] * dz) / length - base);
        heights.push(vertices[i+1]);
      }
      expect(Math.min(...depths)).toBeCloseTo(0.865, 2);
      expect(Math.max(...depths)).toBeGreaterThan(1.4);
      expect(Math.max(...heights)).toBeGreaterThan(2.3);
    }
  });
});
