import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { lerpAngle } from '../math/geometry';
import { Frustum } from '../renderer/Culling';
import { createHumanMesh, HUMAN_VERTEX_STRIDE } from '../renderer/HumanMesh';
import { INSTANCE_FLOATS, INSTANCE_STRIDE, sampleEyePose, samplePersonPose } from '../renderer/InstanceBuffer';
import type { PersonPose } from '../renderer/Camera';
import { LODManager } from '../renderer/LODManager';
import { createVehicleMesh } from '../renderer/VehicleMesh';
import { packVehicleInstances } from '../renderer/VehicleInstances';
import { SNAPSHOT_STRIDE, VEHICLE_LENGTH, VEHICLE_WIDTH } from '../types';

describe('rendering data contracts', () => {
  it('fits the drawn vehicle inside its collision footprint and faces local +Z', () => {
    const mesh = createVehicleMesh();
    let width = 0, length = 0;
    for (let i = 0; i < mesh.vertices.length; i += 10) {
      width = Math.max(width, Math.abs(mesh.vertices[i]) * 2);
      length = Math.max(length, Math.abs(mesh.vertices[i + 2]) * 2);
      expect(Math.hypot(mesh.vertices[i + 3], mesh.vertices[i + 4], mesh.vertices[i + 5])).toBeCloseTo(1, 5);
    }
    expect(width).toBeCloseTo(VEHICLE_WIDTH, 6);
    expect(length).toBeCloseTo(VEHICLE_LENGTH, 6);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.vertices.length / 10);
    const previous = new Float32Array([0, 0, 0, 2, 6, 50, 0, 1, 1, 2]);
    const current = new Float32Array([1, 0, Math.PI / 2, 2, 6, 0, 0, 0, 0, 0]);
    const packed = new Float32Array(14);
    expect(packVehicleInstances(packed, previous, current, 0.5)).toBe(1);
    expect(packed[0]).toBe(0.5);
    expect(packed[2]).toBeCloseTo(Math.SQRT1_2);
    expect(packed[3]).toBeCloseTo(Math.SQRT1_2);
    current[3]++;
    packVehicleInstances(packed, previous, current, 0);
    expect(packed[0]).toBe(1);
  });
  it('keeps storage records vec4-aligned and mesh indices in bounds at all LODs', () => {
    expect(INSTANCE_STRIDE).toBe(64);
    expect(INSTANCE_FLOATS).toBe(16);
    let previous = Infinity;
    for (let lod = 0; lod < 3; lod++) {
      const mesh = createHumanMesh(lod);
      const vertexCount = mesh.vertices.byteLength / HUMAN_VERTEX_STRIDE;
      expect(Number.isInteger(vertexCount)).toBe(true);
      expect(mesh.indices.length).toBeLessThan(previous);
      previous = mesh.indices.length;
      expect(Math.max(...mesh.indices)).toBeLessThan(vertexCount);
      expect(mesh.indices.length % 3).toBe(0);
      const parts = new Set<number>();
      let minY = Infinity, maxY = -Infinity, shoulderMin = Infinity, shoulderMax = -Infinity;
      for (let i = 0; i < mesh.vertices.length; i += 7) {
        expect(Number.isFinite(mesh.vertices[i])).toBe(true);
        expect(Math.hypot(mesh.vertices[i + 3], mesh.vertices[i + 4], mesh.vertices[i + 5])).toBeCloseTo(1, 5);
        minY = Math.min(minY, mesh.vertices[i + 1]);
        maxY = Math.max(maxY, mesh.vertices[i + 1]);
        const part = mesh.vertices[i + 6];
        parts.add(part);
        if (part === 3 || part === 4) {
          shoulderMin = Math.min(shoulderMin, mesh.vertices[i]);
          shoulderMax = Math.max(shoulderMax, mesh.vertices[i]);
        }
      }
      expect(minY).toBeCloseTo(0, 6);
      expect(maxY).toBeCloseTo(1.65, 6);
      expect(shoulderMax - shoulderMin).toBeCloseTo(0.433, 6);
      for (const part of [0, 1, 3, 4, 7, 8]) expect(parts.has(part)).toBe(true);
    }
  });

  it('carries the eye height through the same gait as the drawn head', () => {
    const frame = new Float32Array(SNAPSHOT_STRIDE);
    frame[6] = 1;
    const pose: PersonPose = { x: 0, z: 0, heading: 0, headYaw: 0, scale: 1 };
    sampleEyePose(pose, frame, frame, 0, 1);
    expect(pose.eyeHeight).toBeCloseTo(1.535);
    frame[3] = 1.35; frame[4] = Math.PI / 2;
    sampleEyePose(pose, frame, frame, 0, 1);
    expect(pose.eyeHeight).toBeCloseTo(1.535 - (0.844 - 0.067) * (1 - Math.cos(0.53)), 5);
    expect(pose.z).toBe(0);
  });

  it('interpolates headings over the shortest angular arc', () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI);
    expect(lerpAngle(0.2, 0.6, 0.5)).toBeCloseTo(0.4);
  });

  it('starts a new life at its own pose even at nearby exits and across skipped snapshots', () => {
    const previous = new Float32Array(SNAPSHOT_STRIDE);
    const current = previous.slice();
    current[0] = 2; current[1] = 3; current[2] = Math.PI / 2; current[6] = 1.1;
    previous[13] = -0.5; current[13] = 0.5;
    const pose = { x: 0, z: 0, heading: 0, headYaw: 0, scale: 1 };
    expect(samplePersonPose(pose, previous, current, 0, 0.25)).toBe(0.25);
    expect(pose.x).toBe(0.5);
    expect(pose.headYaw).toBe(-0.25);
    current[11] = 2;
    expect(samplePersonPose(pose, previous, current, 0, 0.25)).toBe(1);
    expect(pose.x).toBe(2); expect(pose.z).toBe(3);
    expect(pose.heading).toBeCloseTo(Math.PI / 2);
    expect(pose.headYaw).toBe(0.5);
    expect(pose.scale).toBeCloseTo(1.1);
  });
});

describe('culling and LOD', () => {
  it('uses WebGPU near/far planes and includes partially intersecting people', () => {
    const projection = mat4.perspectiveZO(mat4.create(), Math.PI / 2, 1, 1, 100);
    const frustum = new Frustum();
    frustum.update(projection);
    expect(frustum.containsSphere(0, 0, -5, 0.5)).toBe(true);
    expect(frustum.containsSphere(0, 0, 5, 0.5)).toBe(false);
    expect(frustum.containsSphere(0, 0, -102, 0.5)).toBe(false);
    expect(frustum.containsSphere(8, 0, -5, 0.5)).toBe(false);
    expect(frustum.containsSphere(5.2, 0, -5, 0.5)).toBe(true);
  });

  it('keeps the current LOD within a hysteresis band', () => {
    const manager = new LODManager(1);
    expect(manager.select(0, 10, 'balanced')).toBe(2);
    expect(manager.select(0, 15, 'balanced')).toBe(1);
    expect(manager.select(0, 12, 'balanced')).toBe(1);
    expect(manager.select(0, 10, 'balanced')).toBe(2);
    expect(manager.select(0, 50, 'balanced')).toBe(0);
    expect(manager.select(0, 36, 'balanced')).toBe(0);
    expect(manager.select(0, 30, 'balanced')).toBe(1);
  });
});
