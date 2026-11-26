import { MeshBuilder } from '../math/geometry';
import type { Bounds, Point2 } from '../types';
import type { EnvironmentMeshData } from './UrbanMesh';
import type { VehicleLane } from '../simulation/VehicleLanes';

type Polygon = Point2[];
type Color = [number, number, number, number];
interface Patch { polygon: Polygon; bounds: Bounds; color: Color }
export interface RoadMarkings {
  lines: readonly { points: number[][]; width: number; dash?: number[] }[];
  surfaces: readonly { points: number[][]; kind?: string }[];
  stopBars: readonly { lane: number; points: number[][] }[];
}

const asphalt: Color = [0.34, 0.35, 0.36, 5];
const redPavement: Color = [0.55, 0.33, 0.30, 5];
const whitePaint: Color = [0.90, 0.91, 0.88, 2];
const refugeConcrete: Color = [0.57, 0.55, 0.51, 0];
const terminalApron: Color = [0.28, 0.30, 0.31, 5];
const refugeCurb: Color = [0.74, 0.72, 0.67, 0];
const toPoint = ([x, z]: number[]): Point2 => ({ x, z });
const cross = (a: Point2, b: Point2, p: Point2) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
const mix = (a: Point2, b: Point2, t: number): Point2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

function area2(polygon: Polygon): number {
  let sum = 0;
  for (let i = 1; i + 1 < polygon.length; i++) sum += cross(polygon[0], polygon[i], polygon[i + 1]);
  return sum;
}

function bounds(points: Polygon): Bounds {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const { x, z } of points) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}
function overlap(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

// Cut a convex piece by the four (or three) half-planes of a convex patch.
// At each edge the outside slice is final; only the inside is cut again.
// On a miss, retain the intact original polygon to avoid needless subdivisions.
function cut(piece: Polygon, patch: Polygon): { inside: Polygon; outside: Polygon[] } | undefined {
  let inside = piece;
  const outside: Polygon[] = [];
  for (let i = 0; i < patch.length; i++) {
    const a = patch[i], b = patch[(i + 1) % patch.length];
    if (a.x === b.x && a.z === b.z) continue;
    const keep: Polygon = [], reject: Polygon = [];
    let previous = inside[inside.length - 1], d0 = cross(a, b, previous);
    for (const current of inside) {
      const d1 = cross(a, b, current);
      if (d0 * d1 < 0) {
        const hit = mix(previous, current, d0 / (d0 - d1));
        keep.push(hit); reject.push(hit);
      }
      if (d1 >= 0) keep.push(current);
      if (d1 <= 0) reject.push(current);
      previous = current; d0 = d1;
    }
    if (Math.abs(area2(keep)) < 1e-9) return;
    if (Math.abs(area2(reject)) > 1e-9) outside.push(reject);
    inside = keep;
  }
  return { inside, outside };
}

function makePatches(layout: RoadMarkings, lanes: readonly VehicleLane[]): Patch[] {
  const patches: Patch[] = [];
  function add(polygon: Polygon, color: Color) {
    const area = area2(polygon);
    if (Math.abs(area) < 1e-9) return;
    if (area < 0) polygon.reverse();
    patches.push({ polygon, color, bounds: bounds(polygon) });
  }

  function stroke(path: Polygon, width: number, color: Color, dash?: number[]) {
    const normals = path.slice(1).map((b, i) => {
      const dx = b.x - path[i].x, dz = b.z - path[i].z, length = Math.hypot(dx, dz);
      if (!length) throw new Error('A road marking contains a zero-length segment.');
      return { x: -dz / length, z: dx / length };
    });
    const closed = path[0].x === path.at(-1)!.x && path[0].z === path.at(-1)!.z;
    const joins = path.map((_, i) => {
      const n = normals[i - 1] ?? (closed ? normals.at(-1)! : normals[0]);
      const m = normals[i] ?? (closed ? normals[0] : normals.at(-1)!);
      // Miter both sides of a turn so the inside edge and the outside edge meet.
      const denominator = Math.max(0.1, 1 + n.x * m.x + n.z * m.z);
      return { x: (n.x + m.x) / denominator, z: (n.z + m.z) / denominator };
    });
    const offset = (p: Point2, n: Point2, side: number) =>
      ({ x: p.x + n.x * side * width / 2, z: p.z + n.z * side * width / 2 });
    let distance = 0;
    const period = dash ? dash[0] + dash[1] : 0;
    for (let i = 0; i < normals.length; i++) {
      const a = path[i], b = path[i + 1], length = Math.hypot(b.x - a.x, b.z - a.z);
      function ribbon(start: number, end: number) {
        if (end <= start) return;
        const from = mix(a, b, start / length), to = mix(a, b, end / length);
        const n = start === 0 ? joins[i] : normals[i], m = end === length ? joins[i + 1] : normals[i];
        add([offset(from, n, 1), offset(to, m, 1), offset(to, m, -1), offset(from, n, -1)], color);
      }
      if (dash && period > 0) {
        for (let d = Math.floor(distance / period) * period; d < distance + length; d += period) {
          ribbon(Math.max(0, d - distance), Math.min(length, d + dash[0] - distance));
        }
      } else ribbon(0, length);
      distance += length;
    }
  }

  function surface(ring: Polygon, color: Color) {
    // A bend can make a curbside surface concave. Between consecutive vertex
    // heights each pair of intersections forms exactly one convex trapezoid.
    const levels = [...new Set(ring.map(p => p.z))].sort((a, b) => a - b);
    for (let i = 1; i < levels.length; i++) {
      const low = levels[i - 1], high = levels[i], middle = (low + high) / 2;
      const sides: { bottom: Point2; top: Point2 }[] = [];
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j], b = ring[(j + 1) % ring.length];
        if ((a.z > middle) === (b.z > middle)) continue;
        sides.push({ bottom: mix(a, b, (low - a.z) / (b.z - a.z)), top: mix(a, b, (high - a.z) / (b.z - a.z)) });
      }
      sides.sort((a, b) => (a.bottom.x + a.top.x) - (b.bottom.x + b.top.x));
      for (let j = 0; j < sides.length; j += 2) {
        const left = sides[j], right = sides[j + 1];
        add([left.bottom, right.bottom, right.top, left.top], color);
      }
    }
  }
  // First match wins: kerbs and concrete, then markings on the colored asphalt.
  for (const { kind, points } of layout.surfaces) {
    if (kind !== 'island' && kind !== 'apron') continue;
    const ring = points.map(toPoint);
    const closed = ring[0].x === ring.at(-1)!.x && ring[0].z === ring.at(-1)!.z;
    stroke(closed ? ring : [...ring, ring[0]], 0.16, refugeCurb);
    if (kind === 'island') surface(ring, refugeConcrete);
  }
  for (const stop of layout.stopBars) {
    const lane = lanes[stop.lane];
    if (!lane) continue;
    const [a, b] = stop.points.map(toPoint);
    const dx = b.z - a.z, dz = a.x - b.x, length = Math.hypot(dx, dz);
    const forward = (a.x - lane.start.x) * dx + (a.z - lane.start.z) * dz >= 0 ? 1 : -1;
    const offset = (p: Point2) => ({ x: p.x + 0.4 * forward * dx / length, z: p.z + 0.4 * forward * dz / length });
    add([a, b, offset(b), offset(a)], whitePaint);
  }
  for (const { points, width, dash } of layout.lines) stroke(points.map(toPoint), width, whitePaint, dash);
  for (const { kind, points } of layout.surfaces) {
    if (kind !== 'island') surface(points.map(toPoint), kind === 'apron' ? terminalApron : redPavement);
  }
  return patches;
}

