import type { Point2 } from '../types';
import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';

type Order = 'pass' | 'wait' | 'aside';
interface Shopper {
  id: number;
  life: number;
  seen: number;
  arrived: number;
  progressTime: number;
  bestDistance: number;
  distance: number;
  lane: number;
  passSince: number;
  passDistance: number;
  retryAfter: number;
  initiallyBlocked?: boolean;
  priority: number;
  order?: Order;
  until: number;
  x: number;
  z: number;
}

const RADIUS = 12;
const REVIEW = 1;
const STALL = 6;
const BATCH_PER_MOUTH = 3;
const NO_PASSAGE_TIMEOUT = 20;

/** Observe trips at a single storefront; only a persistent blockage claims the public approach. */
export class ShopDeadlockRecovery {
  private readonly shoppers = new Map<number, Shopper>();
  private readonly waiting: Shopper[] = [];
  private readonly load: Uint16Array;
  private readonly approaches: Point2[][];
  private readonly nextPoint = { x: 0, z: 0 };
  private readonly front: Shopper[] = [];
  private readonly end: Point2;
  private readonly nx: number;
  private readonly nz: number;
  private nextReview = -Infinity;
  private completions = 0;
  private lastPassage = -Infinity;
  private started = -Infinity;
  private clearSince = Infinity;
  active = false;

  constructor(private readonly agents: AgentData, private readonly navigation: Navigation,
    readonly targetIndex: number, private readonly mouths: readonly Point2[]) {
    const { approach, end } = navigation.scenario.portals![targetIndex];
    this.end = end;
    const length = Math.hypot(approach.x - end.x, approach.z - end.z);
    this.nx = (approach.x - end.x) / length;
    this.nz = (approach.z - end.z) / length;
    this.load = new Uint16Array(mouths.length);
    // One-turn approaches around a facade corner. A bank can be reached from
    // the side even when the building hides its mouth from the waiting crowd.
    this.approaches = mouths.map(m => {
      const approaches: Point2[] = [];
      for (const depth of [1.5, 3]) for (const side of [-3, 0, 3]) {
        const x = m.x + depth * this.nx + side * this.nz;
        const z = m.z + depth * this.nz - side * this.nx;
        if (navigation.urban!.sidewalks.lineInside(x, z, m.x, m.z, 0.30)) approaches.push({ x, z });
      }
      return approaches;
    });
  }

  order(id: number): Order | undefined {
    if (!this.active || this.agents.portalStage[id] || this.agents.targetId[id] !== this.targetIndex) return;
    const shopper = this.shoppers.get(id);
    if (shopper?.life === this.agents.generation[id]) return shopper.order;
  }

  guide(id: number, direction: Point2): void {
    const p = this.shoppers.get(id);
    if (!p || !this.order(id)) return;
    if (p.order === 'wait') { direction.x = direction.z = 0; return; }
    const dx = p.x - this.agents.current.x[id], dz = p.z - this.agents.current.z[id];
    const length = Math.hypot(dx, dz);
    if (length < 0.10) { direction.x = direction.z = 0; return; }
    direction.x = dx / length;
    direction.z = dz / length;
  }

