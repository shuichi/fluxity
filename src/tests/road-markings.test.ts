import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHIBUYA_VEHICLE_LANES } from '../simulation/VehicleLanes';
import shibuyaMarkings from '../../data/shibuya/road-markings.json';
import { MeshBuilder } from '../math/geometry';
import { tileRoadMarkings, type RoadMarkings } from '../renderer/RoadMarkings';
import type { EnvironmentMeshData } from '../renderer/UrbanMesh';

function rectangle(mesh: MeshBuilder, x: number, z: number, width: number, depth: number, color: number[]) {
  mesh.face([[x, 0, z], [x, 0, z + depth], [x + width, 0, z + depth], [x + width, 0, z]], [0, 1, 0], color);
}
const originalAsphalt = [0.16, 0.19, 0.22, 0];
const empty: RoadMarkings = { surfaces: [], lines: [], stopBars: [] };

function inspect(mesh: EnvironmentMeshData, x: number, z: number) {
  const { vertices, indices } = mesh, visible = new Set<string>();
  let totalArea = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i] * 10, indices[i + 1] * 10, indices[i + 2] * 10];
    const edge = (a: number, b: number, px: number, pz: number) =>
      (vertices[b] - vertices[a]) * (pz - vertices[a + 2]) - (vertices[b + 2] - vertices[a + 2]) * (px - vertices[a]);
    const [a, b, c] = tri, twiceArea = edge(a, b, vertices[c], vertices[c + 2]);
    expect(twiceArea).toBeLessThanOrEqual(1e-8);
    totalArea -= twiceArea / 2;
    if (twiceArea >= 0) continue;
    if (tri.every((p, j) => edge(p, tri[(j + 1) % 3], x, z) <= 1e-8)) {
      if (vertices[a + 9] === 0) visible.add('island');
      else visible.add(vertices[a + 9] === 2 ? 'white' : vertices[a + 6] > 0.5 ? 'red' : 'asphalt');
    }
  }
  return { totalArea, visible: [...visible] };
}

