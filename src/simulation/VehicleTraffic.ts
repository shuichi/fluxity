import { Random } from '../math/random';
import { VEHICLE_LENGTH, VEHICLE_SNAPSHOT_STRIDE, VEHICLE_WIDTH } from '../types';
import type { TrafficAxis, VehicleSignal } from '../types';
import type { AgentData } from './AgentData';
import type { VehicleLane } from './VehicleLanes';
import { VehiclePath } from './VehiclePath';

const HALF_LENGTH = VEHICLE_LENGTH / 2;
const HALF_WIDTH = VEHICLE_WIDTH / 2;
const STANDSTILL_GAP = 2;
// At unit body scale the heel reaches 0.746 m from the pelvis in the fastest
// rendered gait, including the forward lean. Reserve a little extra clearance
// in every heading. This envelope applies only to person/vehicle interactions.
const ANIMATED_PERSON_REACH = 0.78;
const BRAKING = 2.3; // m/s² during ordinary braking
const SLOTS_PER_LANE = 16;

interface Car {
  distance: number;
  speed: number;
  cruise: number;
  acceleration: number;
  headway: number;
  life: number;
  active: boolean;
  entered: boolean;
  passOnYellow: boolean;
}

class LaneTraffic {
  readonly path: VehiclePath;
  private readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  readonly slots: Car[];
  /** Active cars in front-to-back order. Slots keep their IDs across publications. */
  readonly queue: Car[] = [];
  private readonly obstacleStarts: Float64Array;
  private readonly obstacleEnds: Float64Array;
  private obstacleCount = 0;
  private entry = 0;
  private exit = 0;
  private spawnIn = 0;
  private firstArrival = true;
  private lastSignal: VehicleSignal = 'red';

  constructor(readonly lane: VehicleLane, count: number) {
    this.path = new VehiclePath(lane);
    const points = [lane.start, ...(lane.via ?? []), lane.end];
    const pad = Math.hypot(HALF_LENGTH, HALF_WIDTH) + Math.max(...this.path.segments.map(s => s.turnAllowance));
    this.bounds = { minX: Math.min(...points.map(p => p.x)) - pad, maxX: Math.max(...points.map(p => p.x)) + pad,
      minZ: Math.min(...points.map(p => p.z)) - pad, maxZ: Math.max(...points.map(p => p.z)) + pad };
    this.obstacleStarts = new Float64Array(count);
    this.obstacleEnds = new Float64Array(count);
    this.slots = Array.from({ length: SLOTS_PER_LANE }, () => ({
      distance: 0, speed: 0, cruise: 0, acceleration: 0, headway: 0, life: 0, active: false, entered: false, passOnYellow: false,
    }));
  }

  /** Range of car-center arc lengths that could overlap the complete pedestrian sweep.
   * Each segment uses its own heading; adjacent segments also cover the rotating car body. */
  private projectSweep(x: number, z: number, tx: number, tz: number, personScale: number): boolean {
    const reach = personScale * ANIMATED_PERSON_REACH, bounds = this.bounds;
    if (Math.max(x, tx) < bounds.minX - reach || Math.min(x, tx) > bounds.maxX + reach ||
      Math.max(z, tz) < bounds.minZ - reach || Math.min(z, tz) > bounds.maxZ + reach) return false;
    const dx = tx - x, dz = tz - z;
    this.entry = Infinity; this.exit = -Infinity;
    for (const s of this.path.segments) {
      const ox = x - s.x, oz = z - s.z, along = ox * s.ux + oz * s.uz, alongStep = dx * s.ux + dz * s.uz;
      const padding = reach + s.turnAllowance, length = HALF_LENGTH + padding;
      if (Math.max(along, along + alongStep) < -length || Math.min(along, along + alongStep) > s.end - s.start + length) continue;
      const side = ox * s.uz - oz * s.ux, lateralStep = dx * s.uz - dz * s.ux, width = HALF_WIDTH + padding;
      if (Math.min(side, side + lateralStep) > width || Math.max(side, side + lateralStep) < -width) continue;
      let from = 0, to = 1;
      if (Math.abs(lateralStep) > 1e-12) {
        const a = (-width - side) / lateralStep, b = (width - side) / lateralStep;
        from = Math.max(0, Math.min(a, b)); to = Math.min(1, Math.max(a, b));
      }
      const lo = s.start + along + Math.min(from * alongStep, to * alongStep) - length;
      const hi = s.start + along + Math.max(from * alongStep, to * alongStep) + length;
      if (lo > s.end || hi < s.start) continue;
      this.entry = Math.min(this.entry, Math.max(s.start, lo));
      this.exit = Math.max(this.exit, Math.min(s.end, hi));
    }
    return this.entry <= this.exit;
  }

