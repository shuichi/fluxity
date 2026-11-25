import type { PedestrianPortal, Point2 } from '../types';
import type { Random } from '../math/random';
import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';
import type { DoorwayClearance } from './DoorwayClearance';

interface Lane {
  portal: number;
  x: number; z: number;
  endX: number; endZ: number;
  length: number;
  queueX: number; queueZ: number; capture: number;
  outgoing: number; incoming: number; reserved: number;
  lastOut: number; lastIn: number;
  leaving: Set<number>;
  transferOwner: number;
  retryAfter: number;
}
interface Gate {
  exits: Lane[];
  entries: Lane[];
  admissions: number;
}
// Radius is at most 0.283 m. Leave room to advance without intersecting the preceding walker.
const HEADWAY = 0.83;
const LANE_PITCH = 0.615; // One maximum body diameter plus 5 cm between neighboring lanes.
const enum Stage { Walking, Aligning, Leaving, Entering }

/** The only movement allowed past the walkable map follows an explicitly reserved lane. */
export class PortalFlow {
  private readonly gates: Gate[];
  private readonly sharedEntry: boolean;
  private readonly stage: Uint8Array;
  private readonly destination: Lane[];
  private readonly passage: (Lane | undefined)[];
  private readonly reservation: (Lane | undefined)[];
  private readonly leader: Int32Array;
  private readonly alignment: Float32Array;
  private readonly transfers: Int32Array;
  private readonly retryAt: Int32Array;
  waitingAtMouth = false;
  transferCount = 0;

  constructor(private readonly portals: PedestrianPortal[], private readonly nav: Navigation,
    private readonly agents: AgentData, private readonly random: Random, private readonly doorways?: DoorwayClearance) {
    if (portals.length < 2 || portals.length !== nav.scenario.targets.length) {
      throw new Error('Portal scenarios require a passage for each destination and at least two passages.');
    }
    this.gates = portals.map((p, index) => {
      const dx = p.end.x - p.approach.x, dz = p.end.z - p.approach.z;
      const length = Math.hypot(dx, dz);
      if (!(length >= 0.5 && p.width >= 0.72) || !Number.isFinite(length + p.width)) {
        throw new Error(`Invalid passage dimensions for ${p.id}.`);
      }
      // Passing pedestrians keep right. Single-lane gates alternate directions by reservation.
      const lanes: Lane[] = [];
      const span = Math.max(0, p.width - (p.kind === 'door' ? 0.83 : 0.6));
      const pitch = p.kind === 'door' ? HEADWAY : LANE_PITCH;
      const count = Math.min(64, Math.floor(span / pitch) + 1);
      for (let k = 0; k < count; k++) {
        const offset = count === 1 ? 0 : span * (k / (count - 1) - 0.5);
        const ox = offset * dz / length, oz = -offset * dx / length;
        let x = p.approach.x + ox, z = p.approach.z + oz;
        if (!nav.isSpawnable(x, z, 0.34) || !nav.isReachable(x, z, index)) continue;
        // Let normal sidewalk steering handle the outer apron as long as its
        // path to the threshold is clear. Reserve the final two metres at a door.
        let controlledLength = length;
        if (p.kind === 'door' && length > 2) {
          const inset = (length - 2) / length, ax = x + dx * inset, az = z + dz * inset;
          if (nav.isSpawnable(ax, az, 0.34) && nav.isReachable(ax, az, index) && nav.lineOfSight(x, z, ax, az, 0.34)) {
            x = ax; z = az; controlledLength = 2;
          }
        }
        let queueX = x, queueZ = z;
        if (p.kind === 'door' && count > 1 && k >= Math.floor(count / 2)) {
          // Queue on the departure side of the shop instead of gathering across
          // the entrance. The first person then merges diagonally into the doorway.
          const ux = dx / length, uz = dz / length;
          const candidates = [3, 2, 1].map(offset => ({ x: x + uz * offset - ux * 1.1, z: z - ux * offset - uz * 1.1 }));
          if (p.queueApproach) candidates.unshift(p.queueApproach);
          for (const point of candidates) {
            if (nav.isSpawnable(point.x, point.z, 0.42) && nav.isReachable(point.x, point.z, index)
              && nav.lineOfSight(point.x, point.z, x, z, 0.34)) {
              queueX = point.x; queueZ = point.z;
              break;
            }
          }
        }
        const staged = queueX !== x || queueZ !== z;
        const capture = staged ? Math.hypot(queueX - x, queueZ - z) + 0.85 : 1.5;
        lanes.push({ portal: index, queueX, queueZ, capture, x, z, endX: p.end.x + ox, endZ: p.end.z + oz, length: controlledLength, retryAfter: 0,
          outgoing: 0, incoming: 0, reserved: 0, lastOut: -1, lastIn: -1, leaving: new Set<number>(), transferOwner: -1 });
      }
      if (!lanes.length) throw new Error(`No reachable sidewalk lane at ${p.id}.`);
      const split = Math.floor(lanes.length / 2);
      return {
        exits: lanes.slice(p.entry === false ? 0 : split),
        entries: p.entry === false ? [] : lanes.slice(0, Math.max(1, split)),
        admissions: 0,
      };
    });
    this.sharedEntry = this.gates.some(gate => gate.entries.some(lane => gate.exits.includes(lane)));
    this.stage = agents.portalStage;
    this.destination = new Array(agents.count);
    this.passage = new Array(agents.count);
    this.reservation = new Array(agents.count);
    this.retryAt = new Int32Array(agents.count);
    this.transfers = new Int32Array(agents.count);
    this.leader = new Int32Array(agents.count).fill(-1);
    this.alignment = new Float32Array(agents.count);
  }

