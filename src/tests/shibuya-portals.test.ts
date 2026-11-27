import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createShibuyaScenario, shibuya } from '../scenarios/shibuya';
import { createEnvironment } from '../renderer/Environment';
import { SCENE_MATERIAL } from '../renderer/ScrambleEnvironment';
import { Navigation } from '../simulation/Navigation';
import { PortalTripDemand } from '../simulation/PortalTripDemand';
import { PolygonRegion } from '../simulation/UrbanGeometry';

describe('Shibuya entrances', () => {
  it('connects the Hachiko landings to the forecourt across the paved corner', () => {
    const sidewalk = new PolygonRegion(shibuya.urbanMap!.sidewalks);
    // Walk fully on the sidewalk from the western, diagonal and northern landings.
    for (const [x, z] of [[10.5, 23], [14, 17], [22, 15]]) {
      expect(sidewalk.lineInside(x, z, 20, 24, 0.34)).toBe(true);
    }
    expect(sidewalk.contains(29, 26)).toBe(false); // Planting bed.
    expect(sidewalk.contains(32, 45)).toBe(false); // Forecourt building.
    expect(sidewalk.contains(9, 40)).toBe(false); // Beyond the mapped opening.
  });

  it('keeps the full passage width on reachable pavement up to its authored facade', () => {
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
      const steps = Math.ceil(portal.width / 0.25);
      for (let k = 0; k <= steps; k++) {
        const offset = (2 * k / steps - 1) * (portal.width / 2 - 0.34);
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
  });

  it('keeps shopping demand comparable and serves distinct directions on through trips', () => {
    for (const shops of ['five', 'expanded'] as const) for (const streets of ['north', 'all'] as const) {
      const scenario = createShibuyaScenario(shops, streets);
      const portals = scenario.portals!;
      expect(new Set(portals.map(p => p.id)).size).toBe(portals.length);
      expect(portals.filter(p => p.kind === 'door')).toHaveLength(shops === 'five' ? 5 : 50);
      const edges = portals.filter(p => p.kind === 'street').map(p => p.edge);
      expect(new Set(edges)).toEqual(new Set(streets === 'north' ? ['north'] : ['north', 'south', 'east', 'west']));
      const demand = new PortalTripDemand(portals, scenario.portalTripMix!, 42);
      const served = new Set<number>();
      for (let id = 0; id < 10000; id++) {
        const purpose = demand.purpose(id, 1);
        const kind = demand.preferredOrigin(purpose);
        const origin = portals.findIndex(p => p.kind === kind);
        const point = portals[origin].approach;
        const target = demand.target(id, 1, point.x, point.z, origin);
        expect(target).not.toBe(origin);
        expect(portals[target].kind).toBe(purpose === 'shopping' ? 'door' : 'street');
        if (purpose === 'through' && streets === 'all') expect(portals[target].edge).not.toBe(portals[origin].edge);
        served.add(target);
      }
      // The first street cannot be a through destination from itself. Outbound trips still reach it.
      expect(served.size).toBe(portals.length);
    }
  });

  it('continues all street lanes on actual rendered pavement up to their mapped endpoints', () => {
    const floats = readFileSync('public/data/shibuya/vertices.bin'), ints = readFileSync('public/data/shibuya/indices.bin');
    const vertices = new Float32Array(floats.buffer, floats.byteOffset, floats.byteLength / 4);
    const indices = new Uint32Array(ints.buffer, ints.byteOffset, ints.byteLength / 4);
    const sidewalks = new PolygonRegion(shibuya.urbanMap!.sidewalks);
    for (const { id, approach, end, width } of shibuya.portals!.filter(p => p.kind === 'street')) {
      const length = Math.hypot(end.x - approach.x, end.z - approach.z);
      const dx = (end.x - approach.x) / length, dz = (end.z - approach.z) / length;
      if (id === 'north-street') {
        expect(end.z).toBeLessThan(shibuya.bounds.minZ);
      } else {
        // Inside the tile, exits are at a break in the mapped pavement ahead.
        const endsAtBreak = Array.from({ length: 12 }, (_, k) => (k + 1) * 0.25)
          .some(d => !sidewalks.contains(end.x + dx * d, end.z + dz * d));
        expect(endsAtBreak, id).toBe(true);
      }
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
      const { vertices, indices } = createEnvironment({
        ...shibuya, portals: [door], vehicleLanes: [], scramble: { ...shibuya.scramble!, signalPositions: [] },
      });
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
