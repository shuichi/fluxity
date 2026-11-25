import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../types';
import { shibuya } from '../scenarios/shibuya';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import { Steering } from '../simulation/Steering';
import { doorwayRadius } from '../simulation/DoorwayClearance';

function invalidPositions(simulation: Simulation): number {
  const a = simulation.agents;
  let invalid = 0;
  for (let i = 0; i < a.count; i++) {
    if (!simulation.navigation.isFree(a.current.x[i], a.current.z[i], a.radius[i]) && !simulation.isInPortalLane(i)) invalid++;
    if (!Number.isFinite(a.current.x[i] + a.current.z[i] + a.current.heading[i])) invalid++;
    if (Math.hypot(a.current.vx[i], a.current.vz[i]) > a.preferredSpeed[i] * 1.12 + 0.01) invalid++;
  }
  return invalid;
}

describe('PLATEAU Shibuya pedestrian map', () => {
  it('connects every active cell to every destination and keeps spawn cells on sidewalks', () => {
    const navigation = new Navigation(shibuya);
    expect(shibuya.urbanMap?.statistics.lod2Buildings).toBeGreaterThan(0);
    expect(navigation.spawnCells.length).toBeGreaterThan(1000);
    expect(navigation.fields.length).toBe(shibuya.targets.length);
    for (const target of shibuya.targets) expect(navigation.isSpawnable(target.x, target.z, 0.3)).toBe(true);
    let disconnected = 0;
    for (const field of navigation.fields) for (let cell = 0; cell < navigation.walkable.length; cell++) {
      if (navigation.walkable[cell] && !Number.isFinite(field.costs[cell])) disconnected++;
    }
    expect(disconnected).toBe(0);
  });

  it('holds 1,000 pedestrians on sidewalks at red and releases real crossing flows on green', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1000, signalMode: 'red' });
    const a = simulation.agents, geometry = simulation.navigation.scramble!;
    for (let step = 0; step < 120; step++) simulation.step();
    let incursions = 0;
    for (let i = 0; i < a.count; i++) {
      if (!geometry.isSidewalk(a.current.x[i], a.current.z[i], a.radius[i]) && !simulation.isInPortalLane(i)) incursions++;
    }
    expect(incursions).toBe(0); expect(invalidPositions(simulation)).toBe(0);
    expect(simulation.signal?.waiting).toBeGreaterThan(0);
    simulation.updateSettings({ signalMode: 'green' });
    for (let step = 0; step < 180; step++) simulation.step();
    expect(simulation.signal?.crossing).toBeGreaterThan(10);
    // Some initial trips end at a local storefront while others cross the junction.
    expect(simulation.arrivals).toBeGreaterThan(0);
    expect(simulation.stats.meanSpeed).toBeGreaterThan(0.3);
    expect(invalidPositions(simulation)).toBe(0);
  }, 15000);

  it('completes repeated trips from the original five spawn zones with a constant population', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 5, signalMode: 'green' });
    for (let step = 0; step < 6000; step++) {
      simulation.step();
      if (step % 100 === 0) {
        expect(invalidPositions(simulation)).toBe(0);
        expect(simulation.agents.count).toBe(5);
      }
    }
    expect(simulation.arrivals).toBeGreaterThanOrEqual(5);
    expect(simulation.agents.generation.reduce((sum, life) => sum + life, 0)).toBe(simulation.arrivals);
    expect(Math.max(...simulation.agents.stalledTime)).toBeLessThan(10);
  }, 10000);

  it('keeps all five storefront queues moving after the first crowd reaches them', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 300, walkingSpeed: 2.6, signalMode: 'green', seed: 42 });
    const a = sim.agents, portals = shibuya.portals!;
    for (let step = 0; step < 1800; step++) sim.step();
    const visited = new Set<string>();
    const generation = a.generation.slice(), previousTarget = a.targetId.slice();
    for (let step = 0; step < 1800; step++) {
      generation.set(a.generation); previousTarget.set(a.targetId);
      sim.step();
      for (let i = 0; i < a.count; i++) {
        if (a.generation[i] !== generation[i]) visited.add(portals[previousTarget[i]].id);
      }
    }
    for (const door of portals.filter(p => p.kind === 'door')) expect(visited.has(door.id)).toBe(true);
    expect(a.count).toBe(300);
    expect(a.generation.reduce((sum, life) => sum + life, 0)).toBe(sim.arrivals);
  }, 30000);

  it('initializes 20,000 agents without invalid fallback positions and bounds local work', () => {
    const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 20000, signalMode: 'red' });
    const a = simulation.agents, geometry = simulation.navigation.scramble!;
    let invalid = 0;
    for (let i = 0; i < a.count; i++) {
      if (!geometry.isSidewalk(a.current.x[i], a.current.z[i], a.radius[i])
        || !simulation.navigation.isReachable(a.current.x[i], a.current.z[i], a.targetId[i])) invalid++;
    }
    expect(invalid).toBe(0);
    for (const door of shibuya.portals!.filter(portal => portal.kind === 'door')) {
      // Even when the original spawn zones overflow, the public apron starts clear.
      const nearby: number[] = [];
      for (let i = 0; i < a.count; i++) {
        if (Math.hypot(a.current.x[i] - door.approach.x, a.current.z[i] - door.approach.z) <= 3) nearby.push(i);
      }
      for (const [k, i] of nearby.entries()) for (const j of nearby.slice(k + 1)) {
        const distance = Math.hypot(a.current.x[i] - a.current.x[j], a.current.z[i] - a.current.z[j]);
        expect(distance).toBeGreaterThanOrEqual(doorwayRadius(a.scale[i]) + doorwayRadius(a.scale[j]) - 0.0001);
      }
    }
    for (let step = 0; step < 3; step++) simulation.step();
    expect(simulation.signal?.crossing).toBe(0);
    simulation.updateSettings({ signalMode: 'green' });
    for (let step = 0; step < 3; step++) simulation.step();
    expect(invalidPositions(simulation)).toBe(0);
    expect((simulation.avoidance as Steering).candidateChecks).toBeLessThanOrEqual(20000 * 96);
  }, 20000);
});
