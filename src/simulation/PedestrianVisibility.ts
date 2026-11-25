import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

const SIGHT_MARGIN = 0.42;
const MAX_NEIGHBORS = 96;

/** A nearby walker must be in front and at least partly visible past walls and other bodies. */
export function canSeeWalker(a: AgentData, navigation: Navigation, g: SpatialGrid, id: number, other: number): boolean {
  const s = a.current, x = s.x[id], z = s.z[id];
  if (a.opacity[other] <= 0.05) return false;
  const ox = s.x[other], oz = s.z[other], dx = ox - x, dz = oz - z;
  const distance2 = dx * dx + dz * dz;
  if (!distance2 || dx * Math.sin(s.heading[id]) + dz * Math.cos(s.heading[id]) < 0) return false;
  if (!navigation.lineOfSight(x, z, ox, oz, 0)) return false;

  const first = g.cellAt(Math.min(x, ox) - SIGHT_MARGIN, Math.min(z, oz) - SIGHT_MARGIN);
  const last = g.cellAt(Math.max(x, ox) + SIGHT_MARGIN, Math.max(z, oz) + SIGHT_MARGIN);
  let examined = 0;
  for (let row = Math.floor(first / g.columns); row <= Math.floor(last / g.columns); row++) {
    for (let col = first % g.columns; col <= last % g.columns; col++) {
      const cell = row * g.columns + col;
      for (let k = g.offsets[cell]; k < g.offsets[cell + 1]; k++) {
        if (++examined > MAX_NEIGHBORS) return false;
        const blocker = g.indices[k];
        if (blocker === id || blocker === other || a.opacity[blocker] <= 0.05) continue;
        const bx = s.x[blocker] - x, bz = s.z[blocker] - z;
        const t = (bx * dx + bz * dz) / distance2;
        if (t <= 0 || t >= 1) continue;
        // A nearer silhouette must cover the far person's projected width.
        const coverage = a.radius[blocker] - t * a.radius[other];
        if (coverage > 0 && (bx - t * dx) ** 2 + (bz - t * dz) ** 2 < coverage ** 2) return false;
      }
    }
  }
  return true;
}
