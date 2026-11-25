import { Random } from '../math/random';
import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

const MAX_HEAD_YAW = 1.18;
const TURN_RATE = 2.8;

/** Voluntary gaze and pace changes. All clocks run in simulated seconds and
 * each life owns its own random sequence, separate from trips and appearance.
 */
export class PedestrianAttention {
  readonly headYaw: Float32Array;
  readonly counts = { waitLookStarts: 0, hesitationStarts: 0 };
  private readonly random: Random[];
  private readonly curiosity: Float32Array;
  private readonly familiarity: Float32Array;
  private readonly pollIn: Float32Array;
  private readonly glanceCooldown: Float32Array;
  private readonly hold: Float32Array;
  private readonly pace: Float32Array;
  private readonly waiting: Uint8Array;
  private readonly focusX: Float32Array;
  private readonly focusZ: Float32Array;
  private readonly focusId: Int32Array;
  private readonly focusLife: Uint32Array;
  private readonly encounter: Int32Array;
  private readonly encounterLife: Uint32Array;
  private readonly forkX: Float32Array;
  private readonly forkZ: Float32Array;
  private readonly alternative = { x: 0, z: 0 };

  constructor(private readonly seed: number, private readonly agents: AgentData,
    private readonly navigation: Navigation, private readonly grid?: SpatialGrid) {
    const n = agents.count;
    this.headYaw = new Float32Array(n); this.random = new Array(n);
    this.curiosity = new Float32Array(n); this.familiarity = new Float32Array(n);
    this.pollIn = new Float32Array(n); this.glanceCooldown = new Float32Array(n);
    this.hold = new Float32Array(n); this.pace = new Float32Array(n);
    this.waiting = new Uint8Array(n); this.focusX = new Float32Array(n); this.focusZ = new Float32Array(n);
    this.focusId = new Int32Array(n); this.focusLife = new Uint32Array(n);
    this.encounter = new Int32Array(n); this.encounterLife = new Uint32Array(n);
    this.forkX = new Float32Array(n); this.forkZ = new Float32Array(n);
    for (let id = 0; id < n; id++) this.reset(id, agents.generation[id]);
  }

  reset(id: number, generation: number): void {
    const rng = new Random(this.seed ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(generation + 1, 0x85ebca77));
    this.random[id] = rng;
    this.curiosity[id] = rng.next(); this.familiarity[id] = rng.next();
    this.pollIn[id] = rng.range(0.15, 1.5);
    this.glanceCooldown[id] = 0;
    this.hold[id] = this.headYaw[id] = this.waiting[id] = 0;
    this.pace[id] = 1;
    this.focusId[id] = this.encounter[id] = -1;
    this.forkX[id] = Infinity; this.forkZ[id] = Infinity;
  }

  private waitingInterval(id: number): number {
    const rate = 0.032 + 0.18 * this.curiosity[id] ** 2;
    return 0.65 - Math.log1p(-this.random[id].next()) / rate;
  }

  /** Called on steps where portal traffic owns movement. */
  settle(id: number, dt: number): void {
    this.hold[id] = this.waiting[id] = 0; this.pace[id] = 1;
    this.encounter[id] = -1;
    this.turnHead(id, 0, dt);
  }

  /** Returns a voluntary multiplier on route speed. Gaze alone never changes motion. */
  update(id: number, dt: number, waitingAtRedCurb: boolean, routeX: number, routeZ: number,
    allowHesitation: boolean, passerId = -1, passSide = 0): number {
    const rng = this.random[id], a = this.agents, state = a.current;
    if (this.waiting[id] !== Number(waitingAtRedCurb)) {
      this.waiting[id] = Number(waitingAtRedCurb);
      this.pollIn[id] = waitingAtRedCurb ? this.waitingInterval(id) : rng.range(0.8, 1.7);
    }
    if (this.hold[id] > 0 && this.pace[id] < 1
      && (!allowHesitation || waitingAtRedCurb || passerId >= 0 || !this.onSidewalk(id))) this.pace[id] = 1;
    this.pollIn[id] -= dt;
    this.glanceCooldown[id] -= dt;
    if (passerId < 0 || !passSide) this.encounter[id] = -1;
    if (this.hold[id] <= 0) {
      this.pace[id] = 1;
      // One decision per committed encounter. Keep a current glance through its dwell.
      if (!waitingAtRedCurb && passerId >= 0 && passSide && this.glanceCooldown[id] <= 0
        && (this.encounter[id] !== passerId || this.encounterLife[id] !== a.generation[passerId])) {
        this.encounter[id] = passerId; this.encounterLife[id] = a.generation[passerId];
        if (rng.next() < 0.38 + 0.52 * this.curiosity[id]) {
          const side = passSide * rng.range(0.36, 0.62);
          this.startLook(id, state.x[id] + 8 * (routeX + side * routeZ), state.z[id] + 8 * (routeZ - side * routeX));
          this.pollIn[id] = Math.max(this.pollIn[id], this.hold[id]);
        }
      }
      if (this.pollIn[id] <= 0) {
        if (waitingAtRedCurb) {
          this.curbLook(id, routeX, routeZ, passerId);
          this.pollIn[id] = this.hold[id] + this.waitingInterval(id);
        } else {
          this.pollIn[id] = rng.range(0.75, 1.5);
          const x = state.x[id], z = state.z[id];
          // Record both acceptance and refusal until the person leaves the fork.
          if (Number.isFinite(this.forkX[id]) && (x - this.forkX[id]) ** 2 + (z - this.forkZ[id]) ** 2 > 12 ** 2) {
            this.forkX[id] = Infinity;
          }
          if (allowHesitation && passerId < 0 && state.vx[id] ** 2 + state.vz[id] ** 2 > 0.12
            && !Number.isFinite(this.forkX[id])
            && this.navigation.alternativeAtFork(x, z, a.targetId[id], routeX, routeZ, this.alternative)
            && this.onSidewalk(id)) {
            this.forkX[id] = x; this.forkZ[id] = z;
            if (rng.next() < 0.08 + 0.52 * (1 - this.familiarity[id]) ** 2) {
              this.startLook(id, x + this.alternative.x * 8, z + this.alternative.z * 8);
              this.pace[id] = rng.range(0.35, 0.62);
              this.hold[id] = rng.range(0.55, 1.25);
              this.glanceCooldown[id] = this.hold[id] + 0.6;
              this.pollIn[id] = this.hold[id] + rng.range(2, 4);
              this.counts.hesitationStarts++;
            }
          }
        }
      }
    }
    if (this.hold[id] <= 0) { this.turnHead(id, 0, dt); return 1; }
    this.hold[id] -= dt;
    const other = this.focusId[id];
    if (other >= 0 && this.focusLife[id] === a.generation[other]) {
      this.focusX[id] = state.x[other]; this.focusZ[id] = state.z[other];
    }
    const bearing = Math.atan2(this.focusX[id] - state.x[id], this.focusZ[id] - state.z[id]);
    const offset = bearing - state.heading[id];
    this.turnHead(id, Math.max(-MAX_HEAD_YAW, Math.min(MAX_HEAD_YAW, Math.atan2(Math.sin(offset), Math.cos(offset)))), dt);
    return this.pace[id];
  }