  blocksPedestrian(x: number, z: number, tx: number, tz: number, personScale: number): boolean {
    if (!this.queue.length || !this.projectSweep(x, z, tx, tz, personScale)) return false;
    for (const car of this.queue) {
      if (this.entry <= car.distance && this.exit >= car.distance) return true;
    }
    return false;
  }

  private collectPedestrians(agents: AgentData): void {
    const read = agents.current, write = agents.next;
    this.obstacleCount = 0;
    for (let i = 0; i < agents.count; i++) {
      if (!this.projectSweep(read.x[i], read.z[i], write.x[i], write.z[i], agents.scale[i])) continue;
      this.obstacleStarts[this.obstacleCount] = this.entry;
      this.obstacleEnds[this.obstacleCount++] = this.exit;
    }
  }

  private pedestrianGap(center: number): number {
    let gap = Infinity;
    for (let i = 0; i < this.obstacleCount; i++) {
      if (this.obstacleEnds[i] >= center) gap = Math.min(gap, this.obstacleStarts[i] - center);
    }
    return gap;
  }

  private spawn(random: Random): void {
    const center = this.firstArrival ? Math.max(0, this.lane.stop - 25) : 0;
    const leader = this.queue.at(-1);
    const gap = Math.min(this.pedestrianGap(center), leader ? leader.distance - center - VEHICLE_LENGTH : Infinity);
    if (gap < STANDSTILL_GAP) return;
    const car = this.slots.find(slot => !slot.active);
    if (!car) return;
    car.cruise = random.range(20, 30) / 3.6;
    car.acceleration = random.range(1.3, 1.9);
    car.headway = random.range(1.35, 1.85);
    const stoppingRoom = gap - STANDSTILL_GAP;
    car.speed = Math.min(car.cruise, stoppingRoom / car.headway, Math.sqrt(2 * BRAKING * stoppingRoom));
    car.distance = center; car.active = true; car.entered = false; car.passOnYellow = false;
    car.life = (car.life % 16777215) + 1; // Exactly representable in a Float32 snapshot.
    this.queue.push(car);
    this.firstArrival = false;
    this.spawnIn = random.range(3.8, 6.5);
  }

