import type { PedestrianPortal, Point2 } from '../types';
import type { AgentData } from './AgentData';
import type { SpatialGrid } from './SpatialGrid';
import type { Navigation } from './Navigation';

/** Allow for shoulders and a little space between two walkers in a doorway. */
export function doorwayRadius(scale: number): number { return 0.35 * scale + 0.015; }

/** Local reservations for one fixed tick, shared by the sidewalk and the door lanes. */
export class DoorwayClearance {
  readonly cells: Uint8Array;

  private readonly normalsX = new Float64Array(128);
  private readonly normalsZ = new Float64Array(128);
  private readonly gaps = new Float64Array(128);

  constructor(doors: PedestrianPortal[], private readonly grid: SpatialGrid, private readonly agents: AgentData,
    private readonly navigation: Navigation) {
    this.cells = new Uint8Array(grid.counts.length);
    for (const { approach, end, width, queueApproach } of doors) {
      // Include the queue along the storefront and the pedestrians approaching it.
      const margin = width / 2 + 5;
      const queue = queueApproach ?? approach;
      const first = grid.cellAt(Math.min(approach.x - margin, end.x - margin, queue.x - 1.5),
        Math.min(approach.z - margin, end.z - margin, queue.z - 1.5));
      const last = grid.cellAt(Math.max(approach.x + margin, end.x + margin, queue.x + 1.5),
        Math.max(approach.z + margin, end.z + margin, queue.z + 1.5));
      for (let row = Math.floor(first / grid.columns); row <= Math.floor(last / grid.columns); row++) {
        this.cells.fill(1, row * grid.columns + first % grid.columns, row * grid.columns + last % grid.columns + 1);
      }
    }
  }

  /**
   * A lane walker must follow its line. A walker on open sidewalk may also slide
   * alongside a neighbor, provided the adjusted step still clears walls and curbs.
   */
  limit(id: number, x: number, z: number, dt: number, result: Point2, sidewalkOnly?: boolean): boolean {
    const grid = this.grid, a = this.agents, read = a.current;
    result.x = x; result.z = z;
    if (!this.cells[grid.cells[id]] && !this.cells[grid.cellAt(x, z)]) return true;
    const sx = read.x[id], sz = read.z[id], vx = x - sx, vz = z - sz;
    if (vx === 0 && vz === 0) return true;
    const radius = doorwayRadius(a.scale[id]);
    // 5.4 m/s bounds a full-speed neighbor's displacement during this tick.
    const reach = radius + doorwayRadius(1.13) + Math.hypot(vx, vz) + 5.4 * dt + 0.001;
    const first = grid.cellAt(sx - reach, sz - reach), last = grid.cellAt(sx + reach, sz + reach);
    let count = 0, examined = 0, fraction = 1;
    for (let row = Math.floor(first / grid.columns); row <= Math.floor(last / grid.columns); row++) {
      for (let col = first % grid.columns; col <= last % grid.columns; col++) {
        const cell = row * grid.columns + col;
        for (let k = grid.offsets[cell]; k < grid.offsets[cell + 1]; k++) {
          const j = grid.indices[k];
          if (j === id) continue;
          if (++examined > this.gaps.length) { result.x = sx; result.z = sz; return false; }
          const dx = read.x[j] - sx, dz = read.z[j] - sz;
          const distance2 = dx * dx + dz * dz;
          if (distance2 > reach * reach || distance2 === 0) continue;
          const distance = Math.sqrt(distance2), nx = dx / distance, nz = dz / distance;
          // Earlier slots have reserved their actual motion. Later slots still occupy
          // their current positions and will in turn yield to this accepted step.
          const otherAway = j < id ? nx * (a.next.x[j] - read.x[j]) + nz * (a.next.z[j] - read.z[j]) : 0;
          const gap = Math.max(0, distance - radius - doorwayRadius(a.scale[j]) - 0.0001);
          const available = Math.max(0, gap + otherAway);
          this.normalsX[count] = nx; this.normalsZ[count] = nz; this.gaps[count++] = available;
          const toward = nx * vx + nz * vz;
          if (toward > available) fraction = Math.min(fraction, available / toward);
        }
      }
    }
    if (fraction >= 1) return true;
    result.x = sx + fraction * vx; result.z = sz + fraction * vz;
    if (sidewalkOnly === undefined) return false;
    const clearance = a.radius[id] + 0.015;

    // Project the sidewalk step onto the allowed half-planes. On contact with a
    // new boundary, slide along it as far as the preceding neighbors permit.
    let mx = vx, mz = vz;
    let canSlide = true;
    for (let k = 0; k < count; k++) {
      const nx = this.normalsX[k], nz = this.normalsZ[k], gap = this.gaps[k];
      if (nx * mx + nz * mz <= gap + 1e-9) continue;
      const bx = nx * gap, bz = nz * gap, tx = -nz, tz = nx;
      let min = -Infinity, max = Infinity;
      for (let j = 0; j < k; j++) {
        const jx = this.normalsX[j], jz = this.normalsZ[j];
        const along = jx * tx + jz * tz;
        const remaining = this.gaps[j] - jx * bx - jz * bz;
        if (along > 1e-10) max = Math.min(max, remaining / along);
        else if (along < -1e-10) min = Math.max(min, remaining / along);
      }
      if (min > max) { canSlide = false; break; }
      const slide = Math.max(min, Math.min(max, vx * tx + vz * tz));
      mx = bx + tx * slide; mz = bz + tz * slide;
    }
    const px = Math.fround(sx + mx), pz = Math.fround(sz + mz);
    if (canSlide && this.permitsStep(sx, sz, px, pz, clearance, sidewalkOnly)) {
      result.x = px; result.z = pz; return false;
    }
    // At a facade, a shortened straight step may round outside the polygon
    // even when the requested step and the unrounded endpoint are both valid.
    // Shortening on the same segment preserves every neighbor reservation.
    if (this.permitsStep(sx, sz, Math.fround(result.x), Math.fround(result.z), clearance, sidewalkOnly)) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      fraction *= 0.5;
      const fx = Math.fround(sx + fraction * vx), fz = Math.fround(sz + fraction * vz);
      if (this.permitsStep(sx, sz, fx, fz, clearance, sidewalkOnly)) {
        result.x = fx; result.z = fz; return false;
      }
    }
    result.x = sx; result.z = sz;
    return false;
  }

  private permitsStep(sx: number, sz: number, x: number, z: number, clearance: number, sidewalkOnly: boolean): boolean {
    const nav = this.navigation;
    return (!sidewalkOnly || (!!nav.scramble?.isSidewalk(x, z, clearance)
      && (!nav.urban || nav.urban.sidewalks.lineInside(sx, sz, x, z, clearance))))
      && nav.isFree(x, z, clearance) && nav.lineOfSight(sx, sz, x, z, clearance);
  }
}
