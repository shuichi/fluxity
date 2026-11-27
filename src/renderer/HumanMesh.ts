import { MeshBuilder } from '../math/geometry';
import { HUMAN_HEIGHT, HUMAN_JOINTS, HUMAN_SHOULDER_BREADTH } from './HumanAnimation';

export const HUMAN_VERTEX_STRIDE = 28;

/** The three meshes share their sole, crown and joint landmarks in metres. */
export function createHumanMesh(lod: number) {
  const mesh = new MeshBuilder(7);
  const part = (id: number, x: number, bottom: number, top: number, z: number, width: number, depth: number) => {
    const y = (bottom + top) / 2, height = top - bottom;
    if (lod === 2 && id >= 3) {
      // Six vertices keep an articulated limb at far LOD. Fit the triangular
      // prism's three corners to the same width and depth as its close-up box.
      mesh.prism(x + width / 6, y, z, width * 4 / 3, height, depth * 2 / Math.sqrt(3), [id], 3);
    } else if (lod === 0 && id <= 2) {
      // The octagon's vertices sit half a sector away from the width/depth axes.
      const diameter = 1 / Math.cos(Math.PI / 8);
      mesh.prism(x, y, z, width * diameter, height, depth * diameter, [id], 8, id === 0 ? 1.06 : 0.97);
    } else mesh.box(x, y, z, width, height, depth, [id]);
  };
  const { hip, hipX, shoulder, shoulderX, elbow, knee, ankle, neck } = HUMAN_JOINTS;
  const chin = HUMAN_HEIGHT - 0.234;
  part(0, 0, hip - 0.035, lod === 2 ? chin : shoulder + 0.022, 0, 0.319, 0.217);
  part(1, 0, chin, lod < 2 ? HUMAN_HEIGHT - 0.012 : HUMAN_HEIGHT, 0.009, 0.158, 0.185);
  if (lod < 2) part(2, 0, HUMAN_HEIGHT - 0.058, HUMAN_HEIGHT, 0.002, 0.168, 0.194);
  if (lod < 2) part(1, 0, shoulder + 0.012, neck + 0.019, 0, 0.101, 0.116);
  if (lod === 0) {
    part(2, 0, HUMAN_HEIGHT - 0.149, HUMAN_HEIGHT - 0.025, -0.071, 0.152, 0.044);
    part(1, 0, 1.491, 1.534, 0.102, 0.033, 0.039);
  }
  const upperArmWidth = HUMAN_SHOULDER_BREADTH - 2 * shoulderX;
  // The shader unfolds this handset at the right hand as the arm rises.
  if (lod < 2) mesh.box(shoulderX, 0.684, 0.029, 0.076, 0.147, 0.012, [13]);
  for (const side of [-1, 1]) {
    const right = side === 1, ax = side * shoulderX, lx = side * hipX;
    const fingertip = 0.623;
    part(right ? 4 : 3, ax, lod < 2 ? elbow - 0.012 : fingertip, shoulder + 0.021, 0, upperArmWidth, 0.103);
    if (lod < 2) part(right ? 6 : 5, ax, fingertip, elbow + 0.01, 0.009, 0.073, 0.083);
    part(right ? 8 : 7, lx, knee - 0.013, hip + 0.017, 0, 0.146, 0.159);
    part(right ? 10 : 9, lx, ankle - 0.009, knee + 0.014, -0.005, 0.105, 0.114);
    part(right ? 12 : 11, lx, 0, ankle + 0.026, 0.054, 0.108, 0.258);
  }
  return mesh.finish();
}
