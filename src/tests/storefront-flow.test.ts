import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../types';

it('lets a shopper approach a door beside another storefront while through traffic still gives it room', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1, seed: 467, signalMode: 'green' }, undefined, shibuya);
  const portals = shibuya.portals!, target = portals.findIndex(p => p.id === 'shop-39');
  const door = portals[target], flow = sim['portals']!;
  flow.assignTarget(0, target);
  const mouth = flow.assignedArrivalMouth(0);
  const dx = door.end.x - door.approach.x, dz = door.end.z - door.approach.z;
  const length = Math.hypot(dx, dz), ux = dx / length, uz = dz / length;
  sim.agents.current.x[0] = mouth.x - 1.65 * ux;
  sim.agents.current.z[0] = mouth.z - 1.65 * uz;
  const towardDoor = { x: ux, z: uz };
  flow.guideSidewalk(0, towardDoor);
  expect(towardDoor).toEqual({ x: ux, z: uz });

  // A shopper approaching from the side can still walk around a neighboring
  // entrance when the detour brings them closer to their own lane.
  const sideX = mouth.x - 1.65 * ux - 3 * uz, sideZ = mouth.z - 1.65 * uz + 3 * ux;
  sim.agents.current.x[0] = sideX;
  sim.agents.current.z[0] = sideZ;
  const distance = Math.hypot(mouth.x - sideX, mouth.z - sideZ);
  const direct = { x: (mouth.x - sideX) / distance, z: (mouth.z - sideZ) / distance };
  const detour = { ...direct };
  flow.guideSidewalk(0, detour);
  expect(Math.hypot(detour.x - direct.x, detour.z - direct.z)).toBeGreaterThan(0.1);
  expect(Math.hypot(mouth.x - sideX - 0.8 * detour.x, mouth.z - sideZ - 0.8 * detour.z)).toBeLessThan(distance);

  // From the same spot, a traveler passing along the facade can move away from it.
  sim.agents.current.x[0] = mouth.x - 1.65 * ux;
  sim.agents.current.z[0] = mouth.z - 1.65 * uz;
  flow.assignTarget(0, portals.findIndex(p => p.id === 'north-street'));
  const alongFacade = { x: uz, z: -ux };
  flow.guideSidewalk(0, alongFacade);
  expect(alongFacade.x * ux + alongFacade.z * uz).toBeLessThan(0);
});

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
