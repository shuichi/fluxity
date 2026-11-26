import { describe, expect, it } from 'vitest';
import { Random } from '../math/random';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { Navigation } from '../simulation/Navigation';
import { PortalFlow } from '../simulation/PortalFlow';
import { ShopDeadlockRecovery } from '../simulation/ShopDeadlockRecovery';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../types';

const portals = shibuya.portals!;
const shop = portals.findIndex(portal => portal.id === 'northwest-shop');
const door = portals[shop];
const navigation = new Navigation(shibuya);

function placeQueue(agents: AgentData) {
  const dx = door.approach.x - door.end.x, dz = door.approach.z - door.end.z;
  const length = Math.hypot(dx, dz), nx = dx / length, nz = dz / length;
  for (let id = 0; id < agents.count; id++) {
    // The queue begins outside portal capture range, with 90 cm between centers.
    const depth = 6.2 + Math.floor(id / 7) * 0.9, side = -5.5 + id % 7 * 0.9;
    agents.current.x[id] = door.end.x + nx * depth + nz * side;
    agents.current.z[id] = door.end.z + nz * depth - nx * side;
    agents.current.vx[id] = agents.current.vz[id] = 0;
    agents.current.heading[id] = Math.atan2(-nx, -nz);
    expect(navigation.isSpawnable(agents.current.x[id], agents.current.z[id], 0.32)).toBe(true);
  }
}

function queue(count = 8) {
  const agents = new AgentData(count);
  const flow = new PortalFlow(portals, navigation, agents, new Random(42));
  const recovery = new ShopDeadlockRecovery(agents, navigation, shop, flow.shopMouths(shop));
  agents.radius.fill(0.25);
  agents.scale.fill(1);
  agents.preferredSpeed.fill(1.35);
  for (let id = 0; id < count; id++) flow.assignTarget(id, shop);
  placeQueue(agents);
  let nextSecond = 0;
  function observeUntil(second: number, admissionsPerSecond = 0) {
    for (; nextSecond <= second; nextSecond++) recovery.update(nextSecond, nextSecond * admissionsPerSecond);
  }
  const orders = () => Array.from({ length: count }, (_, id) => recovery.order(id));
  return { agents, recovery, observeUntil, orders };
}

describe('northwest shop deadlock recovery', () => {
  it('coordinates a persistent queue and drops orders when a walker enters a passage or a slot is reused', () => {
    const { agents, recovery, observeUntil, orders } = queue(28);
    observeUntil(2);
    expect(orders().every(order => order === undefined)).toBe(true);
    observeUntil(15);
    const issued = orders();
    expect(issued).toContain('pass');
    expect(issued.some(order => order === 'wait' || order === 'aside')).toBe(true);

    const leader = issued.indexOf('pass');
    const follower = issued.findIndex(order => order === 'wait' || order === 'aside');
    agents.portalStage[leader] = 2;
    agents.generation[follower]++;
    expect(recovery.order(leader)).toBeUndefined();
    expect(recovery.order(follower)).toBeUndefined();
  });

  it('leaves a waiting group alone while other shoppers continue to enter', () => {
    const { observeUntil, orders } = queue();
    observeUntil(20, 1);
    expect(orders().every(order => order === undefined)).toBe(true);
  });

  it('allows a group to approach slowly at its configured walking speed before the first admission', () => {
    const { agents, recovery, observeUntil } = queue();
    const s = agents.current;
    agents.preferredSpeed.fill(0.05);
    observeUntil(0);
    for (let second = 1; second <= 12; second++) {
      for (let id = 0; id < agents.count; id++) {
        s.vx[id] = 0.05 * Math.sin(s.heading[id]);
        s.vz[id] = 0.05 * Math.cos(s.heading[id]);
        s.x[id] += s.vx[id];
        s.z[id] += s.vz[id];
      }
      observeUntil(second);
      expect(recovery.active).toBe(false);
    }
  });

  it('returns control to walkers if an intervention cannot get anyone through the entrance', () => {
    const { recovery, observeUntil, orders } = queue(28);
    observeUntil(8);
    expect(recovery.active).toBe(true);
    let time = 8;
    while (recovery.active && time < 40) observeUntil(++time);
    expect(recovery.active).toBe(false);
    expect(orders().every(order => order === undefined)).toBe(true);
    observeUntil(time + 3);
    expect(recovery.active).toBe(false);
  });

  it('holds a place for someone traversing the shop passage until that trip completes', () => {
    const { agents, observeUntil, recovery, orders } = queue(28);
    let time = 0;
    while (time < 30 && !orders().includes('pass')) observeUntil(++time);
    const admitted = orders(), entrant = admitted.indexOf('pass');
    expect(entrant).toBeGreaterThanOrEqual(0);
    expect(admitted).toContain('wait');
    const queued = admitted.flatMap((order, id) => order === 'pass' ? [] : [id]);

    agents.portalStage[entrant] = 2;
    recovery.update(++time, 0);
    expect(recovery.order(entrant)).toBeUndefined();
    expect(queued.some(id => recovery.order(id) === 'pass')).toBe(false);

    agents.generation[entrant]++;
    agents.targetId[entrant] = portals.findIndex(p => p.kind === 'street');
    agents.portalStage[entrant] = 0;
    recovery.update(++time, 1);
    expect(queued.some(id => recovery.order(id) === 'pass')).toBe(true);
  });

  it('does not coordinate bystanders bound for other destinations or walkers off the shop sidewalk', () => {
    const { agents, observeUntil, orders } = queue(10);
    const bystander = 8, roadway = 9;
    agents.targetId[bystander] = portals.findIndex(p => p.kind === 'street');
    // The real zebra is outside the 12 m observation radius. This road point
    // lies inside it, so only the sidewalk filter can exclude this walker.
    agents.current.x[roadway] = -30.5;
    agents.current.z[roadway] = -31.5;
    expect(Math.hypot(agents.current.x[roadway] - door.end.x, agents.current.z[roadway] - door.end.z)).toBeLessThan(12);
    expect(navigation.scramble!.isSidewalk(agents.current.x[roadway], agents.current.z[roadway])).toBe(false);
    observeUntil(8);
    const issued = orders();
    expect(issued).toContain('pass');
    expect(issued[bystander]).toBeUndefined();
    expect(issued[roadway]).toBeUndefined();
  });

  it('applies different walking intentions during the simulation step and releases the queue when disabled', () => {
    // Local avoidance cannot advance anyone. The desired velocities still show
    // which shoppers the simulation is asking to move and which should wait.
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 28, signalMode: 'green' }, {
      compute(_id, _agents, _grid, _direction, _settings, out) { out.x = out.z = 0; },
    }, { ...shibuya, spawnTargets: shibuya.spawnZones.map(() => shop) });
    const a = sim.agents;
    placeQueue(a);
    sim.setShopDeadlockRecovery(true);
    const waiting = () => a.preferredVX.filter((vx, id) => vx === 0 && a.preferredVZ[id] === 0).length;
    for (let step = 0; step < Math.round(2 / FIXED_DT); step++) sim.step();
    expect(waiting()).toBe(0);
    for (let step = 0; step < Math.round(10 / FIXED_DT); step++) sim.step();
    expect(waiting()).toBeGreaterThan(0);
    expect(waiting()).toBeLessThan(a.count);
    sim.setShopDeadlockRecovery(false);
    sim.step();
    expect(waiting()).toBe(0);
  });
});
