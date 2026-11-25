import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SNAPSHOT_STRIDE, type PedestrianPortal, type Scenario } from '../types';
import { Simulation } from '../simulation/Simulation';

const gates: PedestrianPortal[] = [
  { id: 'door', kind: 'door', approach: { x: -7, z: 0 }, end: { x: -11, z: 0 }, width: 0.9 },
  { id: 'street', kind: 'street', approach: { x: 7, z: 0 }, end: { x: 12, z: 0 }, width: 0.9 },
];
function fixture(portals = gates): Scenario {
  return {
    id: 'plaza', name: 'Portal fixture', description: '',
    bounds: { minX: -10, maxX: 10, minZ: -8, maxZ: 8 }, obstacles: [],
    spawnZones: [{ x: 5, z: 0, width: 2, depth: 2 }],
    targets: portals.map(portal => portal.approach), portals, spawnTargets: [1], targetTransitions: [1, 0],
  };
}

describe('fixed-population trips', () => {
  it('walks to the street end, fades and enters from a different portal in the same step', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1 }, undefined, fixture());
    const a = sim.agents, snapshot = new Float32Array(SNAPSHOT_STRIDE);
    const originalAppearance = a.appearance[0];
    let transfers = 0, outwardFade = false, entered = false;
    for (let step = 0; step < 520; step++) {
      const generation = a.generation[0], x = a.current.x[0];
      sim.step();
      sim.writeSnapshot(snapshot);
      expect(snapshot[11]).toBe(a.generation[0]);
      expect(snapshot[12]).toBe(a.opacity[0]);
      expect(a.count).toBe(1);
      expect(sim.stats.meanSpeed).toBeLessThan(2);
      expect(sim.navigation.isFree(a.current.x[0], a.current.z[0], a.radius[0]) || sim.isInPortalLane(0)).toBe(true);
      if (a.opacity[0] > 0 && a.opacity[0] < 1 && generation === 0) {
        expect(a.current.x[0]).toBeGreaterThan(9);
        outwardFade = true;
      }
      if (a.generation[0] !== generation) {
        expect(x).toBeGreaterThan(11.9);
        expect(a.current.x[0]).toBe(-11);
        expect(a.opacity[0]).toBe(0);
        expect(a.appearance[0]).not.toBe(originalAppearance);
        expect(a.targetId[0]).toBe(1);
        transfers++;
      }
      if (transfers && !sim.isInPassage(0)) { entered = true; break; }
    }
    expect([transfers, sim.arrivals]).toEqual([1, 1]);
    expect(outwardFade).toBe(true);
    expect(entered).toBe(true);
    expect(a.current.x[0]).toBeGreaterThanOrEqual(-9);
    expect(a.opacity[0]).toBe(1);
  });

  it('keeps a waiting walker on the map and reserves unique replacement lanes', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 2 }, undefined, fixture());
    const a = sim.agents;
    a.current.x.set([7, 6.36]); a.current.z.fill(0);
    a.current.vx.fill(0); a.current.vz.fill(0);
    let waited = false;
    for (let step = 0; step < 850 && a.generation[1] === 0; step++) {
      sim.step();
      if (sim.isInPassage(0) && a.generation[1] === 0 && !sim.isInPassage(1)) {
        waited = true;
        expect(a.opacity[1]).toBe(1);
        expect(sim.navigation.isFree(a.current.x[1], a.current.z[1], a.radius[1])).toBe(true);
      }
      expect(Math.hypot(a.current.x[0] - a.current.x[1], a.current.z[0] - a.current.z[1]))
        .toBeGreaterThan(a.radius[0] + a.radius[1]);
    }
    expect(waited).toBe(true);
    expect([...a.generation]).toEqual([1, 1]);
    expect(sim.arrivals).toBe(2);
  });

  it('joins the public apron at the current depth when approaching from the side', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 2 }, undefined, fixture());
    const a = sim.agents;
    a.current.x.set([8.12, 7.96]); a.current.z.set([-0.68, 0.62]);
    a.current.vx.fill(0); a.current.vz.fill(0);
    let sharedLane = false;
    for (let step = 0; step < 260 && a.generation[0] === 0; step++) {
      sim.step();
      if (a.generation[0] === 0) expect(a.current.x[0]).toBeGreaterThanOrEqual(8.12 - 0.001);
      if (sim.isInPortalLane(0) && sim.isInPortalLane(1) && a.current.x[0] > 0 && a.current.x[1] > 0) {
        sharedLane = true;
        expect(Math.abs(a.current.x[0] - a.current.x[1])).toBeGreaterThan(0.82);
      }
    }
    expect(sharedLane).toBe(true);
  });

  it('maintains successive waves through busy two-way doors with multiple pedestrians per lane', () => {
    const portals: PedestrianPortal[] = [
      { ...gates[0], width: 2.45 }, { ...gates[1], width: 2.45 },
      { id: 'north', kind: 'street', approach: { x: 0, z: -5 }, end: { x: 0, z: -10 }, width: 2.45 },
      { id: 'south', kind: 'door', approach: { x: 0, z: 5 }, end: { x: 0, z: 9 }, width: 2.45 },
    ];
    const scene = { ...fixture(portals), targetTransitions: [1, 0, 3, 2] };
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 48, walkingSpeed: 2.5 }, undefined, scene);
    let previous = 0;
    for (let interval = 0; interval < 6; interval++) {
      for (let step = 0; step < 300; step++) sim.step(0.1);
      expect(sim.arrivals - previous).toBeGreaterThan(8);
      previous = sim.arrivals;
    }
    expect(sim.agents.count).toBe(48);
    expect(sim.agents.generation.reduce((sum, life) => sum + life, 0)).toBe(previous);
  });

  it('replenishes simultaneous departures at distinct positions and replays deterministically', () => {
    const wide = gates.map(gate => ({ ...gate, width: 7 }));
    const run = () => {
      const sim = new Simulation({ ...DEFAULT_CONFIG, count: 8, seed: 954 }, undefined, fixture(wide));
      const a = sim.agents, landings: number[][] = [];
      // Start exactly at the chosen exit lane with equal walking times.
      a.current.x.set(a.targetX); a.current.z.set(a.targetZ);
      a.current.vx.fill(1.5); a.current.vz.fill(0); a.preferredSpeed.fill(1.5);
      for (let step = 0; step < 200; step++) {
        const old = sim.arrivals;
        sim.step();
        if (sim.arrivals > old) {
          for (let i = 0; i < a.count; i++) if (a.current.x[i] === -11) landings.push([step, a.current.z[i]]);
          break;
        }
      }
      return landings;
    };
    const arrivals = run();
    expect(arrivals.length).toBeGreaterThan(1);
    expect(new Set(arrivals.map(([step]) => step)).size).toBe(1);
    expect(new Set(arrivals.map(([, z]) => z)).size).toBe(arrivals.length);
    expect(run()).toEqual(arrivals);
  });
});
