import type { Quality } from '../types';

/** CPU selection boundary, replaceable by compute culling/compaction later. */
export class LODManager {
  private readonly previous: Uint8Array;
  constructor(capacity: number) { this.previous = new Uint8Array(capacity).fill(2); }

  select(id: number, projectedHeight: number, quality: Quality): number {
    const high = quality === 'ultra' ? 24 : quality === 'balanced' ? 38 : 60;
    const low = quality === 'ultra' ? 8 : quality === 'balanced' ? 12 : 20;
    const previous = this.previous[id];
    let lod: number;
    if (projectedHeight > high * (previous === 0 ? 0.84 : 1.12)) lod = 0;
    else if (projectedHeight > low * (previous < 2 ? 0.84 : 1.12)) lod = 1;
    else lod = 2;
    this.previous[id] = lod;
    return lod;
  }
  reset(): void { this.previous.fill(2); }
}
