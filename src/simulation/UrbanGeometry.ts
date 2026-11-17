import type { Point2, Polygon2, Scenario } from '../types';
import type { Direction } from './Navigation';

interface Edge { ax: number; az: number; bx: number; bz: number; dx: number; dz: number; length2: number; nx: number; nz: number }
export interface Boundary extends Direction { distance: number }
const EPSILON = 0.00003; // Float32 positions near a boundary in a few-hundred-meter local frame.
const cross = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;

function pointSegmentDistance2(x: number, z: number, edge: Edge): number {
  const t = Math.max(0, Math.min(1, ((x - edge.ax) * edge.dx + (z - edge.az) * edge.dz) / edge.length2));
  return (x - edge.ax - t * edge.dx) ** 2 + (z - edge.az - t * edge.dz) ** 2;
}
function intersects(ax: number, az: number, bx: number, bz: number, e: Edge): boolean {
  const dx = bx - ax, dz = bz - az, determinant = cross(dx, dz, e.dx, e.dz);
  if (Math.abs(determinant) < 1e-12) return false;
  const px = e.ax - ax, pz = e.az - az;
  const t = cross(px, pz, e.dx, e.dz) / determinant;
  const u = cross(px, pz, dx, dz) / determinant;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Disjoint, unioned polygons with holes. Row and square indexes keep queries local. */
export class PolygonRegion {
  private readonly edges: Edge[] = [];
  private readonly rows = new Map<number, number[]>();
  private readonly buckets = new Map<string, number[]>();
  private readonly candidates: number[] = [];
  private readonly seen: Uint32Array;
  private query = 0;
  private readonly bucketSize = 4;
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;
  private readonly boundary: Boundary = { x: 0, z: 0, distance: Infinity };

  constructor(polygons: readonly Polygon2[]) {
    for (const polygon of polygons) for (let ringIndex = 0; ringIndex < polygon.rings.length; ringIndex++) {
      const ring = polygon.rings[ringIndex];
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (!Number.isFinite(a.x + a.z)) throw new Error('Map polygon contains a non-finite coordinate.');
        area += a.x * b.z - b.x * a.z;
      }
      if (ring.length < 3 || Math.abs(area) < 1e-10) continue;
      const side = (area > 0 ? 1 : -1) * (ringIndex === 0 ? 1 : -1);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dz = b.z - a.z;
        const length2 = dx * dx + dz * dz;
        if (length2 < 1e-14) continue;
        const length = Math.sqrt(length2), id = this.edges.length;
        this.edges.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, dx, dz, length2, nx: -dz / length * side, nz: dx / length * side });
        const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
        this.minX = Math.min(this.minX, minX); this.maxX = Math.max(this.maxX, maxX);
        this.minZ = Math.min(this.minZ, minZ); this.maxZ = Math.max(this.maxZ, maxZ);
        for (let row = Math.floor(minZ); row <= Math.floor(maxZ); row++) {
          let entries = this.rows.get(row);
          if (!entries) { entries = []; this.rows.set(row, entries); }
          entries.push(id);
        }
        for (let z = Math.floor(minZ / this.bucketSize); z <= Math.floor(maxZ / this.bucketSize); z++) {
          for (let x = Math.floor(minX / this.bucketSize); x <= Math.floor(maxX / this.bucketSize); x++) {
            const key = `${x},${z}`;
            let entries = this.buckets.get(key);
            if (!entries) { entries = []; this.buckets.set(key, entries); }
            entries.push(id);
          }
        }
      }
    }
    this.seen = new Uint32Array(this.edges.length);
  }

  private collect(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    this.candidates.length = 0;
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) { this.seen.fill(0); this.query = 1; }
    for (let z = Math.floor(minZ / this.bucketSize); z <= Math.floor(maxZ / this.bucketSize); z++) {
      for (let x = Math.floor(minX / this.bucketSize); x <= Math.floor(maxX / this.bucketSize); x++) {
        const entries = this.buckets.get(`${x},${z}`);
        if (!entries) continue;
        for (const id of entries) if (this.seen[id] !== this.query) {
          this.seen[id] = this.query; this.candidates.push(id);
        }
      }
    }
    return this.candidates;
  }

  contains(x: number, z: number, radius = 0): boolean {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return false;
    const edges = this.rows.get(Math.floor(z));
    if (!edges) return false;
    let inside = false;
    for (const id of edges) {
      const e = this.edges[id];
      if ((e.az > z) !== (e.bz > z) && x < e.ax + (z - e.az) * e.dx / e.dz) inside = !inside;
    }
    if (!inside) return false;
    if (radius <= EPSILON) return true;
    const clearance2 = Math.max(0, radius - EPSILON) ** 2;
    for (const id of this.collect(x - radius, z - radius, x + radius, z + radius)) {
      if (pointSegmentDistance2(x, z, this.edges[id]) < clearance2) return false;
    }
    return true;
  }

  lineInside(x: number, z: number, tx: number, tz: number, radius = 0): boolean {
    if (!this.contains(x, z, radius) || !this.contains(tx, tz, radius)) return false;
    const dx = tx - x, dz = tz - z, length2 = dx * dx + dz * dz;
    if (length2 < 1e-16) return true;
    const clearance2 = Math.max(0, radius - EPSILON) ** 2;
    for (const id of this.collect(Math.min(x, tx) - radius, Math.min(z, tz) - radius, Math.max(x, tx) + radius, Math.max(z, tz) + radius)) {
      const edge = this.edges[id];
      if (intersects(x, z, tx, tz, edge)) return false;
      if (clearance2 <= 0) continue;
      if (pointSegmentDistance2(x, z, edge) < clearance2 || pointSegmentDistance2(tx, tz, edge) < clearance2) return false;
      const u = Math.max(0, Math.min(1, ((edge.ax - x) * dx + (edge.az - z) * dz) / length2));
      const v = Math.max(0, Math.min(1, ((edge.bx - x) * dx + (edge.bz - z) * dz) / length2));
      if ((edge.ax - x - u * dx) ** 2 + (edge.az - z - u * dz) ** 2 < clearance2
        || (edge.bx - x - v * dx) ** 2 + (edge.bz - z - v * dz) ** 2 < clearance2) return false;
    }
    return true;
  }

  nearest(x: number, z: number, distance: number, result: Boundary): boolean {
    result.distance = distance; result.x = result.z = 0;
    let found = false;
    for (const id of this.collect(x - distance, z - distance, x + distance, z + distance)) {
      const e = this.edges[id];
      const t = Math.max(0, Math.min(1, ((x - e.ax) * e.dx + (z - e.az) * e.dz) / e.length2));
      const dx = x - e.ax - e.dx * t, dz = z - e.az - e.dz * t, d = Math.hypot(dx, dz);
      if (d >= result.distance) continue;
      result.distance = d;
      result.x = d > 1e-9 ? dx / d : e.nx;
      result.z = d > 1e-9 ? dz / d : e.nz;
      found = true;
    }
    return found;
  }

  /** Ray to a curb which opens into a crossing, excluding walls and map borders. */
  curb(x: number, z: number, dx: number, dz: number, radius: number, walkable: PolygonRegion, result: Boundary): boolean {
    result.distance = Infinity;
    for (const id of this.collect(x - 4, z - 4, x + 4, z + 4)) {
      const e = this.edges[id], toward = -(dx * e.nx + dz * e.nz);
      if (toward < 1e-6) continue;
      const determinant = cross(dx, dz, e.dx, e.dz);
      if (Math.abs(determinant) < 1e-10) continue;
      const t = cross(e.ax - x, e.az - z, e.dx, e.dz) / determinant;
      const u = cross(e.ax - x, e.az - z, dx, dz) / determinant;
      if (t < 0 || t > 4 || u < 0 || u > 1) continue;
      const px = x + dx * t, pz = z + dz * t;
      if (!walkable.contains(px - e.nx * 0.08, pz - e.nz * 0.08)) continue;
      const clearance = Math.max(0, (x - px) * e.nx + (z - pz) * e.nz - radius - 0.08);
      if (clearance / toward >= 3 || clearance >= result.distance) continue;
      result.distance = clearance; result.x = e.nx; result.z = e.nz;
    }
    return Number.isFinite(result.distance);
  }

  /** Sweep, stop before contact, then retain the component parallel to the boundary. */
  constrain(x: number, z: number, tx: number, tz: number, radius: number, result: Direction): void {
    if (this.lineInside(x, z, tx, tz, radius)) { result.x = tx; result.z = tz; return; }
    let px = x, pz = z, goalX = tx, goalZ = tz;
    for (let pass = 0; pass < 2; pass++) {
      let low = 0, high = 1;
      for (let i = 0; i < 12; i++) {
        const middle = (low + high) * 0.5;
        if (this.lineInside(px, pz, px + (goalX - px) * middle, pz + (goalZ - pz) * middle, radius)) low = middle;
        else high = middle;
      }
      const nx = px + (goalX - px) * low, nz = pz + (goalZ - pz) * low;
      let dx = goalX - nx, dz = goalZ - nz;
      px = nx; pz = nz;
      if (!this.nearest(px, pz, radius + Math.hypot(dx, dz) + 0.01, this.boundary)) break;
      const inward = dx * this.boundary.x + dz * this.boundary.z;
      if (inward >= -1e-10) break;
      dx -= this.boundary.x * inward; dz -= this.boundary.z * inward;
      goalX = px + dx; goalZ = pz + dz;
      if (this.lineInside(px, pz, goalX, goalZ, radius)) { px = goalX; pz = goalZ; break; }
    }
    result.x = px; result.z = pz;
  }
}

