import { FIXED_DT, MAX_AGENTS, SNAPSHOT_STRIDE, type SnapshotMessage } from '../types';

export interface SnapshotFrame {
  message: SnapshotMessage;
  data: Float32Array<ArrayBuffer>;
}

/** Owns exactly two transferred snapshots. Older buffers return to the worker. */
export class SnapshotTimeline {
  previous: SnapshotFrame | null = null;
  current: SnapshotFrame | null = null;
  private receivedAt = 0;

  constructor(private readonly recycle: (message: SnapshotMessage) => void) {}

  accept(message: SnapshotMessage, now: number): void {
    if (!Number.isInteger(message.count) || message.count < 1 || message.count > MAX_AGENTS
      || message.buffer.byteLength !== message.count * SNAPSHOT_STRIDE * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('The simulation returned an invalid snapshot layout.');
    }
    if (this.current && message.step < this.current.message.step) {
      this.recycle(message);
      return;
    }
    if (this.previous && this.previous !== this.current) this.recycle(this.previous.message);
    this.previous = this.current;
    this.current = { message, data: new Float32Array(message.buffer) };
    if (!this.previous) this.previous = this.current;
    this.receivedAt = now;
  }

  alpha(now: number, simulationSpeed: number): number {
    if (!this.current || !this.previous || this.current === this.previous) return 1;
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
