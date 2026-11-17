import type { Bounds } from '../types';

/** Counting-sort grid: contiguous agent indices per cell; zero per-step allocations. */
export class SpatialGrid {
  readonly columns: number;
  readonly rows: number;
  readonly counts: Uint32Array;
  readonly offsets: Uint32Array;
  readonly indices: Uint32Array;
  readonly cells: Uint32Array;
  private readonly cursors: Uint32Array;
  constructor(readonly bounds: Bounds, capacity: number, readonly cellSize = 2.4) {
    this.columns = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cellSize);
    const size = this.columns * this.rows;
    this.counts = new Uint32Array(size); this.offsets = new Uint32Array(size + 1);
    this.cursors = new Uint32Array(size); this.indices = new Uint32Array(capacity);
    this.cells = new Uint32Array(capacity);
  }
  cellAt(x: number, z: number): number {
    const cx = Math.max(0, Math.min(this.columns - 1, Math.floor((x - this.bounds.minX) / this.cellSize)));
    const cz = Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.bounds.minZ) / this.cellSize)));
    return cz * this.columns + cx;
  }
  rebuild(x: Float32Array, z: Float32Array, count: number): void {
    this.counts.fill(0);
    for (let i = 0; i < count; i++) {
      const cell = this.cellAt(x[i], z[i]);
      this.cells[i] = cell; this.counts[cell]++;
    }
    let offset = 0;
    for (let cell = 0; cell < this.counts.length; cell++) {
      this.offsets[cell] = offset; this.cursors[cell] = offset; offset += this.counts[cell];
    }
    this.offsets[this.counts.length] = offset;
    for (let i = 0; i < count; i++) this.indices[this.cursors[this.cells[i]]++] = i;
  }
}
