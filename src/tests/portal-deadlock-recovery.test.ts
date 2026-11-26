import { describe, expect, it } from 'vitest';
import { Random } from '../math/random';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { Navigation } from '../simulation/Navigation';
import { PortalFlow } from '../simulation/PortalFlow';
import { PortalDeadlockRecovery } from '../simulation/PortalDeadlockRecovery';
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
  const recovery = new PortalDeadlockRecovery(agents, navigation, shop, flow);
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

describe('portal deadlock recovery', () => {
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

  it('watches independent queues at a renamed storefront and a street end from their public approaches', () => {
    const store = portals.findIndex(p => p.id === 'southwest-shop');
    const street = portals.findIndex(p => p.kind === 'street');
    const scene = { ...shibuya, portals: portals.map((p, i) => ({ ...p, id: `gate-${i}` })),
      spawnZones: shibuya.spawnZones.slice(0, 2), spawnTargets: [store, street] };
    // Stop local movement long enough to detect both queues in one simulation.
    let advance = false;
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 16 }, {
      compute(id, agents, _grid, direction, _settings, out) {
        const speed = advance ? agents.preferredSpeed[id] : 0;
        out.x = direction.x * speed; out.z = direction.z * speed;
      },
    }, scene);
    sim.setPortalDeadlockRecovery(true);
    const a = sim.agents;
    a.current.vx.fill(0); a.current.vz.fill(0);
    for (let id = 0; id < a.count; id++) {
      const index = Math.floor(id / 2), gate = a.targetId[id];
      if (gate === store) {
        a.current.x[id] = scene.portals[store].approach.x + 3 + index % 2;
        a.current.z[id] = scene.portals[store].approach.z - 2 + Math.floor(index / 2);
      } else {
        expect(gate).toBe(street);
        a.current.x[id] = scene.portals[street].approach.x - index % 2;
        a.current.z[id] = scene.portals[street].approach.z + 6 + Math.floor(index / 2);
        expect(Math.hypot(a.current.x[id] - scene.portals[street].end.x,
          a.current.z[id] - scene.portals[street].end.z)).toBeGreaterThan(12);
      }
      expect(sim.navigation.isSpawnable(a.current.x[id], a.current.z[id], 0.32)).toBe(true);
    }
    const active = () => scene.portals.flatMap((_, i) => sim.isPortalDeadlockActive(i) ? [i] : []);
    for (let i = 0; i < 8 / FIXED_DT; i++) sim.step();
    expect(active()).toEqual([store, street]);

    for (let id = 0; id < a.count; id++) if (a.targetId[id] === store) a.preferredSpeed[id] = 0;
    for (let i = 0; i < 2 / FIXED_DT; i++) sim.step();
    expect(active()).toEqual([street]);

    advance = true;
    for (let i = 0; i < 30 / FIXED_DT && !sim.completedPortalTrips(street); i++) sim.step();
    expect(sim.completedPortalTrips(street)).toBeGreaterThan(0);
    expect(sim.completedPortalTrips(store)).toBe(0);
    // An arrival here is the original trip crossing the mapped street end outside the city bounds.
    const exited = Array.from(a.generation.keys()).filter(id => a.generation[id] > 0);
    expect(exited).toHaveLength(sim.completedPortalTrips(street));
    for (const id of exited) expect(a.next.z[id]).toBeCloseTo(scene.portals[street].end.z, 1);
  });

  it('guides walkers to their assigned departures and holds a place through a long exit-only street passage', () => {
    const street = portals.findIndex(p => p.kind === 'street');
    const gates = portals.map((p, i) => i === street ? { ...p, entry: false, end: { ...p.end, z: p.end.z - 12 } } : p);
    const nav = new Navigation({ ...shibuya, portals: gates });
    const a = new AgentData(12), flow = new PortalFlow(gates, nav, a, new Random(42));
    const recovery = new PortalDeadlockRecovery(a, nav, street, flow);
    expect(flow.emergenceMouths(street)).toHaveLength(0);
    a.preferredSpeed.fill(1.35); a.radius.fill(0.25);
    const start = gates[street].approach;
    for (let id = 0; id < a.count; id++) {
      flow.assignTarget(id, street);
      a.current.x[id] = start.x - (id % 2);
      a.current.z[id] = start.z + 4 + Math.floor(id / 2);
      expect(nav.isSpawnable(a.current.x[id], a.current.z[id], 0.32)).toBe(true);
    }
    for (let second = 0; second <= 8; second++) recovery.update(second, 0);
    const passing = Array.from(a.id.keys()).filter(id => recovery.order(id) === 'pass');
    expect(passing.length).toBeGreaterThan(0);
    expect(new Set(passing.map(id => a.targetX[id])).size).toBeGreaterThan(1);
    for (const id of passing) {
      const x = a.current.x[id], z = a.current.z[id];
      const dx = a.targetX[id] - x, dz = a.targetZ[id] - z, length = Math.hypot(dx, dz);
      expect(nav.urban!.sidewalks.lineInside(x, z, a.targetX[id], a.targetZ[id], a.radius[id] + 0.015)).toBe(true);
      const direction = { x: 0, z: 0 };
      recovery.guide(id, direction);
      expect(direction.x).toBeCloseTo(dx / length, 5);
      expect(direction.z).toBeCloseTo(dz / length, 5);
    }

    // Someone beyond the observed sidewalk is still using the lane until their trip ends.
    const waiting = Array.from(a.id.keys()).find(id => recovery.order(id) !== 'pass')!;
    const entrant = passing.find(id => a.targetX[id] === a.targetX[waiting])!;
    expect(entrant).toBeDefined();
    a.portalStage[entrant] = 2;
    a.current.z[entrant] = start.z - 14;
    recovery.update(9, 0);
    expect(recovery.order(waiting)).not.toBe('pass');
    a.generation[entrant]++;
    a.targetId[entrant] = shop;
    recovery.update(10, 1);
    expect(recovery.order(waiting)).toBe('pass');
  });

  it('meters newcomers to a blocked street while the people already in the queue can advance', () => {
    const street = portals.findIndex(p => p.kind === 'street'), start = portals[street].approach;
    const a = new AgentData(18), flow = new PortalFlow(portals, navigation, a, new Random(42));
    const recovery = new PortalDeadlockRecovery(a, navigation, street, flow), newcomer = a.count - 1;
    a.preferredSpeed.fill(1.35); a.radius.fill(0.25);
    for (let id = 0; id < a.count; id++) {
      flow.assignTarget(id, street);
      a.current.x[id] = start.x - (id % 2);
      a.current.z[id] = start.z + (id === newcomer ? 14 : 4 + 0.8 * Math.floor(id / 2));
      expect(navigation.isSpawnable(a.current.x[id], a.current.z[id], 0.32)).toBe(true);
    }
    for (let second = 0; second <= 8; second++) recovery.update(second, 0);
    expect(recovery.active).toBe(true);
    const originalOrders = Array.from({ length: newcomer }, (_, id) => recovery.order(id));
    expect(originalOrders).toContain('pass');
    expect(originalOrders).toContain(undefined);
    expect(originalOrders).not.toContain('wait');

    a.current.z[newcomer] = start.z + 9;
    recovery.update(9, 0);
    expect(recovery.order(newcomer)).toBe('wait');
    const direction = { x: 0, z: -1 };
    recovery.guide(newcomer, direction);
    expect(direction).toEqual({ x: 0, z: 0 });
    expect(flow.inPassage(newcomer)).toBe(false);
  });

  it('applies different walking intentions during the simulation step and releases the queue when disabled', () => {
    // Local avoidance cannot advance anyone. The desired velocities still show
    // which shoppers the simulation is asking to move and which should wait.
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 28, signalMode: 'green' }, {
      compute(_id, _agents, _grid, _direction, _settings, out) { out.x = out.z = 0; },
    }, { ...shibuya, spawnTargets: shibuya.spawnZones.map(() => shop) });
    const a = sim.agents;
    placeQueue(a);
    sim.setPortalDeadlockRecovery(true);
    const waiting = () => a.preferredVX.filter((vx, id) => vx === 0 && a.preferredVZ[id] === 0).length;
    for (let step = 0; step < Math.round(2 / FIXED_DT); step++) sim.step();
    expect(waiting()).toBe(0);
    for (let step = 0; step < Math.round(10 / FIXED_DT); step++) sim.step();
    expect(waiting()).toBeGreaterThan(0);
    expect(waiting()).toBeLessThan(a.count);
    sim.setPortalDeadlockRecovery(false);
    sim.step();
    expect(waiting()).toBe(0);
  });
});
