import type { Scenario } from '../types';
import type { Direction } from './Navigation';

interface Corridor { x: number; z: number; ux: number; uz: number; length: number; halfWidth: number }

/** Shared sidewalk/crosswalk boundary; steering and pathfinding use the same painted corridors. */
export class ScrambleGeometry {
  readonly halfWidth: number;
  private readonly corridors: Corridor[];
  private readonly intervalStarts: Float64Array;
  private readonly intervalEnds: Float64Array;
  constructor(scenario: Scenario) {
    if (!scenario.scramble) throw new Error('Scramble geometry requires a road layout.');
    this.halfWidth = scenario.scramble.roadHalfWidth;
    this.corridors = scenario.scramble.crosswalks.map(crosswalk => {
      const dx = crosswalk.to.x - crosswalk.from.x, dz = crosswalk.to.z - crosswalk.from.z, length = Math.hypot(dx, dz);
      return { x: crosswalk.from.x, z: crosswalk.from.z, ux: dx / length, uz: dz / length, length, halfWidth: crosswalk.width / 2 };
    });
    this.intervalStarts = new Float64Array(4 + this.corridors.length);
    this.intervalEnds = new Float64Array(4 + this.corridors.length);
  }
  isSidewalk(x: number, z: number, radius = 0): boolean {
    return Math.abs(x) >= this.halfWidth + radius && Math.abs(z) >= this.halfWidth + radius;
  }
  isWalkable(x: number, z: number, radius = 0): boolean {
    if (this.isSidewalk(x, z, radius)) return true;
    for (const corridor of this.corridors) {
      const dx = x - corridor.x, dz = z - corridor.z;
      const along = dx * corridor.ux + dz * corridor.uz;
      const across = dx * corridor.uz - dz * corridor.ux;
      if (along >= radius && along <= corridor.length - radius && Math.abs(across) <= corridor.halfWidth - radius) return true;
    }
    return false;
  }
  private interval(index: number, x: number, z: number, dx: number, dz: number, left: number, right: number, top: number, bottom: number): void {
    let enter = 0, leave = 1;
    if (Math.abs(dx) < 1e-10) {
      if (x < left || x > right) { this.intervalEnds[index] = -1; return; }
    } else {
      const a = (left - x) / dx, b = (right - x) / dx;
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
    }
    if (Math.abs(dz) < 1e-10) {
      if (z < top || z > bottom) { this.intervalEnds[index] = -1; return; }
    } else {
      const a = (top - z) / dz, b = (bottom - z) / dz;
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
    }
    this.intervalStarts[index] = enter;
    this.intervalEnds[index] = leave >= enter ? leave : -1;
  }
  /** Exact interval coverage of the union avoids sampling long paths every simulation step. */
  lineWalkable(x: number, z: number, tx: number, tz: number, radius = 0): boolean {
    const h = this.halfWidth + radius;
    if (Math.abs(x) >= h && Math.abs(z) >= h && Math.abs(tx) >= h && Math.abs(tz) >= h && x * tx > 0 && z * tz > 0) return true;
    const dx = tx - x, dz = tz - z;
    this.interval(0, x, z, dx, dz, -Infinity, -h, -Infinity, -h);
    this.interval(1, x, z, dx, dz, h, Infinity, -Infinity, -h);
    this.interval(2, x, z, dx, dz, -Infinity, -h, h, Infinity);
    this.interval(3, x, z, dx, dz, h, Infinity, h, Infinity);
    for (let i = 0; i < this.corridors.length; i++) {
      const corridor = this.corridors[i], px = x - corridor.x, pz = z - corridor.z;
      this.interval(i + 4,
        px * corridor.ux + pz * corridor.uz, px * corridor.uz - pz * corridor.ux,
        dx * corridor.ux + dz * corridor.uz, dx * corridor.uz - dz * corridor.ux,
        radius, corridor.length - radius, -corridor.halfWidth + radius, corridor.halfWidth - radius);
    }
    let covered = 0;
    for (let pass = 0; pass < this.intervalStarts.length; pass++) {
      let next = covered;
      for (let i = 0; i < this.intervalStarts.length; i++) {
        if (this.intervalStarts[i] <= covered + 1e-8 && this.intervalEnds[i] > next) next = this.intervalEnds[i];
      }
      if (next >= 1 - 1e-8) return true;
      if (next <= covered) return false;
      covered = next;
    }
    return false;
  }
  distanceToCurb(x: number, z: number, dx: number, dz: number, radius: number): number {
    let distance = Infinity;
    const h = this.halfWidth + radius + 0.08;
    if (x * dx < 0) distance = Math.min(distance, (Math.abs(x) - h) / Math.abs(dx));
    if (z * dz < 0) distance = Math.min(distance, (Math.abs(z) - h) / Math.abs(dz));
    return Math.max(0, distance);
  }
  /** Clip an integration step at the curb or zebra edge, including neighbor-induced motion. */
  constrain(x: number, z: number, nextX: number, nextZ: number, radius: number, sidewalkOnly: boolean, result: Direction): void {
    const valid = sidewalkOnly ? this.isSidewalk(nextX, nextZ, radius) : this.isWalkable(nextX, nextZ, radius);
    if (valid) { result.x = nextX; result.z = nextZ; return; }
    const h = this.halfWidth + radius;
    if (sidewalkOnly) {
      // Preserve motion parallel to the curb while rejecting its normal component.
      result.x = x < 0 ? Math.min(nextX, -h) : Math.max(nextX, h);
      result.z = z < 0 ? Math.min(nextZ, -h) : Math.max(nextZ, h);
      return;
    }
    // A convex piece containing the starting point also contains the segment to its
    // projected endpoint. Test those pieces first: no union ray test or allocation is
    // needed for the usual short step against a zebra edge.
    let best = Infinity, bestX = x, bestZ = z;
    const epsilon = 0.00002; // Float32 motion-state rounding at the edge.
    if (Math.abs(x) >= h - epsilon && Math.abs(z) >= h - epsilon) {
      bestX = x < 0 ? Math.min(nextX, -h) : Math.max(nextX, h);
      bestZ = z < 0 ? Math.min(nextZ, -h) : Math.max(nextZ, h);
      best = (bestX - nextX) ** 2 + (bestZ - nextZ) ** 2;
    }
    for (const corridor of this.corridors) {
      const oldDX = x - corridor.x, oldDZ = z - corridor.z;
      const oldAlong = oldDX * corridor.ux + oldDZ * corridor.uz;
      const oldAcross = oldDX * corridor.uz - oldDZ * corridor.ux;
      if (oldAlong < radius - epsilon || oldAlong > corridor.length - radius + epsilon
        || Math.abs(oldAcross) > corridor.halfWidth - radius + epsilon) continue;
      const dx = nextX - corridor.x, dz = nextZ - corridor.z;
      const along = Math.max(radius, Math.min(corridor.length - radius, dx * corridor.ux + dz * corridor.uz));
      const across = Math.max(-corridor.halfWidth + radius, Math.min(corridor.halfWidth - radius, dx * corridor.uz - dz * corridor.ux));
      const px = corridor.x + along * corridor.ux + across * corridor.uz;
      const pz = corridor.z + along * corridor.uz - across * corridor.ux;
      const error = (px - nextX) ** 2 + (pz - nextZ) ** 2;
      if (error < best) { best = error; bestX = px; bestZ = pz; }
    }
    if (best < Infinity) { result.x = bestX; result.z = bestZ; return; }
    this.constrainFallback(x, z, nextX, nextZ, radius, result);
  }