  assignTarget(id: number, target: number): void {
    const exits = this.gates[target].exits;
    const lane = exits[this.random.int(exits.length)];
    this.destination[id] = lane;
    this.agents.targetId[id] = target;
    this.agents.targetX[id] = lane.queueX;
    this.agents.targetZ[id] = lane.queueZ;
  }

  inPassage(id: number): boolean { return this.stage[id] !== Stage.Walking; }

  /** Verifies the assigned segment, including its endpoints, to Float32 storage precision. */
  inLane(id: number): boolean {
    const lane = this.passage[id];
    if (!lane || this.stage[id] === Stage.Aligning) return false;
    const dx = lane.endX - lane.x, dz = lane.endZ - lane.z;
    const x = this.agents.current.x[id] - lane.x, z = this.agents.current.z[id] - lane.z;
    const along = (x * dx + z * dz) / lane.length;
    return along >= -0.001 && along <= lane.length + 0.001 && Math.abs(x * dz - z * dx) / lane.length < 0.001;
  }

  /** Pick the less crowded open lanes, with a preference for entries farther from the exit. */
  private availableEntry(id: number, exit: Lane, grid: SpatialGrid, ready: boolean): Lane | undefined {
    let best: Lane | undefined, bestScore = -Infinity;
    for (const gate of this.gates) {
      for (const lane of gate.entries) {
        if (lane.portal === exit.portal || lane.outgoing > 0 || (ready && !this.canAppear(id, lane))) continue;
        const occupancy = lane.reserved + lane.incoming;
        const capacity = Math.max(1, Math.floor(lane.length / HEADWAY));
        if (occupancy >= capacity) continue;
        const distance = Math.hypot(exit.x - lane.x, exit.z - lane.z);
        const crowd = grid.counts[grid.cellAt(lane.x, lane.z)];
        const score = 0.5 * distance / (distance + 40) + 2 / (2 + crowd)
          - occupancy / capacity - gate.admissions * 0.12 + this.random.range(0, 0.35);
        if (score > bestScore) { best = lane; bestScore = score; }
      }
    }
    return best;
  }

  /** Distance down the passage, measured from the public sidewalk. */
  private progress(lane: Lane, id: number): number {
    const read = this.agents.current;
    return ((read.x[id] - lane.x) * (lane.endX - lane.x) + (read.z[id] - lane.z) * (lane.endZ - lane.z)) / lane.length;
  }

  private canAppear(id: number, entry: Lane): boolean {
    if (entry.transferOwner >= 0) return entry.transferOwner === id;
    const ahead = entry.lastIn;
    return ahead < 0 || this.passage[ahead] !== entry || this.stage[ahead] !== Stage.Entering
      || this.progress(entry, ahead) <= entry.length - HEADWAY;
  }

