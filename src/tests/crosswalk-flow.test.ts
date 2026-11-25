import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { CrosswalkFlow } from '../simulation/CrosswalkFlow';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG } from '../types';

const mark = shibuya.scramble!.crosswalks[3];
const length = Math.hypot(mark.to.x - mark.from.x, mark.to.z - mark.from.z);
const ux = (mark.to.x - mark.from.x) / length, uz = (mark.to.z - mark.from.z) / length;
type StartsAtEast = (id: number) => boolean;

function cohort() {
  // Remove neighbor steering so crowd pressure cannot produce a false pass
  // by pushing people sideways from identical positions.
  return new Simulation({ ...DEFAULT_CONFIG, count: 64, signalMode: 'green' }, {
    compute(id, agents, _grid, dir, _settings, out, pace = 1) {
      out.x = dir.x * agents.preferredSpeed[id] * pace;
      out.z = dir.z * agents.preferredSpeed[id] * pace;
    },
  }, { ...shibuya, portals: undefined });
}

function lineUp(sim: Simulation, startsAtEast: StartsAtEast) {
  const a = sim.agents;
  for (let i = 0; i < a.count; i++) {
    const along = startsAtEast(i) ? length - 3 : 5;
    a.current.x[i] = mark.from.x + along * ux; a.current.z[i] = mark.from.z + along * uz;
    a.current.vx[i] = a.current.vz[i] = 0;
    const target = startsAtEast(i) ? 1 : 2; // North shop ↔ east shop
    a.targetId[i] = target;
    a.targetX[i] = shibuya.targets[target].x; a.targetZ[i] = shibuya.targets[target].z;
    expect(sim.navigation.scramble!.isSidewalk(a.current.x[i], a.current.z[i], a.radius[i])).toBe(true);
  }
}

function midsection(sim: Simulation, startsAtEast: StartsAtEast) {
  const a = sim.agents, positions: number[][] = [[], []], crossed = new Set<number>();
  for (let step = 0; step < 600 && crossed.size < a.count; step++) {
    sim.step();
    for (let i = 0; i < a.count; i++) {
      if (crossed.has(i)) continue;
      const x = a.current.x[i] - mark.from.x, z = a.current.z[i] - mark.from.z;
      const progress = x * ux + z * uz - length / 2;
      if ((startsAtEast(i) ? -progress : progress) < 0) continue;
      expect(sim.navigation.isFree(a.current.x[i], a.current.z[i], a.radius[i])).toBe(true);
      positions[Number(startsAtEast(i))].push(0.5 + (x * uz - z * ux) / mark.width);
      crossed.add(i);
    }
  }
  expect(crossed.size).toBe(a.count);
  return positions;
}

it('spreads fixed trips over the north zebra and favors opposite sides for opposing flows', () => {
  const sim = cohort(), startsAtEast = (id: number) => id % 2 === 1;
  lineUp(sim, startsAtEast);
  const positions = midsection(sim, startsAtEast);
  const bins = new Set(positions.flat().map(x => Math.floor(x * 5)));
  expect([...bins].sort()).toEqual([0, 1, 2, 3, 4]);
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  expect(mean(positions[0]) - mean(positions[1])).toBeGreaterThan(0.25);
});

it('uses both edges for one-way traffic after a red phase clears the preceding opposite flow', () => {
  const sim = cohort();
  lineUp(sim, () => true);
  for (let step = 0; step < 180; step++) sim.step();
  expect(sim.signal!.crossing).toBe(sim.agents.count);
  sim.updateSettings({ signalMode: 'red' });
  for (let step = 0; step < 750 && sim.signal!.crossing > 0; step++) sim.step();
  expect(sim.signal!.crossing).toBe(0);
  // Reuse the slots for a single controlled approach from the other end. A stale
  // counter for the first group would reserve half the width for an empty flow.
  lineUp(sim, () => false);
  sim.updateSettings({ signalMode: 'green' });
  const [positions] = midsection(sim, () => false);
  expect(positions.filter(x => x < 0.2).length).toBeGreaterThan(3);
  expect(positions.filter(x => x > 0.8).length).toBeGreaterThan(3);
});

it('skips degenerate or narrower-than-body markings and leaves the ordinary trip direction available', () => {
  const nav = new Navigation({ ...shibuya, scramble: { ...shibuya.scramble!, crosswalks: [
    { ...mark, to: mark.from }, { ...mark, width: 0.4 },
  ] } });
  const flow = new CrosswalkFlow(nav, 1, 42), out = { x: 0.7, z: 0.3 };
  expect(flow.guide(0, 0, mark.from.x + 5 * ux, mark.from.z + 5 * uz, 2, 0.27, out)).toBe(false);
  expect(out).toEqual({ x: 0.7, z: 0.3 });
});

it('approaches the diagonal on the forecourt sidewalk without stepping onto the adjacent south zebra', () => {
  const nav = new Navigation(shibuya), flow = new CrosswalkFlow(nav, 1, 42);
  const x = 9, z = 23, radius = 0.27, direction = { x: 0, z: 0 };
  const northShop = shibuya.portals!.findIndex(p => p.id === 'north-shop');
  expect(nav.urban!.isSidewalk(x, z, radius)).toBe(true);
  expect(flow.guide(0, 0, x, z, northShop, radius, direction)).toBe(true);
  // The first 1.5 m towards this crossing are still on the forecourt.
  expect(nav.urban!.sidewalks.lineInside(x, z, x + 1.5 * direction.x, z + 1.5 * direction.z, radius)).toBe(true);
});

it('waits to select the next track while the walker is on a different zebra', () => {
  const nav = new Navigation(shibuya), flow = new CrosswalkFlow(nav, 1, 42);
  const x = 22.3, z = 16.33, radius = 0.27, direction = { x: 0, z: 0 };
  expect(nav.urban!.isSidewalk(x, z, radius)).toBe(false);
  // This point is on the east zebra. The southwest shop's trip will later
  // use the south zebra, while the east shop's trip can already use this one.
  const southwest = shibuya.portals!.findIndex(p => p.id === 'southwest-shop');
  const east = shibuya.portals!.findIndex(p => p.id === 'east-shop');
  expect(flow.guide(0, 0, x, z, southwest, radius, direction)).toBe(false);
  expect(flow.guide(0, 0, x, z, east, radius, direction)).toBe(true);
});
