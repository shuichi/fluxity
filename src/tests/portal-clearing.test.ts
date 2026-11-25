import { expect, it } from 'vitest';
import { Random } from '../math/random';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { DoorwayClearance, doorwayRadius } from '../simulation/DoorwayClearance';
import { Navigation } from '../simulation/Navigation';
import { PortalFlow } from '../simulation/PortalFlow';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { FIXED_DT, type PedestrianPortal, type Scenario } from '../types';

function encounter() {
  const portals: PedestrianPortal[] = [
    { id: 'shop', kind: 'door', approach: { x: 0, z: -1 }, end: { x: 0, z: -5 }, width: 5.2 },
    { id: 'street', kind: 'street', approach: { x: 0, z: 6 }, end: { x: 0, z: 10 }, width: 2.5 },
  ];
  const pavement = [{ rings: [[{ x: -8, z: -7 }, { x: 8, z: -7 }, { x: 8, z: 8 }, { x: -8, z: 8 }]] }];
  const scene: Scenario = {
    ...shibuya, bounds: { minX: -8, maxX: 8, minZ: -7, maxZ: 8 }, portals,
    targets: portals.map(p => p.approach), spawnZones: [{ x: 0, z: 0, width: 2, depth: 2 }],
    spawnTargets: [0], targetTransitions: [1, 0], scramble: { roadHalfWidth: 0, crosswalks: [], signalPositions: [] },
    urbanMap: { ...shibuya.urbanMap!, sidewalks: pavement, walkable: pavement },
  };
  const agents = new AgentData(2), nav = new Navigation(scene), grid = new SpatialGrid(scene.bounds, 2);
  const clearance = new DoorwayClearance([portals[0]], grid, agents, nav);
  const flow = new PortalFlow(portals, nav, agents, new Random(42), clearance);
  agents.radius.fill(0.25); agents.scale.fill(1); agents.preferredSpeed.fill(1.35);
  agents.current.x[1] = 5;
  flow.assignTarget(1, 0);
  let step = 0;
  function advance(id: number) {
    const s = agents.current, w = agents.next;
    grid.rebuild(s.x, s.z, 2);
    w.x.set(s.x); w.z.set(s.z); w.vx.set(s.vx); w.vz.set(s.vz); w.heading.set(s.heading);
    const next = { x: s.x[id], z: s.z[id] };
    if (flow.move(id, FIXED_DT, step++, grid, next)) {
      w.x[id] = next.x; w.z[id] = next.z;
      w.vx[id] = (next.x - s.x[id]) / FIXED_DT; w.vz[id] = (next.z - s.z[id]) / FIXED_DT;
    }
    flow.replaceArrivals(() => {});
    agents.swap();
  }
  return { agents, flow, nav, advance };
}

it('advances past a shoulder without leaving its reserved intake bank', () => {
  const { agents: a, flow, advance } = encounter();
  // The outer track on this side has half a lane of usable space towards the center.
  for (let attempt = 0; attempt < 32 && a.targetX[0] < 2; attempt++) flow.assignTarget(0, 0);
  expect(a.targetX[0]).toBeGreaterThan(2);
  const x = a.targetX[0], z = a.targetZ[0];
  a.current.x[0] = x; a.current.z[0] = z;
  advance(0);
  expect(flow.inLane(0)).toBe(true);
  const shoulders = 2 * doorwayRadius(1);
  a.current.x[1] = x + 0.6; a.current.z[1] = z - Math.sqrt(shoulders ** 2 - 0.6 ** 2);
  a.stalledTime[0] = 1;
  advance(0);
  expect(a.current.z[0]).toBeLessThan(z - 0.001);
  expect(a.current.x[0]).toBeLessThan(x - 0.001);
  expect(a.current.x[0]).toBeGreaterThanOrEqual(x - 0.4371);
  expect(flow.inLane(0)).toBe(true);
  expect(a.generation[0]).toBe(0);
  expect(Math.hypot(a.current.x[0] - a.current.x[1], a.current.z[0] - a.current.z[1])).toBeGreaterThanOrEqual(shoulders - 0.0001);
});