  step(dt: number, signal: VehicleSignal, agents: AgentData, random: Random): void {
    if (signal === 'yellow' && this.lastSignal !== 'yellow') {
      // Only cars already too close to stop safely at the instant of yellow qualify.
      for (const car of this.queue) {
        const gap = (this.lane.entry ?? this.lane.stop) - (car.distance + HALF_LENGTH);
        car.passOnYellow = car.speed > 0 && gap < car.speed ** 2 / (2 * BRAKING);
      }
    }
    this.lastSignal = signal;
    this.collectPedestrians(agents);
    this.spawnIn -= dt;
    if (this.spawnIn <= 0) this.spawn(random);
    let leader: Car | undefined;
    for (const car of this.queue) {
      let hardGap = Math.max(0, this.pedestrianGap(car.distance) - 0.10);
      let target = car.cruise;
      if (leader) {
        const gap = Math.max(0, leader.distance - car.distance - VEHICLE_LENGTH - STANDSTILL_GAP);
        hardGap = Math.min(hardGap, gap);
        target = Math.min(target, gap / car.headway);
      }
      const stopGap = this.lane.stop - (car.distance + HALF_LENGTH);
      const mayEnter = signal === 'green' || signal === 'yellow' && car.passOnYellow && car.speed > 0;
      if (!car.entered) {
        if (!mayEnter) hardGap = Math.min(hardGap, Math.max(0, stopGap));
        if (signal === 'yellow') target = Math.min(target, car.speed);
      }
      // Bound next speed so displacement plus the following braking distance
      // still fits in the remaining gap. The bumper clamp also covers a new
      // obstruction that appeared inside the ordinary stopping distance.
      const brakingStep = BRAKING * dt;
      const halfBrakingStep = brakingStep / 2;
      const remaining = Math.max(0, hardGap - car.speed * dt / 2);
      target = Math.min(target, Math.sqrt(halfBrakingStep ** 2 + 2 * BRAKING * remaining) - halfBrakingStep);
      const nextSpeed = Math.max(0, Math.min(car.speed + car.acceleration * dt, Math.max(car.speed - brakingStep, target)));
      const travel = Math.min(hardGap, (car.speed + nextSpeed) * 0.5 * dt);
      car.distance += travel;
      // A queued car leaves a small gap before the paint. It commits to the
      // junction only once its leading corner crosses the actual near edge.
      const entry = this.lane.entry ?? this.lane.stop;
      if (mayEnter && travel > 0 && car.distance + HALF_LENGTH > entry) car.entered = true;
      car.speed = travel >= hardGap || nextSpeed < 1e-6 ? 0 : nextSpeed;
      leader = car;
    }
    while (this.queue.length && this.queue[0].distance >= this.path.length) this.queue.shift()!.active = false;
  }
}

/** Owns car motion on signal-controlled through lanes. Pedestrian
 * proposals first yield to current vehicles. Vehicles then yield to the
 * complete, accepted pedestrian sweeps before either state is published. */
export class VehicleTraffic {
  readonly capacity: number;
  private readonly lanes: LaneTraffic[];
  private readonly random: Random;

  constructor(seed: number, private readonly agents: AgentData, lanes: readonly VehicleLane[]) {
    this.lanes = lanes.map(lane => new LaneTraffic(lane, agents.count));
    this.capacity = this.lanes.length * SLOTS_PER_LANE;
    this.random = new Random(seed ^ 0x4c414e45);
  }

  get occupiesCrossing(): boolean {
    return this.lanes.some(lane => lane.queue.some(car => car.entered && car.distance - HALF_LENGTH < lane.lane.clear));
  }

  blocksPedestrian(x: number, z: number, tx: number, tz: number, personScale: number): boolean {
    for (const lane of this.lanes) if (lane.blocksPedestrian(x, z, tx, tz, personScale)) return true;
    return false;
  }

  /** Called after all walking proposals, before replacing people at portals. */
  step(dt: number, signals: Readonly<Record<TrafficAxis, VehicleSignal>>): void {
    for (const lane of this.lanes) lane.step(dt, signals[lane.lane.axis], this.agents, this.random);
  }

  writeSnapshot(out: Float32Array): void {
    if (out.length !== this.capacity * VEHICLE_SNAPSHOT_STRIDE) throw new RangeError('Invalid vehicle snapshot length.');
    out.fill(0);
    let slot = 0;
    for (const lane of this.lanes) for (const car of lane.slots) {
      if (car.active) {
        const pose = lane.path.sample(car.distance);
        out[slot] = pose.x; out[slot + 1] = pose.z;
        out[slot + 2] = Math.atan2(pose.ux, pose.uz); out[slot + 3] = car.life; out[slot + 4] = car.speed;
      }
      slot += VEHICLE_SNAPSHOT_STRIDE;
    }
  }
}
