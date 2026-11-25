import type { PedestrianPortal, Point2 } from '../types';
import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

const APPROACH_RADIUS = 8;
const NOTICE_DISTANCE = 2.2;
const CLEAR_SPOT_RADIUS = 0.42;
const REVIEW_INTERVAL = 0.2;
const MIN_YIELD = 0.45;
const MAX_YIELD = 1.6;
const RECOVERY = 0.55;
const MAX_NEIGHBORS = 96;

/** An approaching walker gives one visible peer room, then resumes their own route. */
export class DoorwayCourtesy {
  private readonly openings: { portal: PedestrianPortal; normalX: number; normalZ: number; depth: number }[];
  // Perception is computed from a single motion snapshot before anyone chooses to yield.
  private readonly gate: Int32Array;
  private readonly priority: Float64Array;
  private readonly directionX: Float32Array;
  private readonly directionZ: Float32Array;
  private readonly speed: Float32Array;
  private readonly inMouth: Uint8Array;

  private readonly peer: Int32Array;
  private readonly life: Uint32Array;
  private readonly peerLife: Uint32Array;
  private readonly started: Float64Array;
  private readonly resumeAfter: Float64Array;
  private readonly refugeX: Float32Array;
  private readonly refugeZ: Float32Array;
  private nextReview = 0;

  constructor(private readonly agents: AgentData, private readonly navigation: Navigation,
    private readonly grid: SpatialGrid, portals: PedestrianPortal[]) {
    this.openings = portals.map(portal => {
      const dx = portal.approach.x - portal.end.x, dz = portal.approach.z - portal.end.z;
      const depth = Math.hypot(dx, dz);
      return { portal, normalX: dx / depth, normalZ: dz / depth, depth };
    });
    const count = agents.count;
    this.gate = new Int32Array(count).fill(-1);
    this.priority = new Float64Array(count);
    this.directionX = new Float32Array(count);
    this.directionZ = new Float32Array(count);
    this.speed = new Float32Array(count);
    this.inMouth = new Uint8Array(count);
    this.peer = new Int32Array(count).fill(-1);
    this.life = new Uint32Array(count);
    this.peerLife = new Uint32Array(count);
    this.started = new Float64Array(count);
    this.resumeAfter = new Float64Array(count);
    this.refugeX = new Float32Array(count);
    this.refugeZ = new Float32Array(count);
  }

  private observeApproaches(): void {
    const a = this.agents, s = a.current;
    for (let id = 0; id < a.count; id++) {
      const x = s.x[id], z = s.z[id];
      this.gate[id] = -1;
      for (let k = 0; k < this.openings.length; k++) {
        const { portal, normalX, normalZ, depth } = this.openings[k];
        if ((x - portal.approach.x) ** 2 + (z - portal.approach.z) ** 2 > APPROACH_RADIUS ** 2) continue;
        this.gate[id] = k;
        // When someone is nearly stationary, their body heading is still visible.
        const speed = Math.hypot(s.vx[id], s.vz[id]);
        this.speed[id] = speed;
        this.directionX[id] = speed > 0.15 ? s.vx[id] / speed : Math.sin(s.heading[id]);
        this.directionZ[id] = speed > 0.15 ? s.vz[id] / speed : Math.cos(s.heading[id]);
        const dx = x - portal.end.x, dz = z - portal.end.z;
        const along = dx * normalX + dz * normalZ, side = dx * normalZ - dz * normalX;
        const through = Math.abs(this.directionX[id] * normalX + this.directionZ[id] * normalZ) > 0.7;
        this.inMouth[id] = Number(a.opacity[id] > 0.05 && along > 0 && along < depth * 0.5
          && Math.abs(side) <= portal.width / 2 && through);
        // Priority goes to whoever is passing through, then whoever is closer.
        // Within a 35 cm distance band, both people use the same doorway-relative ordering.
        this.priority[id] = 1000 * this.inMouth[id] - Math.floor(Math.hypot(dx, dz) / 0.35)
          + 0.5 + 0.45 * Math.tanh(side) + 0.04 * Math.tanh(along);
        break;
      }
    }
  }

