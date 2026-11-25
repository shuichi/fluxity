import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../types';

it('admits a group arriving along one side of the forecourt storefront', () => {
  const target = shibuya.portals!.findIndex(portal => portal.id === 'forecourt-building');
  const door = shibuya.portals![target], count = 40;
  const sim = new Simulation({ ...DEFAULT_CONFIG, count, seed: 42, signalMode: 'green' }, undefined, {
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
