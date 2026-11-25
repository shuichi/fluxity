import { describe, expect, it } from 'vitest';
import { createEnvironment } from '../renderer/Environment';
import { plaza } from '../scenarios/plaza';

const { vertices, indices } = createEnvironment(plaza);

// Return the intersected planes along a ray normal to an axis-aligned surface.
function surfaces(u: number, v: number, axis: 1 | 2, normal: number): number[] {
  const second = axis === 1 ? 2 : 1;
  const hits: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 10;
    if (vertices[a + axis + 3] !== normal) continue;
    const b = indices[i + 1] * 10, c = indices[i + 2] * 10;
    const side = (a: number, b: number) =>
      (vertices[b] - vertices[a]) * (v - vertices[a + second])
      - (vertices[b + second] - vertices[a + second]) * (u - vertices[a]);
    const ab = side(a, b), bc = side(b, c), ca = side(c, a);
    if ((ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0)) hits.push(vertices[a + axis]);
  }
  return hits;
}

describe('City Plaza entrance scenery', () => {
  it('continues street paving at foot level past the fade with no trim or buildings across the lanes', () => {
    for (const p of plaza.portals!.filter(p => p.kind === 'street')) {
      const dx = Math.sign(p.end.x - p.approach.x), dz = Math.sign(p.end.z - p.approach.z);
      for (let d = -5; d <= 8; d += 0.25) for (const offset of [-p.width / 2, 0, p.width / 2]) {
        const x = p.end.x + dx * d + dz * offset, z = p.end.z + dz * d - dx * offset;
        expect(Math.max(...surfaces(x, z, 1, 1)), p.id).toBeCloseTo(0);
      }
    }
  });

  it('places an unobstructed doorway on each shop facade facing the square', () => {
    for (const p of plaza.portals!.filter(p => p.kind === 'door')) {
      const normal = Math.sign(p.approach.z - p.end.z);
      for (const offset of [-p.width / 2 + 0.35, 0, p.width / 2 - 0.35]) {
        const distances = surfaces(p.end.x + offset, 1.65, 2, normal)
          .map(z => (z - p.end.z) * normal).filter(d => d < (p.approach.z - p.end.z) * normal);
        // The recessed doorway back lies just in front of the facade. A window
        // or a second decorative door here would mask the opening.
        expect(Math.max(...distances), p.id).toBeCloseTo(0.865, 3);
      }
    }
  });
});
