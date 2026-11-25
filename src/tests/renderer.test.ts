import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { lerpAngle } from '../math/geometry';
import { Frustum } from '../renderer/Culling';
import { createHumanMesh, HUMAN_VERTEX_STRIDE } from '../renderer/HumanMesh';
import { INSTANCE_FLOATS, INSTANCE_STRIDE, samplePersonPose } from '../renderer/InstanceBuffer';
import { LODManager } from '../renderer/LODManager';
import { SNAPSHOT_STRIDE } from '../types';

describe('rendering data contracts', () => {
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
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < mesh.vertices.length; i += 7) {
        expect(Number.isFinite(mesh.vertices[i])).toBe(true);
        expect(Math.hypot(mesh.vertices[i + 3], mesh.vertices[i + 4], mesh.vertices[i + 5])).toBeCloseTo(1, 5);
        minY = Math.min(minY, mesh.vertices[i + 1]);
        maxY = Math.max(maxY, mesh.vertices[i + 1]);
        parts.add(mesh.vertices[i + 6]);
      }
      expect(minY).toBeGreaterThanOrEqual(-0.001);
      expect(maxY).toBeGreaterThan(1.7);
      for (const part of [0, 1, 3, 4, 7, 8]) expect(parts.has(part)).toBe(true);
    }
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
