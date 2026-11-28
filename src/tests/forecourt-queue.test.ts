import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG } from '../types';

it('keeps the front row at each physical curb when the square behind it is available', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 24, signalMode: 'allRed', crowdPreset: 'none' });
  const a = sim.agents, tracks = sim['crosswalkFlow']!, queue = sim['forecourtQueue']!, traffic = sim['forecourt']!.traffic;
  for (let id = 0; id < a.count; id++) {
    const target = a.targetId[id] = id % 3;
    const route = tracks.plannedRoute(id, 16, 20, target), entrance = tracks.entrance(route);
    const curb = tracks.nearestLanding(route, entrance.x, entrance.z);
    a.current.x[id] = curb.x; a.current.z[id] = curb.z;
    expect(tracks.plannedRoute(id, curb.x, curb.z, target)).toBe(route);
    expect(Math.hypot(curb.x - entrance.x, curb.z - entrance.z)).toBeGreaterThan(4);
  }
  for (let sample = 0; sample < 12; sample++) traffic.update(a, 0.25);
  for (let id = 0; id < a.count; id++) {
    expect(traffic.cost(a.current.x[id], a.current.z[id], 0, 0)).toBeGreaterThan(0.55);
    expect(queue.guide(id, 24 - id, { x: 0, z: 0 })).toBe(false);
  }
});

it('keeps later arrivals on the square through red, counts them waiting and releases each to their chosen crossing', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 52, signalMode: 'allRed', crowdPreset: 'none' });
  const a = sim.agents, urban = sim.navigation.urban!, queue = sim['forecourtQueue']!, tracks = sim['crosswalkFlow']!;
  // Three different journeys start behind the Hachikō curb. None finishes at the station.
  const targets = ['northwest-shop', 'north-shop', 'east-shop'].map(key => shibuya.portals!.findIndex(p => p.id === key));
  for (let id = 0; id < a.count; id++) {
    const target = targets[id % targets.length], goal = shibuya.targets[target];
    a.targetId[id] = target; a.targetX[id] = goal.x; a.targetZ[id] = goal.z;
    a.current.x[id] = 15 + (id % 8) * 0.72; a.current.z[id] = 19 + Math.floor(id / 8) * 0.72;
    a.current.vx[id] = a.current.vz[id] = 0;
  }
  const settledSteps = new Uint16Array(a.count), turn = new Float32Array(a.count);
  let largestTurn = 0;
  for (let step = 0; step < 600; step++) {
    const previousHeading = a.current.heading;
    sim.step();
    expect(sim.signal!.crossing).toBe(0);
    for (let id = 0; id < a.count; id++) {
      if (!queue.settled[id]) {
        settledSteps[id] = 0; turn[id] = 0;
        continue;
      }
      // Allow one second to finish braking. Neighbors should not turn a waiting body around.
      if (++settledSteps[id] <= 30) continue;
      turn[id] += Math.abs(a.current.heading[id] - previousHeading[id]);
      largestTurn = Math.max(largestTurn, turn[id]);
    }
  }
  expect(largestTurn).toBeLessThan(Math.PI / 2);
  const routes = queue.route.slice(), settled = queue.settled.reduce((sum, value) => sum + value, 0);
  expect(settled).toBeGreaterThan(12);
  expect(sim.signal!.waiting).toBeGreaterThan(settled); // Both the curbside front row and the overflow.
  expect(new Set(routes).size).toBe(4); // Unassigned front row plus three outgoing crossings.
  for (let id = 0; id < a.count; id++) {
    if (!queue.settled[id]) continue;
    const x = a.current.x[id], z = a.current.z[id], curb = tracks.nearestLanding(routes[id], x, z);
    expect(Math.hypot(x - curb.x, z - curb.z)).toBeLessThanOrEqual(14.8); // Includes sway at the waiting spot.
  }
  sim.updateSettings({ signalMode: 'pedestrian' });
  const departed = new Set<number>(), assigned = routes.filter(Boolean).length;
  for (let step = 0; step < 1500 && departed.size < assigned; step++) {
    sim.step();
    for (let id = 0; id < a.count; id++) {
      if (!routes[id] || departed.has(id) || urban.isSidewalk(a.current.x[id], a.current.z[id], a.radius[id] + 0.015)) continue;
      expect(sim.signal!.pedestrian).toBe('green');
      expect(tracks.activeCrossing(id)).toBe(routes[id]);
      expect(a.targetId[id]).toBe(targets[id % targets.length]);
      departed.add(id);
    }
  }
  expect(departed.size).toBe(assigned);
  expect(queue.route.some(Boolean)).toBe(false);
});