  update(time: number, completed: number): void {
    if (time + 1e-6 < this.nextReview) return;
    this.nextReview = time + REVIEW;
    if (completed !== this.completions) { this.lastPassage = time; this.completions = completed; }
    const a = this.agents, s = a.current;
    this.waiting.length = 0;
    let stalled = 0, starved = 0;
    for (let id = 0; id < a.count; id++) {
      if (a.targetId[id] !== this.targetIndex || a.preferredSpeed[id] <= 0) continue;
      const x = s.x[id], z = s.z[id], radius = a.radius[id] + 0.015;
      if ((x - this.end.x) ** 2 + (z - this.end.z) ** 2 > RADIUS ** 2) continue;
      let p = this.shoppers.get(id);
      // Keep a shopper's place across the existing doorway controller's short alignment retries.
      if (a.portalStage[id]) {
        if (p?.life === a.generation[id]) p.seen = time;
        continue;
      }
      if (!this.navigation.urban!.isSidewalk(x, z, radius)) continue;
      let distance = Infinity;
      for (let i = 0; i < this.mouths.length; i++) {
        const m = this.mouths[i], d = (m.x - x) ** 2 + (m.z - z) ** 2;
        distance = Math.min(distance, d);
      }
      distance = Math.sqrt(distance);
      if (p?.life !== a.generation[id]) {
        p = { id, life: a.generation[id], arrived: time, seen: time, bestDistance: distance,
          progressTime: time, distance, lane: -1, passSince: time, passDistance: distance, retryAfter: time, priority: 0, until: time, x, z };
        this.shoppers.set(id, p);
      }
      // At slow configured walking speeds, two seconds of ordinary walking still count as progress.
      if (distance + Math.min(0.65, 2 * a.preferredSpeed[id]) < p.bestDistance) {
        p.bestDistance = distance;
        p.progressTime = time;
      }
      p.distance = distance; p.seen = time;
      const immobile = time - p.progressTime;
      if (immobile >= STALL - 1e-6) stalled++;
      // A few other shoppers can still enter while a whole subgroup near the front is locked.
      if (distance < 5 && immobile >= 24) starved++;
      this.waiting.push(p);
    }
    let originalGroupPresent = false;
    for (const [id, p] of this.shoppers) {
      if (p.seen !== time) this.shoppers.delete(id);
      else if (p.initiallyBlocked) originalGroupPresent = true;
    }

    if (!this.active) {
      if (!((stalled >= 4 && time - this.lastPassage >= STALL) || starved >= 8)) return;
      this.active = true;
      this.started = time;
      for (const p of this.waiting) p.initiallyBlocked = time - p.progressTime >= STALL - 1e-6;
      originalGroupPresent = true;
    }
    if (stalled < 4) this.clearSince = Math.min(this.clearSince, time);
    else this.clearSince = Infinity;
    // Re-observe unforced motion once the original group is gone, or if two
    // cycles of leader retry and withdrawal have produced no actual passage.
    if (time - this.clearSince >= STALL || !originalGroupPresent
      || time - Math.max(this.started, this.lastPassage) >= NO_PASSAGE_TIMEOUT) {
      this.active = false;
      this.clearSince = Infinity;
      this.shoppers.clear();
      this.nextReview = time + 5;
      return;
    }
    this.assign(time);
  }

  /** Shortest visible route to a bank, optionally via one shoulder-clear sidewalk waypoint. */
  private approach(x: number, z: number, lane: number, radius: number): number {
    const m = this.mouths[lane], sidewalk = this.navigation.urban!.sidewalks;
    if (sidewalk.lineInside(x, z, m.x, m.z, radius)) {
      this.nextPoint.x = m.x; this.nextPoint.z = m.z;
      return Math.hypot(m.x - x, m.z - z);
    }
    let best = Infinity;
    for (const p of this.approaches[lane]) {
      const length = Math.hypot(p.x - x, p.z - z) + Math.hypot(p.x - m.x, p.z - m.z);
      if (length < best && sidewalk.lineInside(x, z, p.x, p.z, radius)
        && sidewalk.lineInside(p.x, p.z, m.x, m.z, radius)) {
        best = length;
        this.nextPoint.x = p.x; this.nextPoint.z = p.z;
      }
    }
    return best;
  }

