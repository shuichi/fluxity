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
  return new Simulation({ ...DEFAULT_CONFIG, count: 64, signalMode: 'pedestrian' }, {
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
  sim.updateSettings({ signalMode: 'allRed' });
  for (let step = 0; step < 750 && sim.signal!.crossing > 0; step++) sim.step();
  expect(sim.signal!.crossing).toBe(0);
  // Reuse the slots for a single controlled approach from the other end. A stale
  // counter for the first group would reserve half the width for an empty flow.
  lineUp(sim, () => false);
  sim.updateSettings({ signalMode: 'pedestrian' });
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

it.each([
  { count: 1, turnRed: false }, { count: 11, turnRed: false }, { count: 11, turnRed: true },
])('keeps the north zebra track or rejoins after passing (count=$count, red=$turnRed)', ({ count, turnRed }) => {
  // These starting positions reproduce a particular baseline encounter at the paint edge.
  const sim = new Simulation({ ...DEFAULT_CONFIG, count, seed: 0, signalMode: 'pedestrian',
    crowdModel: 'baseline', crowdPreset: 'none' }, undefined,
    { ...shibuya, portals: undefined });
  const a = sim.agents, radius = 0.25, clearance = radius + 0.015;
  // One eastbound walker on the outside track; two staggered, body-clear
  // files immediately to their side are approaching from the east.
  for (let i = 0; i < count; i++) {
    const along = length / 2 + (i === 0 ? 0 : ((i - 1) % 5 - 1) * 0.55 + 0.275);
    const across = -(mark.width / 2 - 0.28) + (i === 0 ? 0 : 0.45 + Math.floor((i - 1) / 5) * 0.55);
    a.current.x[i] = mark.from.x + along * ux + across * uz;
    a.current.z[i] = mark.from.z + along * uz - across * ux;
    const sign = i === 0 ? 1 : -1;
    a.current.vx[i] = ux * 1.3 * sign; a.current.vz[i] = uz * 1.3 * sign;
    a.radius[i] = radius; a.preferredSpeed[i] = 1.35;
    const target = i === 0 ? 2 : 1;
    a.targetId[i] = target;
    a.targetX[i] = shibuya.targets[target].x; a.targetZ[i] = shibuya.targets[target].z;
  }
  const geometry = sim.navigation.urban!;
  let maxOutside = -Infinity, leftPaint = -1, rejoined = -1, landed = false;
  for (let tick = 0; tick < (turnRed ? 360 : 120); tick++) {
    const oldX = a.current.x[0], oldZ = a.current.z[0];
    if (turnRed && tick === 20) {
      expect(leftPaint).toBeGreaterThanOrEqual(0);
      expect(geometry.isWalkable(oldX, oldZ)).toBe(false);
      sim.updateSettings({ signalMode: 'allRed' });
    }
    sim.step();
    const x = a.current.x[0], z = a.current.z[0];
    const outside = Math.abs((x - mark.from.x) * uz - (z - mark.from.z) * ux) - mark.width / 2;
    maxOutside = Math.max(maxOutside, outside);
    expect(geometry.crossingLine(oldX, oldZ, x, z, clearance)).toBe(true);
    if (outside > 0 && leftPaint < 0) leftPaint = tick;
    if (leftPaint >= 0 && rejoined < 0 && geometry.isWalkable(x, z, clearance)) rejoined = tick;
    if (turnRed && geometry.isSidewalk(x, z, clearance)) {
      // This near-edge point on the skewed north crossing is closer to its west bank.
      expect((x - mark.from.x) * ux + (z - mark.from.z) * uz).toBeLessThan(length / 2);
      landed = true;
      break;
    }
  }
  if (count === 1) expect(maxOutside + clearance).toBeLessThan(0);
  else {
    expect(maxOutside).toBeGreaterThan(0.1);
    expect(maxOutside + clearance).toBeLessThanOrEqual(0.8);
    expect(rejoined).toBeGreaterThan(leftPaint);
    expect(rejoined - leftPaint).toBeLessThan(60);
  }
  expect(geometry.isWalkable(a.current.x[0], a.current.z[0], clearance)).toBe(true);
  if (turnRed) expect(landed).toBe(true);
});

it('keeps all five carriageway margins out of the trip graph and clips the full body on both edges', () => {
  const nav = new Navigation(shibuya), urban = nav.urban!, radius = 0.265;
  for (const crossing of shibuya.scramble!.crosswalks) {
    const dx = crossing.to.x - crossing.from.x, dz = crossing.to.z - crossing.from.z;
    const distance = Math.hypot(dx, dz), centerX = crossing.from.x + dx / 2, centerZ = crossing.from.z + dz / 2;
    for (const sign of [-1, 1]) {
      const nx = sign * dz / distance, nz = -sign * dx / distance;
      const at = (outside: number) => ({
        x: centerX + (crossing.width / 2 + outside) * nx,
        z: centerZ + (crossing.width / 2 + outside) * nz,
      });
      const start = at(-0.35), pass = at(0.45), far = at(2), result = { ...start };
      expect(nav.lineOfSight(start.x, start.z, pass.x, pass.z, radius)).toBe(false);
      expect(urban.crossingLine(start.x, start.z, pass.x, pass.z, radius)).toBe(true);
      expect(urban.crossingLine(start.x, start.z, far.x, far.z, radius)).toBe(false);
      urban.constrain(start.x, start.z, far.x, far.z, radius, false, result, true);
      const outside = (result.x - centerX) * nx + (result.z - centerZ) * nz - crossing.width / 2;
      expect(outside + radius).toBeCloseTo(0.8, 3);
    }
  }
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
  const x = 22, z = 12, radius = 0.27, direction = { x: 0, z: 0 };
  expect(nav.urban!.isSidewalk(x, z, radius)).toBe(false);
  expect(nav.urban!.occupiesCrossing(x, z, radius)).toBe(true);
  // This point is on the east zebra. The southwest shop's trip will later
  // use the south zebra, while the east shop's trip can already use this one.
  const southwest = shibuya.portals!.findIndex(p => p.id === 'southwest-shop');
  const east = shibuya.portals!.findIndex(p => p.id === 'east-shop');
  expect(flow.plannedRoute(0, x, z, southwest)).toBe(-2);
  expect(flow.guide(0, 0, x, z, southwest, radius, direction)).toBe(false);
  expect(flow.guide(0, 0, x, z, east, radius, direction)).toBe(true);
  expect(flow.activeCrossing(0)).toBe(-3);
});
