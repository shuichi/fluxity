import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { ForecourtFlow } from '../simulation/ForecourtFlow';
import { Navigation } from '../simulation/Navigation';
import type { Point2 } from '../types';

const nav = new Navigation(shibuya);
const sidewalk = nav.urban!.sidewalks;
const radius = 0.265;

function trip(start: Point2, destination: string, crowd: Point2[] = []) {
  const agents = new AgentData(1 + crowd.length), flow = new ForecourtFlow(nav, agents, 42);
  const target = shibuya.portals!.findIndex(p => p.id === destination);
  const goal = shibuya.targets[target];
  agents.targetId[0] = target;
  agents.targetX[0] = goal.x; agents.targetZ[0] = goal.z;
  agents.radius.fill(radius - 0.015); agents.preferredSpeed.fill(1.35);
  agents.current.x[0] = start.x; agents.current.z[0] = start.z;
  crowd.forEach((p, i) => {
    agents.current.x[i + 1] = p.x; agents.current.z[i + 1] = p.z; agents.current.vx[i + 1] = -1;
  });
  for (let i = 0; i < 12; i++) flow.update(0.25);
  const direction = { x: 0, z: 0 }, initial = { x: 0, z: 0 };
  let minZ = start.z;
  for (let i = 0; i < 1800; i++) {
    const x = agents.current.x[0], z = agents.current.z[0];
    if (Math.hypot(x - goal.x, z - goal.z) < 1) break;
    nav.direction(x, z, target, goal.x, goal.z, direction, radius);
    flow.guide(0, direction);
    if (!i) Object.assign(initial, direction);
    const nx = Math.fround(x + direction.x * 1.35 / 30), nz = Math.fround(z + direction.z * 1.35 / 30);
    expect(sidewalk.lineInside(x, z, nx, nz, radius)).toBe(true);
    agents.current.x[0] = nx; agents.current.z[0] = nz;
    minZ = Math.min(minZ, nz);
    flow.update(1 / 30);
  }
  expect(agents.targetId[0]).toBe(target);
  expect(Math.hypot(agents.current.x[0] - goal.x, agents.current.z[0] - goal.z)).toBeLessThan(1);
  return { minZ, initial };
}

it('moves inland earlier when the route along the north edge of the planting is crowded', () => {
  const crowd: Point2[] = [];
  for (let x = 21; x <= 27; x += 0.65) for (let z = 18; z <= 23; z += 0.65) {
    if (sidewalk.contains(x, z, radius)) crowd.push({ x, z });
  }
  const start = { x: 15, z: 15 };
  const empty = trip(start, 'shop-43');
  const busy = trip(start, 'shop-43', crowd.filter((_, i) => i % 2 === 0));
  expect(busy.initial.z).toBeGreaterThan(empty.initial.z + 0.12);
  expect(busy.initial.x).toBeLessThan(empty.initial.x - 0.15);
});

it('takes the open entrance when starting across the gap in the sidewalk from the plaza', () => {
  const start = { x: 5.5, z: 39 };
  expect(sidewalk.lineInside(start.x, start.z, 20, 39, radius)).toBe(false);
  expect(trip(start, 'forecourt-building').minZ).toBeLessThan(27);
});