const sourceAsphalt = [0.16, 0.19, 0.22].map(Math.fround);

/** Retile only the flat asphalt faces produced by import-plateau.py. The original
 * triangles already exclude zebra paint, islands, sidewalks and building holes. */
export function tileRoadMarkings(base: EnvironmentMeshData, layout: RoadMarkings, lanes: readonly VehicleLane[]) {
  const road = new MeshBuilder(10), retained: number[] = [], patches = makePatches(layout, lanes);
  const { vertices, indices } = base;
  function face(polygon: Polygon, color: Color) {
    // Cutting preserves clockwise x,z winding (normal +Y). Rounding to float32
    // can fold a near-collinear corner back onto its edge; drop it from the fan.
    const rounded = polygon.map(p => ({ x: Math.fround(p.x), z: Math.fround(p.z) }));
    const unique = rounded.filter((p, i) => {
      const previous = rounded[(i + rounded.length - 1) % rounded.length];
      return p.x !== previous.x || p.z !== previous.z;
    });
    const corners = unique.filter((p, i) => {
      const previous = unique[(i + unique.length - 1) % unique.length], next = unique[(i + 1) % unique.length];
      return cross(previous, p, next) < 0;
    });
    if (corners.length >= 3) road.face(corners.map(p => [p.x, 0, p.z]), [0, 1, 0], color);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const index = indices[i] * 10;
    if (vertices[index + 1] !== 0 || vertices[index + 4] !== 1 || vertices[index + 9] !== 0
      || sourceAsphalt.some((channel, c) => vertices[index + 6 + c] !== channel)) {
      retained.push(indices[i], indices[i + 1], indices[i + 2]);
      continue;
    }
    const triangle = [indices[i], indices[i + 1], indices[i + 2]].map(n => ({ x: vertices[n * 10], z: vertices[n * 10 + 2] }));
    const triangleBounds = bounds(triangle);
    let unpainted = [triangle];
    for (const patch of patches) {
      if (!overlap(triangleBounds, patch.bounds)) continue;
      const remaining: Polygon[] = [];
      for (const piece of unpainted) {
        const result = overlap(bounds(piece), patch.bounds) && cut(piece, patch.polygon);
        if (result) {
          face(result.inside, patch.color);
          remaining.push(...result.outside);
        } else remaining.push(piece);
      }
      unpainted = remaining;
      if (!unpainted.length) break;
    }
    for (const piece of unpainted) face(piece, asphalt);
  }
  return { base: { ...base, indices: new Uint32Array(retained) }, road: road.finish() };
}
