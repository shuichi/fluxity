import type { AgentData } from './AgentData';
import type { Direction, Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

const LOOKAHEAD = 3.5;
const SHORT_STEP = 1.6;
const NEARBY = 5;
const REVIEW_STEPS = 15;
const MAX_NEIGHBORS = 96;
const paths = [0, 25, -25, 50, -50, 77, -77].map(degrees => ({
  forward: Math.cos(degrees * Math.PI / 180),
  side: Math.sin(degrees * Math.PI / 180),
}));

/** Choose a short passing path on the same sidewalk before two streams reach shoulder contact. */
export class SidewalkPassing {
  private readonly aimX: Float32Array;
  private readonly aimZ: Float32Array;
  private readonly costs = new Float64Array(paths.length);

  constructor(private readonly navigation: Navigation, private readonly grid: SpatialGrid, private readonly agents: AgentData) {
    this.aimX = new Float32Array(agents.count).fill(NaN);
    this.aimZ = new Float32Array(agents.count);
  }

  reset(id: number): void { this.aimX[id] = NaN; }

  guide(id: number, step: number, route: Direction): void {
    const a = this.agents, x = a.current.x[id], z = a.current.z[id], radius = a.radius[id] + 0.015;
    if ((step + id) % REVIEW_STEPS === 0) {
      this.reset(id);
      if (a.portalStage[id] || Math.hypot(route.x, route.z) < 0.8 || this.grid.counts[this.grid.cells[id]] < 2
        || Math.hypot(a.targetX[id] - x, a.targetZ[id] - z) < 3
        || !this.navigation.urban!.isSidewalk(x, z, radius)) return;
      if (this.scorePaths(id, x, z, route)) this.choosePath(id, x, z, route, radius);
    }
    if (!Number.isFinite(this.aimX[id])) return;
    const dx = this.aimX[id] - x, dz = this.aimZ[id] - z, length = Math.hypot(dx, dz);
    if (length < 0.15 || length > LOOKAHEAD + 0.6 || dx * route.x + dz * route.z < 0
      || !this.navigation.urban!.isSidewalk(x, z, radius)) {
      this.reset(id);
      return;
    }
    route.x = dx / length; route.z = dz / length;
  }

  private scorePaths(id: number, x: number, z: number, route: Direction): boolean {
    const g = this.grid, s = this.agents.current;
    const first = g.cellAt(x - NEARBY, z - NEARBY), last = g.cellAt(x + NEARBY, z + NEARBY);
    for (let k = 0; k < paths.length; k++) {
      // Prefer progress, and consistently pass on the same side when both sides are equally clear.
      this.costs[k] = (1 - paths[k].forward) * 1.25 + (paths[k].side < 0 ? 0.2 : 0);
    }
    let blockedAhead = false, examined = 0;
    for (let row = Math.floor(first / g.columns); row <= Math.floor(last / g.columns); row++) {
      for (let col = first % g.columns; col <= last % g.columns; col++) {
        const cell = row * g.columns + col;
        for (let n = g.offsets[cell]; n < g.offsets[cell + 1]; n++) {
          const j = g.indices[n];
          if (j === id) continue;
          if (++examined > MAX_NEIGHBORS) return false;
          const dx = s.x[j] - x, dz = s.z[j] - z, ahead = dx * route.x + dz * route.z;
          if (dx * dx + dz * dz > NEARBY ** 2 || ahead < -0.6) continue;
          const forwardSpeed = s.vx[j] * route.x + s.vz[j] * route.z;
          if (forwardSpeed > 0.65 || this.agents.opacity[j] < 0.05
            || !this.navigation.lineOfSight(x, z, s.x[j], s.z[j], 0)) continue;
          if (Math.abs(dx * route.z - dz * route.x) < 0.83 && ahead > 0 && ahead < 3.2) blockedAhead = true;
          const px = dx + s.vx[j] * 0.4, pz = dz + s.vz[j] * 0.4;
          for (let k = 0; k < paths.length; k++) {
            const path = paths[k], ux = route.x * path.forward + route.z * path.side, uz = route.z * path.forward - route.x * path.side;
            const along = px * ux + pz * uz, side = Math.abs(px * uz - pz * ux);
            if (along < -0.05 || along > LOOKAHEAD + 0.5 || side > 0.95) continue;
            this.costs[k] += (1 - along / (LOOKAHEAD + 1.5)) * (1 - side / 0.95) * (forwardSpeed < -0.2 ? 2.7 : 1.8);
          }
        }
      }
    }
    return blockedAhead && this.costs[0] >= 0.6;
  }

  private choosePath(id: number, x: number, z: number, route: Direction, radius: number): void {
    const sidewalk = this.navigation.urban!.sidewalks;
    let best = this.costs[0] - 0.2;
    for (let k = 1; k < paths.length; k++) {
      if (this.costs[k] >= best) continue;
      const path = paths[k], ux = route.x * path.forward + route.z * path.side, uz = route.z * path.forward - route.x * path.side;
      let distance = LOOKAHEAD;
      if (!sidewalk.lineInside(x, z, x + ux * distance, z + uz * distance, radius)) {
        distance = SHORT_STEP;
        if (!sidewalk.lineInside(x, z, x + ux * distance, z + uz * distance, radius)) continue;
      }
      const cost = this.costs[k] + (LOOKAHEAD - distance) * 0.32;
      if (cost >= best) continue;
      best = cost;
      this.aimX[id] = x + ux * distance; this.aimZ[id] = z + uz * distance;
    }
  }
}
