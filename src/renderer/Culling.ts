import type { mat4 } from 'gl-matrix';

/** Six normalized planes for WebGPU's zero-to-one clip depth. No per-frame allocations. */
export class Frustum {
  private readonly planes = new Float32Array(24);

  update(m: mat4): void {
    const p = this.planes;
    for (let i = 0; i < 4; i++) {
      p[i] = m[i * 4 + 3] + m[i * 4];
      p[4 + i] = m[i * 4 + 3] - m[i * 4];
      p[8 + i] = m[i * 4 + 3] + m[i * 4 + 1];
      p[12 + i] = m[i * 4 + 3] - m[i * 4 + 1];
      p[16 + i] = m[i * 4 + 2];
      p[20 + i] = m[i * 4 + 3] - m[i * 4 + 2];
    }
    for (let i = 0; i < 24; i += 4) {
      const length = Math.hypot(p[i], p[i + 1], p[i + 2]);
      for (let j = 0; j < 4; j++) p[i + j] /= length;
    }
  }

  containsSphere(x: number, y: number, z: number, radius: number): boolean {
    const p = this.planes;
    for (let i = 0; i < 24; i += 4) {
      if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -radius) return false;
    }
    return true;
  }
}
