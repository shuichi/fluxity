import { Random } from '../math/random';
import type { Point2, Scenario } from '../types';
import type { AgentData } from './AgentData';
import { CrossingTraffic } from './CrossingTraffic';
import type { Direction, Navigation } from './Navigation';

type Marking = NonNullable<Scenario['scramble']>['crosswalks'][number];
interface Track {
  offset: number; start: number; end: number; startPoint: Point2; endPoint: Point2;
  forwardCost: number; reverseCost: number;
}
interface GroupTrack { center: number; members: number }
interface Crossing {
  markIndex: number; from: Point2; ux: number; uz: number; length: number; width: number; tracks: Track[];
  forward: number; reverse: number;
  forwardGroups: Map<number, GroupTrack>; reverseGroups: Map<number, GroupTrack>;
}
const APPROACH = 12; // Begin spreading across the mouth while still on the sidewalk.
export const FRONT_ROW_DEPTH = 1.6;
const BODY_CLEARANCE = 0.34;
const NO_CROSSING = -32768;
const ENTRY_SAMPLES = [-1.5, 1.5, 4.5, 7.5] as const;

function groupCenter(tracks: Track[], offset: number): number {
  const first = tracks[0].offset, last = tracks[tracks.length - 1].offset;
  const margin = Math.min(1.26, (last - first) / 2); // Four companions at 0.84 m spacing.
  return Math.max(first + margin, Math.min(last - margin, offset));
}

function nearestTrack(tracks: Track[], offset: number): Track {
  return tracks.reduce((best, t) => Math.abs(t.offset - offset) < Math.abs(best.offset - offset) ? t : best);
}

/** Individual crossing tracks overlay the trip flow field from the approach to the far curb. */
export class CrosswalkFlow {
  private readonly crossings: Crossing[];
  private readonly midlines: Int16Array;
  private readonly nearby: Uint8Array;
  private readonly routes: Int16Array[];
  private readonly maxSteps: number;
  private readonly active: Int16Array;
  private readonly selected: Track[];
  private readonly groups: Int32Array;
  private readonly traffic?: CrossingTraffic;
  /** Counts committed entries whose track changed because of measured traffic. */
  densityDiversions = 0;

