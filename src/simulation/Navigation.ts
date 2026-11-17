import type { Scenario } from '../types';
import { ScrambleGeometry } from './ScrambleGeometry';

export interface Direction { x: number; z: number }

/** Indexed heap keeps Dijkstra construction O(cells log cells), with bounded memory. */
class MinHeap {
  private readonly heap: Int32Array;
  private readonly positions: Int32Array;
  private size = 0;
  constructor(private readonly distances: Float32Array) {
    this.heap = new Int32Array(distances.length);
    this.positions = new Int32Array(distances.length); this.positions.fill(-1);
  }
  get empty(): boolean { return this.size === 0; }
  update(cell: number): void {
    let position = this.positions[cell];
    if (position < 0) { position = this.size++; this.heap[position] = cell; }
    while (position > 0) {
      const parent = (position - 1) >> 1;
      const parentCell = this.heap[parent];
      if (this.distances[parentCell] <= this.distances[cell]) break;
      this.heap[position] = parentCell; this.positions[parentCell] = position; position = parent;
    }
    this.heap[position] = cell; this.positions[cell] = position;
  }
  pop(): number {
    const result = this.heap[0]; this.positions[result] = -1;
    const replacement = this.heap[--this.size];
    if (this.size === 0) return result;
    let position = 0;
    while (true) {
      let child = position * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.distances[this.heap[child + 1]] < this.distances[this.heap[child]]) child++;
      if (this.distances[replacement] <= this.distances[this.heap[child]]) break;
      this.heap[position] = this.heap[child]; this.positions[this.heap[position]] = position; position = child;
    }
    this.heap[position] = replacement; this.positions[replacement] = position;
    return result;
  }
}

export interface FlowField {
  readonly costs: Float32Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
}

