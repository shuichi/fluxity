import { expect, it } from 'vitest';
import markings from '../../data/shibuya/road-markings.json';
import { HUMAN_JOINTS } from '../renderer/HumanAnimation';
import { createHumanMesh } from '../renderer/HumanMesh';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { PolygonRegion } from '../simulation/UrbanGeometry';
import { VehiclePath } from '../simulation/VehiclePath';
import { SHIBUYA_VEHICLE_LANES, type VehicleLane } from '../simulation/VehicleLanes';
import { VehicleTraffic } from '../simulation/VehicleTraffic';
import { FIXED_DT, VEHICLE_LENGTH, VEHICLE_SNAPSHOT_STRIDE, VEHICLE_WIDTH } from '../types';
import type { VehicleSignal } from '../types';

// A straight, rotated fixture isolates braking and swept contact from Shibuya's curves.
const east: VehicleLane = { axis: 'eastWest', start: { x: -100, z: -4 }, end: { x: 115, z: 7 }, stop: 67, clear: 136 };
const mappedPaths = SHIBUYA_VEHICLE_LANES.map(lane => new VehiclePath(lane));
const length = Math.hypot(east.end.x - east.start.x, east.end.z - east.start.z);
const ux = (east.end.x - east.start.x) / length, uz = (east.end.z - east.start.z) / length;
const localX = (distance: number, side = 0) => east.start.x + ux * distance + uz * side;
const localZ = (distance: number, side = 0) => east.start.z + uz * distance - ux * side;
const localDistance = (x: number, z: number) => (x - east.start.x) * ux + (z - east.start.z) * uz;
const signals = (eastWest: VehicleSignal, northSouth: VehicleSignal = 'red') => ({ eastWest, northSouth });

it('fits the full left-hand through lanes on the PLATEAU road with clearance outside both bumpers', () => {
  const roads = new PolygonRegion(shibuya.urbanMap!.roads);
  const maneuvers = new PolygonRegion(shibuya.urbanMap!.crossingManeuvers!);
  const walkable = new PolygonRegion(shibuya.urbanMap!.walkable);
  for (const [index, lane] of SHIBUYA_VEHICLE_LANES.entries()) {
    const path = mappedPaths[index];
    for (let tick = 0; tick <= Math.ceil(path.length / 0.25); tick++) {
      const d = Math.min(tick * 0.25, path.length);
      const { x, z, ux, uz } = path.sample(d);
      const half = VEHICLE_LENGTH / 2;
      expect(roads.lineInside(x - ux * half, z - uz * half, x + ux * half, z + uz * half, VEHICLE_WIDTH / 2 + 0.3),
        `Lane ${index} bumper clearance at ${d.toFixed(1)} m`).toBe(true);
      if (d > lane.stop && d < lane.clear) continue;
      for (const side of [-1.5, 0, 1.5]) {
        expect(maneuvers.contains(x + uz * side, z - ux * side), `Lane ${index} at ${d} m`).toBe(false);
        expect(walkable.contains(x + uz * side, z - ux * side), `Lane ${index} at ${d} m`).toBe(false);
      }
    }
  }
  // At the same station, the opposing lane must remain on this driver's right.
  for (const [index, otherIndex] of [[0, 1], [2, 3]]) {
    const current = mappedPaths[index], opposing = mappedPaths[otherIndex];
    for (let d = 2; d < current.length - 2; d += 1) {
      const pose = current.sample(d);
      const other = opposing.sample(opposing.distanceAt(pose.x, pose.z));
      const separation = (other.z - pose.z) * pose.ux - (other.x - pose.x) * pose.uz;
      expect(separation, `Lanes ${index}/${otherIndex} at ${d} m`).toBeGreaterThan(VEHICLE_WIDTH);
    }
  }
});

function overlapsPaint(pose: ReturnType<VehiclePath['sample']>, points: number[][], width: number): boolean {
  // Compare the car rectangle and each paint segment on the rectangle's two axes and the segment normal.
  const halfWidth = (VEHICLE_WIDTH + width) / 2, halfLength = (VEHICLE_LENGTH + width) / 2;
  const { x, z, ux, uz } = pose;
  for (let j = 1; j < points.length; j++) {
    const [ax, az] = points[j - 1], [bx, bz] = points[j];
    const lateral = (ax - x) * uz - (az - z) * ux, along = (ax - x) * ux + (az - z) * uz;
    const dx = (bx - ax) * uz - (bz - az) * ux, dz = (bx - ax) * ux + (bz - az) * uz;
    if (Math.abs(lateral + dx / 2) > halfWidth + Math.abs(dx) / 2
        || Math.abs(along + dz / 2) > halfLength + Math.abs(dz) / 2) continue;
    if (Math.abs(lateral * dz - along * dx) <= halfWidth * Math.abs(dz) + halfLength * Math.abs(dx)) return true;
  }
  return false;
}

