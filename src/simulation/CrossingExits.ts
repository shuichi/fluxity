import type { Point2 } from '../types';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';
import { PolygonRegion } from './UrbanGeometry';

interface Landing extends Point2 { sidewalk: number; cell: number }
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Locations inside the sidewalks at each open curb. Geometry is shared by all
 * pedestrians; visibility and queue density are checked only on a decision. */
export class CrossingExits {
  private readonly landings: Landing[] = [];
  private readonly sidewalks: PolygonRegion[] | undefined;
  private readonly landingScores: Float64Array;
  private readonly intermediate = { x: 0, z: 0 };
  private search?: { parent: Int32Array; depth: Uint32Array; queue: Int32Array };

  constructor(private readonly nav: Navigation, private readonly grid: SpatialGrid) {
    this.sidewalks = nav.scenario.urbanMap?.sidewalks.map(p => new PolygonRegion([p]));
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
    this.landingScores = new Float64Array(this.landings.length);
  }

  private sidewalkAt(x: number, z: number): number {
    if (!Number.isFinite(x + z)) return -1;
    if (this.sidewalks) return this.sidewalks.findIndex(sidewalk => sidewalk.contains(x, z));
    return (x > 0 ? 1 : 0) + (z > 0 ? 2 : 0);
  }

  choose(x: number, z: number, radius: number, routeX: number, routeZ: number,
    entryX: number, entryZ: number, returning: boolean, out: Point2, firstWaypoint?: Point2): boolean {
    const entrySide = this.sidewalkAt(entryX, entryZ);
    const fromEntry = Math.hypot(x - entryX, z - entryZ);
    if (returning && entrySide < 0) return false;
    // The direction actually taken through the crossing remains meaningful even
    // when the trip's flow field starts steering toward a second zebra.
    if (entrySide >= 0 && fromEntry > 1.5) {
      routeX = (x - entryX) / fromEntry;
      routeZ = (z - entryZ) / fromEntry;
    }
    let best = Infinity, chosen: Landing | undefined;
    this.landingScores.fill(Infinity);
    for (let i = 0; i < this.landings.length; i++) {
      const landing = this.landings[i];
      if (entrySide >= 0 && (landing.sidewalk === entrySide) !== returning) continue;
      const dx = landing.x - x, dz = landing.z - z, distance = Math.hypot(dx, dz);
      let score = distance;
      if (returning) {
        const toEntry = Math.hypot(landing.x - entryX, landing.z - entryZ);
        if (toEntry > 3.5) continue;
        score += toEntry;
      } else {
        const forward = dx * routeX + dz * routeZ;
        if (entrySide < 0 && (routeX || routeZ) && forward <= 0) continue;
        score += (distance - forward) * 1.8;
      }
      score += Math.min(12, this.grid.counts[landing.cell]) * 0.17;
      this.landingScores[i] = score;
      if (score < best && this.nav.lineOfSight(x, z, landing.x, landing.z, radius)) {
        best = score; chosen = landing;
      }
    }
    if (chosen) {
      out.x = chosen.x; out.z = chosen.z;
      if (firstWaypoint) { firstWaypoint.x = out.x; firstWaypoint.z = out.z; }
      return true;
    }
    // A narrow entrance need not have a sidewalk raster centre directly in
    // sight. The saved last sidewalk position is still a valid way back.
    if (returning && this.nav.scramble!.isSidewalk(entryX, entryZ, radius)
      && this.nav.lineOfSight(x, z, entryX, entryZ, radius)) {
      out.x = entryX; out.z = entryZ;
      if (firstWaypoint) { firstWaypoint.x = out.x; firstWaypoint.z = out.z; }
      return true;
    }
    // A bend can conceal the whole destination curb. Only then search for a
    // route to the eligible landings in the same order as the direct choices.
    if (!returning && this.exploreCrossing(x, z, radius)) {
      const ranked = this.landings.map((_, i) => i).filter(i => Number.isFinite(this.landingScores[i]))
        .sort((a, b) => this.landingScores[a] - this.landingScores[b]);
      for (const i of ranked) {
        const landing = this.landings[i];
        if (this.visibleWaypoint(x, z, radius, landing.x, landing.z, firstWaypoint ?? this.intermediate)) {
          out.x = landing.x; out.z = landing.z; return true;
        }
      }
    }
    return false;
  }

  /** Look across the same exit mouth for a less obstructed path inland. */
  reselect(x: number, z: number, radius: number, landingX: number, landingZ: number, out: Point2): boolean {
    const side = this.sidewalkAt(landingX, landingZ);
    let best = Infinity, chosen: Landing | undefined;
    for (const landing of this.landings) {
      if (landing.sidewalk !== side) continue;
      const shift = Math.hypot(landing.x - landingX, landing.z - landingZ);
      if (shift < 0.6 || shift > 5) continue;
      const dx = landing.x - x, dz = landing.z - z, distance = Math.hypot(dx, dz);
      const approach = Math.min(distance, 1.6) / Math.max(distance, 0.001);
      const ahead = this.grid.cellAt(x + dx * approach, z + dz * approach);
      const score = distance + shift * 0.15 + this.grid.counts[landing.cell] * 0.75 + this.grid.counts[ahead] * 0.4;
      if (score < best && this.nav.lineOfSight(x, z, landing.x, landing.z, radius)
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
    if (this.nav.lineOfSight(x, z, landingX, landingZ, radius)) {
      out.x = landingX; out.z = landingZ; return true;
    }
    return this.exploreCrossing(x, z, radius) && this.visibleWaypoint(x, z, radius, landingX, landingZ, out);
  }

  /** Build one road-only search tree, shared by every landing considered in this decision. */
  private exploreCrossing(x: number, z: number, radius: number): boolean {
    const nav = this.nav, start = this.nearestVisibleCell(x, z, radius);
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

  private visibleWaypoint(x: number, z: number, radius: number, landingX: number, landingZ: number, out: Point2): boolean {
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
        if (cost < best && nav.lineOfSight(px, pz, landingX, landingZ, radius)) {
          best = cost; approach = cell;
        }
      }
    }
    if (approach < 0) return false;
    for (let cell = approach; ; cell = parent[cell]) {
      const px = minX + (cell % nav.columns + 0.5) * nav.cellSize;
      const pz = minZ + (Math.floor(cell / nav.columns) + 0.5) * nav.cellSize;
      if (nav.lineOfSight(x, z, px, pz, radius)) {
        out.x = px; out.z = pz; return true;
      }
      if (cell === parent[cell]) return false;
    }
  }

  private nearestVisibleCell(x: number, z: number, radius: number): number {
    const nav = this.nav, cell = nav.cellAt(x, z);
    const cx = cell % nav.columns, cz = Math.floor(cell / nav.columns);
    let best = Infinity, chosen = -1;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= nav.columns || nz < 0 || nz >= nav.rows) continue;
      const next = nz * nav.columns + nx;
      if (!nav.walkable[next]) continue;
      const px = nav.scenario.bounds.minX + (nx + 0.5) * nav.cellSize;
      const pz = nav.scenario.bounds.minZ + (nz + 0.5) * nav.cellSize;
      const distance = (px - x) ** 2 + (pz - z) ** 2;
      if (distance < best && nav.lineOfSight(x, z, px, pz, radius)) {
        best = distance; chosen = next;
      }
    }
    return chosen;
  }
}