  /** Check only the final metre where the controlled passage meets ordinary steering.
   * A pathological grid cell is treated as busy. No admission searches the entire crowd. */
  private clearStep(id: number, x: number, z: number, grid: SpatialGrid): boolean {
    const a = this.agents, read = a.current;
    // Steering requests full personal space. In a dense sidewalk queue shoulders can
    // brush while the narrower body centres still have room to pass.
    const spacing = grid.counts[grid.cellAt(x, z)] > 8 ? 0.75 : 1;
    const reach = a.radius[id] + 0.283;
    const start = grid.cellAt(x - reach, z - reach), end = grid.cellAt(x + reach, z + reach);
    let examined = 0;
    for (let row = Math.floor(start / grid.columns); row <= Math.floor(end / grid.columns); row++) {
      for (let col = start % grid.columns; col <= end % grid.columns; col++) {
        const adjacent = row * grid.columns + col;
        for (let k = grid.offsets[adjacent]; k < grid.offsets[adjacent + 1]; k++) {
          const other = grid.indices[k];
          if (other === id) continue;
          // Other passage walkers are already separated by the lane headway.
          if (this.passage[other] === this.passage[id] && this.passage[id]) continue;
          if (++examined > 128) return false;
          const dx = x - read.x[other], dz = z - read.z[other];
          const required = (a.radius[id] + a.radius[other]) * spacing;
          const oldX = read.x[id] - read.x[other], oldZ = read.z[id] - read.z[other];
          const d2 = dx * dx + dz * dz;
          // Always permit moving away from a pre-existing overlap.
          if (d2 < required * required && d2 < oldX * oldX + oldZ * oldZ) return false;
        }
      }
    }
    return true;
  }

  private reservePassages(id: number, x: number, z: number, step: number, grid: SpatialGrid): boolean {
    const a = this.agents;
    const lane = this.destination[id];
    // Require proximity to the actual lane mouth, with a clear swept approach from the same sidewalk.
    const staged = lane.queueX !== lane.x || lane.queueZ !== lane.z;
    const capture = lane.capture;
    if (Math.abs(x - lane.x) > capture || Math.abs(z - lane.z) > capture
      || Math.hypot(x - lane.x, z - lane.z) > capture) return false;
    this.waitingAtMouth = staged ? Math.hypot(x - lane.queueX, z - lane.queueZ) < 0.38 : true;
    if (step < this.retryAt[id]) return false;
    if (a.preferredSpeed[id] <= 0 || lane.incoming + lane.reserved > 0 || step < lane.retryAfter) return false;
    // Someone reaching the mouth from the side may already be partway along
    // the public apron. Join the lane beside them without an outward-then-inward turn.
    let join = Math.max(0, Math.min(lane.length, this.progress(lane, id)));
    const door = this.portals[lane.portal].kind === 'door';
    if (door) {
      // While someone crosses the queue, all other arrivals wait. Check this
      // before querying sidewalk geometry for the next joining position.
      for (const other of lane.leaving) if (this.stage[other] === Stage.Aligning) return false;
      // Merge diagonally toward the threshold, using only the reachable sidewalk
      // before the facade. A lateral alignment at the same depth cuts across the queue.
      const unitX = (lane.endX - lane.x) / lane.length, unitZ = (lane.endZ - lane.z) / lane.length;
      for (let advance = 1; advance > 0; advance -= 0.25) {
        const candidate = Math.min(lane.length, join + advance);
        const jx = lane.x + unitX * candidate, jz = lane.z + unitZ * candidate;
        if (this.nav.isSpawnable(jx, jz, a.radius[id] + 0.015)
          && this.nav.lineOfSight(x, z, jx, jz, a.radius[id] + 0.015)) { join = candidate; break; }
      }
    }
    let ahead = lane.outgoing ? lane.lastOut : -1;
    if (door) {
      // A sidewalk walker may join from the side already ahead of the queue.
      for (const other of lane.leaving) {
        const gap = this.progress(lane, other) - join;
        if (gap >= -0.05 && gap < HEADWAY) return false;
      }
      ahead = -1;
    } else if (ahead >= 0 && (this.stage[ahead] !== Stage.Leaving || this.progress(lane, ahead) - join < HEADWAY)) {
      return false;
    }
    const fraction = join / lane.length;
    const joinX = lane.x + (lane.endX - lane.x) * fraction;
    const joinZ = lane.z + (lane.endZ - lane.z) * fraction;
    if (!this.nav.isSpawnable(joinX, joinZ, a.radius[id] + 0.015)
      || !this.nav.lineOfSight(x, z, joinX, joinZ, a.radius[id] + 0.015)) {
      this.waitingAtMouth = false;
      return false;
    }
    // A shared single-file entrance must be reserved before moving in the
    // opposite direction. Independent lanes claim a landing only at the final steps.
    if (this.sharedEntry) {
      const entry = this.availableEntry(id, lane, grid, false);
      if (!entry) {
        lane.retryAfter = step + 5;
        return false;
      }
      this.reserveEntry(id, entry);
    }
    this.leader[id] = ahead;
    lane.lastOut = id;
    if (door) lane.leaving.add(id);
    lane.outgoing++;
    this.passage[id] = lane;
    this.alignment[id] = fraction;
    this.stage[id] = Stage.Aligning;
    a.stalledTime[id] = 0;
    return true;
  }