it('keeps each car body between approach markings and outside the hatching and bus islands', () => {
  const islands = markings.surfaces.filter(s => s.kind === 'island');
  const boundaries = markings.lines.filter(line => ['center', 'divider', 'hatch', 'edge'].includes(line.kind));
  const occupiedSurfaces = islands.map(s => new PolygonRegion([{ rings: [s.points.map(([x, z]) => ({ x, z }))] }]));
  // Test the whole outline even where an approach divider is dashed.
  const margins = [...boundaries, ...islands.map(s => ({ ...s, width: 0.16, points: [...s.points, s.points[0]] }))];
  expect(islands.length).toBeGreaterThan(0);
  expect(boundaries.map(line => line.kind)).toEqual(expect.arrayContaining(['center', 'divider', 'hatch']));
  for (const [index, path] of mappedPaths.entries()) {
    for (let tick = 0; tick <= Math.ceil(path.length / 0.25); tick++) {
      const d = Math.min(tick * 0.25, path.length);
      const pose = path.sample(d);
      for (const mark of margins) {
        if (overlapsPaint(pose, mark.points, mark.width)) throw Error(`Lane ${index} intersects ${mark.id} at ${d.toFixed(2)} m`);
      }
      if (occupiedSurfaces.some(island => island.contains(pose.x, pose.z))) throw Error(`Lane ${index} lies within a boarding island`);
    }
  }
});

it('stops both front corners immediately before the painted approach edge on all four arms', () => {
  const traffic = new VehicleTraffic(41, new AgentData(0), SHIBUYA_VEHICLE_LANES);
  const frame = new Float32Array(traffic.capacity * VEHICLE_SNAPSHOT_STRIDE);
  const laneStride = frame.length / SHIBUYA_VEHICLE_LANES.length;
  const red = signals('red');
  expect(markings.stopBars.map(bar => bar.lane).sort()).toEqual([0, 1, 2, 3]);
  for (let tick = 0; tick < 450; tick++) traffic.step(FIXED_DT, red);
  traffic.writeSnapshot(frame);
  for (const { lane, points: [a, b] } of markings.stopBars) {
    const slot = lane * laneStride; // The first car stays at the head of the queue during red.
    expect(frame[slot + 3]).toBe(1);
    expect(frame[slot + 4]).toBe(0);
    const ux = Math.sin(frame[slot + 2]), uz = Math.cos(frame[slot + 2]);
    const frontX = frame[slot] + ux * VEHICLE_LENGTH / 2, frontZ = frame[slot + 1] + uz * VEHICLE_LENGTH / 2;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / length, dz = (b[1] - a[1]) / length;
    const start = SHIBUYA_VEHICLE_LANES[lane].start;
    const forward = Math.sign((a[0] - start.x) * dz - (a[1] - start.z) * dx);
    let nearest = Infinity;
    for (const side of [-VEHICLE_WIDTH / 2, VEHICLE_WIDTH / 2]) {
      const x = frontX + uz * side - a[0], z = frontZ - ux * side - a[1];
      const across = x * dx + z * dz;
      const gap = -forward * (x * dz - z * dx); // Signed metres behind the near edge.
      expect(across).toBeGreaterThan(0);
      expect(across).toBeLessThan(length);
      expect(gap, `Lane ${lane}, front corner ${side}`).toBeGreaterThanOrEqual(-0.00002);
      nearest = Math.min(nearest, gap);
    }
    expect(nearest).toBeLessThan(0.10);
  }
});

