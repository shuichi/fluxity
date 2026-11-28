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
import { PEDESTRIAN_ACCELERATION } from './ReciprocalAvoidance';
import type { LocalAvoidance } from './Steering';
import { parseSignalMode, TrafficSignal } from './TrafficSignal';
import { PedestrianAttention } from './PedestrianAttention';
import { EncounterState } from './EncounterState';
import { SidewalkPassing } from './SidewalkPassing';
import { CrossingClearance } from './CrossingClearance';
import { CrosswalkFlow } from './CrosswalkFlow';
import { ForecourtFlow } from './ForecourtFlow';
import { ForecourtQueue } from './ForecourtQueue';
import { ShibuyaActivities } from './ShibuyaActivities';
import { VehicleTraffic } from './VehicleTraffic';

const TAU = Math.PI * 2;
const VEHICLES_STOPPED = { eastWest: 'red', northSouth: 'red' } as const;
const MAX_SCALE = 1.13;
const RADIUS_AT_UNIT_SCALE = 0.25;
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
  readonly activities?: ShibuyaActivities;
  private readonly enhancedCrossing: boolean;
  private readonly encounterContext = {
    reciprocal: true, speedLimit: 0, dt: FIXED_DT, stationary: undefined as Uint8Array | undefined,
  };
  private readonly traffic: TrafficSignal | undefined;
  private readonly vehicles?: VehicleTraffic;
  private readonly crossings?: CrossingClearance;
  private readonly crosswalkFlow?: CrosswalkFlow;
  private readonly forecourt?: ForecourtFlow;
  private readonly forecourtQueue?: ForecourtQueue;
  private readonly portals: PortalFlow | undefined;
  private readonly tripDemand?: PortalTripDemand;
  private readonly doorways?: DoorwayClearance;
  private readonly courtesy?: DoorwayCourtesy;
  private readonly headway?: DoorwayHeadway;
  private readonly sidewalkPassing?: SidewalkPassing;
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
  get vehicleCapacity(): number { return this.vehicles?.capacity ?? 0; }
  isPortalDeadlockActive(target: number): boolean { return this.recoveryByTarget[target]?.active ?? false; }
  completedPortalTrips(target: number): number { return this.portals?.completedTrips[target] ?? 0; }
  /** @deprecated Use isPortalDeadlockActive to inspect a specific destination. */
  get shopDeadlockActive(): boolean { return this.recoveryByTarget.some(recovery => recovery?.active); }

  constructor(config: SimulationConfig, avoidance?: LocalAvoidance, scenario?: Scenario) {
    const count = Math.floor(finite(config.count, DEFAULT_CONFIG.count, 1, MAX_AGENTS));
    this.agents = new AgentData(count); this.scenario = scenario ?? getScenario(config.scenario);
    const mappedShibuya = this.scenario.roadMarkings === 'shibuya' && this.scenario.id === 'shibuya';
    this.enhancedCrossing = mappedShibuya && config.crowdModel === 'enhanced';
    this.recoveryEnabled = this.scenario.portalRecoveryByDefault ?? true;
    this.random = new Random(config.seed); this.navigation = new Navigation(this.scenario);
    this.grid = new SpatialGrid(this.scenario.bounds, count);
    if (this.navigation.urban) this.sidewalkPassing = new SidewalkPassing(this.navigation, this.grid, this.agents);
    this.attention = new PedestrianAttention(config.seed, this.agents, this.navigation, this.grid);
    this.encounters = new EncounterState(count, config.seed);
    this.settings = { simulationSpeed: 1, walkingSpeed: 1.35, avoidanceStrength: 1, signalMode: 'auto' };
    this.traffic = this.navigation.scramble ? new TrafficSignal(parseSignalMode(config.signalMode)) : undefined;
    if (this.scenario.vehicleLanes?.length) this.vehicles = new VehicleTraffic(config.seed, this.agents, this.scenario.vehicleLanes);
    if (this.traffic) this.crossings = new CrossingClearance(this.navigation, this.grid, count);
    if (this.scenario.scramble?.crosswalks.length) this.crosswalkFlow = new CrosswalkFlow(this.navigation, count, config.seed,
      this.enhancedCrossing && (config.densityGuidance ?? DEFAULT_CONFIG.densityGuidance));
    if (this.scenario.forecourtRouting && this.navigation.urban && this.crosswalkFlow) {
      this.forecourt = new ForecourtFlow(this.navigation, this.agents, config.seed);
      this.forecourtQueue = new ForecourtQueue(this.navigation, this.agents, this.crosswalkFlow, this.forecourt.traffic, config.seed);
    }
    if (this.scenario.portals) {
      const doors = this.scenario.portals.filter(portal => portal.kind === 'door');
      if (doors.length) this.doorways = new DoorwayClearance(doors, this.grid, this.agents, this.navigation);
      if (this.scenario.portalTripMix && !this.scenario.targetTransitions) {
        this.tripDemand = new PortalTripDemand(this.scenario.portals, this.scenario.portalTripMix, config.seed);
      }
      this.portals = new PortalFlow(this.scenario.portals, this.navigation, this.agents, this.random, this.doorways, this.tripDemand,
        this.vehicles && this.permitsPortalStep);
      if (this.navigation.urban) {
        this.courtesy = new DoorwayCourtesy(this.agents, this.navigation, this.grid, this.scenario.portals);
        this.headway = new DoorwayHeadway(this.agents, this.grid, this.navigation, this.scenario.portals);
      }
    }
    this.updateSettings(config);
    this.avoidance = avoidance ?? new Steering(this.scenario, this.navigation.urban, this.doorways?.cells, this.encounters, this.navigation, this.crossings);
    this.initialize();
    if (mappedShibuya && config.crowdPreset && config.crowdPreset !== 'none') {
      this.activities = new ShibuyaActivities(config.crowdPreset, config.seed, this.agents, this.navigation, this.grid);
      this.encounterContext.stationary = this.activities.stationary;
    }
  }
  updateSettings(settings: Partial<SimulationSettings>): void {
    if (settings.simulationSpeed !== undefined) this.settings.simulationSpeed = finite(settings.simulationSpeed, 1, 0.1, 4);
    if (settings.walkingSpeed !== undefined) this.settings.walkingSpeed = finite(settings.walkingSpeed, 1.35, 0, 4);
    if (settings.avoidanceStrength !== undefined) this.settings.avoidanceStrength = finite(settings.avoidanceStrength, 1, 0, 3);
    if (settings.signalMode !== undefined) {
      this.settings.signalMode = parseSignalMode(settings.signalMode) ?? 'auto';
      this.traffic?.setMode(this.settings.signalMode, this.time, this.vehicles?.occupiesCrossing, (this.signal?.crossing ?? 0) > 0);
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
    this.forecourt?.reset(i);
    this.forecourtQueue?.reset(i);
    this.sidewalkPassing?.reset(i);
    a.scale[i] = this.random.range(0.89, MAX_SCALE);
    a.radius[i] = a.scale[i] * RADIUS_AT_UNIT_SCALE; a.speedFactor[i] = this.random.range(0.8, 1.2);
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
    this.forecourt?.reset(id);
    this.forecourtQueue?.reset(id);
    this.sidewalkPassing?.reset(id);
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

  private readonly permitsPortalStep = (id: number, x: number, z: number): boolean => {
    const a = this.agents, fromX = a.current.x[id], fromZ = a.current.z[id], radius = a.radius[id];
    x = Math.fround(x); z = Math.fround(z);
    if (this.vehicles!.blocksPedestrian(fromX, fromZ, x, z, a.scale[id])) return false;
    const urban = this.navigation.urban;
    return this.signal?.pedestrian === 'green' || !urban?.occupiesCrossing(x, z, radius + 0.015)
      || urban.occupiesCrossing(fromX, fromZ, radius + 0.015);
  };

  private readonly permitsSpawn = (x: number, z: number): boolean => {
    x = Math.fround(x); z = Math.fround(z);
    const radius = MAX_SCALE * RADIUS_AT_UNIT_SCALE;
    // Portal replacement creates a new person after car movement. Check the new
    // location with the largest possible radius before changing the slot's life.
    return !this.vehicles!.blocksPedestrian(x, z, x, z, MAX_SCALE)
      && (this.signal?.pedestrian === 'green' || !this.navigation.urban?.occupiesCrossing(x, z, radius + 0.015));
  };

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
    a.stalledTime[i] = !this.activities?.stationary[i] && speed < a.preferredSpeed[i] * 0.2 ? a.stalledTime[i] + dt : 0;
    return speed;
  }
  step(dt = FIXED_DT): void {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1) throw new RangeError('Simulation step must be between 0 and 0.1 seconds.');
    const a = this.agents, read = a.current;
    this.traffic?.update(this.time + dt, this.vehicles?.occupiesCrossing, (this.signal?.crossing ?? 0) > 0);
    const scramble = this.navigation.scramble;
    const pedestrian = this.signal?.pedestrian;
    const crossingClosed = pedestrian === 'red' || pedestrian === 'flashingGreen';
    const clearingCrossers = crossingClosed && (this.signal?.crossing ?? 0) > 0;
    this.grid.rebuild(read.x, read.z, a.count);
    const activities = this.activities;
    if (activities && this.signal) activities.beginStep(dt, this.signal);
    this.crosswalkFlow?.updateTraffic(a, dt);
    this.forecourt?.update(dt);
    this.encounterContext.dt = dt;
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
      const sidewalkOnly = !!scramble && crossingClosed && scramble.isSidewalk(read.x[i], read.z[i], radius);
      // At the first flashing step, choose a reachable curb. Keep that decision
      // until the person lands, including through a red or a later green.
      const clearance = this.crossings && (this.crossings.clearing[i] || (crossingClosed && !sidewalkOnly))
        ? this.crossings : undefined;
      const clearRoad = !!clearance;
      const recovery = this.recoveryByTarget[a.targetId[i]];
      const order = clearRoad ? undefined : recovery?.order(i);
      const passageAllowed = !order || order === 'pass';
      const tx = a.targetX[i] - read.x[i], tz = a.targetZ[i] - read.z[i];
      const previousPeer = this.encounters.gazeTarget[i];
      const passer = previousPeer >= 0 && a.generation[previousPeer] === this.encounters.gazeLife[i] ? previousPeer : -1;
      const passSide = this.encounters.passSide[i];
      this.encounters.advance(i, dt);
      const yielding = !order && !clearRoad && courtesy?.yielding(i) && !this.portals?.steppingAside(i);
      if (this.portals) {
        if (passageAllowed && !yielding && (!clearRoad || this.portals.inPassage(i)) && this.portals.move(i, dt, this.stepCount, this.grid, this.projected)) {
          this.crosswalkFlow?.reset(i);
          this.forecourtQueue?.reset(i);
          this.forecourt?.reset(i);
          this.sidewalkPassing?.reset(i);
          this.attention.settle(i, dt);
          const speed = this.writeMotion(i, dt, this.projected.x, this.projected.z);
          if (this.navigation.urban?.occupiesCrossing(a.next.x[i], a.next.z[i], radius)) crossing++;
          totalSpeed += speed;
          if (speed < a.preferredSpeed[i] * 0.45) stopped++;
          continue;
        }
      } else if (!clearRoad && tx * tx + tz * tz < 10) this.nextTarget(i);
      const steppingAside = this.portals?.steppingAside(i);
      const waitingAtMouth = !order && !clearRoad && !yielding && this.portals?.waitingAtMouth;
      const onOrdinaryTrip = !clearRoad && !order && !yielding && !waitingAtMouth && !steppingAside;
      const queue = this.forecourtQueue;
      if (!onOrdinaryTrip) queue?.reset(i);
      const staging = sidewalkOnly && onOrdinaryTrip && queue?.guide(i, this.stepCount, this.direction);
      const queuedRoute = !crossingClosed && queue ? queue.route[i] : 0;
      if (clearance) this.crosswalkFlow?.reset(i);
      const followingTrack = !staging && !clearance && this.crosswalkFlow?.guide(i, a.generation[i],
        read.x[i], read.z[i], a.targetId[i], radius, this.direction,
        this.enhancedCrossing ? activities?.groupTrackKey[i] : undefined, activities?.groupSlot[i], queuedRoute);
      if (queuedRoute && followingTrack) queue!.reset(i);
      const returningToCrossing = queuedRoute && !followingTrack && queue!.approach(i, this.direction);
      if (!staging && !returningToCrossing && !followingTrack && !clearance) {
        this.navigation.direction(read.x[i], read.z[i], a.targetId[i], a.targetX[i], a.targetZ[i], this.direction, radius);
        if (onOrdinaryTrip) this.forecourt?.guide(i, this.direction);
      } else this.forecourt?.reset(i);
      const crossingPace = clearance
        ? clearance.guide(i, read.x[i], read.z[i], radius, dt, a.preferredSpeed[i], this.direction) : 1;
      if (this.sidewalkPassing) {
        if (socialAvoidance && onOrdinaryTrip && !followingTrack && !staging) {
          this.sidewalkPassing.guide(i, this.stepCount, this.direction);
        } else this.sidewalkPassing.reset(i);
      }
      if (order) recovery!.guide(i, this.direction);
      else if (yielding) courtesy!.guide(i, this.direction);
      else if (waitingAtMouth) { this.direction.x = 0; this.direction.z = 0; }
      const routeX = this.direction.x, routeZ = this.direction.z;
      const makeLandingRoom = clearingCrossers && this.grid.counts[this.grid.cells[i]] > 1;
      const waitingAtCurb = sidewalkOnly && scramble!.brakeAtCurb(read.x[i], read.z[i], this.direction, radius, makeLandingRoom);
      const waitingAtSignal = waitingAtCurb || (!!staging && !!queue!.settled[i]);
      if (waitingAtSignal) waiting++;
      const allowHesitation = !clearRoad && !waitingAtSignal && !staging && !waitingAtMouth && !this.doorways?.cells[this.grid.cells[i]];
      const freeToAct = allowHesitation && !order && !yielding && !steppingAside;
      const activityPace = activities && freeToAct ? activities.guide(i, this.direction, this.enhancedCrossing) : 1;
      const takingPhoto = freeToAct && !!activities?.stationary[i];
      const speedScale = crossingPace * activityPace * this.attention.update(i, dt, waitingAtSignal, routeX, routeZ, allowHesitation, passer, passSide);
      const desiredSpeed = a.preferredSpeed[i] * speedScale;
      a.preferredVX[i] = this.direction.x * desiredSpeed; a.preferredVZ[i] = this.direction.z * desiredSpeed;
      const stayOnSidewalk = sidewalkOnly || !!order;
      const maxSpeed = a.preferredSpeed[i] * crossingPace * Math.max(1, activityPace) * 1.12;
      const speedLimit = Math.max(maxSpeed, Math.hypot(read.vx[i], read.vz[i]) - PEDESTRIAN_ACCELERATION * dt);
      this.encounterContext.speedLimit = speedLimit;
      const reciprocal = this.enhancedCrossing && followingTrack && !crossingClosed && freeToAct && !takingPhoto;
      this.avoidance.compute(i, a, this.grid, this.direction, this.settings, this.velocity, speedScale, stayOnSidewalk,
        reciprocal ? this.encounterContext : undefined);
      if (takingPhoto || (order === 'wait' && !this.avoidance.yieldingAtCurb)) {
        this.velocity.x = 0; this.velocity.z = 0;
      } else if (!this.avoidance.resolvedNextVelocity && !order && !clearRoad && !yielding && !steppingAside && !this.avoidance.yieldingAtCurb) {
        headway?.limit(i, this.stepCount, this.time, this.direction, this.velocity);
      }
      let vx = this.velocity.x, vz = this.velocity.z;
      if (!this.avoidance.resolvedNextVelocity) {
        let ax = (vx - read.vx[i]) / 0.3, az = (vz - read.vz[i]) / 0.3;
        const acceleration = Math.hypot(ax, az);
        if (acceleration > PEDESTRIAN_ACCELERATION) {
          ax *= PEDESTRIAN_ACCELERATION / acceleration; az *= PEDESTRIAN_ACCELERATION / acceleration;
        }
        vx = read.vx[i] + ax * dt; vz = read.vz[i] + az * dt;
      }
      const velocityLength = Math.hypot(vx, vz);
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
        scramble.constrain(read.x[i], read.z[i], x, z, radius, stayOnSidewalk, this.projected, this.avoidance.allowCrossingMargin);
        x = this.projected.x; z = this.projected.z;
      }
      if (this.doorways) {
        this.doorways.limit(i, x, z, dt, this.projected, stayOnSidewalk);
        x = this.projected.x; z = this.projected.z;
      }
      if (this.vehicles?.blocksPedestrian(read.x[i], read.z[i], Math.fround(x), Math.fround(z), a.scale[i])) {
        x = read.x[i]; z = read.z[i];
      }
      if (scramble) {
        const onSidewalk = scramble.isSidewalk(Math.fround(x), Math.fround(z), radius);
        if (!onSidewalk && (!this.navigation.urban || this.navigation.urban.occupiesCrossing(Math.fround(x), Math.fround(z), radius))) crossing++;
        this.crossings!.observeStep(i, onSidewalk);
      }
      const speed = this.writeMotion(i, dt, x, z);
      totalSpeed += speed;
      if (!takingPhoto && speed < a.preferredSpeed[i] * 0.45) stopped++;
    }
    // Use accepted pedestrian trajectories while both endpoints still belong to
    // the same life. A portal replacement has no path across the intervening map.
    const vehicleSignals = this.signal?.crossing === 0 && crossing === 0 ? this.signal : undefined;
    this.vehicles?.step(dt, vehicleSignals ?? VEHICLES_STOPPED);
    if (this.portals && this.portals.transferCount) {
      this.arrivals += this.portals.replaceArrivals(id => {
        this.newPerson(id);
        activities?.reset(id);
        this.attention.reset(id, a.generation[id]);
        this.encounters.reset(id, a.generation[id]);
        this.crossings?.reset(id);
        this.crosswalkFlow?.reset(id);
      }, this.vehicles && this.permitsSpawn);
    }
    a.swap(); this.stepCount++; this.time += dt;
    this.stats.meanSpeed = totalSpeed / a.count; this.stats.congestion = stopped / a.count;
    if (this.signal) { this.signal.waiting = waiting; this.signal.crossing = crossing; }
  }
  writeVehicleSnapshot(target: Float32Array): void {
    if (this.vehicles) this.vehicles.writeSnapshot(target);
    else if (target.length !== 0) throw new RangeError('Snapshot has an invalid vehicle capacity.');
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
      const photo = this.activities?.selfiePose[i] ?? 0;
      target[offset + 13] = this.attention.headYaw[i] * (1 - photo) + 0.24 * photo;
      target[offset + 14] = this.encounters.lean[i];
      target[offset + 15] = photo;
    }
  }
}
