import type { PedestrianPortal, Point2 } from '../types';
import type { Random } from '../math/random';
import type { AgentData } from './AgentData';
import type { Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';
import { doorwayRadius, type DoorwayClearance } from './DoorwayClearance';
import { canSeeWalker } from './PedestrianVisibility';

interface Lane {
  portal: number;
  x: number; z: number;
  endX: number; endZ: number;
  length: number;
  minOffset: number; maxOffset: number;
  queueX: number; queueZ: number;
  crowdStep: number; blockedLanding: number;
  outgoing: number; incoming: number; reserved: number;
  lastOut: number; lastIn: number;
  leaving: Set<number>;
  transferOwner: number;
  retryAfter: number;
}
interface Gate {
  exits: Lane[];
  entries: Lane[];
  emerging: Set<number>;
  admissions: number;
}
// The maximum shoulder diameter at a doorway is 0.821 m.
const HEADWAY = 0.83;
const CAPTURE = 1.5;
const LANE_PITCH = 0.615; // One maximum body diameter plus 5 cm between neighboring lanes.
// Lateral and outward distances for a half-step on the public sidewalk.
const REFUGES = [[0.5, 0.12], [0.35, 0.46], [0, 0.55], [-0.25, 0.52]] as const;
const enum Stage { Walking, Aligning, Leaving, Entering }

/** The only movement allowed past the walkable map follows an explicitly reserved lane. */
export class PortalFlow {
  private readonly gates: Gate[];
  readonly completedTrips: Uint32Array;
  private readonly sharedEntry: boolean;
  private readonly stage: Uint8Array;
  private readonly destination: Lane[];
  private readonly passage: (Lane | undefined)[];
  private readonly reservation: (Lane | undefined)[];
  private readonly leader: Int32Array;
  private readonly alignment: Float32Array;
  private readonly trackOffset: Float32Array;
  private readonly onApproach: Uint8Array;
  private readonly transfers: Int32Array;
  private readonly retryAt: Int32Array;
  private readonly stepAsideX: Float32Array;
  private readonly stepAsideZ: Float32Array;
  private readonly stepAsideTime: Float32Array;
  private readonly pocket = { x: 0, z: 0 };
  private readonly trialStep = { x: 0, z: 0 };
  private blockedByEmergence = false;
  waitingAtMouth = false;
  yieldForEmergence = true;
  transferCount = 0;

  constructor(private readonly portals: PedestrianPortal[], private readonly nav: Navigation,
    private readonly agents: AgentData, private readonly random: Random, private readonly doorways?: DoorwayClearance) {
    if (portals.length < 2 || portals.length !== nav.scenario.targets.length) {
      throw new Error('Portal scenarios require a passage for each destination and at least two passages.');
    }
    this.completedTrips = new Uint32Array(portals.length);
    this.gates = portals.map((p, index) => {
      const dx = p.end.x - p.approach.x, dz = p.end.z - p.approach.z;
      const length = Math.hypot(dx, dz);
      if (!(length >= 0.5 && p.width >= 0.72) || !Number.isFinite(length + p.width)) {
        throw new Error(`Invalid passage dimensions for ${p.id}.`);
      }
      // Each lane must connect to the same reachable sidewalk as its destination.
      const lanes: Lane[] = [];
      const span = Math.max(0, p.width - (p.kind === 'door' ? HEADWAY : 0.6));
      const pitch = p.kind === 'door' ? HEADWAY : LANE_PITCH;
      const count = Math.min(64, Math.floor(span / pitch) + 1);
      for (let k = 0; k < count; k++) {
        const offset = count === 1 ? 0 : span * (k / (count - 1) - 0.5);
        const ox = offset * dz / length, oz = -offset * dx / length;
        let x = p.approach.x + ox, z = p.approach.z + oz;
        if (!nav.isSpawnable(x, z, 0.34) || !nav.isReachable(x, z, index)) continue;
        // Place each mouth at the last shoulder-clear point on its authored
        // approach. Curved pavement edges can cut neighboring lanes at different depths.
        let controlledLength = length;
        if (p.kind === 'door' && length > 2 && (!nav.urban || count < 4)) {
          const inset = (length - 2) / length, ax = x + dx * inset, az = z + dz * inset;
          if (nav.isSpawnable(ax, az, 0.34) && nav.lineOfSight(x, z, ax, az, 0.34)) {
            x = ax; z = az; controlledLength = 2;
          }
        } else if (p.kind === 'door' && length > 2) {
          for (let advance = 0.25; advance <= length - 1; advance += 0.25) {
            const ax = p.approach.x + ox + dx * advance / length;
            const az = p.approach.z + oz + dz * advance / length;
            if (!nav.isSpawnable(ax, az, 0.34) || !nav.lineOfSight(x, z, ax, az, 0.34)) break;
            x = ax; z = az; controlledLength = length - advance;
          }
        }
        const q = p.queueApproach;
        const queue = q && nav.isSpawnable(q.x, q.z, 0.42) && nav.lineOfSight(q.x, q.z, x, z, 0.34) ? q : undefined;
        const queueX = queue?.x ?? x, queueZ = queue?.z ?? z;
        // The public sidewalk handles queuing. Claim the threshold only when
        // the walker is close enough to join it in about one stride.
        lanes.push({
          portal: index, x, z, endX: p.end.x + ox, endZ: p.end.z + oz, length: controlledLength,
          queueX, queueZ, minOffset: 0, maxOffset: 0, crowdStep: -1, blockedLanding: 0,
          outgoing: 0, incoming: 0, reserved: 0, lastOut: -1, lastIn: -1,
          leaving: new Set<number>(), transferOwner: -1, retryAfter: 0,
        });
      }
      if (!lanes.length) throw new Error(`No reachable sidewalk lane at ${p.id}.`);
      // People queue on the public side. A smaller bank of emergence lanes can
      // serve the replenishment shared across all gates.
      const split = Math.floor(lanes.length / (p.kind === 'door' && lanes.length >= 4 ? 3 : 2));
      const central = p.kind === 'door' && lanes.length >= 4 && p.entry !== false;
      const firstEntry = central ? Math.floor((lanes.length - split) / 2) : 0;
      const entries = p.entry === false ? [] : lanes.slice(firstEntry, firstEntry + Math.max(1, split));
      const exits = p.entry === false ? lanes : lanes.filter(lane => !entries.includes(lane));
      if (!exits.length) exits.push(lanes[0]); // A narrow passage alternates directions.
      if (p.kind === 'door' && exits.length >= 2) {
        // Each intake bank is continuous. Someone already
        // lined up with an opening can walk straight in on their own parallel
        // track without first edging sideways to the exact centre of a lane.
        for (let k = 0; k < exits.length; k++) {
          const lane = exits[k];
          for (const neighbor of [exits[k - 1], exits[k + 1]]) {
            if (!neighbor) continue;
            const offset = ((neighbor.endX - lane.endX) * dz - (neighbor.endZ - lane.endZ) * dx) / length;
            if (Math.abs(offset) > HEADWAY * 1.7) continue;
            lane.minOffset = Math.min(lane.minOffset, offset / 2);
            lane.maxOffset = Math.max(lane.maxOffset, offset / 2);
          }
        }
      }
      return { exits, entries, emerging: new Set<number>(), admissions: 0 };
    });
    this.sharedEntry = this.gates.some(gate => gate.entries.some(lane => gate.exits.includes(lane)));
    this.stage = agents.portalStage;
    this.destination = new Array(agents.count);
    this.passage = new Array(agents.count);
    this.reservation = new Array(agents.count);
    this.retryAt = new Int32Array(agents.count);
    this.stepAsideX = new Float32Array(agents.count);
    this.stepAsideZ = new Float32Array(agents.count);
    this.stepAsideTime = new Float32Array(agents.count);
    this.transfers = new Int32Array(agents.count);
    this.leader = new Int32Array(agents.count).fill(-1);
    this.alignment = new Float32Array(agents.count);
    this.trackOffset = new Float32Array(agents.count);
    this.onApproach = new Uint8Array(agents.count);
  }

  assignTarget(id: number, target: number): void {
    const exits = this.gates[target].exits;
    const lane = exits[this.random.int(exits.length)];
    this.destination[id] = lane;
    this.onApproach[id] = 0;
    this.stepAsideTime[id] = 0;
    this.agents.targetId[id] = target;
    this.agents.targetX[id] = lane.queueX;
    this.agents.targetZ[id] = lane.queueZ;
  }

  /** Through traffic follows the public sidewalk around the entrance apron. */
  guideSidewalk(id: number, direction: Point2): void {
    if (!this.nav.urban) return;
    const a = this.agents, x = a.current.x[id], z = a.current.z[id];
    for (const gate of this.gates) {
      const lane = gate.exits[0], portal = this.portals[lane.portal];
      if (portal.kind !== 'door' || gate.exits.length < 2) continue;
      const ex = x - portal.end.x, ez = z - portal.end.z;
      if (Math.abs(ex) > 12 || Math.abs(ez) > 12) continue;
      const ux = (lane.endX - lane.x) / lane.length, uz = (lane.endZ - lane.z) / lane.length;
      const depth = -(ex * ux + ez * uz), tangent = ex * uz - ez * ux;
      if (lane.portal === this.destination[id].portal || Math.abs(tangent) > portal.width / 2 + 7
        || depth < 0 || depth > 6.1) continue;
      const outward = Math.max(-0.2, Math.min(1.3, (5.6 - depth) * 0.65));
      const side = Math.sign(direction.x * uz - direction.z * ux);
      const dx = side * uz - outward * ux, dz = -side * ux - outward * uz;
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      const vx = dx / length, vz = dz / length;
      if (!this.nav.isSpawnable(x + vx * 0.8, z + vz * 0.8, a.radius[id] + 0.015)) continue;
      direction.x = vx; direction.z = vz;
      return;
    }
  }

  inPassage(id: number): boolean { return this.stage[id] !== Stage.Walking; }
  steppingAside(id: number): boolean { return this.yieldForEmergence && this.stepAsideTime[id] > 0; }
  shopMouths(portal: number): readonly Point2[] { return this.gates[portal].exits; }

  /** Verifies the assigned segment, including its endpoints, to Float32 storage precision. */
  inLane(id: number): boolean {
    const lane = this.passage[id];
    if (!lane || this.stage[id] === Stage.Aligning) return false;
    const dx = lane.endX - lane.x, dz = lane.endZ - lane.z;
    const x = this.agents.current.x[id] - lane.x, z = this.agents.current.z[id] - lane.z;
    const along = (x * dx + z * dz) / lane.length;
    return along >= -0.001 && along <= lane.length + 0.001 && Math.abs((x * dz - z * dx) / lane.length - this.trackOffset[id]) < 0.001;
  }

  /** Pick the less crowded open lanes, with a preference for entries farther from the exit. */
  private availableEntry(id: number, exit: Lane, grid: SpatialGrid, ready: boolean, step: number): Lane | undefined {
    let best: Lane | undefined, bestScore = -Infinity;
    for (const gate of this.gates) {
      for (const lane of gate.entries) {
        if (lane.portal === exit.portal || lane.outgoing > 0 || (ready && !this.canAppear(id, lane))) continue;
        const occupancy = lane.reserved + lane.incoming;
        const capacity = Math.max(1, Math.floor(lane.length / HEADWAY));
        if (occupancy >= capacity) continue;
        const distance = Math.hypot(exit.x - lane.x, exit.z - lane.z);
        const crowd = grid.counts[grid.cellAt(lane.x, lane.z)];
        const obstruction = ready && this.portals[lane.portal].kind === 'door' ? this.blockedLanding(lane, grid, step) : 0;
        const score = -obstruction * 1.5 + 0.5 * distance / (distance + 40) + 2 / (2 + crowd)
          - occupancy / capacity - gate.admissions * 0.12 + this.random.range(0, 0.35);
        if (score > bestScore) { best = lane; bestScore = score; }
      }
    }
    return best;
  }

  /** Replacements have a choice of doors. Prefer a clear landing over adding
   * another person behind a stationary crowd on a narrow sidewalk. */
  private blockedLanding(lane: Lane, grid: SpatialGrid, step: number): number {
    if (lane.crowdStep === step) return lane.blockedLanding;
    lane.crowdStep = step;
    const x = lane.x + 0.8 * (lane.x - lane.endX) / lane.length;
    const z = lane.z + 0.8 * (lane.z - lane.endZ) / lane.length;
    const first = grid.cellAt(x - 1.3, z - 1.3), last = grid.cellAt(x + 1.3, z + 1.3);
    let blocked = 0, inspected = 0;
    for (let row = Math.floor(first / grid.columns); row <= Math.floor(last / grid.columns); row++) {
      for (let col = first % grid.columns; col <= last % grid.columns; col++) {
        const cell = row * grid.columns + col;
        for (let k = grid.offsets[cell]; k < grid.offsets[cell + 1]; k++) {
          // An overcrowded approach is already a poor place to emerge.
          if (++inspected > 96) {
            lane.blockedLanding = Math.max(blocked, 8);
            return lane.blockedLanding;
          }
          const id = grid.indices[k];
          const dx = this.agents.current.x[id] - x, dz = this.agents.current.z[id] - z;
          if (this.agents.stalledTime[id] > 0.5 && dx * dx + dz * dz < 1.6) blocked++;
        }
      }
    }
    lane.blockedLanding = blocked;
    return blocked;
  }

  /** Distance down the passage, measured from the public sidewalk. */
  private progress(lane: Lane, id: number): number {
    const read = this.agents.current;
    return ((read.x[id] - lane.x) * (lane.endX - lane.x) + (read.z[id] - lane.z) * (lane.endZ - lane.z)) / lane.length;
  }

  /** Clip a proposed alignment to the short stretch an emerging walker still needs.
   * All depths are measured from that person's current position towards the sidewalk. */
  private conflictingEmergence(id: number, gate: Gate, x: number, z: number, tx: number, tz: number, grid: SpatialGrid): number {
    if (!this.yieldForEmergence || !this.nav.urban || gate.exits.length < 2 || this.portals[gate.exits[0].portal].kind !== 'door') return -1;
    const a = this.agents, s = a.current;
    for (const other of gate.emerging) {
      if (a.opacity[other] < 0.5) continue;
      const entry = this.passage[other]!, ux = (entry.x - entry.endX) / entry.length, uz = (entry.z - entry.endZ) / entry.length;
      const rx = x - s.x[other], rz = z - s.z[other];
      if (Math.abs(rx) > 3.5 || Math.abs(rz) > 3.5) continue;
      // Give an imminent encounter room at once. Farther out, approaching people
      // can usually pass in stride; intervene only after one has lost progress.
      if (rx * rx + rz * rz > 1 && a.stalledTime[id] < 0.6 && a.stalledTime[other] < 0.6) continue;
      const depth = rx * ux + rz * uz, side = rx * uz - rz * ux;
      const dd = (tx - x) * ux + (tz - z) * uz, ds = (tx - x) * uz - (tz - z) * ux;
      const space = doorwayRadius(a.scale[id]) + doorwayRadius(a.scale[other]) + 0.08;
      const ahead = Math.min(1.8, this.progress(entry, other) + 0.55);
      // An alignment that is already carrying the blocker clear may finish.
      if (dd >= -0.02 && side * ds >= 0 && Math.abs(side + ds) >= space && Math.abs(side + ds) > Math.abs(side)) continue;
      let from = 0, to = 1;
      if (Math.abs(dd) > 0.0001) {
        const b = (-0.1 - depth) / dd, e = (ahead - depth) / dd;
        from = Math.max(0, Math.min(b, e)); to = Math.min(1, Math.max(b, e));
      } else if (depth < -0.1 || depth > ahead) continue;
      if (from > to) continue;
      const start = side + ds * from, end = side + ds * to;
      if (Math.min(start, end) < space && Math.max(start, end) > -space && canSeeWalker(a, this.nav, grid, id, other)) return other;
    }
    return -1;
  }

  private makeRoom(id: number, other: number, x: number, z: number, dt: number): void {
    this.blockedByEmergence = true;
    if (this.stepAsideTime[id] > 0) return;
    this.waitingAtMouth = true;
    const a = this.agents, entry = this.passage[other]!;
    const ux = (entry.x - entry.endX) / entry.length, uz = (entry.z - entry.endZ) / entry.length;
    const rx = x - a.current.x[other], rz = z - a.current.z[other];
    const side = rx * uz - rz * ux;
    if (a.preferredSpeed[id] <= 0 || Math.abs(side) > doorwayRadius(a.scale[id]) + doorwayRadius(a.scale[other]) + 0.08
      || rx * ux + rz * uz < -0.1 || !this.doorways) return;
    const sign = side >= 0 ? 1 : -1, radius = a.radius[id] + 0.015;
    // Try the nearer side first, then diagonally back into the public sidewalk.
    // The same swept shoulder checks that integrate actual steps certify the pocket.
    for (const [sideStep, outward] of REFUGES) {
      const tx = x + sign * uz * sideStep + ux * outward, tz = z - sign * ux * sideStep + uz * outward;
      if (!this.nav.urban!.sidewalks.lineInside(x, z, tx, tz, radius)) continue;
      this.doorways.limit(id, tx, tz, dt, this.pocket, true);
      const dx = this.pocket.x - x, dz = this.pocket.z - z;
      if (sign * (dx * uz - dz * ux) < 0.18 && dx * ux + dz * uz < 0.30) continue;
      if (!this.nav.urban!.sidewalks.lineInside(x, z, this.pocket.x, this.pocket.z, radius)) continue;
      this.stepAsideX[id] = this.pocket.x; this.stepAsideZ[id] = this.pocket.z;
      this.stepAsideTime[id] = 0.8;
      this.waitingAtMouth = false;
      return;
    }
  }

  private moveAside(id: number, x: number, z: number, dt: number, result: Point2): boolean {
    const a = this.agents, dx = this.stepAsideX[id] - x, dz = this.stepAsideZ[id] - z;
    const length = Math.hypot(dx, dz);
    this.stepAsideTime[id] -= dt;
    if (length < 0.06 || this.stepAsideTime[id] <= 0) { this.stepAsideTime[id] = 0; return false; }
    const pace = Math.min(a.preferredSpeed[id], 0.85, Math.hypot(a.current.vx[id], a.current.vz[id]) + 3.8 * dt);
    const fraction = Math.min(1, pace * dt / length);
    const px = Math.fround(x + dx * fraction), pz = Math.fround(z + dz * fraction);
    if (!this.nav.urban!.sidewalks.lineInside(x, z, px, pz, a.radius[id] + 0.015)) {
      this.stepAsideTime[id] = 0;
      return false;
    }
    a.preferredVX[id] = pace * dx / length; a.preferredVZ[id] = pace * dz / length;
    this.doorways!.limit(id, px, pz, dt, result, true);
    return true;
  }

  /** A wide intake accepts parallel tracks between its adjacent lane centers. When a
   * shoulder clips the straight step, advance around it within the *same* intake. */
  private slideInBank(id: number, lane: Lane, distance: number, dt: number, result: Point2): boolean {
    if (!this.yieldForEmergence || !this.nav.urban || this.reservation[id] || distance < 0.001
      || lane.minOffset === lane.maxOffset || this.agents.stalledTime[id] < 0.25) return false;
    const s = this.agents.current, x = s.x[id], z = s.z[id];
    const ux = (lane.endX - lane.x) / lane.length, uz = (lane.endZ - lane.z) / lane.length;
    let best = (result.x - x) * ux + (result.z - z) * uz;
    if (best > distance * 0.3) return false;
    const offset = (x - lane.x) * uz - (z - lane.z) * ux;
    let changed = false;
    for (const edge of [lane.minOffset, lane.maxOffset]) {
      const sideways = Math.max(-distance * 0.7, Math.min(distance * 0.7, edge - offset));
      if (Math.abs(sideways) < distance * 0.04) continue;
      const forward = Math.sqrt(distance * distance - sideways * sideways);
      this.doorways!.limit(id, x + ux * forward + uz * sideways, z + uz * forward - ux * sideways, dt, this.trialStep);
      const progress = (this.trialStep.x - x) * ux + (this.trialStep.z - z) * uz;
      if (progress <= best + 0.00001) continue;
      best = progress;
      result.x = this.trialStep.x; result.z = this.trialStep.z;
      changed = true;
    }
    if (changed) this.trackOffset[id] = (result.x - lane.x) * uz - (result.z - lane.z) * ux;
    return changed;
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

  private reservePassages(id: number, x: number, z: number, step: number, grid: SpatialGrid, dt: number): boolean {
    const assigned = this.destination[id];
    const gate = this.gates[assigned.portal];
    const p = this.portals[assigned.portal], door = p.kind === 'door';
    const reach = door ? p.width * 0.5 + 3 : CAPTURE;
    const nearby = Math.abs(x - assigned.x) <= reach && Math.abs(z - assigned.z) <= reach;
    if (!this.onApproach[id] && (assigned.queueX !== assigned.x || assigned.queueZ !== assigned.z)) {
      const dx = x - assigned.queueX, dz = z - assigned.queueZ;
      if (dx * dx + dz * dz < 1 || (nearby && this.progress(assigned, id) > -Math.hypot(assigned.queueX - assigned.x, assigned.queueZ - assigned.z)
        && this.nav.lineOfSight(x, z, assigned.x, assigned.z, this.agents.radius[id] + 0.015))) {
        this.agents.targetX[id] = assigned.x; this.agents.targetZ[id] = assigned.z;
        this.onApproach[id] = 1;
      }
    }
    if (!nearby) return false;
    this.waitingAtMouth = Math.hypot(x - assigned.x, z - assigned.z) < (door ? 0.35 : CAPTURE);
    if (step < this.retryAt[id] || this.agents.preferredSpeed[id] <= 0) return false;
    if (!door || gate.exits.length === 1) return this.tryLane(id, assigned, x, z, step, grid, dt);
    // Admit the pedestrian at the front on the track already beneath their
    // feet, even when they originally approached a different part of the door.
    let nearest = assigned, least = Infinity;
    for (const lane of gate.exits) {
      const lateral = ((x - lane.x) * (lane.endZ - lane.z) - (z - lane.z) * (lane.endX - lane.x)) / lane.length;
      const correction = Math.abs(lateral - Math.max(lane.minOffset, Math.min(lane.maxOffset, lateral)));
      if (correction < least) { least = correction; nearest = lane; }
    }
    if (this.tryLane(id, nearest, x, z, step, grid, dt)) return true;
    for (const lane of gate.exits) {
      if (lane !== nearest && this.tryLane(id, lane, x, z, step, grid, dt)) return true;
    }
    return false;
  }

  private tryLane(id: number, lane: Lane, x: number, z: number, step: number, grid: SpatialGrid, dt: number): boolean {
    const a = this.agents, door = this.portals[lane.portal].kind === 'door';
    if (lane.incoming + lane.reserved > 0 || step < lane.retryAfter) return false;
    const depth = this.progress(lane, id);
    const along = door ? Math.max(0, Math.min(1, depth / lane.length)) : 0;
    const mouthX = lane.x + (lane.endX - lane.x) * along, mouthZ = lane.z + (lane.endZ - lane.z) * along;
    if (Math.abs(x - mouthX) > CAPTURE || Math.abs(z - mouthZ) > CAPTURE
      || (x - mouthX) ** 2 + (z - mouthZ) ** 2 > CAPTURE ** 2) return false;
    // Someone reaching the mouth from the side may already be partway along
    // the public apron. Join the lane beside them without an outward-then-inward turn.
    let join = Math.max(0, Math.min(lane.length, depth)), offset = 0;
    const ux = (lane.endX - lane.x) / lane.length, uz = (lane.endZ - lane.z) / lane.length;
    let ahead = lane.outgoing ? lane.lastOut : -1;
    if (door) {
      const lateral = (x - lane.x) * uz - (z - lane.z) * ux;
      offset = Math.max(lane.minOffset, Math.min(lane.maxOffset, lateral));
      if (Math.abs(lateral - offset) > 0.025) {
        // Adjacent people can approach the broad threshold together. The
        // swept shoulder checks settle their shared space on every tick.
        if (lane.minOffset === lane.maxOffset) {
          for (const other of lane.leaving) if (this.stage[other] === Stage.Aligning) return false;
        }
        // Aim slightly ahead so an arrival on the apron joins from the side
        // without having to turn back into the queue.
        join = 0;
        for (let advance = 0.6; advance >= 0; advance -= 0.2) {
          const progress = Math.min(lane.length, Math.max(0, depth + advance));
          const jx = lane.x + ux * progress + offset * uz, jz = lane.z + uz * progress - offset * ux;
          if (this.nav.isSpawnable(jx, jz, a.radius[id] + 0.015)
            && this.nav.lineOfSight(x, z, jx, jz, a.radius[id] + 0.015)) { join = progress; break; }
        }
      }
      ahead = -1;
    } else if (ahead >= 0 && (this.stage[ahead] !== Stage.Leaving || this.progress(lane, ahead) - join < HEADWAY)) {
      return false;
    }
    const fraction = join / lane.length;
    const joinX = lane.x + (lane.endX - lane.x) * fraction + offset * uz;
    const joinZ = lane.z + (lane.endZ - lane.z) * fraction - offset * ux;
    if (!this.nav.isFree(joinX, joinZ, a.radius[id] + 0.015)
      || !this.nav.lineOfSight(x, z, joinX, joinZ, a.radius[id] + 0.015)
      || (this.nav.scramble && !this.nav.scramble.isSidewalk(joinX, joinZ, a.radius[id] + 0.015))) {
      if (!this.blockedByEmergence) this.waitingAtMouth = false;
      return false;
    }
    if (door && Math.hypot(x - joinX, z - joinZ) > 0.08) {
      const peer = this.conflictingEmergence(id, this.gates[lane.portal], x, z, joinX, joinZ, grid);
      if (peer >= 0) { this.makeRoom(id, peer, x, z, dt); return false; }
    }
    // A shared single-file entrance must be reserved before moving in the
    // opposite direction. Independent lanes claim a landing only at the final steps.
    if (this.sharedEntry) {
      const entry = this.availableEntry(id, lane, grid, false, step);
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
    this.stepAsideTime[id] = 0;
    this.trackOffset[id] = offset;
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
    this.gates[lane.portal].emerging.delete(id);
    this.stage[id] = Stage.Walking;
    this.passage[id] = undefined;
    this.agents.opacity[id] = 1;
  }

  /** Returns true when the approach or passage owns this step's movement. */
  move(id: number, dt: number, step: number, grid: SpatialGrid, result: Point2): boolean {
    const a = this.agents, read = a.current;
    const x = read.x[id], z = read.z[id];
    this.waitingAtMouth = false;
    this.blockedByEmergence = false;
    if (!this.yieldForEmergence) this.stepAsideTime[id] = 0;
    if (this.steppingAside(id) && this.moveAside(id, x, z, dt, result)) return true;
    if (this.stage[id] === Stage.Walking && !this.reservePassages(id, x, z, step, grid, dt)) {
      const dest = this.destination[id], gate = this.gates[dest.portal];
      if (gate.emerging.size && Math.abs(dest.x - x) < 8 && Math.abs(dest.z - z) < 8 && this.portals[dest.portal].kind === 'door') {
        const peer = this.conflictingEmergence(id, gate, x, z, x, z, grid);
        if (peer >= 0) this.makeRoom(id, peer, x, z, dt);
      }
      return this.steppingAside(id) && this.moveAside(id, x, z, dt, result);
    }

    const lane = this.passage[id]!;
    const outward = this.stage[id] === Stage.Leaving;
    const fraction = outward ? 1 : this.stage[id] === Stage.Aligning ? this.alignment[id] : 0;
    const offset = this.trackOffset[id] / lane.length;
    const tx = lane.x + (lane.endX - lane.x) * fraction + offset * (lane.endZ - lane.z);
    const tz = lane.z + (lane.endZ - lane.z) * fraction - offset * (lane.endX - lane.x);
    const dx = tx - x, dz = tz - z, remaining = Math.hypot(dx, dz);
    if (this.stage[id] === Stage.Aligning && !this.reservation[id] && a.stalledTime[id] > 0.2
      && this.nav.urban?.isSidewalk(x, z, a.radius[id] + 0.015)) {
      const peer = this.conflictingEmergence(id, this.gates[lane.portal], x, z, tx, tz, grid);
      if (peer >= 0) {
        this.unlinkExit(id, lane);
        this.passage[id] = undefined;
        this.stage[id] = Stage.Walking;
        this.makeRoom(id, peer, x, z, dt);
        return this.steppingAside(id) && this.moveAside(id, x, z, dt, result);
      }
    }
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
            entry = this.availableEntry(id, lane, grid, true, step);
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
    const clearance = a.radius[id] + 0.015;
    if (this.stage[id] === Stage.Entering && a.opacity[id] >= 0.9999
      && (walkedIn >= mergeDistance || portal.kind === 'door' && a.stalledTime[id] > 0.3)) {
      const onSidewalk = this.nav.scramble ? this.nav.scramble.isSidewalk(x, z, clearance) : this.nav.isFree(x, z, clearance);
      if (onSidewalk && this.nav.lineOfSight(x, z, lane.x, lane.z, clearance)) {
        this.rejoinSidewalk(id, lane);
        return false;
      }
    }
    const onApron = this.stage[id] === Stage.Aligning || (outward ? lane.length - remaining : remaining) < 1.5;
    const throughDoor = this.portals[lane.portal].kind === 'door' && this.doorways;
    const clear = throughDoor ? throughDoor.limit(id, result.x, result.z, dt, result, this.stage[id] === Stage.Aligning ? false : undefined)
      : !onApron || this.clearStep(id, result.x, result.z, grid);
    if (!clear && outward && throughDoor && this.slideInBank(id, lane, Math.min(distance, remaining), dt, result)) {
      reached = false;
    } else if (!clear) {
      if (a.stalledTime[id] >= 0.6 && (this.stage[id] === Stage.Aligning
        || outward && !this.reservation[id] && this.nav.urban && this.nav.scramble!.isSidewalk(x, z, a.radius[id] + 0.015))) {
        // The sidewalk crowd can close a gap while a walker lines up. Yield with
        // ordinary steering and let another walker use the opening from a clear angle.
        const entry = this.reservation[id];
        if (entry) { entry.reserved--; this.gates[entry.portal].admissions--; }
        this.retryAt[id] = step + 24;
        this.unlinkExit(id, lane);
        this.reservation[id] = this.passage[id] = undefined;
        this.stage[id] = Stage.Walking;
        this.waitingAtMouth = false;
        return false;
      }
      if (!throughDoor) { result.x = x; result.z = z; }
      reached = false;
    }
    if (this.stage[id] !== Stage.Aligning) {
      const fromEnd = lane.length - ((result.x - lane.x) * (lane.endX - lane.x) + (result.z - lane.z) * (lane.endZ - lane.z)) / lane.length;
      const fade = this.portals[lane.portal].kind === 'street' ? Math.min(3, lane.length) : 0.35;
      const t = Math.min(1, Math.max(0, fromEnd / fade));
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
      this.completedTrips[exit.portal]++;
      this.unlinkExit(id, exit);
      entry.transferOwner = -1;
      entry.reserved--;
      this.leader[id] = entry.incoming ? entry.lastIn : -1;
      entry.lastIn = id;
      entry.incoming++;
      this.gates[entry.portal].emerging.add(id);
      this.stage[id] = Stage.Entering;
      this.trackOffset[id] = 0;
      this.passage[id] = entry;
      this.reservation[id] = undefined;
      a.generation[id] = (a.generation[id] + 1) % 16777216; // Exactly representable in a float snapshot.
      newPerson(id);
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
