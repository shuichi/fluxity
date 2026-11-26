import { expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { VehicleTraffic } from '../simulation/VehicleTraffic';
import { VehiclePath } from '../simulation/VehiclePath';
import { SHIBUYA_VEHICLE_LANES } from '../simulation/VehicleLanes';
import { Simulation } from '../simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT, VEHICLE_LENGTH, VEHICLE_SNAPSHOT_STRIDE, VEHICLE_WIDTH } from '../types';

const halfDiagonal = Math.hypot(VEHICLE_WIDTH, VEHICLE_LENGTH) / 2;
const stride = VEHICLE_SNAPSHOT_STRIDE;
const paths = SHIBUYA_VEHICLE_LANES.map(lane => new VehiclePath(lane));

// Independent of traffic permissions and the simulator's collision solver. In the
// car's frame, bound how much the distance to the oriented body can change between
// two poses. Subdivide only intervals whose midpoint cannot prove the pair clear.
function separated(x: number, z: number, dx: number, dz: number, heading: number, turn: number, radius: number): boolean {
  const travel = Math.hypot(dx, dz) + Math.abs(turn) * halfDiagonal;
  if (Math.hypot(x, z) > halfDiagonal + radius + travel) return true;
  function interval(t: number, half: number): boolean {
    const rx = x + t * dx, rz = z + t * dz, angle = heading + t * turn;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const lateral = Math.max(0, Math.abs(rx * cos - rz * sin) - VEHICLE_WIDTH / 2);
    const along = Math.max(0, Math.abs(rx * sin + rz * cos) - VEHICLE_LENGTH / 2);
    const gap = Math.hypot(lateral, along) - radius;
    if (gap > half * travel) return true;
    if (gap <= 0 || half < 1e-5) return false;
    return interval(t - half / 2, half / 2) && interval(t + half / 2, half / 2);
  }
  return interval(0.5, 0.5);
}

function observeTraffic(sim: Simulation) {
  const a = sim.agents, lives = a.generation.slice();
  let before = new Float32Array(sim.vehicleCapacity * stride), after = before.slice();
  sim.writeVehicleSnapshot(before);
  const laneStride = before.length / paths.length;
  const urban = sim.navigation.urban!;

  return (dt = FIXED_DT) => {
    const old = a.current;
    lives.set(a.generation);
    sim.step(dt);
    sim.writeVehicleSnapshot(after);
    const lights = sim.signal!;
    // Check every sidewalk-to-crosswalk transition, including during clearance.
    if (lights.pedestrian !== 'green') {
      for (let i = 0; i < a.count; i++) {
        const x = a.current.x[i], z = a.current.z[i], radius = a.radius[i] + 0.015;
        if (urban.inCrossingArea(x, z) && !urban.isSidewalk(x, z, radius) &&
          (lives[i] !== a.generation[i] || urban.isSidewalk(old.x[i], old.z[i], radius))) {
          throw Error(`Pedestrian ${i} entered on ${lights.pedestrian} at step ${sim.stepCount}`);
        }
      }
    }
    for (let slot = 0; slot < after.length; slot += stride) {
      if (!after[slot + 3]) continue;
      const sameCar = after[slot + 3] === before[slot + 3];
      const laneId = Math.floor(slot / laneStride), lane = SHIBUYA_VEHICLE_LANES[laneId];
      const path = paths[laneId];
      const bumperAt = (frame: Float32Array) => path.distanceAt(frame[slot], frame[slot + 1]) + VEHICLE_LENGTH / 2;
      const front = bumperAt(after), entry = lane.entry ?? lane.stop;
      if (front > entry + 1e-4 && front - VEHICLE_LENGTH < lane.clear - 1e-4) {
        const otherAxis = lane.axis === 'eastWest' ? 'northSouth' : 'eastWest';
        if (lights.pedestrian !== 'red' || lights[otherAxis] !== 'red') {
          throw Error(`Conflicting signal with car in the junction at step ${sim.stepCount}`);
        }
        if ((!sameCar || bumperAt(before) <= entry + 1e-4) && lights[lane.axis] === 'red') {
          throw Error(`Car crossed a red stop line on ${lane.axis} at step ${sim.stepCount}`);
        }
      }
      for (let i = 0; i < a.count; i++) {
        const continuous = sameCar && a.generation[i] === lives[i];
        const x = a.current.x[i] - after[slot], z = a.current.z[i] - after[slot + 1];
        const fromX = continuous ? old.x[i] - before[slot] : x;
        const fromZ = continuous ? old.z[i] - before[slot + 1] : z;
        const heading = continuous ? before[slot + 2] : after[slot + 2];
        const angle = after[slot + 2] - heading;
        const limbReach = 0.746 * a.scale[i]; // Farthest rendered heel in a full-speed stride.
        if (!separated(fromX, fromZ, x - fromX, z - fromZ, heading, Math.atan2(Math.sin(angle), Math.cos(angle)), limbReach)) {
          throw Error(`Car ${slot / stride} touches pedestrian ${i} during step ${sim.stepCount}`);
        }
      }
    }
    [before, after] = [after, before];
    return before;
  };
}

// The west end of the north zebra, with the east shop as destination.
function waitAtNorthZebra(sim: Simulation): void {
  const a = sim.agents, mark = shibuya.scramble!.crosswalks[3];
  const dx = mark.to.x - mark.from.x, dz = mark.to.z - mark.from.z, length = Math.hypot(dx, dz);
  a.current.x[0] = mark.from.x + 5 * dx / length;
  a.current.z[0] = mark.from.z + 5 * dz / length;
  a.current.vx[0] = a.current.vz[0] = 0;
  const target = shibuya.portals!.findIndex(p => p.id === 'east-shop');
  a.targetId[0] = target;
  a.targetX[0] = shibuya.targets[target].x; a.targetZ[0] = shibuya.targets[target].z;
}

function onSidewalk(sim: Simulation): boolean {
  const a = sim.agents;
  return sim.navigation.urban!.isSidewalk(a.current.x[0], a.current.z[0], a.radius[0] + 0.015);
}

it('checks continuous body clearance as a car steers around a bend toward a crossing pedestrian', () => {
  const lane = { axis: 'eastWest' as const, start: { x: 0, z: 0 }, via: [{ x: 25, z: 0 }, { x: 40, z: 10 }],
    end: { x: 63, z: 10 }, stop: 14, clear: 48 };
  const path = new VehiclePath(lane), people = new AgentData(1);
  const traffic = new VehicleTraffic(41, people, [lane]), aspect = { eastWest: 'green', northSouth: 'red' } as const;
  people.scale[0] = 1;
  const conflict = path.sample(42);
  let before = new Float32Array(traffic.capacity * stride), after = before.slice();
  let turned = false, stopped = false, resumed = false;
  for (let tick = 0; tick < 700 && !resumed; tick++) {
    // Crossing repeatedly from side to side exercises the full sweep, including clear endpoints.
    const offset = tick % 2 ? 4 : -4;
    const from = tick < 350 ? offset : 16, to = tick < 350 ? -offset : 16;
    people.current.x[0] = conflict.x + from * conflict.uz; people.current.z[0] = conflict.z - from * conflict.ux;
    people.next.x[0] = conflict.x + to * conflict.uz; people.next.z[0] = conflict.z - to * conflict.ux;
    traffic.step(0.1, aspect); traffic.writeSnapshot(after);
    if (after[3] && after[3] === before[3]) {
      const rx = people.current.x[0] - before[0], rz = people.current.z[0] - before[1];
      const dx = people.next.x[0] - after[0] - rx, dz = people.next.z[0] - after[1] - rz;
      const turn = after[2] - before[2];
      expect(separated(rx, rz, dx, dz, before[2], Math.atan2(Math.sin(turn), Math.cos(turn)), 0.746)).toBe(true);
      const distance = path.distanceAt(after[0], after[1]);
      if (tick < 350) {
        expect(distance + VEHICLE_LENGTH / 2).toBeLessThan(42);
        turned ||= Math.abs(after[2] - Math.PI / 2) > 0.4;
        stopped ||= turned && after[4] === 0;
      } else if (stopped && distance > 49) resumed = true;
    }
    [before, after] = [after, before];
  }
  expect({ turned, stopped, resumed }).toEqual({ turned: true, stopped: true, resumed: true });
});

it('distinguishes a shop entrance by the north zebra from a person occupying its carriageway', () => {
  const urban = new Simulation({ ...DEFAULT_CONFIG, count: 1 }).navigation.urban!;
  // A walker emerging from a storefront can straddle its facade near a crossing landing.
  const radius = 0.29;
  expect(urban.inCrossingArea(28.843, -15.528)).toBe(true);
  expect(urban.isSidewalk(28.843, -15.528, radius)).toBe(false);
  expect(urban.occupiesCrossing(28.843, -15.528, radius)).toBe(false);
  expect(urban.occupiesCrossing(10, -18, radius)).toBe(true);
});

it('serves all four approaches and the pedestrian scramble over an automatic cycle without contact', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 32 });
  waitAtNorthZebra(sim);
  const step = observeTraffic(sim), directions = new Set<string>();
  let started = false, crossed = false;
  for (let tick = 0; tick < 5700; tick++) {
    const cars = step(), sidewalk = onSidewalk(sim);
    if (!started && !sidewalk) {
      expect(sim.signal!.pedestrian).toBe('green');
      started = true;
    }
    if (started && sidewalk && sim.agents.current.x[0] > 15) crossed = true;
    for (let i = 0; i < cars.length; i += stride) {
      if (!cars[i + 3] || Math.hypot(cars[i], cars[i + 1]) > 10 || cars[i + 4] <= 1) continue;
      const dx = Math.sin(cars[i + 2]), dz = Math.cos(cars[i + 2]);
      directions.add(Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'));
    }
  }
  expect(crossed).toBe(true);
  expect([...directions].sort()).toEqual(['east', 'north', 'south', 'west']);
}, 20000);