  private assign(time: number): void {
    const a = this.agents, s = a.current;
    this.load.fill(0);
    this.front.length = 0;
    // A permit stays occupied throughout alignment and passage. The shopper's
    // changed generation on completing the trip releases it at the next review.
    for (const p of this.shoppers.values()) {
      if (p.order !== 'pass') continue;
      if (!a.portalStage[p.id]) {
        const remaining = this.approach(s.x[p.id], s.z[p.id], p.lane, a.radius[p.id] + 0.015);
        if (remaining + Math.min(0.35, a.preferredSpeed[p.id]) < p.passDistance) {
          p.passSince = time;
          p.passDistance = remaining;
        }
        if (!Number.isFinite(remaining) || time - p.passSince >= 6) {
          p.order = 'wait'; p.retryAfter = time + 4;
          continue;
        }
        p.x = this.nextPoint.x; p.z = this.nextPoint.z;
        this.front.push(p);
      }
      this.load[p.lane]++;
    }
    for (const p of this.waiting) {
      p.priority = p.distance - Math.min(2.5, (time - p.arrived) * 0.035);
    }
    this.waiting.sort((a, b) => a.priority - b.priority || a.id - b.id);
    for (const p of this.waiting) {
      if (p.order === 'pass' || p.retryAfter > time) continue;
      const x = s.x[p.id], z = s.z[p.id], radius = a.radius[p.id] + 0.015;
      let lane = -1, least = Infinity;
      for (let i = 0; i < this.mouths.length; i++) {
        if (this.load[i] >= BATCH_PER_MOUTH) continue;
        const length = this.approach(x, z, i, radius);
        if (length >= least) continue;
        least = length; lane = i;
        p.x = this.nextPoint.x; p.z = this.nextPoint.z;
      }
      if (lane < 0) continue;
      p.order = 'pass'; p.lane = lane;
      p.passSince = time; p.passDistance = least;
      this.load[lane]++;
      this.front.push(p);
    }
    for (const p of this.waiting) {
      if (p.order === 'pass' || (p.order === 'aside' && time < p.until)) continue;
      p.order = 'wait';
      const x = s.x[p.id], z = s.z[p.id];
      const dx = x - this.end.x, dz = z - this.end.z;
      const depth = dx * this.nx + dz * this.nz, side = dx * this.nz - dz * this.nx;
      // Keep the middle emergence lanes clear while the two outer banks admit shoppers.
      if ((depth >= 0 && depth < 5.5 && Math.abs(side) < 1.4) || p.retryAfter > time) {
        const sign = side >= 0 ? 1 : -1;
        if (this.stepAside(p, time, sign * this.nz, -sign * this.nx, this.nx, this.nz)) continue;
      }
      // A waiting row across the selected person's route can itself deadlock.
      // Ask just the neighbors immediately in front to clear a shoulder-width.
      for (const q of this.front) {
        const qx = s.x[q.id], qz = s.z[q.id], rx = x - qx, rz = z - qz;
        if (Math.abs(rx) > 2 || Math.abs(rz) > 2) continue;
        const hx = q.x - qx, hz = q.z - qz, length = Math.hypot(hx, hz);
        if (length < 0.1) continue;
        const ux = hx / length, uz = hz / length;
        const ahead = rx * ux + rz * uz, across = rx * uz - rz * ux;
        if (ahead < 0.1 || ahead > Math.min(length, 1.8) || Math.abs(across) > 0.85) continue;
        const sign = across >= 0 ? 1 : -1;
        if (this.stepAside(p, time, sign * uz, -sign * ux, -ux, -uz)) break;
      }
    }
  }

  private stepAside(p: Shopper, time: number, sideX: number, sideZ: number, backX: number, backZ: number): boolean {
    const s = this.agents.current, x = s.x[p.id], z = s.z[p.id], radius = this.agents.radius[p.id] + 0.015;
    for (const [side, back] of [[1.3, 0.5], [1, 0], [0.2, 1.25], [-1, 0.5]]) {
      const tx = x + side * sideX + back * backX, tz = z + side * sideZ + back * backZ;
      if (!this.navigation.urban!.sidewalks.lineInside(x, z, tx, tz, radius)) continue;
      p.order = 'aside'; p.x = tx; p.z = tz; p.until = time + 2;
      return true;
    }
    return false;
  }
}
