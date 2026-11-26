import type { Point2, Polygon2 } from '../types';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';
import { PolygonRegion } from './UrbanGeometry';

interface Landing extends Point2 { sidewalk: number; cell: number }
interface InsetVertex extends Point2 { insetX: number; insetZ: number }
interface Candidate extends Point2 { distance: number }

function insetRing(ring: Polygon2['rings'][number], hole: boolean): InsetVertex[] {
  // Intersect the two inward-offset edge lines at each corner. The resulting
  // edges accept a pedestrian's whole body at an oblique curb or a corner.
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    area += a.x * b.z - b.x * a.z;
  }
  const side = Math.sign(area) * (hole ? -1 : 1);
  const normals = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: -side * dz / length, z: side * dx / length };
  });
  return ring.map((v, i) => {
    const a = normals[(i + ring.length - 1) % ring.length], b = normals[i];
    const denominator = 1 + a.x * b.x + a.z * b.z;
    return denominator > 1e-6
      ? { ...v, insetX: (a.x + b.x) / denominator, insetZ: (a.z + b.z) / denominator }
      : { ...v, insetX: b.x, insetZ: b.z };
  });
}

const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Locations inside the sidewalks at each open curb. Geometry is shared by all
 * pedestrians; visibility and queue density are checked only on a decision. */
export class CrossingExits {
  private readonly landings: Landing[] = [];
  private readonly sidewalks: PolygonRegion[] | undefined;
  private readonly rings: InsetVertex[][];
  private readonly candidates: Candidate[] = [];
  private readonly curb = { x: 0, z: 0, distance: 0 };
  private readonly intermediate = { x: 0, z: 0 };
  private search?: { parent: Int32Array; depth: Uint32Array; queue: Int32Array };

  constructor(private readonly nav: Navigation, private readonly grid: SpatialGrid) {
    this.sidewalks = nav.scenario.urbanMap?.sidewalks.map(p => new PolygonRegion([p]));
    this.rings = nav.scenario.urbanMap?.sidewalks.flatMap(p => p.rings.map((r, i) => insetRing(r, i > 0))) ?? [];
    const geometry = nav.scramble!;
    const { columns, rows, walkable, cellSize } = nav;
    const { minX, minZ } = nav.scenario.bounds;
    // Spawn cells already have at least 0.7 m of sidewalk clearance. Keep the
    // first row facing each open road, including the oblique curbs on real maps.
    const road = new Int8Array(walkable.length);
    const reach = Math.ceil(0.7 / cellSize) + 1;
    for (const cell of nav.spawnCells) {
      const cx = cell % columns, cz = Math.floor(cell / columns);
      let atCurb = false;
      for (let dz = -reach; dz <= reach && !atCurb; dz++) for (let dx = -reach; dx <= reach; dx++) {
        if (cx + dx < 0 || cx + dx >= columns || cz + dz < 0 || cz + dz >= rows) continue;
        const neighbor = cell + dz * columns + dx;
        if (!walkable[neighbor]) continue;
        if (!road[neighbor]) {
          const nx = minX + (cx + dx + 0.5) * cellSize, nz = minZ + (cz + dz + 0.5) * cellSize;
          road[neighbor] = geometry.isSidewalk(nx, nz) ? -1 : 1;
        }
        if (road[neighbor] === 1) { atCurb = true; break; }
      }
      if (atCurb) {
        const x = minX + (cx + 0.5) * cellSize, z = minZ + (cz + 0.5) * cellSize;
        this.landings.push({ x, z, sidewalk: this.sidewalkAt(x, z), cell: grid.cellAt(x, z) });
      }
    }
  }

  private sidewalkAt(x: number, z: number): number {
    if (!Number.isFinite(x + z)) return -1;
    if (this.sidewalks) return this.sidewalks.findIndex(sidewalk => sidewalk.contains(x, z));
    return (x > 0 ? 1 : 0) + (z > 0 ? 2 : 0);
  }

