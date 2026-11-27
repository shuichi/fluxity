import type { Bounds } from '../types';
import type { AgentData } from './AgentData';

const CELL = 1.6; // metres
const SAMPLE_PERIOD = 0.25;
const HALF_LIFE = 0.8;

/** Time-smoothed people/m² and pedestrian momentum on the local crossing grid. */
export class CrossingTraffic {
  private readonly columns: number;
  private readonly rows: number;
  private readonly sample: Float32Array;
  private readonly field: Float32Array;
  private elapsed = 0;

  constructor(private readonly bounds: Bounds) {
    this.columns = Math.ceil((bounds.maxX - bounds.minX) / CELL);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / CELL);
    this.sample = new Float32Array(this.rows * this.columns * 3);
    this.field = new Float32Array(this.sample.length);
  }

  update(agents: AgentData, dt: number): boolean {
    this.elapsed += dt;
    if (this.elapsed + 1e-8 < SAMPLE_PERIOD) return false;
    const blend = 1 - Math.pow(0.5, this.elapsed / HALF_LIFE);
    this.elapsed = 0;
    this.sample.fill(0);
    const { x, z, vx, vz } = agents.current;
    for (let id = 0; id < agents.count; id++) {
      if (agents.portalStage[id]) continue;
      const col = Math.floor((x[id] - this.bounds.minX) / CELL);
      const row = Math.floor((z[id] - this.bounds.minZ) / CELL);
      if (col < 0 || col >= this.columns || row < 0 || row >= this.rows) continue;
      const index = 3 * (row * this.columns + col);
      this.sample[index]++;
      this.sample[index + 1] += vx[id];
      this.sample[index + 2] += vz[id];
    }
    const area = CELL * CELL;
    for (let i = 0; i < this.field.length; i++) {
      this.field[i] += blend * (this.sample[i] / area - this.field[i]);
    }
    return true;
  }

  /** Bilinear sampling in travel direction. Opposing motion adds to the density cost. */
  cost(x: number, z: number, ux: number, uz: number): number {
    const cx = (x - this.bounds.minX) / CELL - 0.5, cz = (z - this.bounds.minZ) / CELL - 0.5;
    const col = Math.floor(cx), row = Math.floor(cz);
    if (col < 0 || col + 1 >= this.columns || row < 0 || row + 1 >= this.rows) return 0;
    const fx = cx - col, fz = cz - row;
    let density = 0, flux = 0;
    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c <= 1; c++) {
        const weight = (r ? fz : 1 - fz) * (c ? fx : 1 - fx);
        const index = 3 * ((row + r) * this.columns + col + c);
        density += weight * this.field[index];
        flux += weight * (ux * this.field[index + 1] + uz * this.field[index + 2]);
      }
    }
    return density + Math.max(0, -flux) / 1.35;
  }
}
