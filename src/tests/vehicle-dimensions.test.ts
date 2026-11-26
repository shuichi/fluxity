import { expect, it } from 'vitest';
import { createVehicleMesh } from '../renderer/VehicleMesh';
import { VEHICLE_LENGTH, VEHICLE_WIDTH } from '../types';

it('measures the car submitted to WebGPU against the Corolla Sport G dimensions in meters', () => {
  const { vertices, indices } = createVehicleMesh();
  const points = [...new Set(indices)].map(index => {
    const i = index * 10;
    return { x: vertices[i], y: vertices[i + 1], z: vertices[i + 2], red: vertices[i + 6], paint: vertices[i + 9] };
  });
  type Vertex = typeof points[number];
  const bounds = (group: Vertex[], axis: 'x' | 'y' | 'z') => {
    const values = group.map(p => p[axis]), min = Math.min(...values), max = Math.max(...values);
    return { min, max, size: max - min, center: (min + max) / 2 };
  };
  const body = points.filter(p => p.paint === 1);
  const tires = points.filter(p => Math.abs(p.red - 0.12) < 1e-6);
  const rim = points.filter(p => Math.abs(p.red - 0.61) < 1e-6);
  expect(bounds(points, 'z').size).toBeCloseTo(4.375, 6);
  expect(bounds(body, 'x').size).toBeCloseTo(1.790, 6);
  expect(bounds(points, 'x').size).toBeCloseTo(2.080, 6);
  expect(bounds(points, 'y').min).toBe(0);
  expect(bounds(points, 'y').max).toBeCloseTo(1.460, 6);
  expect(bounds(points.filter(p => Math.abs(p.x) < 0.62), 'y').min).toBeCloseTo(0.135, 6);
  expect(bounds(tires, 'x').size).toBeCloseTo(1.735, 6);
  expect(bounds(points, 'z').size).toBeCloseTo(VEHICLE_LENGTH, 6);
  expect(bounds(points, 'x').size).toBeCloseTo(VEHICLE_WIDTH, 6);

  // Use the extrema of each tire's indexed vertices to recover both axle
  // centers and track independently of the dimensions used by the mesh author.
  const leftTires = tires.filter(p => p.x < 0), rightTires = tires.filter(p => p.x > 0);
  expect(bounds(rightTires, 'x').center - bounds(leftTires, 'x').center).toBeCloseTo(1.530, 6);
  for (const wheels of [leftTires, rightTires]) {
    const front = wheels.filter(p => p.z > 0), rear = wheels.filter(p => p.z < 0);
    const frontAxle = bounds(front, 'z').center, rearAxle = bounds(rear, 'z').center;
    expect(frontAxle - rearAxle).toBeCloseTo(2.640, 6);
    expect(bounds(points, 'z').max - frontAxle).toBeCloseTo(0.940, 6);
    expect(rearAxle - bounds(points, 'z').min).toBeCloseTo(0.795, 6);
    for (const wheel of [front, rear]) {
      expect(bounds(wheel, 'y').min).toBe(0);
      expect(bounds(wheel, 'y').size).toBeCloseTo(0.6319, 6);
      expect(bounds(wheel, 'x').size).toBeCloseTo(0.205, 6);
    }
  }
  expect(bounds(rim, 'y').size).toBeCloseTo(0.4064, 6);
});