it('holds a manual green request while a car clears, then lets a waiting pedestrian enter', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1, signalMode: 'eastWest', avoidanceStrength: 0 });
  waitAtNorthZebra(sim);
  const step = observeTraffic(sim);
  let occupied = false;
  for (let tick = 0; tick < 900 && !occupied; tick++) {
    const cars = step();
    for (let i = 0; i < cars.length; i += stride) {
      if (cars[i + 3] && Math.hypot(cars[i], cars[i + 1]) < 4) occupied = true;
    }
  }
  expect(occupied).toBe(true);
  sim.updateSettings({ signalMode: 'pedestrian' });
  expect(sim.signal!.pedestrian).toBe('red');
  let entered = false;
  for (let tick = 0; tick < 1200 && !entered; tick++) {
    step();
    entered = !onSidewalk(sim);
    if (entered) expect(sim.signal!.pedestrian).toBe('green');
  }
  expect(entered).toBe(true);
}, 15000);

it('keeps traffic stopped for a stationary person on the diagonal and resumes after they reach the sidewalk', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1, seed: 137, walkingSpeed: 0,
    avoidanceStrength: 0, signalMode: 'pedestrian' });
  const a = sim.agents, diagonal = shibuya.scramble!.crosswalks[4];
  const dx = diagonal.to.x - diagonal.from.x, dz = diagonal.to.z - diagonal.from.z;
  // Pick the intersection of the mapped diagonal and the actual eastbound trajectory.
  const path = paths[0];
  let x = 0, z = 0, distanceToDiagonal = Infinity;
  for (let d = SHIBUYA_VEHICLE_LANES[0].stop; d <= SHIBUYA_VEHICLE_LANES[0].clear; d += 0.1) {
    const p = path.sample(d);
    const distance = Math.abs((p.x - diagonal.from.x) * dz - (p.z - diagonal.from.z) * dx) / Math.hypot(dx, dz);
    if (distance < distanceToDiagonal) { x = Math.fround(p.x); z = Math.fround(p.z); distanceToDiagonal = distance; }
  }
  expect(distanceToDiagonal).toBeLessThan(0.1);
  a.current.x[0] = x; a.current.z[0] = z;
  a.current.vx[0] = a.current.vz[0] = 0;
  expect(sim.navigation.isFree(x, z, a.radius[0])).toBe(true);
  expect(onSidewalk(sim)).toBe(false);
  sim.updateSettings({ signalMode: 'eastWest' });
  const step = observeTraffic(sim);
  let queued = false;
  for (let tick = 0; tick < 350; tick++) {
    const cars = step(0.1);
    for (let i = 0; i < cars.length; i += stride) {
      if (!cars[i + 3]) continue;
      expect(Math.hypot(cars[i], cars[i + 1])).toBeGreaterThan(20);
      if (i < cars.length / paths.length && cars[i + 4] < 0.1
          && Math.abs(path.distanceAt(cars[i], cars[i + 1]) + VEHICLE_LENGTH / 2 - SHIBUYA_VEHICLE_LANES[0].stop) < 0.05) queued = true;
    }
  }
  expect(queued).toBe(true);
  expect(a.current.x[0]).toBe(x);
  expect(a.current.z[0]).toBe(Math.fround(z));
  sim.updateSettings({ walkingSpeed: 1.35 });
  let passed = false;
  for (let tick = 0; tick < 500 && !passed; tick++) {
    const cars = step(0.1);
    for (let i = 0; i < cars.length; i += stride) {
      if (cars[i + 3] && Math.hypot(cars[i] - x, cars[i + 1] - z) < 1) passed = true;
    }
  }
  expect(onSidewalk(sim)).toBe(true);
  expect(passed).toBe(true);
}, 15000);