/** Shared integration fields, one per destination. Suitable for replacement by a WASM navigator. */
export class Navigation {
  readonly columns: number;
  readonly rows: number;
  readonly walkable: Uint8Array;
  readonly fields: FlowField[];
  readonly cellSize = 1.5;
  readonly scramble: ScrambleGeometry | undefined;
  constructor(readonly scenario: Scenario) {
    this.scramble = scenario.scramble ? new ScrambleGeometry(scenario) : undefined;
    const b = scenario.bounds;
    this.columns = Math.ceil((b.maxX - b.minX) / this.cellSize);
    this.rows = Math.ceil((b.maxZ - b.minZ) / this.cellSize);
    this.walkable = new Uint8Array(this.columns * this.rows);
    for (let z = 0; z < this.rows; z++) for (let x = 0; x < this.columns; x++) {
      this.walkable[z * this.columns + x] = this.isFree(b.minX + (x + 0.5) * this.cellSize, b.minZ + (z + 0.5) * this.cellSize, 0.58) ? 1 : 0;
    }
    this.fields = scenario.targets.map(target => this.buildField(target.x, target.z));
  }
  isFree(x: number, z: number, radius = 0.3): boolean {
    const b = this.scenario.bounds;
    if (x < b.minX + radius || x > b.maxX - radius || z < b.minZ + radius || z > b.maxZ - radius) return false;
    if (this.scramble && !this.scramble.isWalkable(x, z, radius)) return false;
    for (const obstacle of this.scenario.obstacles) {
      if (Math.abs(x - obstacle.x) < obstacle.width * 0.5 + radius && Math.abs(z - obstacle.z) < obstacle.depth * 0.5 + radius) return false;
    }
    return true;
  }
  cellAt(x: number, z: number): number {
    const b = this.scenario.bounds;
    const cx = Math.max(0, Math.min(this.columns - 1, Math.floor((x - b.minX) / this.cellSize)));
    const cz = Math.max(0, Math.min(this.rows - 1, Math.floor((z - b.minZ) / this.cellSize)));
    return cz * this.columns + cx;
  }
  /** Slab test prevents steering straight through obstacles, including diagonally through corners. */
  lineOfSight(x: number, z: number, tx: number, tz: number, radius = 0.58): boolean {
    if (this.scramble && !this.scramble.lineWalkable(x, z, tx, tz, radius)) return false;
    const dx = tx - x, dz = tz - z;
    for (const obstacle of this.scenario.obstacles) {
      const minX = obstacle.x - obstacle.width * 0.5 - radius;
      const maxX = obstacle.x + obstacle.width * 0.5 + radius;
      const minZ = obstacle.z - obstacle.depth * 0.5 - radius;
      const maxZ = obstacle.z + obstacle.depth * 0.5 + radius;
      let enter = 0, leave = 1;
      if (Math.abs(dx) < 1e-8) { if (x < minX || x > maxX) continue; }
      else {
        const a = (minX - x) / dx, b = (maxX - x) / dx;
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      }
      if (Math.abs(dz) < 1e-8) { if (z < minZ || z > maxZ) continue; }
      else {
        const a = (minZ - z) / dz, b = (maxZ - z) / dz;
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      }
      if (leave >= enter && leave > 0 && enter < 1) return false;
    }
    return true;
  }
  direction(x: number, z: number, targetId: number, targetX: number, targetZ: number, result: Direction): void {
    let dx = targetX - x, dz = targetZ - z;
    if (!this.lineOfSight(x, z, targetX, targetZ)) {
      const field = this.fields[targetId];
      let cell = this.cellAt(x, z);
      if (!this.walkable[cell]) {
        let best = Infinity;
        const cx = cell % this.columns, cz = Math.floor(cell / this.columns);
        for (let oz = -2; oz <= 2; oz++) for (let ox = -2; ox <= 2; ox++) {
          const nx = cx + ox, nz = cz + oz;
          if (nx < 0 || nx >= this.columns || nz < 0 || nz >= this.rows) continue;
          const next = nz * this.columns + nx;
          const score = field.costs[next] + Math.hypot(ox, oz) * 2;
          if (this.walkable[next] && score < best) {
            if (this.scramble && !this.scramble.lineWalkable(x, z,
              this.scenario.bounds.minX + (nx + 0.5) * this.cellSize,
              this.scenario.bounds.minZ + (nz + 0.5) * this.cellSize, 0.2)) continue;
            cell = next; best = score;
          }
        }
        const cxWorld = this.scenario.bounds.minX + ((cell % this.columns) + 0.5) * this.cellSize;
        const czWorld = this.scenario.bounds.minZ + (Math.floor(cell / this.columns) + 0.5) * this.cellSize;
        dx = cxWorld - x; dz = czWorld - z;
      } else {
        dx = field.x[cell]; dz = field.z[cell];
      }
    }
    const length = Math.hypot(dx, dz);
    result.x = length > 1e-5 ? dx / length : 0;
    result.z = length > 1e-5 ? dz / length : 0;
  }
  private buildField(targetX: number, targetZ: number): FlowField {
    const count = this.walkable.length;
    const costs = new Float32Array(count); costs.fill(Infinity);
    const x = new Float32Array(count), z = new Float32Array(count);
    let goal = this.cellAt(targetX, targetZ);
    if (!this.walkable[goal]) {
      let best = Infinity;
      for (let i = 0; i < count; i++) if (this.walkable[i]) {
        const dx = this.scenario.bounds.minX + ((i % this.columns) + 0.5) * this.cellSize - targetX;
        const dz = this.scenario.bounds.minZ + (Math.floor(i / this.columns) + 0.5) * this.cellSize - targetZ;
        const distance = dx * dx + dz * dz;
        if (distance < best) { best = distance; goal = i; }
      }
    }
    const heap = new MinHeap(costs); costs[goal] = 0; heap.update(goal);
    while (!heap.empty) {
      const cell = heap.pop(), cx = cell % this.columns, cz = Math.floor(cell / this.columns);
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oz === 0) continue;
        const nx = cx + ox, nz = cz + oz;
        if (nx < 0 || nx >= this.columns || nz < 0 || nz >= this.rows) continue;
        const neighbor = nz * this.columns + nx;
        if (!this.walkable[neighbor]) continue;
        if (ox !== 0 && oz !== 0 && (!this.walkable[cz * this.columns + nx] || !this.walkable[nz * this.columns + cx])) continue;
        const distance = costs[cell] + (ox !== 0 && oz !== 0 ? Math.SQRT2 : 1);
        if (distance + 1e-4 < costs[neighbor]) { costs[neighbor] = distance; heap.update(neighbor); }
      }
    }
    for (let cell = 0; cell < count; cell++) {
      if (!this.walkable[cell] || !Number.isFinite(costs[cell])) continue;
      const cx = cell % this.columns, cz = Math.floor(cell / this.columns);
      let best = costs[cell];
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox, nz = cz + oz;
        if (nx < 0 || nx >= this.columns || nz < 0 || nz >= this.rows) continue;
        const neighbor = nz * this.columns + nx;
        if (ox !== 0 && oz !== 0 && (!this.walkable[cz * this.columns + nx] || !this.walkable[nz * this.columns + cx])) continue;
        if (costs[neighbor] < best) { best = costs[neighbor]; x[cell] = ox; z[cell] = oz; }
      }
      const length = Math.hypot(x[cell], z[cell]);
      if (length > 0) { x[cell] /= length; z[cell] /= length; }
    }
    return { costs, x, z };
  }
}
