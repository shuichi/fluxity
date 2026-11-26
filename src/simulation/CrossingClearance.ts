import type { Direction, Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';
import { CrossingExits } from './CrossingExits';

const PROGRESS_INTERVAL = 2;

/** A temporary destination for one crossing. The person's underlying trip is kept intact. */
export class CrossingClearance {
  readonly clearing: Uint8Array;
  readonly blocked: Uint8Array;
  readonly landingX: Float32Array;
  readonly landingZ: Float32Array;
  readonly waypointX: Float32Array;
  readonly waypointZ: Float32Array;
  private readonly reviewIn: Float32Array;
  private readonly previousDistance: Float32Array;
  private readonly fromMargin: Uint8Array;
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
    this.fromMargin = new Uint8Array(count);
    this.reviewIn = new Float32Array(count);
    this.previousDistance = new Float32Array(count);
  }

  reset(id: number): void {
    this.clearing[id] = 0;
    this.blocked[id] = this.fromMargin[id] = 0;
    this.landingX[id] = this.landingZ[id] = NaN;
    this.waypointX[id] = this.waypointZ[id] = NaN;
  }

  observeStep(id: number, landed: boolean): void {
    if (landed && this.clearing[id]) this.reset(id);
  }

  /** Choose a side when the crossing first closes, then review progress toward it. */
  guide(id: number, x: number, z: number, radius: number, dt: number, pace: number, direction: Direction): number {
    if (!this.clearing[id]) {
      this.clearing[id] = 1;
      this.reviewIn[id] = 0;
    }
    let dx = this.waypointX[id] - x, dz = this.waypointZ[id] - z;
    let distance = Math.hypot(dx, dz);
    const atBend = distance < 0.6 && (this.waypointX[id] !== this.landingX[id] || this.waypointZ[id] !== this.landingZ[id]);
    // A line chosen from outside the markings may use the passing margin.
    // Once back inside, continue to the same bank along an ordinary crossing leg.
    const rejoined = this.fromMargin[id] && this.navigation.urban!.isWalkable(x, z, radius);
    this.reviewIn[id] -= dt;
    if (this.reviewIn[id] <= 0 || atBend || rejoined) {
      const hasLanding = Number.isFinite(this.landingX[id]);
      const stalled = hasLanding && !atBend && !rejoined && pace > 0 && (!Number.isFinite(distance)
        || this.previousDistance[id] - distance < Math.min(0.4, pace * PROGRESS_INTERVAL * 0.25));
      this.blocked[id] = Number(stalled);
      if ((!hasLanding && this.exits.choose(x, z, radius, this.candidate, this.approach))
        || (stalled && this.exits.reselect(x, z, radius, this.landingX[id], this.landingZ[id], this.candidate))) {
        this.landingX[id] = this.candidate.x;
        this.landingZ[id] = this.candidate.z;
        this.waypointX[id] = hasLanding ? this.candidate.x : this.approach.x;
        this.waypointZ[id] = hasLanding ? this.candidate.z : this.approach.z;
      } else if (atBend || stalled || rejoined) {
        const found = this.exits.recoverLanding(x, z, radius, this.landingX[id], this.landingZ[id], this.candidate, this.approach);
        if (found) {
          this.landingX[id] = this.candidate.x;
          this.landingZ[id] = this.candidate.z;
        }
        this.waypointX[id] = found ? this.approach.x : NaN;
        this.waypointZ[id] = found ? this.approach.z : NaN;
      }
      dx = this.waypointX[id] - x;
      dz = this.waypointZ[id] - z;
      distance = Math.hypot(dx, dz);
      this.fromMargin[id] = Number(!!this.navigation.urban && !this.navigation.urban.isWalkable(x, z, radius));
      this.previousDistance[id] = distance;
      this.reviewIn[id] = PROGRESS_INTERVAL;
    }
    if (distance > 0) { direction.x = dx / distance; direction.z = dz / distance; }
    else { direction.x = 0; direction.z = 0; }
    // A slower walker still clears at their own pace. The signal can wait for them.
    return pace > 0 ? Math.max(1, Math.min(1.25, 2.8 / pace)) : 1;
  }
}
