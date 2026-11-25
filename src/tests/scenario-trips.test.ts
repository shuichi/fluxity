import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type PedestrianPortal } from '../types';
import { Simulation } from '../simulation/Simulation';

// Match the actual terminal cross-section, including lanes on either side of its center.
function terminalAt(portals: PedestrianPortal[], x: number, z: number, tolerance: number): number {
  return portals.findIndex(({ approach, end, width }) => {
    const dx = end.x - approach.x, dz = end.z - approach.z, length = Math.hypot(dx, dz);
    const along = ((x - end.x) * dx + (z - end.z) * dz) / length;
    const across = ((x - end.x) * dz - (z - end.z) * dx) / length;
    return Math.abs(along) <= tolerance && Math.abs(across) <= width / 2;
  });
}

describe('pedestrian trips in the procedural scenes', () => {
  it.each(['plaza', 'corridor', 'bottleneck', 'crossing'] as const)('%s replenishes from another entrance and keeps its flow', scenario => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, scenario, count: 18, walkingSpeed: 2.5 });
    const a = sim.agents, portals = sim.scenario.portals!;
    const observed = new Set<number>(), previousLife = a.generation.slice();
    const expected = scenario === 'bottleneck' ? [1] : portals.map((_, i) => i);
    for (let tick = 0; tick < 3600; tick++) {
      sim.step(0.1);
      for (let i = 0; i < a.count; i++) {
        if (a.generation[i] === previousLife[i]) continue;
        const exit = terminalAt(portals, a.next.x[i], a.next.z[i], 0.35);
        const entry = terminalAt(portals, a.current.x[i], a.current.z[i], 0.001);
        expect(exit).toBeGreaterThanOrEqual(0);
        expect(entry).toBeGreaterThanOrEqual(0);
        expect(entry).not.toBe(exit);
        expect(portals[entry].entry).not.toBe(false);
        expect(a.opacity[i]).toBe(0);
        expect(a.targetId[i]).not.toBe(entry);
        if (sim.scenario.targetTransitions) expect(a.targetId[i]).toBe(sim.scenario.targetTransitions[entry]);
        previousLife[i] = a.generation[i];
        observed.add(exit);
      }
      if (sim.arrivals >= a.count && observed.size === expected.length) break;
    }
    expect(observed).toEqual(new Set(expected));
    expect(a.count).toBe(18);
    expect(sim.arrivals).toBeGreaterThanOrEqual(a.count);
    expect(previousLife.reduce((sum, life) => sum + life, 0)).toBe(sim.arrivals);
  });
});
