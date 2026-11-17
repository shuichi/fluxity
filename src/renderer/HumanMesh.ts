import { MeshBuilder } from '../math/geometry';

export const HUMAN_VERTEX_STRIDE = 28;

/** One shared mesh per LOD; the last vertex component identifies its articulated part. */
export function createHumanMesh(lod: number) {
  const mesh = new MeshBuilder(7);
  const part = (id: number, x: number, y: number, z: number, w: number, h: number, d: number) => {
    if (lod === 0 && (id === 0 || id === 1 || id === 2)) {
      mesh.prism(x, y, z, w * 1.08, h, d * 1.08, [id], 8, id === 0 ? 1.13 : 0.94);
    } else mesh.box(x, y, z, w, h, d, [id]);
  };
  part(0, 0, 1.19, 0, 0.42, 0.55, 0.25);
  part(1, 0, 1.64, 0.015, 0.28, 0.31, 0.28);
  if (lod < 2) {
    part(2, 0, 1.79, -0.012, 0.295, 0.10, 0.29);
    if (lod === 0) {
      part(2, 0, 1.69, -0.12, 0.27, 0.20, 0.08);
      part(1, 0, 1.48, 0, 0.115, 0.1, 0.13);
      // A tiny nose gives a readable front direction when the camera is at street level.
      part(1, 0, 1.65, 0.165, 0.07, 0.07, 0.065);
    }
  }
  for (const side of [-1, 1]) {
    const right = side === 1;
    const ax = side * 0.29, lx = side * 0.12;
    if (lod < 2) {
      part(right ? 4 : 3, ax, 1.25, 0, 0.14, 0.32, 0.16);
      part(right ? 6 : 5, ax, 0.94, 0.015, 0.115, 0.31, 0.13);
      part(right ? 8 : 7, lx, 0.70, 0, 0.18, 0.43, 0.20);
      part(right ? 10 : 9, lx, 0.285, 0, 0.145, 0.40, 0.16);
      part(right ? 12 : 11, lx, 0.075, 0.05, 0.18, 0.15, 0.31);
    } else {
      part(right ? 4 : 3, ax, 1.09, 0, 0.135, 0.63, 0.14);
      part(right ? 8 : 7, lx, 0.47, 0, 0.17, 0.87, 0.18);
    }
  }
  return mesh.finish();
}
