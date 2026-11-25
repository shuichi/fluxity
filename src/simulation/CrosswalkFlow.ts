import { Random } from '../math/random';
import type { Point2, Scenario } from '../types';
import type { Direction, Navigation } from './Navigation';

type Marking = NonNullable<Scenario['scramble']>['crosswalks'][number];
interface Track { offset: number; start: number; end: number }
interface Crossing { from: Point2; ux: number; uz: number; length: number; width: number; tracks: Track[]; forward: number; reverse: number }
const APPROACH = 12; // Begin spreading across the mouth while still on the sidewalk.
const BODY_CLEARANCE = 0.34;
const NO_CROSSING = -32768;

/** Individual crossing tracks overlay the trip flow field from the approach to the far curb. */
export class CrosswalkFlow {
  private readonly crossings: Crossing[];
  private readonly midlines: Int16Array;
  private readonly nearby: Uint8Array;
  private readonly routes: Int16Array[];
  private readonly maxSteps: number;
  private readonly active: Int16Array;
  private readonly selected: Track[];

  constructor(private readonly nav: Navigation, count: number, private readonly seed: number) {
    this.midlines = new Int16Array(nav.walkable.length);
    this.nearby = new Uint8Array(nav.walkable.length);
    this.crossings = nav.scenario.scramble!.crosswalks.map(mark => this.buildCrossing(mark)).filter(c => c !== undefined);
    this.maxSteps = Math.ceil((APPROACH + Math.max(0, ...this.crossings.map(c => c.length)) / 2) * 1.5 / nav.cellSize);
    this.routes = nav.fields.map(() => new Int16Array(nav.walkable.length));
    this.active = new Int16Array(count);
    this.selected = new Array(count);
    const { minX, minZ } = nav.scenario.bounds;
    for (let i = 0; i < this.crossings.length; i++) {
      const c = this.crossings[i];
      const halfWidth = c.width / 2;
      for (let cell = 0; cell < nav.walkable.length; cell++) {
        if (!nav.walkable[cell]) continue;
        const dx = minX + (cell % nav.columns + 0.5) * nav.cellSize - c.from.x;
        const dz = minZ + (Math.floor(cell / nav.columns) + 0.5) * nav.cellSize - c.from.z;
        const along = dx * c.ux + dz * c.uz, across = Math.abs(dx * c.uz - dz * c.ux);
        if (along < -APPROACH || along > c.length + APPROACH || across > halfWidth + APPROACH) continue;
        this.nearby[cell] = 1;
        if (Math.abs(along - c.length / 2) <= nav.cellSize && across <= halfWidth) this.midlines[cell] = i + 1;
      }
    }
  }

  private buildCrossing({ from, to, width }: Marking): Crossing | undefined {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    if (!(length > 0 && width >= 2 * BODY_CLEARANCE && Number.isFinite(length + width))) return;
    const ux = (to.x - from.x) / length, uz = (to.z - from.z) / length;
    const tracks: Track[] = [], span = Math.max(0, width - 2 * (BODY_CLEARANCE + 0.12));
    const count = Math.max(1, Math.ceil(span / 0.55) + 1);
    for (let k = 0; k < count; k++) {
      const offset = count === 1 ? 0 : span * (k / (count - 1) - 0.5);
      const x = from.x + uz * offset, z = from.z - ux * offset;
      // At skewed curbs, different parts of the same marking land at different distances.
      const landing = (sign: number): number => {
        for (let a = length / 2; a >= 0 && a <= length; a += sign * 0.4) {
          const px = x + a * ux, pz = z + a * uz;
          if (this.nav.scramble!.isSidewalk(px, pz, BODY_CLEARANCE)) return a;
        }
        return NaN;
      };
      const start = landing(-1), end = landing(1);
      if (start < end && this.nav.lineOfSight(x + start * ux, z + start * uz, x + end * ux, z + end * uz, BODY_CLEARANCE)) {
        tracks.push({ offset, start, end });
      }
    }
    if (tracks.length) return { from, ux, uz, length, width, tracks, forward: 0, reverse: 0 };
  }

  /** Follow the existing route to its first zebra midline. Cache both hits and misses by cell and destination. */
  private upcoming(startCell: number, target: number): number {
    if (!this.nearby[startCell]) return 0;
    const cache = this.routes[target], cached = cache[startCell];
    if (cached) return cached === NO_CROSSING ? 0 : cached;
    const field = this.nav.fields[target];
    let routeCell = startCell, signedCrossing = 0;
    for (let step = 0; step < this.maxSteps && this.nearby[routeCell]; step++) {
      const dx = Math.sign(field.x[routeCell]), dz = Math.sign(field.z[routeCell]);
      if (!dx && !dz) break;
      const crossingIndex = this.midlines[routeCell];
      if (crossingIndex) {
        const crossing = this.crossings[crossingIndex - 1];
        const forward = dx * crossing.ux + dz * crossing.uz;
        if (Math.abs(forward) > 0.35) { signedCrossing = crossingIndex * Math.sign(forward); break; }
      }
      routeCell += dx + dz * this.nav.columns;
    }
    cache[startCell] = signedCrossing || NO_CROSSING;
    return signedCrossing;
  }