  private canSee(id: number, other: number): boolean {
    const a = this.agents, s = a.current, x = s.x[id], z = s.z[id];
    if (a.opacity[other] <= 0.05) return false;
    const ox = s.x[other], oz = s.z[other], dx = ox - x, dz = oz - z;
    const distance2 = dx * dx + dz * dz;
    if (!distance2 || dx * Math.sin(s.heading[id]) + dz * Math.cos(s.heading[id]) < 0) return false;
    if (!this.navigation.lineOfSight(x, z, ox, oz, 0)) return false;

    const g = this.grid;
    const first = g.cellAt(Math.min(x, ox) - CLEAR_SPOT_RADIUS, Math.min(z, oz) - CLEAR_SPOT_RADIUS);
    const last = g.cellAt(Math.max(x, ox) + CLEAR_SPOT_RADIUS, Math.max(z, oz) + CLEAR_SPOT_RADIUS);
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

  private conflictingPeer(id: number): number {
    const a = this.agents, s = a.current, g = this.grid;
    const x = s.x[id], z = s.z[id], cell = g.cells[id];
    const row = Math.floor(cell / g.columns), col = cell % g.columns;
    const span = Math.ceil(NOTICE_DISTANCE / g.cellSize);
    let peer = -1, bestScore = -Infinity, examined = 0;
    for (let rz = Math.max(row - span, 0); rz <= Math.min(row + span, g.rows - 1); rz++) {
      for (let cx = Math.max(col - span, 0); cx <= Math.min(col + span, g.columns - 1); cx++) {
        const c = rz * g.columns + cx;
        for (let k = g.offsets[c]; k < g.offsets[c + 1]; k++) {
          if (++examined > MAX_NEIGHBORS) return peer;
          const j = g.indices[k];
          if (this.gate[j] !== this.gate[id] || this.priority[j] <= this.priority[id]) continue;
          const dx = x - s.x[j], dz = z - s.z[j], distance2 = dx * dx + dz * dz;
          if (distance2 > NOTICE_DISTANCE ** 2 || distance2 < 0.02) continue;
          const ux = this.directionX[j], uz = this.directionZ[j], ahead = dx * ux + dz * uz;
          if (ahead < -0.05 || ahead > 2.05) continue;
          const ownX = this.directionX[id], ownZ = this.directionZ[id];
          if (ownX * ux + ownZ * uz > 0.8 && !this.inMouth[j]) continue;
          // Will our path intersect their next second of travel?
          const lateral = dx * uz - dz * ux;
          const eta = Math.max(0, Math.min(1, ahead / Math.max(0.45, this.speed[j])));
          const futureSide = lateral + (ownX * uz - ownZ * ux) * a.preferredSpeed[id] * eta;
          const miss = lateral * futureSide < 0 ? 0 : Math.min(Math.abs(lateral), Math.abs(futureSide));
          if (miss > 0.70) continue;
          const score = 2 * this.inMouth[j] - miss - distance2 * 0.2;
          if (score > bestScore && this.canSee(id, j)) { bestScore = score; peer = j; }
        }
      }
    }
    return peer;
  }

  private spotIsClear(id: number, x: number, z: number): boolean {
    const a = this.agents, s = a.current, g = this.grid;
    const radius = a.radius[id] + 0.015;
    if (!this.navigation.isSpawnable(x, z, radius) || !this.navigation.lineOfSight(s.x[id], s.z[id], x, z, radius)) return false;
    const first = g.cellAt(x - CLEAR_SPOT_RADIUS, z - CLEAR_SPOT_RADIUS);
    const last = g.cellAt(x + CLEAR_SPOT_RADIUS, z + CLEAR_SPOT_RADIUS);
    let examined = 0;
    for (let row = Math.floor(first / g.columns); row <= Math.floor(last / g.columns); row++) {
      for (let col = first % g.columns; col <= last % g.columns; col++) {
        const cell = row * g.columns + col;
        for (let k = g.offsets[cell]; k < g.offsets[cell + 1]; k++) {
          if (++examined > MAX_NEIGHBORS) return false;
          const j = g.indices[k];
          if (j !== id && (s.x[j] - x) ** 2 + (s.z[j] - z) ** 2 < CLEAR_SPOT_RADIUS ** 2 && this.canSee(id, j)) return false;
        }
      }
    }
    return true;
  }

  private chooseRefuge(id: number, peer: number): void {
    const s = this.agents.current, x = s.x[id], z = s.z[id];
    const ux = this.directionX[peer], uz = this.directionZ[peer];
    const side = (x - s.x[peer]) * uz - (z - s.z[peer]) * ux;
    // Try the nearer side of their path, then the other. Stand back if both are occupied.
    // For a head-on encounter the doorway-relative priority breaks the side tie.
    let sign = Math.sign(side);
    if (Math.abs(side) < 0.06) sign = this.priority[id] % 1 > -0.5 ? 1 : -1;
    this.refugeX[id] = x; this.refugeZ[id] = z;
    for (let attempt = 0; attempt < 2; attempt++, sign = -sign) {
      const offset = Math.max(0.25, Math.min(0.97, 0.95 - sign * side));
      const tx = x + sign * uz * offset + ux * 0.16, tz = z - sign * ux * offset + uz * 0.16;
      if (this.spotIsClear(id, tx, tz)) {
        this.refugeX[id] = tx; this.refugeZ[id] = tz;
        break;
      }
    }
  }

  update(time: number): void {
    if (time + 1e-8 < this.nextReview) return;
    this.nextReview = time + REVIEW_INTERVAL;
    this.observeApproaches();
    const a = this.agents, s = a.current;
    for (let id = 0; id < a.count; id++) {
      if (this.life[id] !== a.generation[id]) {
        this.life[id] = a.generation[id];
        this.peer[id] = -1;
        this.resumeAfter[id] = 0;
      }
      const peer = this.peer[id];
      if (peer >= 0) {
        const dx = s.x[id] - s.x[peer], dz = s.z[id] - s.z[peer];
        const ahead = dx * this.directionX[peer] + dz * this.directionZ[peer];
        const age = time - this.started[id];
        if (this.gate[id] >= 0 && !a.portalStage[id] && this.peerLife[id] === a.generation[peer]
          && this.gate[id] === this.gate[peer] && this.priority[peer] > this.priority[id]
          && age < MAX_YIELD && dx * dx + dz * dz < 2.5 ** 2
          && (age < MIN_YIELD || ahead > -0.22) && this.canSee(id, peer)) continue;
        this.peer[id] = -1;
        this.resumeAfter[id] = time + RECOVERY;
      }
      if (this.gate[id] < 0 || a.portalStage[id] || time < this.resumeAfter[id] || a.preferredSpeed[id] <= 0) continue;
      const other = this.conflictingPeer(id);
      if (other < 0) continue;
      this.peer[id] = other;
      this.peerLife[id] = a.generation[other];
      this.started[id] = time;
      this.chooseRefuge(id, other);
    }
  }

  yielding(id: number): boolean {
    const peer = this.peer[id];
    return peer >= 0 && !this.agents.portalStage[id] && this.life[id] === this.agents.generation[id]
      && this.peerLife[id] === this.agents.generation[peer];
  }

  guide(id: number, out: Point2): void {
    const dx = this.refugeX[id] - this.agents.current.x[id], dz = this.refugeZ[id] - this.agents.current.z[id];
    const length = Math.hypot(dx, dz);
    const scale = length < 0.065 ? 0 : Math.min(1.65, 0.85 / length);
    out.x = dx * scale; out.z = dz * scale;
  }
}