describe('Shibuya road surfacing', () => {
  it('tiles the existing asphalt and leaves the baked zebra, pavement and central island untouched', () => {
    const base = new MeshBuilder(10);
    rectangle(base, 0, 0, 6, 2, originalAsphalt);
    rectangle(base, 0, 4, 6, 2, originalAsphalt);
    rectangle(base, 0, 2, 2, 2, originalAsphalt);
    rectangle(base, 4, 2, 2, 2, originalAsphalt);
    rectangle(base, 2, 2, 2, 2, [0.38, 0.43, 0.40, 0]); // Island.
    rectangle(base, 6, 0, 1, 6, [0.90, 0.91, 0.88, 2]); // Existing zebra.
    rectangle(base, 7, 0, 2, 6, [0.61, 0.64, 0.64, 4]); // Sidewalk.
    const source = base.finish();
    const layout = { ...empty,
      surfaces: [{ points: [[-2, 1], [10, 1], [10, 7], [2, 7], [2, 2], [-2, 2]] }],
      lines: [{ width: 0.30, points: [[-1, 1.7], [8, 1.7]] }],
    };
    const result = tileRoadMarkings(source, layout, []);
    expect(result.base.indices).toEqual(source.indices.slice(-18));
    const at = (x: number, z: number) => inspect(result.road, x, z);
    expect(at(3.1, 1.7)).toEqual({ totalArea: expect.closeTo(32, 5), visible: ['white'] });
    expect(at(5.1, 4.3).visible).toEqual(['red']);
    expect(at(1.1, 3.3).visible).toEqual(['asphalt']);
    for (const x of [3.1, 6.2, 7.4]) expect(at(x, 3.3).visible).toEqual([]);
  });

  it('keeps dashed paint phase through bends and fills the authored full-width stop bar', () => {
    const base = new MeshBuilder(10);
    rectangle(base, -2, -1, 16, 12, originalAsphalt);
    const layout = { ...empty,
      lines: [{ points: [[0, 1], [3, 1], [3, 8]], width: 0.20, dash: [2, 2] }],
      stopBars: [{ lane: 0, points: [[8, 0], [8, 7]] }],
    };
    const lane = { axis: 'eastWest' as const, start: { x: 0, z: 1 }, end: { x: 14, z: 1 }, stop: 8, clear: 12 };
    const { road } = tileRoadMarkings(base.finish(), layout, [lane]);
    const at = (x: number, z: number) => inspect(road, x, z).visible;
    expect(at(1, 1)).toEqual(['white']);
    expect(at(3, 1.4)).toEqual(['asphalt']);
    expect(at(3, 2.4)).toEqual(['white']);
    expect(at(3, 4.5)).toEqual(['asphalt']);
    expect(at(8.2, 6.9)).toEqual(['white']);
    expect(at(7.99, 3.1)).toEqual(['asphalt']);
    expect(at(8.41, 3.1)).toEqual(['asphalt']);
  });

  it('gives the calibrated station refuge and kerb priority over road markings', () => {
    const base = new MeshBuilder(10);
    rectangle(base, 0, 0, 10, 10, originalAsphalt);
    const layout = { ...empty,
      surfaces: [{ kind: 'island', points: [[2, 2], [6, 2], [6, 7], [4, 9], [2, 7]] }],
      lines: [{ width: 0.5, points: [[0, 4], [10, 4]] }],
    };
    const { road } = tileRoadMarkings(base.finish(), layout, []);
    expect(inspect(road, 4.05, 4.08)).toEqual({ totalArea: expect.closeTo(100, 4), visible: ['island'] });
    expect(inspect(road, 1.95, 4.1).visible).toEqual(['island']);
    expect(inspect(road, 1.8, 4.1).visible).toEqual(['white']);
  });

  it('conserves the area of the shipped Shibuya road mesh while leaving every other face in its original order', () => {
    const bytes = (path: string) => {
      const b = readFileSync(path);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    };
    const vertices = new Float32Array(bytes('public/data/shibuya/vertices.bin'));
    const indices = new Uint32Array(bytes('public/data/shibuya/indices.bin'));
    const result = tileRoadMarkings({ vertices, indices }, shibuyaMarkings, SHIBUYA_VEHICLE_LANES);
    const areas = new Map<string, number>();
    function signedArea(v: Float32Array, a: number, b: number, c: number) {
      return ((v[b + 2] - v[a + 2]) * (v[c] - v[a]) - (v[b] - v[a]) * (v[c + 2] - v[a + 2])) / 2;
    }
    let originalArea = 0, retained = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 10, b = indices[i + 1] * 10, c = indices[i + 2] * 10;
      if (vertices[a + 1] === 0 && vertices[a + 4] === 1 && vertices[a + 6] === Math.fround(0.16)
        && vertices[a + 7] === Math.fround(0.19) && vertices[a + 8] === Math.fround(0.22)) {
        originalArea += signedArea(vertices, a, b, c);
      } else {
        for (let j = i; j < i + 3; j++) {
          if (result.base.indices[retained++] !== indices[j]) throw new Error('A non-road face was changed');
        }
      }
    }
    expect(retained).toBe(result.base.indices.length);
    const road = result.road;
    for (let i = 0; i < road.indices.length; i += 3) {
      const a = road.indices[i] * 10, b = road.indices[i + 1] * 10, c = road.indices[i + 2] * 10;
      const group = [road.vertices[a + 6], road.vertices[a + 9]].join('/');
      const area = signedArea(road.vertices, a, b, c);
      if (area < -1e-7) throw new Error('A road marking triangle faces down');
      areas.set(group, (areas.get(group) ?? 0) + area);
    }
    const totalArea = [...areas.values()].reduce((total, x) => total + x, 0);
    expect(Math.abs(totalArea - originalArea)).toBeLessThan(0.01); // m² across the full 500 m tile.
    expect(areas.get([Math.fround(0.9), 2].join('/'))).toBeGreaterThan(20);
    expect(areas.get([Math.fround(0.55), 5].join('/'))).toBeGreaterThan(50);
  });
});
