import { describe, expect, it } from 'vitest';
import { FIXED_DT, type Scenario } from '../types';
import { AgentData } from '../simulation/AgentData';
import { Navigation } from '../simulation/Navigation';
import { PedestrianAttention } from '../simulation/PedestrianAttention';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';

const fork: Scenario = {
  id: 'plaza', name: 'Two paths around a planter', description: '',
  bounds: { minX: -30, maxX: 30, minZ: -20, maxZ: 20 },
  obstacles: [{ x: 0, z: 0, width: 2, depth: 7, height: 2, kind: 'planter' }],
  spawnZones: [{ x: -14, z: 0, width: 5, depth: 3 }], targets: [{ x: 25, z: 0 }],
};

describe('contextual pedestrian attention', () => {
  it('recognizes two competitive paths to one goal and rejects an open or one-sided approach', () => {
    const nav = new Navigation(fork), look = { x: 0, z: 0 };
    expect(nav.alternativeAtFork(-8, 0, 0, 1, 0.7, look)).toBe(true);
    expect(look.z).toBeLessThan(0);
    expect(nav.alternativeAtFork(-8, 9, 0, 1, 0, look)).toBe(false);
    expect(new Navigation({ ...fork, obstacles: [] }).alternativeAtFork(-8, 0, 0, 1, 0, look)).toBe(false);
  });

  it('makes one personal decision at a fork and recovers speed within the dwell time', () => {
    const a = new AgentData(90), attention = new PedestrianAttention(333, a, new Navigation(fork));
    a.current.x.fill(-8); a.current.vx.fill(1);
    let peak = 0, firstCount = 0;
    for (let step = 0; step < 180; step++) {
      let slowing = 0;
      for (let i = 0; i < a.count; i++) {
        const pace = attention.update(i, FIXED_DT, false, 1, 0.7, true);
        if (pace < 1) slowing++;
        if (step > 90) expect(pace).toBe(1);
      }
      peak = Math.max(peak, slowing);
      if (step === 90) firstCount = attention.counts.hesitationStarts;
    }
    expect(firstCount).toBeGreaterThan(0);
    expect(firstCount).toBeLessThan(a.count);
    expect(attention.counts.hesitationStarts).toBe(firstCount);
    expect(peak).toBeLessThan(a.count);
  });

  it('staggers looks over a red wait, reproduces each life, and keeps the body stationary', () => {
    const a = new AgentData(75), nav = new Navigation(syntheticShibuya);
    const attention = new PedestrianAttention(14, a, nav);
    a.current.x.fill(-23); a.current.z.fill(-19); a.current.heading.fill(0.55);
    const run = (generation: number) => {
      const firstTurn = new Int16Array(a.count).fill(-1);
      for (let i = 0; i < a.count; i++) attention.reset(i, generation);
      for (let step = 0; step < 210; step++) for (let i = 0; i < a.count; i++) {
        const oldYaw = attention.headYaw[i];
        const pace = attention.update(i, FIXED_DT, true, 0, 1, false);
        if (pace !== 1 || Math.abs(attention.headYaw[i] - oldYaw) > 0.094) throw new Error('Invalid curb-wait pose');
        if (firstTurn[i] < 0 && Math.abs(attention.headYaw[i]) > 0.01) firstTurn[i] = step;
      }
      return firstTurn;
    };
    const first = run(0), repeat = run(0), next = run(1);
    expect(repeat).toEqual(first); expect(next).not.toEqual(first);
    expect(first).toContain(-1);
    expect(new Set(first).size).toBeGreaterThan(8);
    expect(a.current.heading[0]).toBeCloseTo(0.55);
    expect(a.current.vx.every(v => v === 0)).toBe(true);
  });

  it('looks toward a committed passing gap on the first step, then settles through a portal', () => {
    const a = new AgentData(40), attention = new PedestrianAttention(28, a, new Navigation(fork));
    let looked = 0;
    for (let i = 0; i < a.count; i++) {
      const side = i % 2 ? 1 : -1;
      const pace = attention.update(i, FIXED_DT, false, 0, 1, true, (i + 1) % a.count, side);
      expect(pace).toBe(1);
      if (attention.headYaw[i]) { expect(Math.sign(attention.headYaw[i])).toBe(side); looked++; }
      for (let step = 0; step < 60; step++) attention.settle(i, FIXED_DT);
      expect(attention.headYaw[i]).toBe(0);
    }
    expect(looked).toBeGreaterThan(0); expect(looked).toBeLessThan(a.count);
  });
});
