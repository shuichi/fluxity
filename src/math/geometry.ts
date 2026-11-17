export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return a + delta * t;
}

/** Shared indexed geometry builder. Normals are per face for crisp low-poly shading. */
export class MeshBuilder {
  private vertices: number[] = [];
  private indices: number[] = [];
  constructor(readonly stride: number) {}

  face(points: number[][], normal: number[], attributes: number[]): void {
    const start = this.vertices.length / this.stride;
    for (const p of points) this.vertices.push(...p, ...normal, ...attributes);
    for (let i = 1; i < points.length - 1; i++) this.indices.push(start, start + i, start + i + 1);
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, attributes: number[]): void {
    const a = x - w / 2, b = x + w / 2, c = y - h / 2, e = y + h / 2;
    const f = z - d / 2, g = z + d / 2;
    this.face([[a,c,g],[b,c,g],[b,e,g],[a,e,g]], [0,0,1], attributes);
    this.face([[b,c,f],[a,c,f],[a,e,f],[b,e,f]], [0,0,-1], attributes);
    this.face([[b,c,g],[b,c,f],[b,e,f],[b,e,g]], [1,0,0], attributes);
    this.face([[a,c,f],[a,c,g],[a,e,g],[a,e,f]], [-1,0,0], attributes);
    this.face([[a,e,g],[b,e,g],[b,e,f],[a,e,f]], [0,1,0], attributes);
    this.face([[a,c,f],[b,c,f],[b,c,g],[a,c,g]], [0,-1,0], attributes);
  }

  /** A vertical polygon prism with separately sized top and bottom rings. */
  prism(x: number, y: number, z: number, w: number, h: number, d: number,
    attributes: number[], sides = 8, taper = 1): void {
    const lower: number[][] = [], upper: number[][] = [];
    const offset = Math.PI / sides;
    for (let i = 0; i < sides; i++) {
      const angle = i / sides * TAU + offset;
      const px = Math.cos(angle) * w / 2, pz = Math.sin(angle) * d / 2;
      lower.push([x + px, y - h / 2, z + pz]);
      upper.push([x + px * taper, y + h / 2, z + pz * taper]);
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const dx = lower[j][0] - lower[i][0], dz = lower[j][2] - lower[i][2];
      const slopeX = (upper[i][0] - lower[i][0]) / h;
      const slopeZ = (upper[i][2] - lower[i][2]) / h;
      const ny = -(dz * slopeX - dx * slopeZ);
      const length = Math.hypot(dz, ny, dx);
      this.face([lower[j], lower[i], upper[i], upper[j]], [dz / length, ny / length, -dx / length], attributes);
    }
    this.face(upper.slice().reverse(), [0,1,0], attributes);
    this.face(lower, [0,-1,0], attributes);
  }

  finish(): { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices) };
  }
}
