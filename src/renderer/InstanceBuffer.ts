import { lerpAngle } from '../math/geometry';
import { MAX_AGENTS, SNAPSHOT_STRIDE } from '../types';
import type { Quality } from '../types';
import type { Camera, PersonPose } from './Camera';
import { Frustum } from './Culling';
import { LODManager } from './LODManager';

/** Four vec4s: WGSL Instance is 64-byte aligned/strided. */
export const INSTANCE_FLOATS = 16;
export const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

/** Sample the same pose for the visible mesh and the camera riding with it. */
export function samplePersonPose(pose: PersonPose, from: Float32Array, to: Float32Array, offset: number, alpha: number): number {
  const x = from[offset], z = from[offset + 1];
  const dx = to[offset] - x, dz = to[offset + 1] - z;
  // The worker may skip snapshots. A changed life always starts a new trajectory.
  const t = from[offset + 11] === to[offset + 11] ? alpha : 1;
  pose.x = x + dx * t;
  pose.z = z + dz * t;
  pose.heading = lerpAngle(from[offset + 2], to[offset + 2], t);
  pose.scale = to[offset + 6];
  return t;
}

export class InstanceBuffer {
  readonly buffer: GPUBuffer;
  readonly lod = new LODManager(MAX_AGENTS);
  readonly counts: [number, number, number] = [0, 0, 0];
  readonly offsets: [number, number, number] = [0, 0, 0];
  private readonly scratch = new Float32Array(MAX_AGENTS * INSTANCE_FLOATS);
  private readonly packed = new Float32Array(MAX_AGENTS * INSTANCE_FLOATS);
  private readonly ids = new Uint32Array(MAX_AGENTS);
  readonly visibleLives = new Uint32Array(MAX_AGENTS);
  private readonly levels = new Uint8Array(MAX_AGENTS);
  private readonly frustum = new Frustum();
  private readonly pose: PersonPose = { x: 0, z: 0, heading: 0, scale: 1 };
  visible = 0;

  constructor(private readonly device: GPUDevice) {
    this.buffer = device.createBuffer({
      label: 'Compacted human instances · 64 bytes / person',
      size: MAX_AGENTS * INSTANCE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  update(from: Float32Array, current: Float32Array, count: number, alpha: number,
    camera: Camera, viewportHeight: number, quality: Quality, followedId?: number): void {
    this.frustum.update(camera.viewProjection);
    this.counts[0] = 0; this.counts[1] = 0; this.counts[2] = 0;
    this.visible = 0;
    const focalLength = viewportHeight / (2 * Math.tan(camera.fov / 2));
    const view = camera.view;
    for (let id = 0; id < count; id++) {
      if (id === followedId) continue;
      const s = id * SNAPSHOT_STRIDE;
      const t = samplePersonPose(this.pose, from, current, s, alpha);
      const opacity = from[s + 12] + (current[s + 12] - from[s + 12]) * t;
      if (opacity <= 0) continue;
      const { x, z, scale, heading } = this.pose;
      if (!this.frustum.containsSphere(x, 0.94 * scale, z, 1.12 * scale)) continue;
      const depth = -(view[2] * x + view[6] * scale + view[10] * z + view[14]);
      const projectedHeight = 1.85 * scale * focalLength / Math.max(0.2, depth);
      const lod = this.lod.select(id, projectedHeight, quality);
      this.ids[this.visible++] = id;
      this.visibleLives[id] = current[s + 11];
      this.levels[id] = lod;
      this.counts[lod]++;
      const p = id * INSTANCE_FLOATS;
      this.scratch[p] = x; this.scratch[p + 1] = 0; this.scratch[p + 2] = z;
      this.scratch[p + 3] = heading;
      this.scratch[p + 4] = scale;
      this.scratch[p + 5] = from[s + 3] + (current[s + 3] - from[s + 3]) * t;
      this.scratch[p + 6] = from[s + 4] + (current[s + 4] - from[s + 4]) * t;
      this.scratch[p + 7] = current[s + 5];
      this.scratch[p + 8] = current[s + 8];
      this.scratch[p + 9] = current[s + 9];
      this.scratch[p + 10] = current[s + 10];
      this.scratch[p + 11] = current[s + 7];
      this.scratch[p + 12] = id;
      this.scratch[p + 13] = lod;
      this.scratch[p + 14] = opacity;
    }
    this.offsets[0] = 0;
    this.offsets[1] = this.counts[0];
    this.offsets[2] = this.counts[0] + this.counts[1];
    let offset0 = 0, offset1 = this.offsets[1], offset2 = this.offsets[2];
    for (let i = 0; i < this.visible; i++) {
      const id = this.ids[i], lod = this.levels[id];
      const destination = (lod === 0 ? offset0++ : lod === 1 ? offset1++ : offset2++) * INSTANCE_FLOATS;
      const source = id * INSTANCE_FLOATS;
      // A scalar copy avoids allocating a subarray for each person.
      for (let j = 0; j < INSTANCE_FLOATS; j++) this.packed[destination + j] = this.scratch[source + j];
    }
    if (this.visible > 0) this.device.queue.writeBuffer(this.buffer, 0, this.packed.buffer, 0, this.visible * INSTANCE_STRIDE);
  }

  destroy(): void { this.buffer.destroy(); }
}