  /** Compare reachable distances from the signal-change position. The original
   * trip, entry side and queue density do not affect which sidewalk is nearest. */
  choose(x: number, z: number, radius: number, out: Point2, firstWaypoint: Point2, requiredSide?: number): boolean {
    const inset = radius + 0.01; // Keep the chosen landing inside after Float32 integration.
    let count = 0, nearest = 0;
    const add = (px: number, pz: number) => {
      const c = this.candidates[count] ??= { x: 0, z: 0, distance: 0 };
      c.x = px; c.z = pz; c.distance = Math.hypot(px - x, pz - z);
      if (c.distance < this.candidates[nearest].distance) nearest = count;
      count++;
    };
    for (const ring of this.rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const ax = a.x + inset * a.insetX, az = a.z + inset * a.insetZ;
      const dx = b.x + inset * b.insetX - ax, dz = b.z + inset * b.insetZ - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      add(ax + dx * t, az + dz * t);
    }
    if (!this.sidewalks) {
      const edge = this.nav.scenario.scramble!.roadHalfWidth + inset;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        add(sx * Math.max(edge, sx * x), sz * Math.max(edge, sz * z));
      }
    }
    // Also cover partial openings where the perpendicular to a curb lies
    // behind a wall or outside the permitted crossing surface.
    for (const landing of this.landings) add(landing.x, landing.z);
    // A visible straight line to the closest candidate is already optimal.
    // Most walkers on a painted crossing can skip ranking every other curb.
    const closest = this.candidates[nearest];
    if (closest && (requiredSide === undefined || this.sidewalkAt(closest.x, closest.z) === requiredSide)
      && this.nav.scramble!.isSidewalk(closest.x, closest.z, radius)
      && this.nav.lineOfSight(x, z, closest.x, closest.z, radius, true)) {
      out.x = firstWaypoint.x = closest.x;
      out.z = firstWaypoint.z = closest.z;
      return true;
    }
    this.candidates.sort((a, b) => a.distance - b.distance);
    let best = Infinity, searched = false, hasTree = false;
    for (const c of this.candidates) {
      if (c.distance >= best) break;
      if (requiredSide !== undefined && this.sidewalkAt(c.x, c.z) !== requiredSide) continue;
      if (!this.nav.scramble!.isSidewalk(c.x, c.z, radius)) continue;
      let distance = c.distance;
      if (this.nav.lineOfSight(x, z, c.x, c.z, radius, true)) {
        this.intermediate.x = c.x; this.intermediate.z = c.z;
      } else {
        if (!searched) { hasTree = this.exploreCrossing(x, z, radius); searched = true; }
        if (!hasTree) continue;
        distance = this.routeToLanding(x, z, radius, c.x, c.z, this.intermediate);
      }
      if (distance < best) {
        best = distance; out.x = c.x; out.z = c.z;
        firstWaypoint.x = this.intermediate.x; firstWaypoint.z = this.intermediate.z;
      }
    }
    return Number.isFinite(best);
  }

  /** In a packed approach, look farther along the same bank. A clear landing
   * behind a solid queue is less useful than a gap visible all the way in. */
  private crowdedLanding(x: number, z: number, radius: number, side: number, landingX: number, landingZ: number, out: Point2): boolean {
    const occupiedCell = this.grid.cellAt(x, z);
    if (this.grid.counts[occupiedCell] < 6) return false;
    let best = Infinity, chosen: Landing | undefined;
    for (const landing of this.landings) {
      if (landing.sidewalk !== side) continue;
      const shift = Math.hypot(landing.x - landingX, landing.z - landingZ);
      if (shift <= 0.2 || shift > 12) continue;
      const dx = landing.x - x, dz = landing.z - z, distance = Math.hypot(dx, dz);
      if (!distance || !this.nav.lineOfSight(x, z, landing.x, landing.z, radius, true)) continue;
      let samples = 0, occupants = 0, peak = 0;
      // Include the first stride on the sidewalk as well as the way to the curb.
      for (let d = 0.65; d <= distance + 1.2; d += 0.75) {
        const cell = this.grid.cellAt(x + dx * d / distance, z + dz * d / distance);
        if (cell === occupiedCell) continue;
        const count = this.grid.counts[cell];
        samples++; occupants += count; peak = Math.max(peak, count);
      }
      const score = distance + shift * 0.1 + 0.65 * occupants / Math.max(1, samples)
        + 0.4 * (peak + this.grid.counts[landing.cell]);
      if (score < best) { best = score; chosen = landing; }
    }
    if (!chosen) return false;
    out.x = chosen.x; out.z = chosen.z;
    return true;
  }

  /** Look across the same exit mouth for a less obstructed path inland. */
  reselect(x: number, z: number, radius: number, landingX: number, landingZ: number, out: Point2): boolean {
    const side = this.sidewalkAt(landingX, landingZ);
    if (this.crowdedLanding(x, z, radius, side, landingX, landingZ, out)) return true;
    // At the chosen curb, try a short step inland before seeking a landing farther along it.
    const polygon = this.sidewalks?.[side];
    if (polygon?.nearest(x, z, 1.2, this.curb)) {
      const inward = polygon.contains(x, z) ? 1 : -1;
      const travel = (radius + 0.65) * inward - this.curb.distance;
      const px = x + this.curb.x * travel, pz = z + this.curb.z * travel;
      // A failed attempt at this same patch of sidewalk should reopen the other landing choices.
      if (Math.hypot(px - landingX, pz - landingZ) > 0.05 && polygon.contains(px, pz, radius)
        && this.nav.lineOfSight(x, z, px, pz, radius, true)) {
        out.x = px; out.z = pz;
        return true;
      }
    }
    let best = Infinity, chosen: Landing | undefined;
    for (const landing of this.landings) {
      if (landing.sidewalk !== side) continue;
      const shift = Math.hypot(landing.x - landingX, landing.z - landingZ);
      if (shift < 0.6 || shift > 5) continue;
      const dx = landing.x - x, dz = landing.z - z, distance = Math.hypot(dx, dz);
      const approach = Math.min(distance, 1.6) / Math.max(distance, 0.001);
      const ahead = this.grid.cellAt(x + dx * approach, z + dz * approach);
      const score = distance + shift * 0.15 + this.grid.counts[landing.cell] * 0.75 + this.grid.counts[ahead] * 0.4;
      if (score < best && this.nav.lineOfSight(x, z, landing.x, landing.z, radius, true)
        && (!this.nav.urban || this.nav.urban.sidewalks.lineInside(landingX, landingZ, landing.x, landing.z, radius))) {
        best = score; chosen = landing;
      }
    }
    if (!chosen) return false;
    out.x = chosen.x; out.z = chosen.z;
    return true;
  }

  /** Avoidance may push someone around a corner of the painted surface. Find a
   * visible point on the route around that corner, retaining their chosen exit. */
  waypoint(x: number, z: number, radius: number, landingX: number, landingZ: number, out: Point2): boolean {
    if (this.nav.lineOfSight(x, z, landingX, landingZ, radius, true)) {
      out.x = landingX; out.z = landingZ; return true;
    }
    return this.exploreCrossing(x, z, radius) && Number.isFinite(this.routeToLanding(x, z, radius, landingX, landingZ, out));
  }

  /** After passing someone the old route may no longer be legal. Keep the
   * destination bank, but allow a different approach and landing on that bank. */
  recoverLanding(x: number, z: number, radius: number, oldX: number, oldZ: number, landing: Point2, waypoint: Point2): boolean {
    landing.x = oldX; landing.z = oldZ;
    if (this.waypoint(x, z, radius, oldX, oldZ, waypoint)) return true;
    if (this.reselect(x, z, radius, oldX, oldZ, landing)) {
      waypoint.x = landing.x; waypoint.z = landing.z;
      return true;
    }
    const bank = this.sidewalkAt(oldX, oldZ);
    return bank >= 0 && this.choose(x, z, radius, landing, waypoint, bank);
  }

  /** Build one road-only search tree, shared by every landing considered in this decision. */
  private exploreCrossing(x: number, z: number, radius: number): boolean {
    const nav = this.nav, start = nav.nearestVisibleCell(x, z, radius);
    if (start < 0) return false;
    const size = nav.walkable.length;
    this.search ??= { parent: new Int32Array(size), depth: new Uint32Array(size), queue: new Int32Array(size) };
    const { queue, parent, depth } = this.search;
    parent.fill(-1); parent[start] = start; depth[start] = 0; queue[0] = start;
    const { minX, minZ } = nav.scenario.bounds;
    let tail = 1;
    for (let head = 0; head < tail; head++) {
      const cell = queue[head];
      for (const [dx, dz] of CARDINAL) {
        const next = nav.cardinalNeighbor(cell, dx, dz);
        if (next < 0 || parent[next] >= 0) continue;
        const nx = minX + (next % nav.columns + 0.5) * nav.cellSize;
        const nz = minZ + (Math.floor(next / nav.columns) + 0.5) * nav.cellSize;
        // A detour may turn at a zebra junction, but may not lead across a
        // third sidewalk and start another crossing during red.
        if (nav.scramble!.isSidewalk(nx, nz, radius)) continue;
        parent[next] = cell; depth[next] = depth[cell] + 1; queue[tail++] = next;
      }
    }
    return true;
  }

  private routeToLanding(x: number, z: number, radius: number, landingX: number, landingZ: number, out: Point2): number {
    const nav = this.nav, { parent, depth } = this.search!;
    const { minX, minZ } = nav.scenario.bounds;
    const goal = nav.cellAt(landingX, landingZ), cx = goal % nav.columns, cz = Math.floor(goal / nav.columns);
    const reach = Math.ceil(0.7 / nav.cellSize) + 1;
    let approach = -1, best = Infinity;
    for (let nz = Math.max(0, cz - reach); nz <= Math.min(nav.rows - 1, cz + reach); nz++) {
      for (let nx = Math.max(0, cx - reach); nx <= Math.min(nav.columns - 1, cx + reach); nx++) {
        const cell = nz * nav.columns + nx;
        if (parent[cell] < 0) continue;
        const px = minX + (nx + 0.5) * nav.cellSize, pz = minZ + (nz + 0.5) * nav.cellSize;
        const cost = depth[cell] * nav.cellSize + Math.hypot(landingX - px, landingZ - pz);
        if (cost < best && nav.lineOfSight(px, pz, landingX, landingZ, radius, true)) {
          best = cost; approach = cell;
        }
      }
    }
    if (approach < 0) return Infinity;
    for (let cell = approach; ; cell = parent[cell]) {
      const px = minX + (cell % nav.columns + 0.5) * nav.cellSize;
      const pz = minZ + (Math.floor(cell / nav.columns) + 0.5) * nav.cellSize;
      if (nav.lineOfSight(x, z, px, pz, radius, true)) {
        out.x = px; out.z = pz;
        return Math.hypot(px - x, pz - z) + best - depth[cell] * nav.cellSize;
      }
      if (cell === parent[cell]) return Infinity;
    }
  }

}