it('brakes to a queued stop, starts gradually, clears after entry, and keeps bumper headway as slots recycle', () => {
  const traffic = new VehicleTraffic(41, new AgentData(0), [east]);
  const frame = new Float32Array(traffic.capacity * VEHICLE_SNAPSHOT_STRIDE);
  let previousSpeed = 0, priorLife = 0, stopped = false, departed = false, cleared = false, recycled = false;
  for (let i = 0; i < 30 * 85; i++) {
    const allow = i >= 450 && i < 525 || i > 1150;
    traffic.step(FIXED_DT, signals(allow ? 'green' : 'red'));
    traffic.writeSnapshot(frame);
    const positions: number[] = [];
    for (let slot = 0; slot < frame.length; slot += VEHICLE_SNAPSHOT_STRIDE) {
      if (frame[slot + 3]) positions.push(localDistance(frame[slot], frame[slot + 1]));
    }
    positions.sort((a, b) => b - a);
    for (let n = 1; n < positions.length; n++) expect(positions[n - 1] - positions[n]).toBeGreaterThan(VEHICLE_LENGTH + 1.99);
    const life = frame[3], speed = frame[4], front = localDistance(frame[0], frame[1]) + VEHICLE_LENGTH / 2;
    if (i < 450) {
      expect(front).toBeLessThanOrEqual(east.stop + 0.00001);
      if (i > 0) expect(previousSpeed - speed).toBeLessThan(2.4 * FIXED_DT);
      stopped ||= Math.abs(front - east.stop) < 0.03 && speed === 0;
    }
    if (i >= 450 && priorLife === life && life) expect(speed - previousSpeed).toBeLessThan(2 * FIXED_DT);
    if (i >= 525 && i < 1150 && traffic.occupiesCrossing) departed = true;
    if (departed && i < 1150 && !traffic.occupiesCrossing) {
      cleared = true;
      expect(front - VEHICLE_LENGTH).toBeGreaterThanOrEqual(east.clear - 0.00001);
    }
    if (life > 1) recycled = true;
    previousSpeed = speed; priorLife = life;
  }
  expect({ stopped, departed, cleared, recycled }).toEqual({ stopped: true, departed: true, cleared: true, recycled: true });
});

it('makes the yellow decision at onset and permits red only for cars already beyond the stop line', () => {
  function approach(untilGap: number) {
    const traffic = new VehicleTraffic(7, new AgentData(0), [east]);
    const frame = new Float32Array(traffic.capacity * VEHICLE_SNAPSHOT_STRIDE);
    const gap = () => east.stop - VEHICLE_LENGTH / 2 - localDistance(frame[0], frame[1]);
    const step = (aspect: VehicleSignal) => {
      traffic.step(FIXED_DT, signals(aspect)); traffic.writeSnapshot(frame);
    };
    do { step('green'); } while (gap() > untilGap);
    return { traffic, step, gap, frame };
  }
  const far = approach(17);
  expect(far.gap()).toBeGreaterThan(far.frame[4] ** 2 / (2 * 2.3));
  for (let tick = 0; tick < 180; tick++) {
    far.step(tick < 90 ? 'yellow' : 'red');
    expect(far.gap()).toBeGreaterThan(-0.00001);
    expect(far.traffic.occupiesCrossing).toBe(false);
  }
  expect(far.frame[4]).toBe(0);

  const near = approach(3);
  expect(near.gap()).toBeLessThan(near.frame[4] ** 2 / (2 * 2.3));
  const onsetSpeed = near.frame[4];
  for (let tick = 0; tick < 90; tick++) {
    near.step('yellow');
    expect(near.frame[4]).toBeLessThanOrEqual(onsetSpeed + 0.00001);
  }
  expect(near.gap()).toBeLessThan(0);
  expect(near.traffic.occupiesCrossing).toBe(true);
  for (let tick = 0; tick < 600 && near.traffic.occupiesCrossing; tick++) near.step('red');
  expect(near.traffic.occupiesCrossing).toBe(false);

  // Even a previously granted yellow cannot be carried across a red stop line.
  const revoked = approach(3);
  revoked.step('yellow');
  for (let tick = 0; tick < 100; tick++) {
    revoked.step('red');
    expect(revoked.gap()).toBeGreaterThan(-0.00001);
  }
});

it('serves both opposing lanes of the displayed axis and clears before cross traffic moves', () => {
  for (const active of ['eastWest', 'northSouth'] as const) {
    const entered = new Set<number>();
    const traffic = new VehicleTraffic(43, new AgentData(0), SHIBUYA_VEHICLE_LANES);
    const frame = new Float32Array(traffic.capacity * VEHICLE_SNAPSHOT_STRIDE);
    const laneStride = frame.length / SHIBUYA_VEHICLE_LANES.length;
    for (let tick = 0; tick < 30 * 45; tick++) {
      const color = tick < 600 ? 'green' : tick < 690 ? 'yellow' : 'red';
      traffic.step(FIXED_DT, active === 'eastWest' ? signals(color) : signals('red', color));
      traffic.writeSnapshot(frame);
      SHIBUYA_VEHICLE_LANES.forEach((lane, index) => {
        for (let slot = index * laneStride; slot < (index + 1) * laneStride; slot += VEHICLE_SNAPSHOT_STRIDE) {
          if (!frame[slot + 3]) continue;
          const center = mappedPaths[index].distanceAt(frame[slot], frame[slot + 1]);
          if (center + VEHICLE_LENGTH / 2 > (lane.entry ?? lane.stop) + 0.00001) entered.add(index);
        }
      });
    }
    expect([...entered].sort()).toEqual(active === 'eastWest' ? [0, 1] : [2, 3]);
    expect(traffic.occupiesCrossing).toBe(false);
  }
});

