import { describe, expect, it } from 'vitest';
import { AgentData } from '../simulation/AgentData';
import { CrossingTraffic } from '../simulation/CrossingTraffic';
import { CrosswalkFlow } from '../simulation/CrosswalkFlow';
import { Navigation } from '../simulation/Navigation';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';

describe('local crossing traffic', () => {
  it('smooths stationary density and signed motion between sparse samples and ignores distant people', () => {
    const traffic = new CrossingTraffic({ minX: -8, maxX: 8, minZ: -8, maxZ: 8 });
    const agents = new AgentData(3);
    agents.current.x.fill(0.8); agents.current.z.fill(0.8);
    agents.current.x[1] = -40;
    agents.portalStage[2] = 1;
    agents.current.vx.fill(-1.35);
    expect(traffic.update(agents, 0.125)).toBe(false);
    expect(traffic.cost(0.8, 0.8, 1, 0)).toBe(0);
    expect(traffic.update(agents, 0.125)).toBe(true);
    const against = traffic.cost(0.8, 0.8, 1, 0);
    expect(against).toBeGreaterThan(0);
    expect(against).toBeCloseTo(2 * traffic.cost(0.8, 0.8, -1, 0), 6);
    expect(against).toBeCloseTo(2 * (1 - 0.5 ** (0.25 / 0.8)) / 1.6 ** 2, 5);
    expect(traffic.cost(-40, 0.8, 1, 0)).toBe(0);
    agents.current.x[0] = 40;
    traffic.update(agents, 0.8);
    expect(traffic.cost(0.8, 0.8, 1, 0)).toBeCloseTo(against / 2, 6);
  });

  it('steers new entries away from an occupied counterflow strip without displacing existing choices', () => {
    // A westbound stream fills the northern half of the eastbound approach.
    const agents = new AgentData(60), nav = new Navigation(syntheticShibuya);
    for (let i = 0; i < agents.count; i++) {
      agents.current.x[i] = -20 + (i % 10);
      agents.current.z[i] = -30 + Math.floor(i / 10) * 0.45;
      agents.current.vx[i] = -1.5;
    }
    const plain = new CrosswalkFlow(nav, 128, 42), enhanced = new CrosswalkFlow(nav, 128, 42, true);
    const direction = { x: 0, z: 0 };
    const enter = (flow: CrosswalkFlow, id: number) => {
      expect(flow.guide(id, 0, -23, -27, 1, 0.27, direction)).toBe(true);
      expect(flow.activeCrossing(id)).toBe(3);
      return flow.trackOffset(id)!;
    };
    const initial = enter(enhanced, 0);
    for (let tick = 0; tick < 24; tick++) enhanced.updateTraffic(agents, 0.25);
    expect(enter(enhanced, 0)).toBe(initial);
    let enteredOccupiedPlain = 0, enteredOccupiedEnhanced = 0;
    for (let i = 1; i < 128; i++) {
      const baseline = enter(plain, i), adjusted = enter(enhanced, i);
      expect(Math.abs(adjusted - baseline)).toBeLessThanOrEqual(2.2);
      expect(Math.abs(adjusted)).toBeLessThan(5 - 0.34);
      if (baseline >= 0 && baseline <= 3.5) enteredOccupiedPlain++;
      if (adjusted >= 0 && adjusted <= 3.5) enteredOccupiedEnhanced++;
    }
    expect(enteredOccupiedPlain).toBeGreaterThan(30);
    expect(enteredOccupiedEnhanced).toBeLessThan(enteredOccupiedPlain / 2);
    expect(enhanced.densityDiversions).toBeGreaterThan(0);
    enhanced.reset(0);
    expect(enhanced.activeCrossing(0)).toBe(0);
    expect(enhanced.trackOffset(0)).toBeUndefined();
  });

  it('keeps four companions in adjacent tracks even if the group leader enters later', () => {
    const nav = new Navigation(syntheticShibuya), flow = new CrosswalkFlow(nav, 4, 42);
    const slots = [-0.9, -0.3, 0.3, 0.9], direction = { x: 0, z: 0 };
    for (const i of [2, 1, 0, 3]) {
      expect(flow.guide(i, i + 1, -23, -27, 1, 0.27, direction, 0, slots[i])).toBe(true);
    }
    const offsets = slots.map((_, i) => flow.trackOffset(i)!);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i] - offsets[i - 1]).toBeGreaterThan(0.3);
      expect(offsets[i] - offsets[i - 1]).toBeLessThan(1.15);
    }
    for (let i = 0; i < slots.length; i++) flow.reset(i);
    const fresh = new CrosswalkFlow(nav, 4, 42);
    for (const f of [flow, fresh]) {
      expect(f.guide(0, 9, -23, -27, 1, 0.27, direction, 0, slots[0])).toBe(true);
    }
    expect(flow.trackOffset(0)).toBe(fresh.trackOffset(0));
  });
});
