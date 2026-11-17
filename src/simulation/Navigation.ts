import type { Point2, Scenario } from '../types';
import { ScrambleGeometry } from './ScrambleGeometry';
import { UrbanGeometry } from './UrbanGeometry';

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
  readonly cellSize: number;
  readonly clearance: number;
  readonly scramble: ScrambleGeometry | UrbanGeometry | undefined;
  readonly urban: UrbanGeometry | undefined;
  readonly goals: Point2[] = [];
  readonly spawnCells: number[] = [];
  private readonly connections: Uint8Array | undefined;
  constructor(readonly scenario: Scenario) {
    this.urban = scenario.urbanMap ? new UrbanGeometry(scenario) : undefined;
    this.scramble = this.urban ?? (scenario.scramble ? new ScrambleGeometry(scenario) : undefined);
    this.cellSize = scenario.navigationCellSize ?? (this.urban ? 1 : 1.5);
    if (!Number.isFinite(this.cellSize) || this.cellSize < 0.25 || this.cellSize > 4) throw new Error('Invalid navigation cell size.');
    if (!scenario.targets.length || !scenario.spawnZones.length) throw new Error('A scenario requires destinations and spawn zones.');
    for (const index of [...(scenario.spawnTargets ?? []), ...(scenario.targetTransitions ?? [])]) {
      if (!Number.isInteger(index) || index < 0 || index >= scenario.targets.length) throw new Error('A scenario references an invalid destination.');
    }
    this.clearance = this.urban ? 0.34 : 0.58;
    const b = scenario.bounds;
    this.columns = Math.ceil((b.maxX - b.minX) / this.cellSize);
    this.rows = Math.ceil((b.maxZ - b.minZ) / this.cellSize);
    this.walkable = new Uint8Array(this.columns * this.rows);
    for (let z = 0; z < this.rows; z++) for (let x = 0; x < this.columns; x++) {
      this.walkable[z * this.columns + x] = this.isFree(b.minX + (x + 0.5) * this.cellSize, b.minZ + (z + 0.5) * this.cellSize, this.clearance) ? 1 : 0;
    }
    if (this.urban) {
      this.connections = new Uint8Array(this.walkable.length);
      this.connectUrbanCells();
    }
    this.fields = scenario.targets.map(target => this.buildField(target.x, target.z));
    // A real map can include disconnected courtyards. Keep the component shared by every destination.
    if (this.urban) for (let cell = 0; cell < this.walkable.length; cell++) {
      if (this.walkable[cell] && !this.fields.every(field => Number.isFinite(field.costs[cell]))) this.walkable[cell] = 0;
    }
    if (this.urban && this.goals.some(goal => !this.walkable[this.cellAt(goal.x, goal.z)])) {
      throw new Error('Map destinations are disconnected: check crossing widths and sidewalk connections.');
    }
    for (let cell = 0; cell < this.walkable.length; cell++) if (this.walkable[cell]) {
      const x = b.minX + (cell % this.columns + 0.5) * this.cellSize;
      const z = b.minZ + (Math.floor(cell / this.columns) + 0.5) * this.cellSize;
      if (!this.scramble || this.scramble.isSidewalk(x, z, 0.7)) this.spawnCells.push(cell);
    }
    if (!this.spawnCells.length) throw new Error('Map has no reachable sidewalk cells for spawning.');
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
  isReachable(x: number, z: number, target = 0): boolean {
    const cell = this.cellAt(x, z);
    return !!this.walkable[cell] && Number.isFinite(this.fields[target]?.costs[cell]);
  }
  isSpawnable(x: number, z: number, radius = 0.7): boolean {
    return this.isFree(x, z, radius) && (!this.scramble || this.scramble.isSidewalk(x, z, radius))
      && (!this.urban || this.isReachable(x, z));
  }
  private connectUrbanCells(): void {
    const b = this.scenario.bounds;
    for (let cell = 0; cell < this.walkable.length; cell++) {
      if (!this.walkable[cell]) continue;
      const cx = cell % this.columns, cz = Math.floor(cell / this.columns);
      const x = b.minX + (cx + 0.5) * this.cellSize, z = b.minZ + (cz + 0.5) * this.cellSize;
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oz) continue;
        const nx = cx + ox, nz = cz + oz;
        if (nx < 0 || nx >= this.columns || nz < 0 || nz >= this.rows || !this.walkable[nz * this.columns + nx]) continue;
        if (ox && oz && (!this.walkable[cz * this.columns + nx] || !this.walkable[nz * this.columns + cx])) continue;
        if (this.urban!.lineWalkable(x, z, x + ox * this.cellSize, z + oz * this.cellSize, this.clearance)) {
          const bit = (oz + 1) * 3 + ox + 1;
          this.connections![cell] |= 1 << (bit > 4 ? bit - 1 : bit);
        }
      }
    }
  }
  private connected(cell: number, ox: number, oz: number): boolean {
    if (!this.connections) return true;
    const bit = (oz + 1) * 3 + ox + 1;
    return !!(this.connections[cell] & (1 << (bit > 4 ? bit - 1 : bit)));
  }
  /** Slab test prevents steering straight through obstacles, including diagonally through corners. */
  lineOfSight(x: number, z: number, tx: number, tz: number, radius = this.clearance): boolean {
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
  direction(x: number, z: number, targetId: number, targetX: number, targetZ: number, result: Direction, radius = this.clearance): void {
    if (this.urban) { this.urbanDirection(x, z, targetId, targetX, targetZ, result, radius); return; }
    let dx = targetX - x, dz = targetZ - z;
    if (!this.lineOfSight(x, z, targetX, targetZ)) {
      const field = this.fields[targetId];
      let cell = this.cellAt(x, z);
      if (!this.walkable[cell] || !Number.isFinite(field.costs[cell])) {
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
  /** Short flow-field lookahead avoids tracing a hundred-meter polygon ray for every agent. */
  private urbanDirection(x: number, z: number, targetId: number, targetX: number, targetZ: number, result: Direction, radius: number): void {
    let dx = targetX - x, dz = targetZ - z;
    if (dx * dx + dz * dz > 100 || !this.urban!.lineWalkable(x, z, targetX, targetZ, radius)) {
      const field = this.fields[targetId], bounds = this.scenario.bounds;
      let cell = this.cellAt(x, z), chosen = -1;
      const cx = cell % this.columns, cz = Math.floor(cell / this.columns);
      let best = Infinity;
      // Include a nearby cell on the same component when avoidance moves off the raster centerline.
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox, nz = cz + oz;
        if (nx < 0 || nx >= this.columns || nz < 0 || nz >= this.rows) continue;
        const next = nz * this.columns + nx;
        if (!this.walkable[next] || !Number.isFinite(field.costs[next])) continue;
        const px = bounds.minX + (nx + 0.5) * this.cellSize, pz = bounds.minZ + (nz + 0.5) * this.cellSize;
        const score = field.costs[next] + Math.hypot(px - x, pz - z) * 0.1;
        if (score >= best || !this.urban!.lineWalkable(x, z, px, pz, radius)) continue;
        chosen = next; best = score;
      }
      if (chosen < 0) { result.x = result.z = 0; return; }
      cell = chosen;
      let px = bounds.minX + (cell % this.columns + 0.5) * this.cellSize;
      let pz = bounds.minZ + (Math.floor(cell / this.columns) + 0.5) * this.cellSize;
      for (let step = 0; step < 3; step++) {
        const ox = Math.sign(field.x[cell]), oz = Math.sign(field.z[cell]);
        if ((!ox && !oz) || !this.connected(cell, ox, oz)) break;
        const next = cell + oz * this.columns + ox;
        const nx = bounds.minX + (next % this.columns + 0.5) * this.cellSize;
        const nz = bounds.minZ + (Math.floor(next / this.columns) + 0.5) * this.cellSize;
        if (!this.walkable[next] || !this.urban!.lineWalkable(x, z, nx, nz, radius)) break;
        cell = next; px = nx; pz = nz;
      }
      dx = px - x; dz = pz - z;
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
    if (!this.walkable[goal]) throw new Error('Map has no walkable navigation cells.');
    this.goals.push({ x: this.scenario.bounds.minX + (goal % this.columns + 0.5) * this.cellSize,
      z: this.scenario.bounds.minZ + (Math.floor(goal / this.columns) + 0.5) * this.cellSize });
    const heap = new MinHeap(costs); costs[goal] = 0; heap.update(goal);
    while (!heap.empty) {
      const cell = heap.pop(), cx = cell % this.columns, cz = Math.floor(cell / this.columns);
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oz === 0) continue;
        const nx = cx + ox, nz = cz + oz;
        if (nx < 0 || nx >= this.columns || nz < 0 || nz >= this.rows) continue;
        const neighbor = nz * this.columns + nx;
        if (!this.walkable[neighbor] || !this.connected(cell, ox, oz)) continue;
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
        if ((ox || oz) && this.connected(cell, ox, oz) && costs[neighbor] < best) { best = costs[neighbor]; x[cell] = ox; z[cell] = oz; }
      }
      const length = Math.hypot(x[cell], z[cell]);
      if (length > 0) { x[cell] /= length; z[cell] /= length; }
    }
    return { costs, x, z };
  }
}
