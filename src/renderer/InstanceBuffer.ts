import { lerpAngle } from '../math/geometry';
import { MAX_AGENTS, SNAPSHOT_STRIDE } from '../types';
import type { Quality } from '../types';
import type { Camera, PersonPose } from './Camera';
import { Frustum } from './Culling';
import { LODManager } from './LODManager';
import { HUMAN_EYE_HEIGHT, HUMAN_GAIT, HUMAN_HEIGHT, HUMAN_JOINTS } from './HumanAnimation';

/** Four vec4s: WGSL Instance is 64-byte aligned/strided. */
export const INSTANCE_FLOATS = 16;
export const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
// Include the extended shoe at full running stride near the edge of the frustum.
const CULL_RADIUS = Math.hypot(HUMAN_HEIGHT / 2, HUMAN_JOINTS.hip);

/** Sample the same pose for the visible mesh and the camera riding with it. */
export function samplePersonPose(pose: PersonPose, from: Float32Array, to: Float32Array, offset: number, alpha: number): number {
  const x = from[offset], z = from[offset + 1];
  const dx = to[offset] - x, dz = to[offset + 1] - z;
  // The worker may skip snapshots. A changed life always starts a new trajectory.
  const t = from[offset + 11] === to[offset + 11] ? alpha : 1;
  pose.x = x + dx * t;
  pose.z = z + dz * t;
  pose.heading = lerpAngle(from[offset + 2], to[offset + 2], t);
  pose.headYaw = from[offset + 13] + (to[offset + 13] - from[offset + 13]) * t;
  pose.scale = to[offset + 6];
  return t;
}

function smoothstep(lo: number, hi: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** Follow the eye landmark through the same hip roll, pelvis travel and forward tilt as the head. */
export function sampleEyePose(pose: PersonPose, from: Float32Array, to: Float32Array, offset: number, alpha: number): void {
  const t = samplePersonPose(pose, from, to, offset, alpha);
  const sample = (field: number) => from[offset + field] + (to[offset + field] - from[offset + field]) * t;
  const speed = sample(3), phase = sample(4);
  const moving = smoothstep(0.02, 0.55, speed), running = smoothstep(1.9, 3.2, speed);
  const stride = (HUMAN_GAIT.walkStride + HUMAN_GAIT.runExtraStride * running) * moving;
  const roll = sample(14) * HUMAN_GAIT.leanAngle;
  const rise = HUMAN_EYE_HEIGHT - HUMAN_JOINTS.hip;
  const drop = (HUMAN_JOINTS.hip - HUMAN_JOINTS.ankle) * (1 - Math.cos(Math.sin(phase) * stride));
  pose.eyeHeight = HUMAN_JOINTS.hip + Math.cos(roll) * rise - drop
    + Math.abs(Math.sin(2 * phase)) * HUMAN_GAIT.bobHeight * moving;
  const breadth = Math.fround(to[offset + 5] * Math.fround(0.618034));
  const width = 0.87 + (breadth - Math.floor(breadth)) * 0.25;
  const side = Math.sin(roll) * rise * width * pose.scale;
  const forward = (pose.eyeHeight - HUMAN_JOINTS.hip) * running * HUMAN_GAIT.runTilt * pose.scale;
  pose.x += Math.cos(pose.heading) * side + Math.sin(pose.heading) * forward;
  pose.z += -Math.sin(pose.heading) * side + Math.cos(pose.heading) * forward;
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
  private readonly pose: PersonPose = { x: 0, z: 0, heading: 0, headYaw: 0, scale: 1 };
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
      const height = HUMAN_HEIGHT * scale;
      if (!this.frustum.containsSphere(x, height / 2, z, CULL_RADIUS * scale)) continue;
      const depth = -(view[2] * x + view[6] * height / 2 + view[10] * z + view[14]);
      const projectedHeight = height * focalLength / Math.max(0.2, depth);
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
      // The procedural shader derives its gait from speed; tint.w carries the shoulder reaction.
      this.scratch[p + 11] = from[s + 14] + (current[s + 14] - from[s + 14]) * t;
      this.scratch[p + 12] = id;
      this.scratch[p + 13] = lod;
      this.scratch[p + 14] = opacity;
      this.scratch[p + 15] = this.pose.headYaw;
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
