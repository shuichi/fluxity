import type { PedestrianPortal, Point2 } from '../types';
import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import { canSeeWalker } from './PedestrianVisibility';
import type { SpatialGrid } from './SpatialGrid';

const EXTRA_GAP = 0.70;
const LOOK_AHEAD = 2;
const MAX_NEIGHBORS = 96;

/** Leave a stride in front of a waiting shopper so the front of the queue can move. */
export class DoorwayHeadway {
  private readonly holdUntil: Float64Array;
  private readonly life: Uint32Array;
  private readonly leader: Int32Array;
  private readonly leaderLife: Uint32Array;

  constructor(private readonly agents: AgentData, private readonly grid: SpatialGrid,
    private readonly navigation: Navigation, private readonly portals: PedestrianPortal[]) {
    this.holdUntil = new Float64Array(agents.count);
    this.life = new Uint32Array(agents.count);
    this.leader = new Int32Array(agents.count).fill(-1);
    this.leaderLife = new Uint32Array(agents.count);
  }

  limit(id: number, step: number, time: number, direction: Point2, velocity: Point2): void {
    const a = this.agents, s = a.current;
    const leader = this.leader[id];
    const holding = time < this.holdUntil[id] && this.life[id] === a.generation[id]
      && leader >= 0 && this.leaderLife[id] === a.generation[leader];
    // Stagger perception over six fixed steps. Braking still takes effect on every tick.
    if (!holding && (step + id) % 6 !== 0) return;
    const portal = this.portals[a.targetId[id]];
    if (portal.kind !== 'door' || a.portalStage[id]) return;
    const x = s.x[id], z = s.z[id], goal = portal.end;
    const distance2 = (x - goal.x) ** 2 + (z - goal.z) ** 2;
    // Leave the threshold to its own passage control and keep the crossing landing moving.
    if (distance2 < 2 ** 2 || distance2 > 17 ** 2
      || !this.navigation.scramble?.isSidewalk(x, z, a.radius[id] + 0.015)) return;
    if (!holding) {
      if (direction.x ** 2 + direction.z ** 2 < 0.8) return;
      const other = this.stoppedAhead(id, direction, goal, distance2);
      if (other < 0) return;
      this.leader[id] = other;
      this.life[id] = a.generation[id];
      this.leaderLife[id] = a.generation[other];
      this.holdUntil[id] = time + 0.35;
    }
    // Set the desired velocity. Simulation still limits deceleration and checks swept shoulders.
    velocity.x = 0; velocity.z = 0;
  }

  private stoppedAhead(id: number, direction: Point2, goal: Point2, distance2: number): number {
    const a = this.agents, s = a.current, g = this.grid, x = s.x[id], z = s.z[id];
    const first = g.cellAt(x - LOOK_AHEAD, z - LOOK_AHEAD), last = g.cellAt(x + LOOK_AHEAD, z + LOOK_AHEAD);
    let nearest = -1, nearestAhead = LOOK_AHEAD, examined = 0;
    for (let row = Math.floor(first / g.columns); row <= Math.floor(last / g.columns); row++) {
      for (let col = first % g.columns; col <= last % g.columns; col++) {
        const cell = row * g.columns + col;
        for (let k = g.offsets[cell]; k < g.offsets[cell + 1]; k++) {
          if (++examined > MAX_NEIGHBORS) return nearest;
          const j = g.indices[k];
          if (j === id || a.opacity[j] < 0.1 || s.vx[j] ** 2 + s.vz[j] ** 2 > 0.28 ** 2) continue;
          const dx = s.x[j] - x, dz = s.z[j] - z;
          const ahead = dx * direction.x + dz * direction.z;
          if (ahead <= 0.15 || ahead >= nearestAhead || ahead >= a.radius[id] + a.radius[j] + EXTRA_GAP
            || Math.abs(dx * direction.z - dz * direction.x) > 0.52) continue;
          // Compare observed positions so a pair cannot both wait on one another at this door.
          if ((s.x[j] - goal.x) ** 2 + (s.z[j] - goal.z) ** 2 > distance2 - 0.4) continue;
          if (canSeeWalker(a, this.navigation, g, id, j)) { nearest = j; nearestAhead = ahead; }
        }
      }
    }
    return nearest;
  }
}
