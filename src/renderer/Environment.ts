import { MeshBuilder } from '../math/geometry';
import type { Scenario, Zone } from '../types';
import { addDoorways } from './Doorways';
import { createScrambleEnvironment } from './ScrambleEnvironment';

export const ENVIRONMENT_VERTEX_STRIDE = 40;

/** Procedural scenery or fixtures to merge with a preconverted urban mesh. */
export function createEnvironment(scenario: Scenario) {
  if (scenario.scramble) return createScrambleEnvironment(scenario);
  const mesh = new MeshBuilder(10);
  if (scenario.urbanMap) return mesh.finish();
  const { minX, maxX, minZ, maxZ } = scenario.bounds;
  const width = maxX - minX, depth = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const ground = [0.84, 0.85, 0.80, 1];
  const curb = [0.94, 0.93, 0.86, 0];
  const palette = [
    [0.77, 0.63, 0.51, 0], [0.88, 0.85, 0.75, 0],
    [0.68, 0.73, 0.66, 0], [0.82, 0.75, 0.64, 0],
  ];
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number[]) =>
    mesh.box(x, y, z, w, h, d, color);

  box(cx, -0.63, cz, 1500, 0.1, 1500, [0.82, 0.85, 0.81, 0]);
  box(cx, -0.32, cz, width + 10, 0.48, depth + 10, curb);
  box(cx, -0.05, cz, width, 0.10, depth, ground);
  // Procedural street ends are axis-aligned. Continue the same paving through
  // the backdrop, well beyond the point where the last pedestrian disappears.
  const walks: Zone[] = [];
  for (const portal of scenario.portals ?? []) {
    if (portal.kind !== 'street') continue;
    const end = portal.end, w = portal.width + 2;
    const alongX = Math.abs(end.x - portal.approach.x) > Math.abs(end.z - portal.approach.z);
    const sign = Math.sign(alongX ? end.x - portal.approach.x : end.z - portal.approach.z);
    const edge = alongX ? (sign < 0 ? minX : maxX) : (sign < 0 ? minZ : maxZ);
    const length = sign * ((alongX ? end.x : end.z) - edge) + 22;
    const center = edge + sign * length / 2;
    const walk = alongX
      ? { x: center, z: end.z, width: length, depth: w }
      : { x: end.x, z: center, width: w, depth: length };
    walks.push(walk);
    box(walk.x, -0.29, walk.z, walk.width, 0.58, walk.depth, ground);
  }
  const overlapsWalk = (x: number, z: number, w: number, d: number) => walks.some(walk =>
    Math.abs(walk.x - x) < (walk.width + w) / 2 && Math.abs(walk.z - z) < (walk.depth + d) / 2);
  for (const side of [-1, 1]) {
    const x = cx + side * (width / 2 + 1.2), z = cz + side * (depth / 2 + 1.2);
    if (!overlapsWalk(x, cz, 0.22, depth + 4)) box(x, 0.012, cz, 0.22, 0.024, depth + 4, [0.63, 0.69, 0.62, 0]);
    if (!overlapsWalk(cx, z, width + 4, 0.22)) box(cx, 0.012, z, width + 4, 0.024, 0.22, [0.63, 0.69, 0.62, 0]);
  }

  let index = 0;
  for (const obstacle of scenario.obstacles) {
    const { x, z, width: w, depth: d, height: h } = obstacle;
    if (obstacle.kind === 'planter') {
      box(x, h / 2, z, w, h, d, [0.73, 0.77, 0.67, 0]);
      box(x, h + 0.07, z, w - 0.48, 0.14, d - 0.48, [0.39, 0.50, 0.35, 0]);
      // Tiered, faceted crowns read as trees without any external textures or assets.
      const treeCount = w > 8 ? 3 : 1;
      for (let i = 0; i < treeCount; i++) {
        const tx = x + (i - (treeCount - 1) / 2) * w * 0.26;
        const tz = z + (i % 2 ? 0.65 : -0.45);
        const th = 4.1 + ((index * 7 + i * 3) % 5) * 0.24;
        mesh.prism(tx, h + th * 0.30, tz, 0.24, th * 0.60, 0.24, [0.42,0.37,0.27,0], 6);
        mesh.prism(tx, h + th * 0.76, tz, 3.6, 2.5, 3.6, [0.34,0.48,0.35,0], 7, 0.68);
        mesh.prism(tx + 0.18, h + th * 1.05, tz + 0.12, 2.8, 1.6, 2.8, [0.43,0.56,0.39,0], 7, 0.55);
      }
      // Wood seating lives within the non-walkable planter footprint.
      if (w > 6) {
        box(x, h + 0.16, z + d / 2 - 0.34, w - 1, 0.16, 0.56, [0.61, 0.43, 0.29, 0]);
        box(x, h + 0.16, z - d / 2 + 0.34, w - 1, 0.16, 0.56, [0.61, 0.43, 0.29, 0]);
      }
    } else if (obstacle.kind === 'building') {
      addBuilding(x, z, w, d, h, index++);
    } else {
      box(x, h / 2, z, w, h, d, [0.73, 0.76, 0.70, 0]);
      box(x, h + 0.08, z, w + 0.1, 0.16, d + 0.1, curb);
    }
  }

  // Context blocks remain outside the navigable boundary; they never hide an invisible wall.
  function addBuilding(x: number, z: number, w: number, d: number, h: number, number: number) {
    const color = palette[number % palette.length];
    const door = scenario.portals?.find(p => p.kind === 'door'
      && Math.abs(p.end.x - x) < w / 2 && Math.abs(p.end.z - z) < d / 2);
    const front = door ? Math.sign(door.approach.z - door.end.z) : 1;
    const entranceX = door?.approach.x ?? x;
    box(x, h / 2, z, w, h, d, color);
    box(x, h + 0.14, z, w + 0.35, 0.28, d + 0.35, [0.92, 0.90, 0.81, 0]);
    box(x, h + 0.36, z, w - 0.9, 0.08, d - 0.9, [0.64, 0.67, 0.61, 0]);
    const floors = Math.floor((h - 1) / 3);
    const cols = Math.max(1, Math.floor(w / 3));
    for (let floor = 0; floor < floors; floor++) {
      for (let col = 0; col < cols; col++) {
        const wx = x - w / 2 + (col + 0.5) * w / cols;
        const wy = 2.2 + floor * 3;
        const windowColor = [0.38, 0.48, 0.45, 0];
        for (const side of [-1, 1]) {
          if (door && floor === 0 && side === front && Math.abs(entranceX - wx) < door.width / 2 + 0.8) continue;
          box(wx, wy, z + side * (d / 2 + 0.055), 1.15, 1.45, 0.11, windowColor);
          box(wx, wy - 0.78, z + side * (d / 2 + 0.1), 1.35, 0.1, 0.25, curb);
        }
      }
      const sideCols = Math.max(1, Math.floor(d / 3));
      for (let col = 0; col < sideCols; col++) {
        const wz = z - d / 2 + (col + 0.5) * d / sideCols;
        for (const side of [-1, 1]) {
          box(x + side * (w / 2 + 0.055), 2.2 + floor * 3, wz, 0.11, 1.45, 1.15, [0.38,0.48,0.45,0]);
        }
      }
    }
    if (!door) box(x, 1.3, z + d / 2 + 0.035, Math.min(w * 0.45, 7), 2.6, 0.07, [0.29,0.39,0.36,0]);
    box(entranceX, 2.85, z + front * (d / 2 + 0.6), Math.min(w * 0.55, 8), 0.18, 1.2, [0.59,0.41,0.30,0]);
  }
  for (let i = 0; i < 5; i++) {
    const w = width / 5 - 3;
    const x = minX + (i + 0.5) * width / 5;
    if (!overlapsWalk(x, minZ - 13, w + 2, 18)) addBuilding(x, minZ - 13, w, 16, 8 + ((i * 7) % 5) * 2.2, i);
  }
  for (let i = 0; i < 3; i++) {
    const d = depth / 4 - 3;
    const z = minZ + (i + 0.65) * depth / 3.7;
    if (!overlapsWalk(minX - 14, z, 20, d + 2)) addBuilding(minX - 14, z, 18, d, 8 + i * 3.4, i + 2);
  }
  addDoorways(mesh, scenario.portals);
  return mesh.finish();
}