it('rejects a swept pedestrian crossing a stationary car and checks the sweep against spawning and moving cars', () => {
  const people = new AgentData(1), traffic = new VehicleTraffic(3, people, [east]);
  const scale = 1, spawn = east.stop - 25;
  const sweep = (distance: number) => {
    people.current.x[0] = localX(distance, -3); people.current.z[0] = localZ(distance, -3);
    people.next.x[0] = localX(distance, 3); people.next.z[0] = localZ(distance, 3);
    people.scale[0] = scale;
  };
  const frame = new Float32Array(traffic.capacity * VEHICLE_SNAPSHOT_STRIDE);
  sweep(spawn);
  traffic.step(FIXED_DT, signals('green')); traffic.writeSnapshot(frame);
  expect(frame[3]).toBe(0);
  const obstacle = spawn + 11;
  sweep(obstacle);
  for (let i = 0; i < 200; i++) {
    traffic.step(FIXED_DT, signals('green')); traffic.writeSnapshot(frame);
    expect(localDistance(frame[0], frame[1]) + VEHICLE_LENGTH / 2).toBeLessThan(obstacle - 0.745);
  }
  expect(frame[3]).toBe(1); expect(frame[4]).toBe(0);
  const stopped = localDistance(frame[0], frame[1]);
  expect(traffic.blocksPedestrian(localX(stopped, -4), localZ(stopped, -4), localX(stopped, 4), localZ(stopped, 4), scale)).toBe(true);
  // A point next to the car can move parallel to it outside the expanded body.
  expect(traffic.blocksPedestrian(localX(stopped, 3), localZ(stopped, 3), localX(stopped + 5, 3), localZ(stopped + 5, 3), scale)).toBe(false);
  sweep(length + 10);
  for (let i = 0; i < 180; i++) traffic.step(FIXED_DT, signals('green'));
  traffic.writeSnapshot(frame);
  expect(localDistance(frame[0], frame[1])).toBeGreaterThan(obstacle + 4);
});

it('protects the outstretched running heel at every LOD and scales its clearance with the person', () => {
  const traffic = new VehicleTraffic(9, new AgentData(0), [east]);
  traffic.step(FIXED_DT, signals('green'));
  const frame = new Float32Array(traffic.capacity * VEHICLE_SNAPSHOT_STRIDE);
  traffic.writeSnapshot(frame);
  const center = localDistance(frame[0], frame[1]);
  // At full run and peak forward leg rotation the supporting leg is straight.
  // Its horizontal displacement is sin(stride) times hip-to-ankle length;
  // the shader counter-rotates the shoe and lowers the hip to plant the sole.
  const stride = 0.53 + 0.31, legLength = HUMAN_JOINTS.hip - HUMAN_JOINTS.ankle;
  for (let lod = 0; lod < 3; lod++) {
    const { vertices } = createHumanMesh(lod);
    let reach = 0;
    for (let i = 0; i < vertices.length; i += 7) {
      if (vertices[i + 6] < 11) continue;
      const x = vertices[i] * 1.12;
      const z = vertices[i + 2] - Math.sin(stride) * legLength + (vertices[i + 1] - HUMAN_JOINTS.hip) * 0.09;
      reach = Math.max(reach, Math.hypot(x, z));
    }
    expect(reach).toBeCloseTo(0.7455, 4);
    for (const scale of [0.89, 1, 1.13]) {
      const offset = VEHICLE_WIDTH / 2 + reach * scale;
      const x = localX(center, offset), z = localZ(center, offset);
      expect(traffic.blocksPedestrian(x, z, x, z, scale)).toBe(true);
    }
  }
  const side = VEHICLE_WIDTH / 2 + 0.80;
  const x = localX(center, side), z = localZ(center, side);
  expect(traffic.blocksPedestrian(x, z, x, z, 0.89)).toBe(false);
  expect(traffic.blocksPedestrian(x, z, x, z, 1.13)).toBe(true);
});
