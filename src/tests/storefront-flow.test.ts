import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../types';

it.each([
  ['shop-39', 1.65],
  ['west-street-south', 5],
  ['south-street-west', 5],
] as const)('walks past empty neighboring doors and completes a trip to %s', (portalId, setback) => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1, seed: 467, signalMode: 'pedestrian' }, undefined, shibuya);
  const target = shibuya.portals!.findIndex(p => p.id === portalId);
  const door = shibuya.portals![target], flow = sim['portals']!;
  flow.assignTarget(0, target);
  const mouth = flow.assignedArrivalMouth(0);
  const dx = door.end.x - door.approach.x, dz = door.end.z - door.approach.z;
  const length = Math.hypot(dx, dz), ux = dx / length, uz = dz / length;
  const state = sim.agents.current;
  state.x[0] = mouth.x - setback * ux;
  state.z[0] = mouth.z - setback * uz;
  state.vx[0] = state.vz[0] = 0;
  state.heading[0] = Math.atan2(ux, uz);
  expect(sim.navigation.urban!.sidewalks.lineInside(state.x[0], state.z[0], mouth.x, mouth.z, 0.30)).toBe(true);
  for (let step = 0; step < 15 / FIXED_DT && !sim.completedPortalTrips(target); step++) sim.step();
  expect(sim.completedPortalTrips(target)).toBe(1);
});

it('admits a group arriving along one side of the forecourt storefront', () => {
  const target = shibuya.portals!.findIndex(portal => portal.id === 'forecourt-building');
  const door = shibuya.portals![target], count = 40;
  const sim = new Simulation({ ...DEFAULT_CONFIG, count, seed: 42, signalMode: 'pedestrian' }, undefined, {
    ...shibuya, spawnTargets: shibuya.spawnZones.map(() => target),
  });
  const a = sim.agents, length = Math.hypot(door.end.x - door.approach.x, door.end.z - door.approach.z);
  const ux = (door.end.x - door.approach.x) / length, uz = (door.end.z - door.approach.z) / length;
  // A shoulder-clear group approaches along the facade. Each person's door
  // lane is the one selected by the normal seeded trip initialization.
  let placed = 0;
  for (let depth = 3; depth <= 8 && placed < count; depth += 0.95) {
    for (let side = 0; side <= 25 && placed < count; side += 0.95) {
      const x = door.end.x - depth * ux + side * uz, z = door.end.z - depth * uz - side * ux;
      if (!sim.navigation.isSpawnable(x, z, 0.37)) continue;
      a.current.x[placed] = x; a.current.z[placed] = z;
      a.current.vx[placed] = a.current.vz[placed] = 0;
      placed++;
    }
  }
  expect(placed).toBe(count);
  for (let step = 0; step < Math.round(60 / FIXED_DT); step++) sim.step();
  // Each original walker must reach the interior before their slot is reused.
  // Counting generations excludes repeat visits by the few already admitted.
  expect(a.generation.filter(life => life > 0).length).toBeGreaterThanOrEqual(30);
});

it('lets opposing rows pass each other on the north sidewalk while keeping bodies clear', () => {
  const perDirection = 16, count = 2 * perDirection;
  const sim = new Simulation({ ...DEFAULT_CONFIG, count, seed: 42, signalMode: 'pedestrian' }, undefined, shibuya);
  const a = sim.agents, portals = shibuya.portals!;
  const northExit = portals.findIndex(p => p.id === 'north-street-west');
  const eastExit = portals.findIndex(p => p.id === 'east-street-south');
  // Two four-abreast groups meet on the public sidewalk, far from their street exits.
  const midX = 12.24, midZ = -64;
  const angle = Math.atan2(-0.219, 0.976), ux = Math.sin(angle), uz = Math.cos(angle);
  for (let id = 0; id < count; id++) {
    const sign = id < perDirection ? 1 : -1, index = id % perDirection;
    const depth = -sign * (1.7 + Math.floor(index / 4) * 0.84), side = (index % 4 - 1.5) * 0.86;
    const x = midX + ux * depth + uz * side, z = midZ + uz * depth - ux * side;
    expect(sim.navigation.isSpawnable(x, z, a.radius[id] + 0.015)).toBe(true);
    a.current.x[id] = x; a.current.z[id] = z;
    a.current.vx[id] = ux * sign; a.current.vz[id] = uz * sign;
    a.current.heading[id] = Math.atan2(ux * sign, uz * sign);
    sim['portals']!.assignTarget(id, sign > 0 ? eastExit : northExit);
  }
  const passed = new Set<number>();
  let minimumBodyGap = Infinity;
  for (let step = 0; step < 30 / FIXED_DT && passed.size < count; step++) {
    sim.step();
    for (let id = 0; id < count; id++) {
      const x = a.current.x[id], z = a.current.z[id];
      const along = (x - midX) * ux + (z - midZ) * uz;
      if ((id < perDirection ? along : -along) > 3) passed.add(id);
      // Measure body clearance across the full 12 m stretch where the groups meet.
      if (Math.abs(along) > 6) continue;
      for (let peer = 0; peer < id; peer++) {
        const gap = Math.hypot(x - a.current.x[peer], z - a.current.z[peer]) - a.radius[id] - a.radius[peer];
        minimumBodyGap = Math.min(minimumBodyGap, gap);
      }
    }
  }
  expect(minimumBodyGap).toBeGreaterThan(-0.001);
  expect([...passed].filter(id => id < perDirection).length).toBe(perDirection);
  expect([...passed].filter(id => id >= perDirection).length).toBe(perDirection);
});