  private reserveEntry(id: number, entry: Lane): void {
    entry.reserved++;
    this.gates[entry.portal].admissions++;
    this.reservation[id] = entry;
  }

  private unlinkExit(id: number, lane: Lane): void {
    if (lane.lastOut === id) lane.lastOut = this.leader[id];
    lane.leaving.delete(id);
    lane.outgoing--;
  }

  private rejoinSidewalk(id: number, lane: Lane): void {
    lane.incoming--;
    this.stage[id] = Stage.Walking;
    this.passage[id] = undefined;
    this.agents.opacity[id] = 1;
  }

  /** Returns true when the approach or passage owns this step's movement. */
  move(id: number, dt: number, step: number, grid: SpatialGrid, result: Point2): boolean {
    const a = this.agents, read = a.current;
    const x = read.x[id], z = read.z[id];
    this.waitingAtMouth = false;
    if (this.stage[id] === Stage.Walking && !this.reservePassages(id, x, z, step, grid)) return false;

    const lane = this.passage[id]!;
    const outward = this.stage[id] === Stage.Leaving;
    const fraction = outward ? 1 : this.stage[id] === Stage.Aligning ? this.alignment[id] : 0;
    const tx = lane.x + (lane.endX - lane.x) * fraction;
    const tz = lane.z + (lane.endZ - lane.z) * fraction;
    const dx = tx - x, dz = tz - z, remaining = Math.hypot(dx, dz);
    a.preferredVX[id] = remaining > 0.001 ? dx * a.preferredSpeed[id] / remaining : 0;
    a.preferredVZ[id] = remaining > 0.001 ? dz * a.preferredSpeed[id] / remaining : 0;
    const previousSpeed = Math.hypot(read.vx[id], read.vz[id]);
    const speed = Math.max(previousSpeed - 3.8 * dt, Math.min(a.preferredSpeed[id], previousSpeed + 3.8 * dt));
    let distance = speed * dt;
    if (this.stage[id] !== Stage.Aligning) {
      const ahead = this.leader[id];
      const progress = this.progress(lane, id);
      if (outward && this.portals[lane.portal].kind === 'door') {
        // Use actual depth along the lane. A side arrival may complete alignment
        // while the original queue has already moved past its joining position.
        for (const other of lane.leaving) {
          if (other === id || this.stage[other] !== Stage.Leaving) continue;
          const gap = this.progress(lane, other) - progress;
          if (gap > 0.001) distance = Math.min(distance, Math.max(0, gap - HEADWAY));
        }
      } else if (ahead >= 0 && this.passage[ahead] === lane && this.stage[ahead] === this.stage[id]) {
        const gap = outward ? this.progress(lane, ahead) - progress : progress - this.progress(lane, ahead);
        distance = Math.min(distance, Math.max(0, gap - HEADWAY));
      }
      // Variable walking speeds can deliver two tickets close together. Wait before the facade or fade.
      if (outward) {
        let entry = this.reservation[id];
        const visibleEnd = this.portals[lane.portal].kind === 'door' ? Math.max(0.1, lane.length - 1.15) : Math.max(0.15, lane.length - 3);
        if (progress + distance >= visibleEnd && entry?.transferOwner !== id) {
          if (!entry) {
            entry = this.availableEntry(id, lane, grid, true);
            if (entry) this.reserveEntry(id, entry);
          }
          if (entry && this.canAppear(id, entry)) entry.transferOwner = id;
          else distance = Math.min(distance, Math.max(0, visibleEnd - progress));
        }
      }
    }
    let reached = remaining <= distance + 0.00001;
    result.x = reached ? tx : x + dx * distance / remaining;
    result.z = reached ? tz : z + dz * distance / remaining;
    // Once the entrant has reached open sidewalk, local steering can merge into the
    // crowd around a busy doorway instead of waiting for its exact centre to clear.
    const portal = this.portals[lane.portal];
    const walkedIn = lane.length - remaining;
    const mergeDistance = Math.min(2, Math.hypot(portal.end.x - portal.approach.x, portal.end.z - portal.approach.z) * 0.5);
    if (this.stage[id] === Stage.Entering && a.opacity[id] >= 0.9999 && (walkedIn >= mergeDistance || portal.kind === 'door' && a.stalledTime[id] > 0.3)
      && this.nav.isSpawnable(x, z, 0.34) && this.nav.lineOfSight(x, z, lane.x, lane.z, 0.34)) {
      this.rejoinSidewalk(id, lane);
      return false;
    }
    const onApron = this.stage[id] === Stage.Aligning || (outward ? lane.length - remaining : remaining) < 1.5;
    const throughDoor = this.portals[lane.portal].kind === 'door' && this.doorways;
    const clear = throughDoor ? throughDoor.limit(id, result.x, result.z, dt, result, this.stage[id] === Stage.Aligning ? false : undefined)
      : !onApron || this.clearStep(id, result.x, result.z, grid);
    if (!clear) {
      if (this.stage[id] === Stage.Aligning && a.stalledTime[id] >= 0.6) {
        // The sidewalk crowd can close a gap while a walker lines up. Yield with
        // ordinary steering and let another walker use the opening from a clear angle.
        const entry = this.reservation[id];
        if (entry) { entry.reserved--; this.gates[entry.portal].admissions--; }
        this.retryAt[id] = step + 24;
        this.unlinkExit(id, lane);
        this.reservation[id] = this.passage[id] = undefined;
        this.stage[id] = Stage.Walking;
        this.waitingAtMouth = true;
        return false;
      }
      if (!throughDoor) { result.x = x; result.z = z; }
      reached = false;
    }
    if (this.stage[id] !== Stage.Aligning) {
      const fromEnd = Math.hypot(lane.endX - result.x, lane.endZ - result.z);
      const fade = this.portals[lane.portal].kind === 'street' ? Math.min(3, lane.length) : 0.35;
      const t = Math.min(1, fromEnd / fade);
      a.opacity[id] = t * t * (3 - 2 * t);
    }
    if (reached) {
      if (this.stage[id] === Stage.Aligning) {
        this.stage[id] = Stage.Leaving;
      } else if (outward) {
        if (this.reservation[id]?.transferOwner === id) this.transfers[this.transferCount++] = id;
      } else {
        this.rejoinSidewalk(id, lane);
      }
    }
    return true;
  }