/** Shared real-world ground geometry; elevation and multilevel routing are intentionally separate. */
export class UrbanGeometry {
  readonly walkable: PolygonRegion;
  readonly sidewalks: PolygonRegion;
  private readonly boundary: Boundary = { x: 0, z: 0, distance: Infinity };
  constructor(scenario: Scenario) {
    if (!scenario.urbanMap) throw new Error('Urban geometry requires a map.');
    this.walkable = new PolygonRegion(scenario.urbanMap.walkable);
    this.sidewalks = new PolygonRegion(scenario.urbanMap.sidewalks);
  }
  isSidewalk(x: number, z: number, radius = 0): boolean { return this.sidewalks.contains(x, z, radius); }
  isWalkable(x: number, z: number, radius = 0): boolean { return this.walkable.contains(x, z, radius); }
  lineWalkable(x: number, z: number, tx: number, tz: number, radius = 0): boolean { return this.walkable.lineInside(x, z, tx, tz, radius); }
  brakeAtCurb(x: number, z: number, direction: Direction, radius: number): boolean {
    if (!this.sidewalks.curb(x, z, direction.x, direction.z, radius, this.walkable, this.boundary)) return false;
    const inward = direction.x * this.boundary.x + direction.z * this.boundary.z;
    const brake = 1 - Math.min(1, this.boundary.distance / 2.2);
    direction.x -= this.boundary.x * inward * brake;
    direction.z -= this.boundary.z * inward * brake;
    return true;
  }
  constrain(x: number, z: number, tx: number, tz: number, radius: number, sidewalkOnly: boolean, result: Direction): void {
    const region = sidewalkOnly ? this.sidewalks : this.walkable;
    region.constrain(x, z, tx, tz, radius, result);
    let qx = Math.fround(result.x), qz = Math.fround(result.z);
    if (region.contains(qx, qz, radius)) { result.x = qx; result.z = qz; return; }
    // The sweep can finish exactly at its tolerance. Float32 storage must not
    // round that point outside and turn a waiting pedestrian into a crosser.
    // Reserve 0.1 mm inward only when quantization fails, retaining the slide
    // and never increasing the requested integration distance.
    const maxTravel = Math.hypot(tx - x, tz - z);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!region.nearest(qx, qz, radius + 0.001, this.boundary)) break;
      const inset = Math.max(0.0001, radius + 0.0001 - this.boundary.distance);
      let px = qx + this.boundary.x * inset, pz = qz + this.boundary.z * inset;
      const travel = Math.hypot(px - x, pz - z);
      if (travel > maxTravel && travel > 0) {
        const scale = maxTravel / travel;
        px = x + (px - x) * scale; pz = z + (pz - z) * scale;
      }
      qx = Math.fround(px); qz = Math.fround(pz);
      if (region.lineInside(x, z, qx, qz, radius)) { result.x = qx; result.z = qz; return; }
    }
    // A tight concave corner may leave no representable safe step.
    result.x = x; result.z = z;
  }
  avoidance(x: number, z: number, radius: number, result: Point2): void {
    result.x = result.z = 0;
    const safe = radius + 0.75;
    if (this.walkable.nearest(x, z, safe, this.boundary)) {
      const weight = (safe - this.boundary.distance) * 1.8;
      result.x = this.boundary.x * weight; result.z = this.boundary.z * weight;
    }
  }
}