it.each([[true, true], [false, true], [true, false]])('considers an emerging walker with yielding %s and facing the doorway %s', (enabled, facing) => {
  const { agents: a, flow, nav, advance } = encounter();
  flow.yieldForEmergence = enabled;
  flow.assignTarget(0, 1);
  a.current.x[0] = a.targetX[0]; a.current.z[0] = a.targetZ[0];
  // Complete a street trip normally so that slot 0 emerges from the shop.
  for (let tick = 0; tick < 300 && (!a.generation[0] || a.opacity[0] < 0.85); tick++) advance(0);
  expect(a.generation[0]).toBe(1);
  expect(flow.inLane(0)).toBe(true);
  const x = a.current.x[0], z = a.current.z[0] + 0.78;
  a.current.x[1] = x; a.current.z[1] = z; a.current.heading[1] = facing ? Math.PI : 0;
  advance(1);
  expect(flow.steppingAside(1)).toBe(enabled && facing);
  expect(flow.inPassage(1)).toBe(!(enabled && facing));
  expect(nav.scramble!.isSidewalk(a.current.x[1], a.current.z[1], a.radius[1] + 0.015)).toBe(true);
  expect(Math.hypot(a.current.x[1] - a.current.x[0], a.current.z[1] - a.current.z[0])).toBeGreaterThanOrEqual(2 * doorwayRadius(1) - 0.0001);
});

it('releases a diagonal alignment that was committed before the other person appeared', () => {
  const { agents: a, flow, nav, advance } = encounter();
  flow.assignTarget(0, 1);
  a.current.x[0] = a.targetX[0]; a.current.z[0] = a.targetZ[0];
  for (let tick = 0; tick < 300 && !a.generation[0]; tick++) advance(0);
  expect(a.opacity[0]).toBe(0);
  a.current.x[1] = a.current.x[0]; a.current.z[1] = -3.92; a.current.heading[1] = Math.PI;
  advance(1);
  expect(flow.inPassage(1)).toBe(true);
  expect(flow.inLane(1)).toBe(false);
  for (let tick = 0; tick < 60 && a.opacity[0] < 0.85; tick++) advance(0);
  expect(a.opacity[0]).toBeGreaterThanOrEqual(0.85);
  a.stalledTime[1] = 0.4;
  advance(1);
  expect(flow.inPassage(1)).toBe(false);
  expect(flow.steppingAside(1)).toBe(true);
  expect(nav.scramble!.isSidewalk(a.current.x[1], a.current.z[1], a.radius[1] + 0.015)).toBe(true);
  expect(a.generation[1]).toBe(0);
});

it.each([
  { entering: 0, emerging: 0, yields: false },
  { entering: 0.59, emerging: 0.59, yields: false },
  { entering: 0.6, emerging: 0, yields: true },
  { entering: 0, emerging: 0.6, yields: true },
])('at 1.1 m checks both stall durations ($entering s entering, $emerging s emerging)', ({ entering, emerging, yields }) => {
  const { agents: a, flow, advance } = encounter();
  flow.assignTarget(0, 1);
  a.current.x[0] = a.targetX[0]; a.current.z[0] = a.targetZ[0];
  for (let tick = 0; tick < 300 && (!a.generation[0] || a.opacity[0] < 0.85); tick++) advance(0);
  expect(a.generation[0]).toBe(1);
  a.current.x[1] = a.current.x[0]; a.current.z[1] = a.current.z[0] + 1.1;
  a.current.heading[1] = Math.PI; a.current.vz[1] = entering ? 0 : -1;
  if (emerging) a.current.vz[0] = 0;
  a.stalledTime.set([emerging, entering]);
  advance(1);
  expect(flow.steppingAside(1)).toBe(yields);
  expect(flow.inPassage(1)).toBe(!yields);
});