  /** Apply all replacements after all steering reads, before publishing this fixed step. */
  replaceArrivals(newPerson: (id: number) => void): void {
    const a = this.agents, write = a.next;
    for (let n = 0; n < this.transferCount; n++) {
      const id = this.transfers[n], exit = this.passage[id]!, entry = this.reservation[id]!;
      this.unlinkExit(id, exit);
      entry.transferOwner = -1;
      entry.reserved--;
      this.leader[id] = entry.incoming ? entry.lastIn : -1;
      entry.lastIn = id;
      entry.incoming++;
      this.stage[id] = Stage.Entering;
      this.passage[id] = entry;
      this.reservation[id] = undefined;
      newPerson(id);
      a.generation[id] = (a.generation[id] + 1) % 16777216; // Exactly representable in a float snapshot.
      const dx = (entry.x - entry.endX) / entry.length, dz = (entry.z - entry.endZ) / entry.length;
      write.x[id] = entry.endX; write.z[id] = entry.endZ;
      write.vx[id] = dx * a.preferredSpeed[id]; write.vz[id] = dz * a.preferredSpeed[id];
      write.heading[id] = Math.atan2(dx, dz);
      write.phase[id] = this.random.range(0, Math.PI * 2);
      a.stalledTime[id] = 0; a.opacity[id] = 0;
      a.preferredVX[id] = write.vx[id]; a.preferredVZ[id] = write.vz[id];
      const target = this.nav.scenario.targetTransitions?.[entry.portal] ?? this.randomDestination(entry.portal);
      this.assignTarget(id, target);
    }
    this.transferCount = 0;
  }

  private randomDestination(entry: number): number {
    // Prefer a trip through the scene over immediately exiting on the same side.
    const from = this.portals[entry].approach;
    let target = -1, best = -Infinity;
    for (let i = 0; i < this.portals.length; i++) {
      if (i === entry) continue;
      const to = this.portals[i].approach;
      const score = this.random.range(0.2, 1) * Math.hypot(to.x - from.x, to.z - from.z);
      if (score > best) { target = i; best = score; }
    }
    return target;
  }
}