it('holds both vehicle axes for a slow late entrant returning along the Shibuya diagonal', () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, count: 1, seed: 137, walkingSpeed: 0, avoidanceStrength: 0 });
  const a = sim.agents, diagonal = shibuya.scramble!.crosswalks[4];
  const dx = diagonal.to.x - diagonal.from.x, dz = diagonal.to.z - diagonal.from.z, length = Math.hypot(dx, dz);
  // Six metres along the marked corridor is still on the northwest sidewalk.
  a.current.x[0] = diagonal.from.x + 6 * dx / length;
  a.current.z[0] = diagonal.from.z + 6 * dz / length;
  a.current.vx[0] = a.current.vz[0] = 0;
  const target = shibuya.portals!.findIndex(portal => portal.id === 'forecourt-building');
  a.targetId[0] = target; a.targetX[0] = shibuya.targets[target].x; a.targetZ[0] = shibuya.targets[target].z;
  expect(onSidewalk(sim)).toBe(true);

  const step = observeTraffic(sim);
  let entered = false, held = false, returned = false, released = false;
  for (let tick = 0; tick < 70 * 30 && !released; tick++) {
    if (tick === 32 * 30) sim.updateSettings({ walkingSpeed: 0.7 });
    // The person slows mid-crossing, so the ordinary four seconds of all-red run out.
    if (tick === 37 * 30 - 1) sim.updateSettings({ walkingSpeed: 0.075 });
    const cars = step(), sidewalk = onSidewalk(sim);
    if (!entered && !sidewalk) {
      expect(sim.time).toBeGreaterThan(32);
      expect(sim.time).toBeLessThan(37);
      expect(sim.signal!.pedestrian).toBe('green');
      entered = true;
    }
    if (entered && !sidewalk) {
      expect([sim.signal!.eastWest, sim.signal!.northSouth]).toEqual(['red', 'red']);
      if (sim.time > 51.1 && !held) {
        expect(sim.signal!.pedestrian).toBe('red');
        expect(sim.signal!.remaining).toBeNull();
        // Check that actual front bumpers are queued against all four stripes.
        for (const [index, lane] of SHIBUYA_VEHICLE_LANES.entries()) {
          const stop = paths[index].sample(lane.stop - VEHICLE_LENGTH / 2);
          let queued = false;
          for (let slot = 0; slot < cars.length; slot += stride) {
            if (cars[slot + 3] && cars[slot + 4] < 0.01 && Math.hypot(cars[slot] - stop.x, cars[slot + 1] - stop.z) < 0.05) queued = true;
          }
          expect(queued).toBe(true);
        }
        held = true;
      }
    }
    if (entered && sidewalk && !returned) {
      expect(Math.hypot(a.current.x[0] - diagonal.from.x, a.current.z[0] - diagonal.from.z)).toBeLessThan(10);
      returned = true;
    }
    if (sim.signal!.eastWest === 'green') {
      expect(returned).toBe(true);
      expect(sim.signal!.northSouth).toBe('red');
      released = true;
    }
  }
  expect({ entered, held, returned, released }).toEqual({ entered: true, held: true, returned: true, released: true });
}, 15000);
