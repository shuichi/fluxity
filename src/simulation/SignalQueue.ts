import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

/** Signed crossing routes of pedestrians who have reached a place to stand on red. */
export class SignalQueue {
  readonly route: Int16Array;
  readonly previous: Int16Array;

  constructor(private readonly agents: AgentData, private readonly grid: SpatialGrid, private readonly navigation: Navigation) {
    this.route = new Int16Array(agents.count);
    this.previous = new Int16Array(agents.count);
  }

  beginStep(): void {
    // Read last step's row while building this one, so a queue grows independently of slot order.
    this.previous.set(this.route);
    this.route.fill(0);
  }

  /** Reach the stop line or the back of a queue. Only the latter needs a periodic neighbor check. */
  hasArrived(id: number, step: number, route: number, curbDistance: number, dirX: number, dirZ: number): boolean {
    if (curbDistance <= 0.45) return true;
    if ((step + id) % 4 !== 0) return false;
    // At a crowded mouth the front row can be staggered across the approach.
    const stalledAtCurb = Number.isFinite(curbDistance) && this.agents.stalledTime[id] >= 1;
    return this.hasWaiterAhead(id, route, dirX, dirZ, stalledAtCurb);
  }

  /** Join only a nearby row blocking this walker's path to the same crossing and bank. */
  private hasWaiterAhead(id: number, route: number, dirX: number, dirZ: number, stalledAtCurb: boolean): boolean {
    const a = this.agents, s = a.current, g = this.grid, x = s.x[id], z = s.z[id];
    const reach = stalledAtCurb ? 1.5 : 1.2;
    const first = g.cellAt(x - reach, z - reach), last = g.cellAt(x + reach, z + reach);
    let examined = 0;
    for (let row = Math.floor(first / g.columns); row <= Math.floor(last / g.columns); row++) {
      for (let col = first % g.columns; col <= last % g.columns; col++) {
        const cell = row * g.columns + col;
        for (let k = g.offsets[cell]; k < g.offsets[cell + 1]; k++) {
          if (++examined > 96) return false;
          const j = g.indices[k];
          if (j === id || this.previous[j] !== route) continue;
          const dx = s.x[j] - x, dz = s.z[j] - z;
          const radii = a.radius[id] + a.radius[j];
          const ahead = dx * dirX + dz * dirZ;
          const side = Math.abs(dx * dirZ - dz * dirX);
          if (ahead <= 0 || ahead > radii + 0.52 || side > radii + (stalledAtCurb ? 0.55 : 0)
            || dx * dx + dz * dz > reach * reach) continue;
          if (this.navigation.lineOfSight(x, z, s.x[j], s.z[j], 0)) return true;
        }
      }
    }
    return false;
  }
}
