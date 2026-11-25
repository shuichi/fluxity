import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type PedestrianPortal, type Scenario } from '../types';
import { Simulation } from '../simulation/Simulation';
import { doorwayRadius } from '../simulation/DoorwayClearance';
import { Steering, type LocalAvoidance } from '../simulation/Steering';

const door: PedestrianPortal = {
  id: 'shop', kind: 'door', approach: { x: 6, z: 0 }, end: { x: 10, z: 0 }, width: 0.9,
};
const street: PedestrianPortal = {
  id: 'street', kind: 'street', approach: { x: -8, z: 0 }, end: { x: -12, z: 0 }, width: 0.9,
};

function twoWalkers(targets: [number, number], avoidance: LocalAvoidance): Simulation {
  const scene: Scenario = {
    id: 'shibuya', name: 'Shop and sidewalk', description: '',
    bounds: { minX: -10, maxX: 12, minZ: -6, maxZ: 6 },
    obstacles: [{ x: 11.2, z: 0, width: 4, depth: 6, height: 6, kind: 'building' }],
    portals: [door, street], targets: [door.approach, street.approach],
    spawnZones: [{ x: 0, z: 0, width: 2, depth: 2 }, { x: -3, z: 0, width: 2, depth: 2 }],
    spawnTargets: targets, targetTransitions: [1, 0],
  };
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 2, walkingSpeed: 2 }, avoidance, scene);
  sim.agents.current.vx.fill(0);
  sim.agents.current.vz.fill(0);
  return sim;
}

// Minimum separation *during* a fixed step, including the poses a renderer interpolates.
function advance(sim: Simulation, dt: number): void {
  const a = sim.agents;
  const beforeX = a.current.x[0] - a.current.x[1], beforeZ = a.current.z[0] - a.current.z[1];
  const previousArrivals = sim.arrivals;
  sim.step(dt);
  expect(a.count).toBe(2);
  expect(a.generation[0] + a.generation[1]).toBe(sim.arrivals);
  const afterX = a.current.x[0] - a.current.x[1], afterZ = a.current.z[0] - a.current.z[1];
  const dx = afterX - beforeX, dz = afterZ - beforeZ, travel = dx * dx + dz * dz;
  const closest = travel ? Math.max(0, Math.min(1, -(beforeX * dx + beforeZ * dz) / travel)) : 0;
  const separation = previousArrivals === sim.arrivals
    ? Math.hypot(beforeX + dx * closest, beforeZ + dz * closest) : Math.hypot(afterX, afterZ);
  expect(separation).toBeGreaterThanOrEqual(doorwayRadius(a.scale[0]) + doorwayRadius(a.scale[1]) - 0.0001);
}

