import { DEFAULT_CONFIG, FIXED_DT, MAX_AGENTS, SNAPSHOT_STRIDE } from '../types';
import type { Scenario, SignalState, SimulationConfig, SimulationSettings } from '../types';
import { Random } from '../math/random';
import { getScenario } from '../scenarios';
import { AgentData } from './AgentData';
import { Navigation } from './Navigation';
import { SpatialGrid } from './SpatialGrid';
import { PortalFlow } from './PortalFlow';
import { PortalTripDemand } from './PortalTripDemand';
import { DoorwayClearance, doorwayRadius } from './DoorwayClearance';
import { DoorwayCourtesy } from './DoorwayCourtesy';
import { DoorwayHeadway } from './DoorwayHeadway';
import { PortalDeadlockRecovery } from './PortalDeadlockRecovery';
import { Steering } from './Steering';
import type { LocalAvoidance } from './Steering';
import { TrafficSignal } from './TrafficSignal';
import { PedestrianAttention } from './PedestrianAttention';
import { EncounterState } from './EncounterState';
import { CrossingClearance } from './CrossingClearance';
import { CrosswalkFlow } from './CrosswalkFlow';

const TAU = Math.PI * 2;
const PALETTE = [
  [0.20, 0.35, 0.34], [0.79, 0.43, 0.30], [0.88, 0.76, 0.55], [0.33, 0.43, 0.55],
  [0.71, 0.72, 0.61], [0.35, 0.29, 0.29], [0.87, 0.85, 0.76], [0.55, 0.63, 0.48],
  [0.71, 0.57, 0.56], [0.28, 0.31, 0.38], [0.74, 0.59, 0.35], [0.48, 0.50, 0.66],
];
function finite(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
export interface SimulationStatistics { meanSpeed: number; congestion: number }

/** The CPU-only simulation boundary can be hosted in any worker or replaced by WASM. */
export class Simulation {
  readonly agents: AgentData;
  readonly scenario: Scenario;
  readonly navigation: Navigation;
  readonly grid: SpatialGrid;
  readonly settings: SimulationSettings;
  readonly random: Random;
  readonly stats: SimulationStatistics = { meanSpeed: 0, congestion: 0 };
  readonly avoidance: LocalAvoidance;
  readonly attention: PedestrianAttention;
  readonly encounters: EncounterState;
  private readonly traffic: TrafficSignal | undefined;
  private readonly crossings?: CrossingClearance;
  private readonly crosswalkFlow?: CrosswalkFlow;
  private readonly portals: PortalFlow | undefined;
  private readonly tripDemand?: PortalTripDemand;
  private readonly doorways?: DoorwayClearance;
  private readonly courtesy?: DoorwayCourtesy;
  private readonly headway?: DoorwayHeadway;
  private readonly recoveryByTarget: (PortalDeadlockRecovery | undefined)[] = [];
  private recoveryEnabled = true;
  private recoveryPortalId?: string;
  stepCount = 0;
  time = 0;
  arrivals = 0;
  private readonly direction = { x: 0, z: 0 };
  private readonly velocity = { x: 0, z: 0 };
  private readonly projected = { x: 0, z: 0 };

  get signal(): SignalState | undefined { return this.traffic?.state; }
  isPortalDeadlockActive(target: number): boolean { return this.recoveryByTarget[target]?.active ?? false; }
  completedPortalTrips(target: number): number { return this.portals?.completedTrips[target] ?? 0; }
  /** @deprecated Use isPortalDeadlockActive to inspect a specific destination. */
  get shopDeadlockActive(): boolean { return this.recoveryByTarget.some(recovery => recovery?.active); }

  constructor(config: SimulationConfig, avoidance?: LocalAvoidance, scenario?: Scenario) {
    const count = Math.floor(finite(config.count, DEFAULT_CONFIG.count, 1, MAX_AGENTS));
    this.agents = new AgentData(count); this.scenario = scenario ?? getScenario(config.scenario);
    this.recoveryEnabled = this.scenario.portalRecoveryByDefault ?? true;
    this.random = new Random(config.seed); this.navigation = new Navigation(this.scenario);
    this.grid = new SpatialGrid(this.scenario.bounds, count);
    this.attention = new PedestrianAttention(config.seed, this.agents, this.navigation, this.grid);
    this.encounters = new EncounterState(count, config.seed);
    this.settings = { simulationSpeed: 1, walkingSpeed: 1.35, avoidanceStrength: 1, signalMode: 'auto' };
    this.traffic = this.navigation.scramble ? new TrafficSignal() : undefined;
    if (this.traffic) this.crossings = new CrossingClearance(this.navigation, this.grid, count);
    if (this.scenario.scramble?.crosswalks.length) this.crosswalkFlow = new CrosswalkFlow(this.navigation, count, config.seed);
    if (this.scenario.portals) {
      const doors = this.scenario.portals.filter(portal => portal.kind === 'door');
      if (doors.length) this.doorways = new DoorwayClearance(doors, this.grid, this.agents, this.navigation);
      if (this.scenario.portalTripMix && !this.scenario.targetTransitions) {
        this.tripDemand = new PortalTripDemand(this.scenario.portals, this.scenario.portalTripMix, config.seed);
      }
      this.portals = new PortalFlow(this.scenario.portals, this.navigation, this.agents, this.random, this.doorways, this.tripDemand);
      if (this.navigation.urban) {
        this.courtesy = new DoorwayCourtesy(this.agents, this.navigation, this.grid, this.scenario.portals);
        this.headway = new DoorwayHeadway(this.agents, this.grid, this.navigation, this.scenario.portals);
      }
    }
    this.updateSettings(config);
    this.avoidance = avoidance ?? new Steering(this.scenario, this.navigation.urban, this.doorways?.cells, this.encounters, this.navigation, this.crossings);
    this.initialize();
  }
  updateSettings(settings: Partial<SimulationSettings>): void {
    if (settings.simulationSpeed !== undefined) this.settings.simulationSpeed = finite(settings.simulationSpeed, 1, 0.1, 4);
    if (settings.walkingSpeed !== undefined) this.settings.walkingSpeed = finite(settings.walkingSpeed, 1.35, 0, 4);
    if (settings.avoidanceStrength !== undefined) this.settings.avoidanceStrength = finite(settings.avoidanceStrength, 1, 0, 3);
    if (settings.signalMode !== undefined) {
      this.settings.signalMode = settings.signalMode === 'red' || settings.signalMode === 'green' ? settings.signalMode : 'auto';
      this.traffic?.setMode(this.settings.signalMode, this.time);
    }
    for (let i = 0; i < this.agents.count; i++) this.agents.preferredSpeed[i] = this.agents.speedFactor[i] * this.settings.walkingSpeed;
    if (settings.walkingSpeed !== undefined || settings.avoidanceStrength !== undefined) this.configurePortalRecovery();
  }

  /** Omitting the portal ID enables recovery at every authored trip destination. */
  setPortalDeadlockRecovery(enabled: boolean, onlyPortalId?: string): void {
    this.recoveryEnabled = enabled;
    this.recoveryPortalId = onlyPortalId;
    this.configurePortalRecovery();
  }

  /** @deprecated Use setPortalDeadlockRecovery to select all portals or a single one. */
  setShopDeadlockRecovery(enabled: boolean): void { this.setPortalDeadlockRecovery(enabled); }

  private configurePortalRecovery(): void {
    const portals = this.scenario.portals;
    if (!this.recoveryEnabled || !this.portals || !portals || !this.navigation.urban || this.scenario.id !== 'shibuya'
      || this.settings.walkingSpeed === 0 || this.settings.avoidanceStrength === 0) {
      this.recoveryByTarget.length = 0;
      return;
    }
    for (let target = 0; target < portals.length; target++) {
      if (this.recoveryPortalId === undefined || portals[target].id === this.recoveryPortalId) {
        this.recoveryByTarget[target] ??= new PortalDeadlockRecovery(this.agents, this.navigation, target, this.portals, this.grid);
      } else {
        this.recoveryByTarget[target] = undefined;
      }
    }
  }
  private readonly newPerson = (i: number): void => {
    const a = this.agents;
    a.scale[i] = this.random.range(0.89, 1.13);
    a.radius[i] = a.scale[i] * 0.25; a.speedFactor[i] = this.random.range(0.8, 1.2);
    a.preferredSpeed[i] = a.speedFactor[i] * this.settings.walkingSpeed;
    a.appearance[i] = this.random.int(65535);
    const color = PALETTE[this.random.int(PALETTE.length)];
    a.tint.set(color, i * 3);
  };
  private initialize(): void {
    const a = this.agents, state = a.current, b = this.scenario.bounds;
    const heads = new Int32Array(this.grid.counts.length); heads.fill(-1);
    const next = new Int32Array(a.count); next.fill(-1);
    // If rejection sampling runs out of space, distribute overflow on the open
    // sidewalk. A doorway must start with enough room for the first person to pass.
    const doorways = this.scenario.initialDoorways
      ? new DoorwayClearance(this.scenario.initialDoorways, this.grid, a, this.navigation)
      : this.doorways;
    const openCells = doorways ? this.navigation.spawnCells.filter(cell => {
      const x = b.minX + (cell % this.navigation.columns + 0.5) * this.navigation.cellSize;
      const z = b.minZ + (Math.floor(cell / this.navigation.columns) + 0.5) * this.navigation.cellSize;
      return !doorways.cells[this.grid.cellAt(x, z)];
    }) : this.navigation.spawnCells;
    const fallbackCells = openCells.length ? openCells : this.navigation.spawnCells;
    const cellsByZone = this.scenario.spawnZones.map(zone => fallbackCells.filter(cell => {
      const x = b.minX + (cell % this.navigation.columns + 0.5) * this.navigation.cellSize;
      const z = b.minZ + (Math.floor(cell / this.navigation.columns) + 0.5) * this.navigation.cellSize;
      return Math.abs(x - zone.x) <= zone.width / 2 && Math.abs(z - zone.z) <= zone.depth / 2;
    }));
    for (let i = 0; i < a.count; i++) {
      a.id[i] = i; this.newPerson(i);
      const zoneIndex = i % this.scenario.spawnZones.length, zone = this.scenario.spawnZones[zoneIndex];
      let x = 0, z = 0, cell = 0, placed = false;
      // Deterministic rejection reduces initial overlap; fallback is bounded in dense scenarios.
      for (let attempt = 0; attempt < 100; attempt++) {
        x = this.random.range(zone.x - zone.width * 0.5, zone.x + zone.width * 0.5);
        z = this.random.range(zone.z - zone.depth * 0.5, zone.z + zone.depth * 0.5);
        x = Math.max(b.minX + 1, Math.min(b.maxX - 1, x)); z = Math.max(b.minZ + 1, Math.min(b.maxZ - 1, z));
        if (!this.navigation.isSpawnable(x, z, 0.7)) continue;
        cell = this.grid.cellAt(x, z);
        let close = false;
        const cx = cell % this.grid.columns, cz = Math.floor(cell / this.grid.columns);
        for (let oz = -1; oz <= 1 && !close; oz++) for (let ox = -1; ox <= 1 && !close; ox++) {
          const nx = cx + ox, nz = cz + oz;
          if (nx < 0 || nx >= this.grid.columns || nz < 0 || nz >= this.grid.rows) continue;
          const neighborCell = nz * this.grid.columns + nx;
          const nearDoor = doorways && (doorways.cells[cell] || doorways.cells[neighborCell]);
          if (!nearDoor && attempt > 90) continue;
          for (let j = heads[neighborCell]; j >= 0; j = next[j]) {
            const dx = state.x[j] - x, dz = state.z[j] - z;
            const separation = nearDoor ? doorwayRadius(a.scale[i]) + doorwayRadius(a.scale[j]) + 0.001
              : (a.radius[i] + a.radius[j]) * (attempt > 60 ? 0.65 : 1.1);
            if (dx * dx + dz * dz < separation * separation) { close = true; break; }
          }
        }
        if (!close) { placed = true; break; }
      }
      // A prevalidated finite list avoids unbounded searches on maps with empty courtyards.
      if (!placed) {
        const candidates = cellsByZone[zoneIndex].length ? cellsByZone[zoneIndex] : fallbackCells;
        const freeCell = candidates[this.random.int(candidates.length)];
        x = b.minX + ((freeCell % this.navigation.columns) + 0.5) * this.navigation.cellSize;
        z = b.minZ + (Math.floor(freeCell / this.navigation.columns) + 0.5) * this.navigation.cellSize;
        cell = this.grid.cellAt(x, z);
      }
      state.x[i] = x; state.z[i] = z; next[i] = heads[cell]; heads[cell] = i;
      const routes = this.scenario.spawnTargets?.[zoneIndex];
      const selected = Array.isArray(routes) ? routes[this.random.int(routes.length)] : routes;
      const target = selected ?? this.tripDemand?.target(i, 0, x, z) ?? this.random.int(this.scenario.targets.length);
      this.assignTarget(i, target);
      this.navigation.direction(x, z, a.targetId[i], a.targetX[i], a.targetZ[i], this.direction, a.radius[i] + 0.015);
      state.heading[i] = Math.atan2(this.direction.x, this.direction.z);
      state.vx[i] = this.direction.x * a.preferredSpeed[i] * 0.7;
      state.vz[i] = this.direction.z * a.preferredSpeed[i] * 0.7;
      state.phase[i] = this.random.range(0, TAU);
    }
    this.grid.rebuild(state.x, state.z, a.count);
  }
  private assignTarget(id: number, targetId: number): void {
    this.crosswalkFlow?.reset(id);
    if (this.portals) { this.portals.assignTarget(id, targetId); return; }
    const a = this.agents, target = this.scenario.targets[targetId], b = this.scenario.bounds;
    a.targetId[id] = targetId;
    let x = target.x, z = target.z;
    // Spread arrivals across an edge instead of collapsing every flow into a point.
    for (let attempt = 0; attempt < 8; attempt++) {
      const spread = this.scenario.targetSpread ?? (this.scenario.id === 'plaza' ? 7 : 22);
      const alongX = Math.abs(target.z) > Math.abs(target.x);
      x = target.x + (this.navigation.urban || alongX ? this.random.range(-spread, spread) : this.random.range(-2, 2));
      z = target.z + (this.navigation.urban || !alongX ? this.random.range(-spread, spread) : this.random.range(-2, 2));
      x = Math.max(b.minX + 2, Math.min(b.maxX - 2, x)); z = Math.max(b.minZ + 2, Math.min(b.maxZ - 2, z));
      if (this.navigation.isFree(x, z, 1) && (!this.navigation.urban || this.navigation.isReachable(x, z, targetId))) break;
      x = target.x; z = target.z;
    }
    if (this.navigation.urban && (!this.navigation.isFree(x, z, this.navigation.clearance) || !this.navigation.isReachable(x, z, targetId))) {
      const goal = this.navigation.goals[targetId]; x = goal.x; z = goal.z;
    }
    a.targetX[id] = x; a.targetZ[id] = z;
  }
  private nextTarget(id: number): void {
    const previous = this.agents.targetId[id];
    if (this.scenario.targetTransitions) {
      this.assignTarget(id, this.scenario.targetTransitions[previous] ?? previous);
    } else if (this.scenario.id === 'shibuya') {
      this.assignTarget(id, previous ^ 3);
    } else if (this.scenario.id === 'corridor' || this.scenario.id === 'bottleneck' || this.scenario.id === 'crossing') {
      this.assignTarget(id, previous ^ 1);
    } else {
      let target = this.random.int(this.scenario.targets.length - 1);
      if (target >= previous) target++;
      this.assignTarget(id, target);
    }
    this.arrivals++;
  }
  isInPassage(id: number): boolean { return this.portals?.inPassage(id) ?? false; }
  isInPortalLane(id: number): boolean { return this.portals?.inLane(id) ?? false; }

  private writeMotion(i: number, dt: number, x: number, z: number): number {
    const a = this.agents, read = a.current, write = a.next;
    const vx = (x - read.x[i]) / dt, vz = (z - read.z[i]) / dt;
    const speed = Math.hypot(vx, vz);
    let heading = read.heading[i];
    if (speed > 0.045) {
      const desiredHeading = Math.atan2(vx, vz);
      let difference = ((desiredHeading - heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
      difference = Math.max(-3.5 * dt, Math.min(3.5 * dt, difference));
      heading += difference;
    }
    write.x[i] = x; write.z[i] = z; write.vx[i] = vx; write.vz[i] = vz; write.heading[i] = heading;
    // Unbounded phase avoids interpolation seams; stride length is measured in world meters.
    write.phase[i] = read.phase[i] + speed * dt * 4.5;
    a.stalledTime[i] = speed < a.preferredSpeed[i] * 0.2 ? a.stalledTime[i] + dt : 0;
    return speed;
  }
  step(dt = FIXED_DT): void {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1) throw new RangeError('Simulation step must be between 0 and 0.1 seconds.');
    const a = this.agents, read = a.current;
    this.traffic?.update(this.time + dt);
    const scramble = this.navigation.scramble;
    const red = this.signal?.phase === 'red';
    this.grid.rebuild(read.x, read.z, a.count);
    const socialAvoidance = this.settings.avoidanceStrength > 0;
    const courtesy = socialAvoidance ? this.courtesy : undefined;
    const headway = socialAvoidance ? this.headway : undefined;
    if (this.portals) this.portals.yieldForEmergence = socialAvoidance;
    courtesy?.update(this.time);
    for (const recovery of this.recoveryByTarget) {
      if (recovery) recovery.update(this.time, this.completedPortalTrips(recovery.targetIndex));
    }
    if (this.avoidance instanceof Steering) this.avoidance.candidateChecks = 0;
    let totalSpeed = 0, stopped = 0, waiting = 0, crossing = 0;
    const b = this.scenario.bounds;
    for (let i = 0; i < a.count; i++) {
      // Use one clearance for classification, routing and integration. A person who
      // has only partly cleared the exit curb must keep moving onto the sidewalk.
      const radius = a.radius[i] + 0.015;
      const sidewalkOnly = !!scramble && red && scramble.isSidewalk(read.x[i], read.z[i], radius);
      const clearance = this.crossings && (this.crossings.clearing[i] || (red && !sidewalkOnly)) ? this.crossings : undefined;
      const recovery = this.recoveryByTarget[a.targetId[i]];
      const order = clearance ? undefined : recovery?.order(i);
      const passageAllowed = !order || order === 'pass';
      const tx = a.targetX[i] - read.x[i], tz = a.targetZ[i] - read.z[i];
      const previousPeer = this.encounters.gazeTarget[i];
      const passer = previousPeer >= 0 && a.generation[previousPeer] === this.encounters.gazeLife[i] ? previousPeer : -1;
      const passSide = this.encounters.passSide[i];
      this.encounters.advance(i, dt);
      const yielding = !order && !clearance && courtesy?.yielding(i) && !this.portals?.steppingAside(i);
      if (this.portals) {
        if (passageAllowed && !yielding && (!clearance || this.portals.inPassage(i)) && this.portals.move(i, dt, this.stepCount, this.grid, this.projected)) {
          this.crosswalkFlow?.reset(i);
          this.attention.settle(i, dt);
          const speed = this.writeMotion(i, dt, this.projected.x, this.projected.z);
          totalSpeed += speed;
          if (speed < a.preferredSpeed[i] * 0.45) stopped++;
          continue;
        }
      } else if (!clearance && tx * tx + tz * tz < 10) this.nextTarget(i);
      if (clearance) this.crosswalkFlow?.reset(i);
      const followingTrack = !clearance && this.crosswalkFlow?.guide(i, a.generation[i],
        read.x[i], read.z[i], a.targetId[i], radius, this.direction);
      if (!followingTrack && (!clearance || !Number.isFinite(clearance.landingX[i]))) {
        this.navigation.direction(read.x[i], read.z[i], a.targetId[i], a.targetX[i], a.targetZ[i], this.direction, radius);
      }
      if (!clearance && this.doorways?.cells[this.grid.cells[i]]) this.portals?.guideSidewalk(i, this.direction);
      const crossingPace = clearance?.guide(i, read.x[i], read.z[i], radius, dt, a.preferredSpeed[i], this.direction) ?? 1;
      const steppingAside = this.portals?.steppingAside(i);
      const waitingAtMouth = !order && !clearance && !yielding && this.portals?.waitingAtMouth;
      if (order) recovery!.guide(i, this.direction);
      else if (yielding) courtesy!.guide(i, this.direction);
      else if (waitingAtMouth) { this.direction.x = 0; this.direction.z = 0; }
      const routeX = this.direction.x, routeZ = this.direction.z;
      const waitingAtRed = sidewalkOnly && scramble!.brakeAtCurb(read.x[i], read.z[i], this.direction, radius);
      if (waitingAtRed) waiting++;
      const allowHesitation = !clearance && !waitingAtRed && !waitingAtMouth && !this.doorways?.cells[this.grid.cells[i]];
      const speedScale = crossingPace * this.attention.update(i, dt, waitingAtRed, routeX, routeZ, allowHesitation, passer, passSide);
      const desiredSpeed = a.preferredSpeed[i] * speedScale;
      a.preferredVX[i] = this.direction.x * desiredSpeed; a.preferredVZ[i] = this.direction.z * desiredSpeed;
      const stayOnSidewalk = sidewalkOnly || !!order;
      this.avoidance.compute(i, a, this.grid, this.direction, this.settings, this.velocity, speedScale, stayOnSidewalk);
      if (order === 'wait' && !this.avoidance.yieldingAtCurb) {
        this.velocity.x = 0; this.velocity.z = 0;
      } else if (!order && !clearance && !yielding && !steppingAside && !this.avoidance.yieldingAtCurb) {
        headway?.limit(i, this.stepCount, this.time, this.direction, this.velocity);
      }
      let ax = (this.velocity.x - read.vx[i]) / 0.3, az = (this.velocity.z - read.vz[i]) / 0.3;
      const acceleration = Math.hypot(ax, az);
      if (acceleration > 3.8) { ax *= 3.8 / acceleration; az *= 3.8 / acceleration; }
      let vx = read.vx[i] + ax * dt, vz = read.vz[i] + az * dt;
      const velocityLength = Math.hypot(vx, vz), maxSpeed = a.preferredSpeed[i] * crossingPace * 1.12;
      // Smoothly decelerate on a lower UI speed limit, without a one-frame velocity jump.
      const speedLimit = Math.max(maxSpeed, Math.hypot(read.vx[i], read.vz[i]) - 3.8 * dt);
      if (velocityLength > speedLimit && velocityLength > 0) { vx *= speedLimit / velocityLength; vz *= speedLimit / velocityLength; }
      let x = read.x[i] + vx * dt, z = read.z[i] + vz * dt;
      x = Math.max(b.minX + radius, Math.min(b.maxX - radius, x));
      z = Math.max(b.minZ + radius, Math.min(b.maxZ - radius, z));
      for (const obstacle of this.scenario.obstacles) {
        const left = obstacle.x - obstacle.width * 0.5 - radius, right = obstacle.x + obstacle.width * 0.5 + radius;
        const top = obstacle.z - obstacle.depth * 0.5 - radius, bottom = obstacle.z + obstacle.depth * 0.5 + radius;
        if (x > left && x < right && z > top && z < bottom) {
          const dl = x - left, dr = right - x, dtp = z - top, db = bottom - z;
          const minimum = Math.min(dl, dr, dtp, db);
          if (minimum === dl) x = left;
          else if (minimum === dr) x = right;
          else if (minimum === dtp) z = top;
          else z = bottom;
        }
      }
      if (scramble) {
        scramble.constrain(read.x[i], read.z[i], x, z, radius, stayOnSidewalk, this.projected);
        x = this.projected.x; z = this.projected.z;
      }
      if (this.doorways) {
        this.doorways.limit(i, x, z, dt, this.projected, stayOnSidewalk);
        x = this.projected.x; z = this.projected.z;
      }
      if (scramble) {
        const onSidewalk = scramble.isSidewalk(Math.fround(x), Math.fround(z), radius);
        if (!onSidewalk) crossing++;
        this.crossings!.observeStep(i, read.x[i], read.z[i], radius, onSidewalk);
      }
      const speed = this.writeMotion(i, dt, x, z);
      totalSpeed += speed;
      if (speed < a.preferredSpeed[i] * 0.45) stopped++;
    }
    if (this.portals && this.portals.transferCount) {
      this.arrivals += this.portals.transferCount;
      this.portals.replaceArrivals(id => {
        this.newPerson(id);
        this.attention.reset(id, a.generation[id]);
        this.encounters.reset(id, a.generation[id]);
        this.crossings?.reset(id);
        this.crosswalkFlow?.reset(id);
      });
    }
    a.swap(); this.stepCount++; this.time += dt;
    this.stats.meanSpeed = totalSpeed / a.count; this.stats.congestion = stopped / a.count;
    if (this.signal) { this.signal.waiting = waiting; this.signal.crossing = crossing; }
  }
  writeSnapshot(target: Float32Array): void {
    const a = this.agents, state = a.current;
    if (target.length !== a.count * SNAPSHOT_STRIDE) throw new RangeError('Snapshot has an invalid length.');
    for (let i = 0; i < a.count; i++) {
      const offset = i * SNAPSHOT_STRIDE, speed = Math.hypot(state.vx[i], state.vz[i]);
      target[offset] = state.x[i]; target[offset + 1] = state.z[i]; target[offset + 2] = state.heading[i];
      target[offset + 3] = speed; target[offset + 4] = state.phase[i]; target[offset + 5] = a.appearance[i];
      target[offset + 6] = a.scale[i]; target[offset + 7] = speed < 0.06 ? 0 : speed > 2.2 ? 2 : 1;
      target[offset + 8] = a.tint[i * 3]; target[offset + 9] = a.tint[i * 3 + 1]; target[offset + 10] = a.tint[i * 3 + 2];
      target[offset + 11] = a.generation[i]; target[offset + 12] = a.opacity[i];
      target[offset + 13] = this.attention.headYaw[i];
      target[offset + 14] = this.encounters.lean[i];
    }
  }
}
