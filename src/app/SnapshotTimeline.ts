import { FIXED_DT, MAX_AGENTS, SNAPSHOT_STRIDE, VEHICLE_SNAPSHOT_STRIDE, type SnapshotMessage } from '../types';

export interface SnapshotFrame {
  message: SnapshotMessage;
  data: Float32Array<ArrayBuffer>;
  vehicles: Float32Array<ArrayBuffer>;
}

/** Owns exactly two transferred snapshots. Older buffers return to the worker. */
export class SnapshotTimeline {
  previous: SnapshotFrame | null = null;
  current: SnapshotFrame | null = null;
  private receivedAt = 0;
  private canInterpolate = false;

  constructor(private readonly recycle: (message: SnapshotMessage) => void) {}

  accept(message: SnapshotMessage, now: number): void {
    const crowdFloats = message.count * SNAPSHOT_STRIDE;
    if (!Number.isInteger(message.count) || message.count < 1 || message.count > MAX_AGENTS
      || !Number.isSafeInteger(message.vehicleCapacity) || message.vehicleCapacity < 0
      || message.buffer.byteLength !== (crowdFloats + message.vehicleCapacity * VEHICLE_SNAPSHOT_STRIDE) * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('The simulation returned an invalid snapshot layout.');
    }
    if (this.current && (message.generation < this.current.message.generation
      || (message.generation === this.current.message.generation && message.step < this.current.message.step))) {
      this.recycle(message);
      return;
    }
    if (this.previous && this.previous !== this.current) this.recycle(this.previous.message);
    this.previous = this.current;
    this.current = {
      message, data: new Float32Array(message.buffer, 0, crowdFloats),
      vehicles: new Float32Array(message.buffer, crowdFloats * Float32Array.BYTES_PER_ELEMENT),
    };
    this.canInterpolate = this.previous !== null && this.previous.message.generation === message.generation
      && this.previous.message.count === message.count && this.previous.message.vehicleCapacity === message.vehicleCapacity;
    // Interpolation is safe across a single verified traffic step. Joining endpoints across missing
    // steps or a respawn could show two trajectories meeting between otherwise valid positions.
    if (this.canInterpolate && this.previous && message.vehicleCapacity > 0) {
      this.canInterpolate = message.step === this.previous.message.step + 1
        && message.signal?.pedestrian === this.previous.message.signal?.pedestrian
        && message.signal?.eastWest === this.previous.message.signal?.eastWest
        && message.signal?.northSouth === this.previous.message.signal?.northSouth
        && sameLives(this.previous.vehicles, this.current.vehicles, 3, VEHICLE_SNAPSHOT_STRIDE)
        && sameLives(this.previous.data, this.current.data, 11, SNAPSHOT_STRIDE);
    }
    if (!this.previous) this.previous = this.current;
    this.receivedAt = now;
  }

  alpha(now: number, simulationSpeed: number): number {
    if (!this.canInterpolate || !this.current || !this.previous) return 1;
    const delta = this.current.message.simulationTime - this.previous.message.simulationTime;
    const interval = (delta > 0 ? delta : FIXED_DT) * 1000 / Math.max(simulationSpeed, 0.1);
    return Math.min(1, Math.max(0, (now - this.receivedAt) / interval));
  }

  clear(): void {
    if (this.previous && this.previous !== this.current) this.recycle(this.previous.message);
    if (this.current) this.recycle(this.current.message);
    this.previous = this.current = null;
  }
}

function sameLives(previous: Float32Array, current: Float32Array, lifeOffset: number, stride: number): boolean {
  for (let i = lifeOffset; i < current.length; i += stride) {
    if (previous[i] !== current[i]) return false;
  }
  return true;
}
