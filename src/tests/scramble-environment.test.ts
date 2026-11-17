import { describe, expect, it } from 'vitest';
import { createEnvironment, ENVIRONMENT_VERTEX_STRIDE } from '../renderer/Environment';
import { SCENE_MATERIAL } from '../renderer/ScrambleEnvironment';
import { shibuya } from '../scenarios/shibuya';
import { plaza } from '../scenarios/plaza';
import type { Scenario } from '../types';

const vertexFloats = ENVIRONMENT_VERTEX_STRIDE / Float32Array.BYTES_PER_ELEMENT;

function positionsForMaterial(vertices: Float32Array, material: number): number[][] {
  const positions: number[][] = [];
  for (let offset = 0; offset < vertices.length; offset += vertexFloats) {
    if (vertices[offset + 9] === material) positions.push(Array.from(vertices.slice(offset, offset + 3)));
  }
  return positions;
}

describe('scramble crossing scenery', () => {
  it('builds valid indexed geometry with both independently switchable pedestrian lamps', () => {
    const geometry = createEnvironment(shibuya);
    const count = geometry.vertices.length / vertexFloats;
    expect(Number.isInteger(count)).toBe(true);
    expect(geometry.indices.length % 3).toBe(0);
    for (const index of geometry.indices) expect(index).toBeLessThan(count);
    expect(geometry.vertices.every(Number.isFinite)).toBe(true);
    for (const material of [SCENE_MATERIAL.redSignal, SCENE_MATERIAL.greenSignal, SCENE_MATERIAL.paint, SCENE_MATERIAL.sign]) {
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
    const lamps = positionsForMaterial(geometry.vertices, SCENE_MATERIAL.greenSignal);
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

  it('keeps the original plaza environment free from crossing-specific material states', () => {
    const geometry = createEnvironment(plaza);
    expect(positionsForMaterial(geometry.vertices, SCENE_MATERIAL.redSignal)).toHaveLength(0);
    expect(positionsForMaterial(geometry.vertices, SCENE_MATERIAL.greenSignal)).toHaveLength(0);
    expect(positionsForMaterial(geometry.vertices, SCENE_MATERIAL.paving).length).toBeGreaterThan(0);
  });
});