describe('pedestrians merging at a doorway', () => {
  it('waits behind a blocked threshold and enters once the pedestrian in front has passed', () => {
    let sidewalkIsMoving = false;
    const sim = twoWalkers([0, 1], {
      compute(id, agents, _grid, direction, _settings, out) {
        out.x = id === 1 ? 0 : direction.x * agents.preferredSpeed[id];
        out.z = id === 1 ? (sidewalkIsMoving ? 1.6 : 0) : direction.z * agents.preferredSpeed[id];
      },
    });
    const a = sim.agents;
    a.current.x.set([5.85, 8.35]);
    a.current.z.fill(0);
    for (let step = 0; step < 80; step++) advance(sim, 0.1);
    expect(sim.arrivals).toBe(0);
    expect(a.current.x[0]).toBeLessThan(a.current.x[1]);
    expect(Math.hypot(a.current.vx[0], a.current.vz[0])).toBeLessThan(0.05);

    sidewalkIsMoving = true;
    for (let step = 0; step < 100 && !sim.arrivals; step++) advance(sim, 0.1);
    expect(a.generation[0]).toBe(1);
    expect(a.current.x[0]).toBe(street.end.x);
  });

  it('waits inside the doorway until the person on the sidewalk has cleared it', () => {
    let sidewalkIsMoving = false;
    const sim = twoWalkers([1, 1], {
      compute(id, agents, _grid, direction, _settings, out) {
        out.x = id === 0 ? direction.x * agents.preferredSpeed[id] : 0;
        out.z = id === 1 && sidewalkIsMoving ? 1.5 : 0;
      },
    });
    const a = sim.agents;
    a.current.x.set([street.approach.x, 8.4]); a.current.z.fill(0);
    for (let step = 0; step < 120 && !a.generation[0]; step++) advance(sim, 0.1);
    expect(a.generation[0]).toBe(1);
    for (let step = 0; step < 60; step++) advance(sim, 0.1);
    expect(a.current.x[0]).toBeGreaterThan(a.current.x[1]);
    expect(a.opacity[0]).toBe(1);
    expect(Math.hypot(a.current.vx[0], a.current.vz[0])).toBeLessThan(0.05);

    sidewalkIsMoving = true;
    for (let step = 0; step < 60 && a.current.x[0] > 6.5; step++) advance(sim, 0.1);
    expect(a.current.x[0]).toBeLessThanOrEqual(6.5);
    expect(sim.isInPassage(0)).toBe(false);
    expect(sim.arrivals).toBe(1);
  });

  it.each([0, 1])('lets an emerging walker and crossing foot traffic clear each other (entrant slot %i)', entrant => {
    const passer = 1 - entrant;
    let crossing = false;
    const sim = twoWalkers([1, 1], {
      compute(id, agents, grid, direction, settings, out) {
        if (id === passer && !crossing) { out.x = out.z = 0; return; }
        steering.compute(id, agents, grid, id === passer ? { x: 0, z: 1 } : direction, settings, out);
      },
    });
    const steering = new Steering(sim.scenario);
    const a = sim.agents;
    a.current.x[entrant] = street.approach.x; a.current.z[entrant] = 0;
    a.current.x[passer] = 8; a.current.z[passer] = -3;
    // Let the street exit and the replacement's first steps actually occur.
    for (let step = 0; step < 100 && !a.generation[entrant]; step++) advance(sim, 0.1);
    expect(a.generation[entrant]).toBe(1);
    for (let step = 0; step < 30 && a.current.x[entrant] > 9; step++) advance(sim, 0.1);

    // A passer approaches at right angles just as the entrant reaches the facade.
    a.current.x[passer] = a.current.x[entrant] - 0.34;
    a.current.z[passer] = -0.83;
    a.current.vz[passer] = 1.6;
    crossing = true;
    for (let step = 0; step < 120 && (a.current.x[entrant] > 5.5 || a.current.z[passer] < 1.2); step++) {
      advance(sim, 0.1);
    }
    expect(a.current.x[entrant]).toBeLessThanOrEqual(5.5);
    expect(a.current.z[passer]).toBeGreaterThanOrEqual(1.2);
  });

  it('waits for a replacement lane even when the public sidewalk reaches the exit endpoint', () => {
    const publicDoor: PedestrianPortal = {
      id: 'arcade', kind: 'door', approach: { x: 4, z: 0 }, end: { x: 5, z: 0 }, width: 2.45,
    };
    const otherDoor: PedestrianPortal = {
      id: 'opposite', kind: 'door', approach: { x: -4, z: 0 }, end: { x: -5, z: 0 }, width: 2.45,
    };
    const scene: Scenario = {
      id: 'plaza', name: 'Open passage', description: '', obstacles: [],
      bounds: { minX: -10, maxX: 10, minZ: -6, maxZ: 6 },
      spawnZones: [{ x: 0, z: 0, width: 2, depth: 2 }], spawnTargets: [0],
      portals: [publicDoor, otherDoor], targets: [publicDoor.approach, otherDoor.approach], targetTransitions: [1, 0],
    };
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 2, walkingSpeed: 2 }, undefined, scene);
    const a = sim.agents;
    const exitZ = -(publicDoor.width - 0.83) / 2;
    a.current.x.set([publicDoor.end.x, 0]); a.current.z.set([exitZ, 0]);
    a.current.vx.fill(0); a.current.vz.fill(0); a.preferredSpeed[1] = 0;
    for (let step = 0; step < 20 && !sim.arrivals; step++) advance(sim, 0.1);
    expect(a.generation[0]).toBe(1);

    // The replacement has stopped at its doorway, so its landing is occupied.
    a.preferredSpeed[0] = 0; a.current.vx[0] = a.current.vz[0] = 0;
    a.current.x[1] = publicDoor.end.x; a.current.z[1] = exitZ; a.preferredSpeed[1] = 2;
    for (let step = 0; step < 20; step++) advance(sim, 0.1);
    expect(sim.arrivals).toBe(1);
    a.preferredSpeed[0] = 2;
    for (let step = 0; step < 50 && !a.generation[1]; step++) advance(sim, 0.1);
    expect(a.generation[1]).toBe(1);
    expect(sim.arrivals).toBe(2);
  });

  it('resolves simultaneous sidewalk steps where both old positions alone appear clear', () => {
    const sim = twoWalkers([1, 1], {
      compute(id, _agents, _grid, _direction, _settings, out) {
        out.x = 0; out.z = id ? -1.4 : 1.4;
      },
    });
    const a = sim.agents, halfGap = (doorwayRadius(a.scale[0]) + doorwayRadius(a.scale[1]) + 0.21) / 2;
    a.current.x.fill(7.5);
    a.current.z.set([-halfGap, halfGap]);
    a.current.vz.set([1.4, -1.4]);
    advance(sim, 0.1);
  });
});