  reset(id: number): void {
    const route = this.active[id];
    if (!route) return;
    const c = this.crossings[Math.abs(route) - 1];
    if (route > 0) c.forward--; else c.reverse--;
    this.active[id] = 0;
  }

  guide(id: number, generation: number, x: number, z: number, target: number, radius: number, out: Direction): boolean {
    const activeCrossing = this.active[id];
    const signedCrossing = activeCrossing || this.upcoming(this.nav.cellAt(x, z), target);
    if (!signedCrossing) return false;
    const crossing = this.crossings[Math.abs(signedCrossing) - 1], sign = Math.sign(signedCrossing);
    const along = (x - crossing.from.x) * crossing.ux + (z - crossing.from.z) * crossing.uz;
    const positionAcross = (x - crossing.from.x) * crossing.uz - (z - crossing.from.z) * crossing.ux;
    // Keep the current trip direction when a different marking is still underfoot.
    if (!activeCrossing && (along < -radius || along > crossing.length + radius || Math.abs(positionAcross) > crossing.width / 2 + radius)
      && !this.nav.scramble!.isSidewalk(x, z, radius)) return false;
    if (sign * (along - crossing.length / 2) > 0 && this.nav.scramble!.isSidewalk(x, z, radius)) {
      this.reset(id);
      return false;
    }
    let track = this.selected[id];
    if (!activeCrossing) {
      const rng = new Random(this.seed ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(generation + 1, 0x85ebca77) ^ Math.imul(Math.abs(signedCrossing), 0x27d4eb2d));
      // Opposing groups keep to their passing side in proportion to their size.
      // One-way traffic uses the full stripe. Established tracks stay in place.
      const opposing = sign > 0 ? crossing.reverse : crossing.forward;
      const share = 1 - opposing / (crossing.forward + crossing.reverse + 2);
      const position = rng.next() * share;
      const rank = sign > 0 ? 1 - position : position;
      track = crossing.tracks[Math.min(crossing.tracks.length - 1, Math.floor(rank * crossing.tracks.length))];
      const entry = sign > 0 ? track.start : track.end;
      const entryX = crossing.from.x + crossing.ux * entry + crossing.uz * track.offset;
      const entryZ = crossing.from.z + crossing.uz * entry - crossing.ux * track.offset;
      if (this.nav.scramble!.isSidewalk(x, z, radius) &&
        (Math.hypot(entryX - x, entryZ - z) > APPROACH ||
          (this.nav.urban && !this.nav.urban.sidewalks.lineInside(x, z, entryX, entryZ, radius)))) return false;
    }
    const trackX = crossing.from.x + crossing.uz * track.offset, trackZ = crossing.from.z - crossing.ux * track.offset;
    // Merge gradually when arriving on a different track, maintaining forward progress.
    const lateralError = (x - trackX) * crossing.uz - (z - trackZ) * crossing.ux;
    const lookahead = Math.max(2.6, 1.6 * Math.abs(lateralError));
    let ahead = Math.max(track.start, Math.min(track.end, along + sign * lookahead));
    let aimX = trackX + crossing.ux * ahead, aimZ = trackZ + crossing.uz * ahead;
    // The aim point is inside the chosen zebra. Intersect the approach segment
    // with its length and usable width, and keep everything before that first
    // intersection on the sidewalk, including at corners shared by two zebras.
    const sidewalk = this.nav.urban?.sidewalks;
    let leavesSidewalkEarly = false;
    if (sidewalk && sidewalk.contains(x, z, radius)) {
      const across = lateralError + track.offset, usableHalfWidth = crossing.width / 2 - radius;
      let entryFraction = 0;
      if (along < 0) entryFraction = -along / (ahead - along);
      if (along > crossing.length) entryFraction = (crossing.length - along) / (ahead - along);
      if (Math.abs(across) > usableHalfWidth) entryFraction = Math.max(entryFraction, (Math.abs(across) - usableHalfWidth) / Math.abs(lateralError));
      if (entryFraction > 0) {
        const firstX = x + (aimX - x) * entryFraction, firstZ = z + (aimZ - z) * entryFraction;
        leavesSidewalkEarly = !sidewalk.lineInside(x, z, firstX, firstZ, radius);
      }
    }
    if (leavesSidewalkEarly || !this.nav.lineOfSight(x, z, aimX, aimZ, radius)) {
      // Approaching from the side may require following the sidewalk up to the mouth first.
      ahead = sign > 0 ? track.start : track.end;
      if (sign * (ahead - along) < -2.6) return false;
      aimX = trackX + crossing.ux * ahead; aimZ = trackZ + crossing.uz * ahead;
      if ((leavesSidewalkEarly && !sidewalk!.lineInside(x, z, aimX, aimZ, radius)) || !this.nav.lineOfSight(x, z, aimX, aimZ, radius)) return false;
    }
    const distance = Math.hypot(aimX - x, aimZ - z);
    if (distance < 0.05) return false;
    if (!activeCrossing) {
      this.selected[id] = track; this.active[id] = signedCrossing;
      if (signedCrossing > 0) crossing.forward++; else crossing.reverse++;
    }
    out.x = (aimX - x) / distance; out.z = (aimZ - z) / distance;
    return true;
  }
}