  /** Defensive recovery for a starting point outside every piece beyond rounding tolerance. */
  private constrainFallback(x: number, z: number, nextX: number, nextZ: number, radius: number, result: Direction): void {
    const h = this.halfWidth + radius;
    let best = Infinity, bestX = x, bestZ = z;
    const travel = Math.hypot(nextX - x, nextZ - z) + 0.001;
    const consider = (px: number, pz: number): void => {
      const error = (px - nextX) ** 2 + (pz - nextZ) ** 2;
      if (error >= best || (px - x) ** 2 + (pz - z) ** 2 > travel * travel) return;
      if (!this.lineWalkable(x, z, px, pz, Math.max(0, radius - 0.00002))) return;
      best = error; bestX = px; bestZ = pz;
    };
    consider(Math.min(nextX, -h), Math.min(nextZ, -h));
    consider(Math.max(nextX, h), Math.min(nextZ, -h));
    consider(Math.min(nextX, -h), Math.max(nextZ, h));
    consider(Math.max(nextX, h), Math.max(nextZ, h));
    for (const corridor of this.corridors) {
      const dx = nextX - corridor.x, dz = nextZ - corridor.z;
      const along = Math.max(radius, Math.min(corridor.length - radius, dx * corridor.ux + dz * corridor.uz));
      const across = Math.max(-corridor.halfWidth + radius, Math.min(corridor.halfWidth - radius, dx * corridor.uz - dz * corridor.ux));
      consider(corridor.x + along * corridor.ux + across * corridor.uz, corridor.z + along * corridor.uz - across * corridor.ux);
    }
    if (best < Infinity) { result.x = bestX; result.z = bestZ; return; }
    // Defensive fallback for a rounding error at an intersection of convex pieces.
    let low = 0, high = 1;
    for (let i = 0; i < 10; i++) {
      const middle = (low + high) * 0.5;
      const px = x + (nextX - x) * middle, pz = z + (nextZ - z) * middle;
      if (this.isWalkable(px, pz, radius)) low = middle;
      else high = middle;
    }
    result.x = x + (nextX - x) * low; result.z = z + (nextZ - z) * low;
  }
}
