/** Shared data-only boundary: Simulation has no dependency on DOM or WebGPU. */
export type ScenarioId = 'shibuya' | 'plaza' | 'corridor' | 'bottleneck' | 'crossing';
export type SignalMode = 'auto' | 'green' | 'red';
export interface SignalState {
  mode: SignalMode;
  phase: 'green' | 'red';
  /** Simulation seconds until the next automatic phase, null for manual control. */
  remaining: number | null;
  waiting: number;
  crossing: number;
}
export type Quality = 'performance' | 'balanced' | 'ultra';
export type CameraView = 'perspective' | 'overview' | 'street';
export interface Point2 { x: number; z: number }
/** A reachable routing goal and its short, directed passage behind a facade or past a street edge. */
export interface PedestrianPortal {
  id: string;
  kind: 'door' | 'street';
  /** Direction served by a street gateway, including termini just inside the map's walkable extent. */
  edge?: 'north' | 'south' | 'east' | 'west';
  approach: Point2;
  end: Point2;
  width: number;
  /** Optional public-side waiting point along a storefront on a busy sidewalk. */
  queueApproach?: Point2;
  /** Exit-only passage in a one-way pedestrian flow. */
  entry?: boolean;
}
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Zone { x: number; z: number; width: number; depth: number }
export interface Obstacle extends Zone {
  height: number;
  kind: 'building' | 'planter' | 'barrier';
}
/** First ring is the exterior; subsequent rings are holes. Coordinates are local meters. */
export interface Polygon2 { rings: Point2[][] }
export interface UrbanMap {
  schemaVersion: number;
  origin: { latitude: number; longitude: number; crs: string };
  renderBounds: Bounds;
  /** Unioned surfaces, with building footprints and traffic islands removed. */
  sidewalks: Polygon2[];
  walkable: Polygon2[];
  roads: Polygon2[];
  buildingFootprints: Polygon2[];
  mesh: {
    vertices: string; indices: string; vertexCount: number; indexCount: number;
    /** Content digests bind the rendered geometry to this exact navigation map. */
    vertexSha256: string; indexSha256: string;
  };
  /** Optional photographic appearance; coordinates are float32 u,v,page per mesh vertex. */
  appearance?: {
    coordinates: string;
    coordinateSha256: string;
    width: number;
    height: number;
    atlases: { path: string; sha256: string }[];
  };
  statistics: { buildings: number; lod2Buildings: number; lod1Buildings: number; triangles: number };
}
export interface Scenario {
  id: ScenarioId;
  name: string;
  description: string;
  bounds: Bounds;
  obstacles: Obstacle[];
  spawnZones: Zone[];
  targets: Point2[];
  /** When present, targets are the corresponding portal approaches, in the same order. */
  portals?: PedestrianPortal[];
  /** Initial destination per zone. An array samples among routes, with repeats giving a route more weight. */
  spawnTargets?: (number | number[])[];
  /** Next destination from each target, or the destination for a trip starting at that portal. */
  targetTransitions?: number[];
  /** Draw a trip purpose first. The remaining share represents people leaving shops for the street. */
  portalTripMix?: { through: number; shopping: number };
  /** Doorways to keep clear at initial placement, shared by alternative layouts of the same map. */
  initialDoorways?: PedestrianPortal[];
  /** Defaults to enabled for legacy Shibuya scenarios. */
  portalRecoveryByDefault?: boolean;
  targetSpread?: number;
  navigationCellSize?: number;
  urbanMap?: UrbanMap;
  /** Shared geometry for navigation, stop lines, zebra markings and signal fixtures. */
  scramble?: {
    roadHalfWidth: number;
    crosswalks: { from: Point2; to: Point2; width: number }[];
    signalPositions: (Point2 & { direction?: Point2 })[];
  };
}
export interface SimulationSettings {
  simulationSpeed: number;
  walkingSpeed: number;
  avoidanceStrength: number;
  signalMode: SignalMode;
}
export interface SimulationConfig extends SimulationSettings {
  count: number;
  seed: number;
  scenario: ScenarioId;
}
export const DEFAULT_CONFIG: SimulationConfig = {
  count: 1000, seed: 42, scenario: 'shibuya',
  simulationSpeed: 1, walkingSpeed: 1.35, avoidanceStrength: 1, signalMode: 'auto',
};
/** Packed slot: x,z,heading,speed,phase,appearance,scale,clip,r,g,b,life,opacity,headYaw,contactLean. */
export const SNAPSHOT_STRIDE = 15;
export const FIXED_DT = 1 / 30;
export const MAX_AGENTS = 20000;
export interface SnapshotMessage {
  type: 'snapshot';
  generation: number;
  buffer: ArrayBuffer;
  count: number;
  step: number;
  simulationTime: number;
  stepMs: number;
  meanSpeed: number;
  congestion: number;
  signal?: SignalState;
}
export type WorkerInput =
  | { type: 'init'; config: SimulationConfig; generation: number; paused: boolean }
  | { type: 'settings'; settings: Partial<SimulationSettings> }
  | { type: 'pause'; paused: boolean }
  | { type: 'recycle'; buffer: ArrayBuffer; generation: number };
export type WorkerOutput = SnapshotMessage | { type: 'error'; message: string };
export interface RenderStats {
  visible: number;
  lodCounts: [number, number, number];
  drawCalls: number;
  triangles: number;
  cpuMs: number;
  resolution: string;
}
export interface AppStats extends RenderStats {
  fps: number;
  frameMs: number;
  stepMs: number;
  count: number;
  meanSpeed: number;
  congestion: number;
  simulationTime: number;
  paused: boolean;
}