  constructor(private readonly nav: Navigation, count: number, private readonly seed: number, densityGuidance = false) {
    this.midlines = new Int16Array(nav.walkable.length);
    this.nearby = new Uint8Array(nav.walkable.length);
    this.crossings = nav.scenario.scramble!.crosswalks.map((mark, i) => this.buildCrossing(mark, i)).filter(c => c !== undefined);
    this.maxSteps = Math.ceil((APPROACH + Math.max(0, ...this.crossings.map(c => c.length)) / 2) * 1.5 / nav.cellSize);
    this.routes = nav.fields.map(() => new Int16Array(nav.walkable.length));
    this.active = new Int16Array(count);
    this.selected = new Array(count);
    this.groups = new Int32Array(count).fill(-1);
    if (densityGuidance && this.crossings.length) {
      const ends = this.crossings.flatMap(c => [c.from, { x: c.from.x + c.ux * c.length, z: c.from.z + c.uz * c.length }]);
      const margin = APPROACH + Math.max(...this.crossings.map(c => c.width / 2));
      this.traffic = new CrossingTraffic({
        minX: Math.min(...ends.map(p => p.x)) - margin, maxX: Math.max(...ends.map(p => p.x)) + margin,
        minZ: Math.min(...ends.map(p => p.z)) - margin, maxZ: Math.max(...ends.map(p => p.z)) + margin,
      });
    }
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

  private buildCrossing({ from, to, width }: Marking, markIndex: number): Crossing | undefined {
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
        tracks.push({ offset, start, end,
          startPoint: { x: x + start * ux, z: z + start * uz }, endPoint: { x: x + end * ux, z: z + end * uz },
          forwardCost: 0, reverseCost: 0 });
      }
    }
    if (tracks.length) return { markIndex, from, ux, uz, length, width, tracks, forward: 0, reverse: 0,
      forwardGroups: new Map(), reverseGroups: new Map() };
  }

  /** Refresh entry costs from the previous tick's read-only motion state, before choosing tracks. */
  updateTraffic(agents: AgentData, dt: number): void {
    const traffic = this.traffic;
    if (!traffic || !traffic.update(agents, dt)) return;
    for (const c of this.crossings) {
      for (const track of c.tracks) {
        const x = c.from.x + c.uz * track.offset, z = c.from.z - c.ux * track.offset;
        const distance = track.end - track.start;
        let forward = 0, reverse = 0;
        // Look just behind the mouth and into the crossing. Closest samples matter most.
        for (const advance of ENTRY_SAMPLES) {
          const offset = Math.min(advance, distance / 2), weight = advance > 3 ? 0.15 : 0.35;
          const a = track.start + offset, b = track.end - offset;
          forward += weight * traffic.cost(x + a * c.ux, z + a * c.uz, c.ux, c.uz);
          reverse += weight * traffic.cost(x + b * c.ux, z + b * c.uz, -c.ux, -c.uz);
        }
        track.forwardCost = forward; track.reverseCost = reverse;
      }
    }
  }

  /** Signed 1-based crossing number; zero off a track. */
  activeCrossing(id: number): number {
    const route = this.active[id];
    return route ? Math.sign(route) * (this.crossings[Math.abs(route) - 1].markIndex + 1) : 0;
  }

  /** Metres along the marking's fixed lateral axis, independent of the trip direction. */
  trackOffset(id: number): number | undefined { return this.active[id] ? this.selected[id].offset : undefined; }

  /** The intended crossing before a walker joins the queue, including its travel direction. */
  plannedRoute(id: number, x: number, z: number, target: number): number {
    return this.active[id] || this.upcoming(this.nav.cellAt(x, z), target);
  }

  entrance(route: number): Point2 {
    const c = this.crossings[Math.abs(route) - 1], mark = this.nav.scenario.scramble!.crosswalks[c.markIndex];
    return route > 0 ? mark.from : mark.to;
  }

  /** The authored marking extends into the square. The front row stands at the actual curb along its width. */
  nearestLanding(route: number, x: number, z: number): Point2 {
    const tracks = this.crossings[Math.abs(route) - 1].tracks;
    let nearest = route > 0 ? tracks[0].startPoint : tracks[0].endPoint, best = Infinity;
    for (const track of tracks) {
      const point = route > 0 ? track.startPoint : track.endPoint;
      const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
      if (distance < best) { nearest = point; best = distance; }
    }
    return nearest;
  }

  /** An approach near a neighboring zebra can hit its curb well before reaching this mouth. */
  approachingMouth(route: number, x: number, z: number, curbDistance: number): boolean {
    const landing = this.nearestLanding(route, x, z);
    return Math.hypot(landing.x - x, landing.z - z) <= curbDistance + FRONT_ROW_DEPTH;
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
    const key = this.groups[id];
    if (key >= 0) {
      const groups = route > 0 ? c.forwardGroups : c.reverseGroups;
      const group = groups.get(key)!;
      group.members--;
      if (group.members === 0) groups.delete(key);
      this.groups[id] = -1;
    }
    this.active[id] = 0;
  }

  private canApproach(c: Crossing, track: Track, sign: number, x: number, z: number, radius: number): boolean {
    if (!this.nav.scramble!.isSidewalk(x, z, radius)) return true;
    const entry = sign > 0 ? track.start : track.end;
    const entryX = c.from.x + c.ux * entry + c.uz * track.offset;
    const entryZ = c.from.z + c.uz * entry - c.ux * track.offset;
    return Math.hypot(entryX - x, entryZ - z) <= APPROACH &&
      (!this.nav.urban || this.nav.urban.sidewalks.lineInside(x, z, entryX, entryZ, radius));
  }

  private trafficTrack(c: Crossing, seedTrack: Track, sign: number, share: number, x: number, z: number, radius: number): Track {
    const sideRank = sign > 0 ? 1 - share : share;
    const limit = c.tracks[Math.min(c.tracks.length - 1, Math.floor(sideRank * c.tracks.length))].offset;
    let best = seedTrack, bestCost = sign > 0 ? best.forwardCost : best.reverseCost;
    for (const candidate of c.tracks) {
      const shift = Math.abs(candidate.offset - seedTrack.offset);
      if (shift > 2.2 || sign * (candidate.offset - limit) < 0) continue;
      const cost = (sign > 0 ? candidate.forwardCost : candidate.reverseCost) + 0.17 * shift;
      if (cost < bestCost && this.canApproach(c, candidate, sign, x, z, radius)) { bestCost = cost; best = candidate; }
    }
    return best;
  }

  guide(id: number, generation: number, x: number, z: number, target: number, radius: number, out: Direction,
    groupKey = -1, groupOffset = 0, queuedRoute = 0): boolean {
    const activeCrossing = this.active[id];
    const signedCrossing = queuedRoute || this.plannedRoute(id, x, z, target);
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
    let center = 0, diverted = false;
    const groups = sign > 0 ? crossing.forwardGroups : crossing.reverseGroups;
    if (!activeCrossing) {
      const rng = new Random(this.seed ^ Math.imul((groupKey >= 0 ? groupKey : id) + 1, 0x9e3779b1)
        ^ Math.imul((groupKey >= 0 ? 0 : generation) + 1, 0x85ebca77) ^ Math.imul(Math.abs(signedCrossing), 0x27d4eb2d));
      // Opposing groups keep to their passing side in proportion to their size.
      // One-way traffic uses the full stripe. Established tracks stay in place.
      const opposing = sign > 0 ? crossing.reverse : crossing.forward;
      const share = 1 - opposing / (crossing.forward + crossing.reverse + 2);
      const position = rng.next() * share;
      const rank = sign > 0 ? 1 - position : position;
      const tracks = crossing.tracks;
      const seedTrack = tracks[Math.min(tracks.length - 1, Math.floor(rank * tracks.length))];
      const assigned = groupKey >= 0 ? groups.get(groupKey) : undefined;
      track = this.traffic && !assigned ? this.trafficTrack(crossing, seedTrack, sign, share, x, z, radius) : seedTrack;
      diverted = track !== seedTrack;
      if (groupKey >= 0) {
        center = assigned?.center ?? groupCenter(tracks, track.offset);
        track = nearestTrack(tracks, center + sign * groupOffset);
        if (diverted) diverted = track !== nearestTrack(tracks, groupCenter(tracks, seedTrack.offset) + sign * groupOffset);
      }
      if (!this.canApproach(crossing, track, sign, x, z, radius)) return false;
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
    // A walker displaced by a neighbor can steer straight back to their own
    // track without admitting a new trip or sidewalk approach through the margin.
    if (leavesSidewalkEarly || !this.nav.lineOfSight(x, z, aimX, aimZ, radius, !!activeCrossing)) {
      // Approaching from the side may require following the sidewalk up to the mouth first.
      ahead = sign > 0 ? track.start : track.end;
      if (sign * (ahead - along) < -2.6) return false;
      aimX = trackX + crossing.ux * ahead; aimZ = trackZ + crossing.uz * ahead;
      if ((leavesSidewalkEarly && !sidewalk!.lineInside(x, z, aimX, aimZ, radius)) || !this.nav.lineOfSight(x, z, aimX, aimZ, radius, !!activeCrossing)) return false;
    }
    const distance = Math.hypot(aimX - x, aimZ - z);
    if (distance < 0.05) return false;
    if (!activeCrossing) {
      this.selected[id] = track; this.active[id] = signedCrossing;
      if (signedCrossing > 0) crossing.forward++; else crossing.reverse++;
      if (groupKey >= 0) {
        const group = groups.get(groupKey);
        if (group) group.members++; else groups.set(groupKey, { center, members: 1 });
        this.groups[id] = groupKey;
      }
      if (diverted) this.densityDiversions++;
    }
    out.x = (aimX - x) / distance; out.z = (aimZ - z) / distance;
    return true;
  }
}
