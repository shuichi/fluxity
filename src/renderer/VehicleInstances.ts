import { lerpAngle } from '../math/geometry';
import { VEHICLE_SNAPSHOT_STRIDE } from '../types';

const PAINTS = [
  [0.88, 0.89, 0.85], [0.18, 0.26, 0.32], [0.29, 0.43, 0.55], [0.69, 0.70, 0.68],
  [0.54, 0.25, 0.22], [0.20, 0.34, 0.32], [0.76, 0.71, 0.59],
] as const;
const INSTANCE_FLOATS = 7;
export const VEHICLE_INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

/** Pack only occupied slots, preserving paint and pose continuity for each trip. */
export function packVehicleInstances(output: Float32Array, previous: Float32Array, current: Float32Array, alpha: number): number {
  let count = 0;
  for (let i = 0; i < current.length; i += VEHICLE_SNAPSHOT_STRIDE) {
    const life = current[i + 3];
    if (life === 0) continue;
    const continuity = alpha < 1 && previous[i + 3] === life;
    const x = continuity ? previous[i] + (current[i] - previous[i]) * alpha : current[i];
    const z = continuity ? previous[i + 1] + (current[i + 1] - previous[i + 1]) * alpha : current[i + 1];
    const angle = continuity ? lerpAngle(previous[i + 2], current[i + 2], alpha) : current[i + 2];
    const offset = count * INSTANCE_FLOATS;
    output[offset] = x;
    output[offset + 1] = z;
    output[offset + 2] = Math.sin(angle);
    output[offset + 3] = Math.cos(angle);
    output.set(PAINTS[(i / VEHICLE_SNAPSHOT_STRIDE + life) % PAINTS.length], offset + 4);
    count++;
  }
  return count;
}

export class VehicleInstances {
  buffer: GPUBuffer | null = null;
  private packed = new Float32Array(0);

  constructor(private readonly device: GPUDevice) {}

  update(previous: Float32Array, current: Float32Array, alpha: number): number {
    const required = current.length / VEHICLE_SNAPSHOT_STRIDE * INSTANCE_FLOATS;
    if (required > this.packed.length) {
      this.packed = new Float32Array(required);
      this.buffer?.destroy();
      this.buffer = this.device.createBuffer({
        label: 'Passenger car instances', size: this.packed.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const count = packVehicleInstances(this.packed, previous, current, alpha);
    if (count > 0) this.device.queue.writeBuffer(this.buffer!, 0, this.packed.buffer, 0, count * VEHICLE_INSTANCE_STRIDE);
    return count;
  }
}