  private onSidewalk(id: number): boolean {
    const a = this.agents;
    return !this.navigation.scramble || this.navigation.scramble.isSidewalk(a.current.x[id], a.current.z[id], a.radius[id] + 0.015);
  }

  private turnHead(id: number, target: number, dt: number): void {
    const difference = target - this.headYaw[id];
    if (difference === 0) return;
    // Ease the last part of a turn, snapping only subpixel residual angles.
    const step = Math.min(Math.abs(difference) * Math.min(1, dt * 9), TURN_RATE * dt);
    this.headYaw[id] += Math.abs(difference) < 0.001 ? difference : Math.sign(difference) * step;
  }

  private startLook(id: number, x: number, z: number, other = -1): void {
    this.focusX[id] = x; this.focusZ[id] = z;
    this.focusId[id] = other;
    if (other >= 0) this.focusLife[id] = this.agents.generation[other];
    this.hold[id] = this.random[id].range(0.45, 1.05);
    this.glanceCooldown[id] = this.hold[id] + this.random[id].range(0.4, 1.2);
  }

  private curbLook(id: number, routeX: number, routeZ: number, passerId: number): void {
    const layout = this.navigation.scenario.scramble;
    if (!layout) return;
    const state = this.agents.current, x = state.x[id], z = state.z[id], rng = this.random[id];
    if (rng.next() < 0.42) {
      const other = passerId >= 0 && state.vx[passerId] ** 2 + state.vz[passerId] ** 2 > 0.16
        ? passerId : this.movingPasser(id);
      if (other >= 0) {
        this.startLook(id, state.x[other], state.z[other], other);
        this.counts.waitLookStarts++;
        return;
      }
    }
    let farX = x + routeX * 10, farZ = z + routeZ * 10, best = Infinity;
    for (const crossing of layout.crosswalks) {
      const { from, to } = crossing;
      const dFrom = Math.hypot(from.x - x, from.z - z), dTo = Math.hypot(to.x - x, to.z - z);
      const near = dFrom < dTo ? from : to, far = dFrom < dTo ? to : from;
      const dx = far.x - near.x, dz = far.z - near.z;
      const score = Math.min(dFrom, dTo) - 9 * (dx * routeX + dz * routeZ) / Math.max(0.01, Math.hypot(dx, dz));
      if (score < best) { best = score; farX = far.x; farZ = far.z; }
    }
    let focusX = farX, focusZ = farZ;
    if (rng.next() < 0.65) {
      best = Infinity;
      for (const signal of layout.signalPositions) {
        const facing = signal.direction;
        if (facing && (x - signal.x) * facing.x + (z - signal.z) * facing.z < 0) continue;
        const distance = (signal.x - farX) ** 2 + (signal.z - farZ) ** 2;
        if (distance < best) { best = distance; focusX = signal.x; focusZ = signal.z; }
      }
    }
    this.startLook(id, focusX, focusZ);
    this.counts.waitLookStarts++;
  }

  private movingPasser(id: number): number {
    const grid = this.grid;
    if (!grid) return -1;
    const state = this.agents.current, heading = state.heading[id];
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const cell = grid.cells[id], cx = cell % grid.columns, cz = Math.floor(cell / grid.columns);
    let best = grid.cellSize ** 2, other = -1;
    for (let nz = Math.max(0, cz - 1); nz <= Math.min(cz + 1, grid.rows - 1); nz++) {
      for (let nx = Math.max(0, cx - 1); nx <= Math.min(cx + 1, grid.columns - 1); nx++) {
        const bucket = nz * grid.columns + nx, start = grid.offsets[bucket], count = grid.counts[bucket];
        for (let i = 0; i < Math.min(count, 4); i++) {
          const j = grid.indices[start + (id + i) % count];
          if (j === id || state.vx[j] ** 2 + state.vz[j] ** 2 < 0.16) continue;
          const dx = state.x[j] - state.x[id], dz = state.z[j] - state.z[id], distance = dx * dx + dz * dz;
          if (distance > 0.05 && distance < best && dx * fx + dz * fz >= 0) { best = distance; other = j; }
        }
      }
    }
    return other;
  }
}
