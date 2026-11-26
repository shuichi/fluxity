import { describe, expect, it } from 'vitest';
import { createEnvironment, ENVIRONMENT_VERTEX_STRIDE } from '../renderer/Environment';
import { SCENE_MATERIAL } from '../renderer/ScrambleEnvironment';
import { LAMP, signalLampMask } from '../renderer/TrafficLights';
import { VehiclePath } from '../simulation/VehiclePath';
import { shibuya as mapped } from '../scenarios/shibuya';
import { syntheticShibuya as shibuya } from './fixtures/synthetic-shibuya';
import { plaza } from '../scenarios/plaza';
import type { Scenario, SignalState } from '../types';

const vertexFloats = ENVIRONMENT_VERTEX_STRIDE / Float32Array.BYTES_PER_ELEMENT;

function positionsForMaterial(vertices: Float32Array, material: number): number[][] {
  const positions: number[][] = [];
  for (let offset = 0; offset < vertices.length; offset += vertexFloats) {
    if (vertices[offset + 9] === material) positions.push(Array.from(vertices.slice(offset, offset + 3)));
  }
  return positions;
}

describe('scramble crossing scenery', () => {
  it('builds valid indexed geometry with two independently switchable pedestrian lamps', () => {
    const geometry = createEnvironment(shibuya);
    const count = geometry.vertices.length / vertexFloats;
    expect(Number.isInteger(count)).toBe(true);
    expect(geometry.indices.length % 3).toBe(0);
    for (const index of geometry.indices) expect(index).toBeLessThan(count);
    expect(geometry.vertices.every(Number.isFinite)).toBe(true);
    for (const material of [LAMP.pedestrian.red, LAMP.pedestrian.green, SCENE_MATERIAL.paint, SCENE_MATERIAL.sign]) {
      expect(positionsForMaterial(geometry.vertices, material).length).toBeGreaterThan(0);
    }
  });

  it('positions fixtures and zebra stripes from the scenario data instead of fixed coordinates', () => {
    const custom: Scenario = {
      ...shibuya, obstacles: [],
      scramble: {
        roadHalfWidth: 12,
        signalPositions: [{ x: -40, z: 20 }],
        crosswalks: [{ from: { x: 7, z: -9 }, to: { x: 7, z: 9 }, width: 6 }],
      },
    };
    const geometry = createEnvironment(custom);
    const lamps = positionsForMaterial(geometry.vertices, LAMP.pedestrian.green);
    expect(lamps.length).toBeGreaterThan(0);
    for (const [x, y, z] of lamps) {
      expect(Math.hypot(x + 40, z - 20)).toBeLessThan(1);
      expect(y).toBeGreaterThan(2);
    }
    // Lane markings are outside this central region; these vertices belong to the custom zebra.
    const zebra = positionsForMaterial(geometry.vertices, SCENE_MATERIAL.paint).filter(([, , z]) => Math.abs(z) < 10);
    expect(zebra.length).toBeGreaterThan(0);
    const crosswalkVertices = zebra.filter(([x]) => x >= 4 && x <= 10);
    expect(Math.min(...crosswalkVertices.map(([x]) => x))).toBeCloseTo(4);
    expect(Math.max(...crosswalkVertices.map(([x]) => x))).toBeCloseTo(10);
    expect(crosswalkVertices.every(([, , z]) => Math.abs(z) <= 9)).toBe(true);
  });

  it('faces both ends of all five crossings with the standing red figure above the walking green figure', () => {
    const { vertices } = createEnvironment(mapped);
    const heads = (material: number) => {
      const found = new Set<string>();
      for (let i = 0; i < vertices.length; i += vertexFloats) {
        if (vertices[i + 9] === material) found.add(`${vertices[i + 3].toFixed(4)},${vertices[i + 5].toFixed(4)}`);
      }
      return found;
    };
    const scramble = mapped.scramble!;
    const reds = positionsForMaterial(vertices, LAMP.pedestrian.red);
    const greens = positionsForMaterial(vertices, LAMP.pedestrian.green);
    expect(Math.min(...reds.map(p => p[1]))).toBeGreaterThan(Math.max(...greens.map(p => p[1])));
    const expected = new Set<string>();
    for (const { from, to } of scramble.crosswalks) {
      for (const [near, far] of [[from, to], [to, from]]) {
        const pole = [...scramble.signalPositions].sort((a, b) =>
          Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z))[0];
        const dx = far.x - pole.x, dz = far.z - pole.z, length = Math.hypot(dx, dz);
        expected.add(`${(dx / length).toFixed(4)},${(dz / length).toFixed(4)}`);
      }
    }
    expect(expected.size).toBe(10);
    expect(heads(LAMP.pedestrian.green)).toEqual(expected);
    expect(heads(LAMP.pedestrian.red)).toEqual(expected);
  });

  it('mounts one horizontal green–yellow–red head facing each approaching driver', () => {
    const { vertices } = createEnvironment(mapped);
    for (const lane of mapped.vehicleLanes!) {
      const path = new VehiclePath(lane);
      const driver = path.sample(lane.stop - 3);
      const centers = Object.values(LAMP[lane.axis]).map(material => {
        const points: number[][] = [];
        let nx = 0, nz = 0;
        for (let i = 0; i < vertices.length; i += vertexFloats) {
          if (vertices[i + 9] !== material) continue;
          const dx = driver.x - vertices[i], dz = driver.z - vertices[i + 2];
          // The driver sees the front of the far-side lamp through the junction.
          if (dx * driver.ux + dz * driver.uz >= -20) continue;
          const dot = (dx * vertices[i + 3] + dz * vertices[i + 5]) / Math.hypot(dx, dz);
          if (dot < 0.997) continue;
          nx = vertices[i + 3]; nz = vertices[i + 5];
          points.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
        }
        expect(points.length).toBe(20);
        // Project left-to-right in the driver's view.
        expect(Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]))).toBeCloseTo(0.30, 4);
        return points.reduce((sum, p) => sum + nz * p[0] - nx * p[2], 0) / points.length;
      });
      expect(centers[1] - centers[0]).toBeCloseTo(0.35, 3);
      expect(centers[2] - centers[1]).toBeCloseTo(0.35, 3);
    }
  });

  it('blinks only the pedestrian green on simulation time and switches vehicle heads independently', () => {
    const state: SignalState = { mode: 'auto', pedestrian: 'flashingGreen', eastWest: 'red', northSouth: 'red', remaining: 10, crossing: 2, waiting: 2 };
    const lit = (time: number) => Object.values(LAMP).flatMap(Object.values)
      .filter(material => signalLampMask(state, time) & (1 << (-material - 1)));
    expect(lit(37)).toEqual([LAMP.pedestrian.green, LAMP.eastWest.red, LAMP.northSouth.red]);
    expect(lit(37.5)).toEqual([LAMP.eastWest.red, LAMP.northSouth.red]);
    expect(lit(38)).toEqual(lit(37));
    Object.assign(state, { pedestrian: 'red', eastWest: 'yellow' });
    expect(lit(95.7)).toEqual([LAMP.pedestrian.red, LAMP.eastWest.yellow, LAMP.northSouth.red]);
    Object.assign(state, { eastWest: 'red', northSouth: 'green' });
    expect(lit(107)).toEqual([LAMP.pedestrian.red, LAMP.eastWest.red, LAMP.northSouth.green]);
  });

  it('keeps the original plaza environment free from crossing-specific material states', () => {
    const geometry = createEnvironment(plaza);
    expect(positionsForMaterial(geometry.vertices, LAMP.pedestrian.red)).toHaveLength(0);
    for (const material of Object.values(LAMP.eastWest)) expect(positionsForMaterial(geometry.vertices, material)).toHaveLength(0);
    expect(positionsForMaterial(geometry.vertices, LAMP.pedestrian.green)).toHaveLength(0);
    expect(positionsForMaterial(geometry.vertices, SCENE_MATERIAL.paving).length).toBeGreaterThan(0);
  });
});
