import type { Point2, Polygon2, Scenario } from '../types';
import type { Direction } from './Navigation';

interface Edge { ax: number; az: number; bx: number; bz: number; dx: number; dz: number; length2: number; nx: number; nz: number }
export interface Boundary extends Direction { distance: number }
const EPSILON = 0.00003; // Float32 positions near a boundary in a few-hundred-meter local frame.
const BUCKET_SIZE = 4;
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

interface EdgeIndex { offsets: Uint32Array; ids: Uint32Array }

/** Each cell's edge IDs occupy [offsets[cell], offsets[cell + 1]) in insertion order. */
function packEdgeLists(lists: (number[] | undefined)[]): EdgeIndex {
  const offsets = new Uint32Array(lists.length + 1);
  for (let i = 0; i < lists.length; i++) offsets[i + 1] = offsets[i] + (lists[i]?.length ?? 0);
  const ids = new Uint32Array(offsets[lists.length]);
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    if (list) ids.set(list, offsets[i]);
  }
  return { offsets, ids };
}

/** Disjoint, unioned polygons with holes. Row and square indexes keep queries local. */
export class PolygonRegion {
  private readonly edges: Edge[] = [];
  private readonly firstRow: number;
  private readonly rows: EdgeIndex;
  private readonly bucketX: number;
  private readonly bucketZ: number;
  private readonly columns: number;
  private readonly bucketRows: number;
  private readonly buckets: EdgeIndex;
  /** A cell without boundary edges is wholly inside (+1) or outside (-1). Other cells use the ray test. */
  private readonly coverage: Int8Array;
  private readonly candidates: Uint32Array;
  private readonly seen: Uint32Array;
  private query = 0;
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
        const length = Math.sqrt(length2);
        this.edges.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, dx, dz, length2, nx: -dz / length * side, nz: dx / length * side });
        this.minX = Math.min(this.minX, a.x, b.x); this.maxX = Math.max(this.maxX, a.x, b.x);
        this.minZ = Math.min(this.minZ, a.z, b.z); this.maxZ = Math.max(this.maxZ, a.z, b.z);
      }
    }
    this.firstRow = Math.floor(this.minZ);
    this.bucketX = Math.floor(this.minX / BUCKET_SIZE);
    this.bucketZ = Math.floor(this.minZ / BUCKET_SIZE);
    this.columns = Math.max(0, Math.floor(this.maxX / BUCKET_SIZE) - this.bucketX + 1);
    this.bucketRows = Math.max(0, Math.floor(this.maxZ / BUCKET_SIZE) - this.bucketZ + 1);
    const rows = new Array<number[] | undefined>(Math.max(0, Math.floor(this.maxZ) - this.firstRow + 1));
    const buckets = new Array<number[] | undefined>(this.columns * this.bucketRows);
    for (let id = 0; id < this.edges.length; id++) {
      const { ax, az, bx, bz } = this.edges[id];
      const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
      for (let row = Math.floor(minZ); row <= Math.floor(maxZ); row++) (rows[row - this.firstRow] ??= []).push(id);
      const firstX = Math.floor(Math.min(ax, bx) / BUCKET_SIZE) - this.bucketX;
      const lastX = Math.floor(Math.max(ax, bx) / BUCKET_SIZE) - this.bucketX;
      for (let z = Math.floor(minZ / BUCKET_SIZE); z <= Math.floor(maxZ / BUCKET_SIZE); z++) {
        const base = (z - this.bucketZ) * this.columns;
        for (let x = firstX; x <= lastX; x++) (buckets[base + x] ??= []).push(id);
      }
    }
    this.rows = packEdgeLists(rows);
    this.buckets = packEdgeLists(buckets);
    this.coverage = new Int8Array(buckets.length);
    for (let z = 0; z < this.bucketRows; z++) {
      const centerZ = (this.bucketZ + z + 0.5) * BUCKET_SIZE;
      for (let x = 0; x < this.columns; x++) {
        const cell = z * this.columns + x;
        if (buckets[cell]) continue;
        const centerX = (this.bucketX + x + 0.5) * BUCKET_SIZE;
        const inside = centerZ >= this.minZ && centerZ <= this.maxZ && this.insideRow(centerX, centerZ);
        this.coverage[cell] = inside ? 1 : -1;
      }
    }
    this.candidates = new Uint32Array(this.edges.length);
    this.seen = new Uint32Array(this.edges.length);
  }

  private collect(minX: number, minZ: number, maxX: number, maxZ: number): number {
    const firstX = Math.max(0, Math.floor(minX / BUCKET_SIZE) - this.bucketX);
    const lastX = Math.min(this.columns - 1, Math.floor(maxX / BUCKET_SIZE) - this.bucketX);
    if (firstX > lastX) return 0;
    const firstZ = Math.max(0, Math.floor(minZ / BUCKET_SIZE) - this.bucketZ);
    const lastZ = Math.min(this.bucketRows - 1, Math.floor(maxZ / BUCKET_SIZE) - this.bucketZ);
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) { this.seen.fill(0); this.query = 1; }
    const { offsets, ids } = this.buckets;
    let count = 0;
    for (let z = firstZ; z <= lastZ; z++) {
      // Adjacent cells form one span. Keep the first occurrence for equal-distance ties.
      const base = z * this.columns;
      const end = offsets[base + lastX + 1];
      for (let i = offsets[base + firstX]; i < end; i++) {
        const id = ids[i];
        if (this.seen[id] !== this.query) {
          this.seen[id] = this.query; this.candidates[count++] = id;
        }
      }
    }
    return count;
  }

  private insideRow(x: number, z: number): boolean {
    const row = Math.floor(z) - this.firstRow;
    const { offsets, ids } = this.rows;
    let inside = false;
    for (let i = offsets[row], end = offsets[row + 1]; i < end; i++) {
      const e = this.edges[ids[i]];
      if ((e.az > z) !== (e.bz > z) && x < e.ax + (z - e.az) * e.dx / e.dz) inside = !inside;
    }
    return inside;
  }

  contains(x: number, z: number, radius = 0): boolean {
    if (!(x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ)) return false;
    const cellX = Math.floor(x / BUCKET_SIZE), cellZ = Math.floor(z / BUCKET_SIZE);
    const coverage = this.coverage[(cellZ - this.bucketZ) * this.columns + (cellX - this.bucketX)];
    if (coverage < 0 || (coverage === 0 && !this.insideRow(x, z))) return false;
    if (radius <= EPSILON) return true;
    if (coverage > 0) {
      const localX = x - cellX * BUCKET_SIZE, localZ = z - cellZ * BUCKET_SIZE;
      if (radius <= Math.min(localX, BUCKET_SIZE - localX, localZ, BUCKET_SIZE - localZ)) return true;
    }
    const clearance2 = Math.max(0, radius - EPSILON) ** 2;
    const count = this.collect(x - radius, z - radius, x + radius, z + radius);
    for (let i = 0; i < count; i++) {
      if (pointSegmentDistance2(x, z, this.edges[this.candidates[i]]) < clearance2) return false;
    }
    return true;
  }

  lineInside(x: number, z: number, tx: number, tz: number, radius = 0): boolean {
    if (!this.contains(x, z, radius) || !this.contains(tx, tz, radius)) return false;
    const dx = tx - x, dz = tz - z, length2 = dx * dx + dz * dz;
    if (length2 < 1e-16) return true;
    const clearance2 = Math.max(0, radius - EPSILON) ** 2;
    const count = this.collect(Math.min(x, tx) - radius, Math.min(z, tz) - radius, Math.max(x, tx) + radius, Math.max(z, tz) + radius);
    for (let i = 0; i < count; i++) {
      const edge = this.edges[this.candidates[i]];
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
    const count = this.collect(x - distance, z - distance, x + distance, z + distance);
    for (let i = 0; i < count; i++) {
      const e = this.edges[this.candidates[i]];
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
    const count = this.collect(x - 4, z - 4, x + 4, z + 4);
    for (let i = 0; i < count; i++) {
      const e = this.edges[this.candidates[i]], toward = -(dx * e.nx + dz * e.nz);
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
  private readonly maneuvers?: PolygonRegion;
  private readonly carriageway?: PolygonRegion;
  private readonly boundary: Boundary = { x: 0, z: 0, distance: Infinity };
  constructor(scenario: Scenario) {
    if (!scenario.urbanMap) throw new Error('Urban geometry requires a map.');
    this.walkable = new PolygonRegion(scenario.urbanMap.walkable);
    this.sidewalks = new PolygonRegion(scenario.urbanMap.sidewalks);
    if (scenario.urbanMap.roads.length) this.carriageway = new PolygonRegion(scenario.urbanMap.roads);
    if (scenario.urbanMap.crossingManeuvers?.length) this.maneuvers = new PolygonRegion(scenario.urbanMap.crossingManeuvers);
  }
  isSidewalk(x: number, z: number, radius = 0): boolean { return this.sidewalks.contains(x, z, radius); }
  /** Includes the passing margins and landings of the signal-controlled crossings. */
  inCrossingArea(x: number, z: number): boolean { return (this.maneuvers ?? this.walkable).contains(x, z); }
  /** A doorway near a landing may be off the sidewalk without entering the carriageway. */
  occupiesCrossing(x: number, z: number, radius: number): boolean {
    if (!this.inCrossingArea(x, z) || this.isSidewalk(x, z, radius)) return false;
    return !this.carriageway || this.carriageway.contains(x, z) || this.carriageway.nearest(x, z, radius, this.boundary);
  }
  isWalkable(x: number, z: number, radius = 0): boolean { return this.walkable.contains(x, z, radius); }
  lineWalkable(x: number, z: number, tx: number, tz: number, radius = 0): boolean { return this.walkable.lineInside(x, z, tx, tz, radius); }
  crossingLine(x: number, z: number, tx: number, tz: number, radius = 0): boolean {
    return this.lineWalkable(x, z, tx, tz, radius) || !!this.maneuvers?.lineInside(x, z, tx, tz, radius);
  }
  canPassOnCrossing(x: number, z: number, radius: number): boolean {
    return !!this.maneuvers?.contains(x, z, radius) && !this.isSidewalk(x, z, radius);
  }
  /** Brake on approach and return the remaining normal clearance to the stop line, in metres. */
  brakeAtCurb(x: number, z: number, direction: Direction, radius: number): number {
    if (!this.sidewalks.curb(x, z, direction.x, direction.z, radius, this.walkable, this.boundary)) return Infinity;
    const inward = direction.x * this.boundary.x + direction.z * this.boundary.z;
    const brake = 1 - Math.min(1, this.boundary.distance / 2.2);
    direction.x -= this.boundary.x * inward * brake;
    direction.z -= this.boundary.z * inward * brake;
    return this.boundary.distance;
  }
  constrain(x: number, z: number, tx: number, tz: number, radius: number, sidewalkOnly: boolean, result: Direction,
    allowCrossingMargin = false): void {
    const region = sidewalkOnly ? this.sidewalks : allowCrossingMargin && this.maneuvers ? this.maneuvers : this.walkable;
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
    // An older motion state may already be a Float32 rounding unit beyond the
    // permitted clearance. Spend part of this step moving back inside before
    // attempting another sweep from that position.
    const roundoff = Math.max(1, Math.abs(x), Math.abs(z)) * 2 ** -23;
    const clearance = Math.max(0, radius - EPSILON);
    if (maxTravel > 0 && region.nearest(x, z, clearance, this.boundary)
      && clearance - this.boundary.distance <= roundoff && region.contains(x, z)) {
      const inset = clearance - this.boundary.distance + roundoff;
      const px = Math.fround(x + this.boundary.x * inset), pz = Math.fround(z + this.boundary.z * inset);
      if (Math.hypot(px - x, pz - z) <= maxTravel && region.contains(px, pz, radius)) {
        result.x = px; result.z = pz; return;
      }
    }
    // A tight concave corner may leave no representable safe step.
    result.x = x; result.z = z;
  }
  avoidance(x: number, z: number, radius: number, result: Point2, passing = false, sidewalkOnly = false,
    clearing = false): boolean {
    result.x = result.z = 0;
    const safe = radius + 0.75;
    if (!this.walkable.nearest(x, z, safe, this.boundary)) return false;
    const motionRadius = radius + 0.015;
    if (!sidewalkOnly && this.maneuvers && this.canPassOnCrossing(x, z, motionRadius) &&
      (passing || !this.isWalkable(x, z, motionRadius))) {
      // After the encounter ends, turn toward the painted surface. A red-signal
      // evacuation already has a specific, reachable target on the nearest bank.
      if (!passing && !clearing) {
        const inward = this.isWalkable(x, z) ? 1 : -1;
        result.x = this.boundary.x * inward; result.z = this.boundary.z * inward;
      }
      if (this.maneuvers.nearest(x, z, safe, this.boundary)) {
        const weight = (safe - this.boundary.distance) * 1.8;
        result.x += this.boundary.x * weight; result.z += this.boundary.z * weight;
      }
      return true;
    }
    const weight = (safe - this.boundary.distance) * 1.8;
    result.x = this.boundary.x * weight; result.z = this.boundary.z * weight;
    return false;
  }
}
