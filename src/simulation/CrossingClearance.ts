import type { Direction, Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';
import { CrossingExits } from './CrossingExits';

const enum Decision { None, Cross, Return }
const RETURN_DISTANCE = 1.5;
const PROGRESS_INTERVAL = 2;

/** A temporary destination for one crossing. The person's underlying trip is kept intact. */
export class CrossingClearance {
  readonly clearing: Uint8Array;
  readonly blocked: Uint8Array;
  readonly landingX: Float32Array;
  readonly landingZ: Float32Array;
  readonly waypointX: Float32Array;
  readonly waypointZ: Float32Array;
  private readonly entryX: Float32Array;
  private readonly entryZ: Float32Array;
  private readonly reviewIn: Float32Array;
  private readonly previousDistance: Float32Array;
  private readonly exits: CrossingExits;
  private readonly candidate = { x: 0, z: 0 };
  private readonly approach = { x: 0, z: 0 };

  constructor(private readonly navigation: Navigation, grid: SpatialGrid, count: number) {
    this.exits = new CrossingExits(navigation, grid);
    this.clearing = new Uint8Array(count);
    this.blocked = new Uint8Array(count);
    this.landingX = new Float32Array(count).fill(NaN);
    this.landingZ = new Float32Array(count).fill(NaN);
    this.waypointX = new Float32Array(count).fill(NaN);
    this.waypointZ = new Float32Array(count).fill(NaN);
    this.entryX = new Float32Array(count).fill(NaN);
    this.entryZ = new Float32Array(count).fill(NaN);
    this.reviewIn = new Float32Array(count);
    this.previousDistance = new Float32Array(count);
  }

  reset(id: number): void {
    this.clearing[id] = Decision.None;
    this.blocked[id] = 0;
    this.landingX[id] = this.landingZ[id] = NaN;
    this.waypointX[id] = this.waypointZ[id] = NaN;
    this.entryX[id] = this.entryZ[id] = NaN;
  }

  observeStep(id: number, oldX: number, oldZ: number, radius: number, landed: boolean): void {
    if (landed) {
      if (this.clearing[id] || Number.isFinite(this.entryX[id])) this.reset(id);
    } else if (!this.clearing[id] && !Number.isFinite(this.entryX[id])
      && this.navigation.scramble!.isSidewalk(oldX, oldZ, radius)) {
      this.entryX[id] = oldX;
      this.entryZ[id] = oldZ;
    }
  }

  private chooseLanding(id: number, x: number, z: number, radius: number, direction: Direction): boolean {
    const entryX = this.entryX[id], entryZ = this.entryZ[id];
    if (this.clearing[id] === Decision.Return) {
      if (this.exits.choose(x, z, radius, direction.x, direction.z, entryX, entryZ, true, this.candidate, this.approach)) return true;
      this.clearing[id] = Decision.Cross;
    }
    return this.exits.choose(x, z, radius, direction.x, direction.z, entryX, entryZ, false, this.candidate, this.approach);
  }

  /** Choose a side on the first red movement step, then review progress toward it. */
  guide(id: number, x: number, z: number, radius: number, dt: number, pace: number, direction: Direction): number {
    if (!this.clearing[id]) {
      const fromEntry = Math.hypot(x - this.entryX[id], z - this.entryZ[id]);
      this.clearing[id] = fromEntry <= RETURN_DISTANCE ? Decision.Return : Decision.Cross;
      this.reviewIn[id] = 0;
    }
    let dx = this.waypointX[id] - x, dz = this.waypointZ[id] - z;
    let distance = Math.hypot(dx, dz);
    const atBend = distance < 0.6 && (this.waypointX[id] !== this.landingX[id] || this.waypointZ[id] !== this.landingZ[id]);
    this.reviewIn[id] -= dt;
    if (this.reviewIn[id] <= 0 || atBend) {
      const hasLanding = Number.isFinite(this.landingX[id]);
      const stalled = hasLanding && !atBend && pace > 0
        && this.previousDistance[id] - distance < Math.min(0.4, pace * PROGRESS_INTERVAL * 0.25);
      this.blocked[id] = Number(stalled);
      if ((!hasLanding && this.chooseLanding(id, x, z, radius, direction))
        || (stalled && this.exits.reselect(x, z, radius, this.landingX[id], this.landingZ[id], this.candidate))) {
        this.landingX[id] = this.candidate.x;
        this.landingZ[id] = this.candidate.z;
        this.waypointX[id] = hasLanding ? this.candidate.x : this.approach.x;
        this.waypointZ[id] = hasLanding ? this.candidate.z : this.approach.z;
      } else if (atBend || stalled) {
        const found = this.exits.waypoint(x, z, radius, this.landingX[id], this.landingZ[id], this.candidate);
        this.waypointX[id] = found ? this.candidate.x : this.landingX[id];
        this.waypointZ[id] = found ? this.candidate.z : this.landingZ[id];
      }
      dx = this.waypointX[id] - x;
      dz = this.waypointZ[id] - z;
      distance = Math.hypot(dx, dz);
      this.previousDistance[id] = distance;
      this.reviewIn[id] = PROGRESS_INTERVAL;
    }
    if (distance > 0) { direction.x = dx / distance; direction.z = dz / distance; }
    else if (distance === 0) { direction.x = 0; direction.z = 0; }
    // Preserve a zero speed setting and the pace of people already moving faster than a jog.
    return this.clearing[id] === Decision.Cross && pace > 0 ? Math.max(1, Math.min(1.7, 2.8 / pace)) : 1;
  }
}
