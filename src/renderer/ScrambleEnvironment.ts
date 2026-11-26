import { MeshBuilder } from '../math/geometry';
import { VehiclePath } from '../simulation/VehiclePath';
import type { Scenario } from '../types';
import { addDoorways } from './Doorways';
import { addTrafficLights } from './TrafficLights';

// The fourth vertex color component selects the material in the environment shader.
export const SCENE_MATERIAL = { paving: 1, paint: 2, sign: 3, mappedPaving: 4 } as const;

const GLYPHS: Record<string, readonly number[]> = {
  A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [14,17,16,16,16,17,14],
  D: [30,17,17,17,17,17,30], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16],
  G: [14,17,16,23,17,17,15], H: [17,17,17,31,17,17,17], I: [31,4,4,4,4,4,31],
  J: [7,2,2,2,2,18,12], K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31],
  M: [17,27,21,21,17,17,17], N: [17,25,25,21,19,19,17], O: [14,17,17,17,17,17,14],
  P: [30,17,17,30,16,16,16], Q: [14,17,17,17,21,18,13], R: [30,17,17,30,20,18,17],
  S: [15,16,16,14,1,1,30], T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14],
  V: [17,17,17,17,17,10,4], W: [17,17,17,21,21,27,17], X: [17,17,10,4,10,17,17],
  Y: [17,17,10,4,4,4,4], Z: [31,1,2,4,8,16,31],
  '0': [14,17,19,21,25,17,14], '1': [4,12,4,4,4,4,14], '2': [14,17,1,2,4,8,31],
  '3': [30,1,1,14,1,1,30], '9': [14,17,17,15,1,1,14], ' ': [0,0,0,0,0,0,0],
};

type Vec3 = [number, number, number];

/** Geometry uses the same road/crosswalk/signal data as navigation and stop lines. */
export function createScrambleEnvironment(scenario: Scenario) {
  const scramble = scenario.scramble;
  if (!scramble) throw new Error('A scramble environment requires shared road geometry.');
  const mesh = new MeshBuilder(10);
  addTrafficLights(mesh, scenario);
  // Calibrated stop bars tile the PLATEAU carriageway itself alongside other paint.
  for (const lane of scenario.roadMarkings ? [] : scenario.vehicleLanes ?? []) {
    // The front bumper stops at the near edge of this 0.4 m stripe on the asphalt (y=0).
    const center = new VehiclePath(lane).sample((lane.entry ?? lane.stop) + 0.2);
    horizontalMark(center.x, center.z, 0.2, 1.75, center.ux, center.uz);
  }
  // PLATEAU buildings, surfaces and clipped zebra paint are already in the static asset.
  if (scenario.urbanMap) {
    addDoorways(mesh, scenario.portals);
    return mesh.finish();
  }
  const { minX, maxX, minZ, maxZ } = scenario.bounds;
  const width = maxX - minX, depth = maxZ - minZ;
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  const road = scramble.roadHalfWidth;
  mesh.box(centerX, -0.63, centerZ, 1500, 0.1, 1500, [0.78,0.81,0.79,0]);
  mesh.box(centerX, -0.30, centerZ, width + 10, 0.44, depth + 10, [0.82,0.84,0.80,0]);
  // The ground shader shades a cross-shaped road on this one surface: no overlapping slabs.
  mesh.box(centerX, -0.05, centerZ, width, 0.10, depth, [0.79,0.81,0.77,SCENE_MATERIAL.paving]);

  function horizontalMark(x: number, z: number, halfAlong: number, halfAcross: number,
    alongX: number, alongZ: number, color = [0.91,0.92,0.85,SCENE_MATERIAL.paint]) {
    const acrossX = -alongZ, acrossZ = alongX;
    const point = (along: number, across: number): number[] => [
      x + alongX * along + acrossX * across, 0.012,
      z + alongZ * along + acrossZ * across,
    ];
    mesh.face([
      point(-halfAlong, -halfAcross), point(-halfAlong, halfAcross),
      point(halfAlong, halfAcross), point(halfAlong, -halfAcross),
    ], [0,1,0], color);
  }

  for (const crosswalk of scramble.crosswalks) {
    const dx = crosswalk.to.x - crosswalk.from.x, dz = crosswalk.to.z - crosswalk.from.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001 || crosswalk.width <= 0) continue;
    const ux = dx / length, uz = dz / length;
    const stripes = Math.max(1, Math.floor(length / 1.85));
    for (let i = 0; i < stripes; i++) {
      const travel = (i + 0.5) * length / stripes;
      horizontalMark(crosswalk.from.x + ux * travel, crosswalk.from.z + uz * travel,
        0.48, crosswalk.width / 2, ux, uz);
    }
  }

  // Lane markings on the procedural map stop before pedestrian crossings.
  const outer = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minZ), Math.abs(maxZ));
  for (const side of [-1, 1]) {
    for (let travel = road * 2.25; travel < outer - 3; travel += 8) {
      for (const lane of [-road / 3, road / 3]) {
        horizontalMark(lane, side * travel, 1.8, 0.10, 0, 1);
        horizontalMark(side * travel, lane, 1.8, 0.10, 1, 0);
      }
    }
    const armStart = road * 2.25, armLength = outer - armStart;
    for (const offset of [-0.25, 0.25]) {
      horizontalMark(offset, side * (armStart + armLength / 2), armLength / 2, 0.08, 0, 1, [0.82,0.68,0.34,2]);
      horizontalMark(side * (armStart + armLength / 2), offset, armLength / 2, 0.08, 1, 0, [0.82,0.68,0.34,2]);
    }
  }

  const colors = [[0.61,0.67,0.65,0], [0.79,0.78,0.70,0], [0.67,0.70,0.69,0], [0.79,0.73,0.65,0]];
  let buildingIndex = 0;
  for (const obstacle of scenario.obstacles) {
    const { x, z, width: w, depth: d, height: h } = obstacle;
    if (obstacle.kind !== 'building') {
      mesh.box(x, h / 2, z, w, h, d, [0.64,0.71,0.61,0]);
      continue;
    }
    const index = buildingIndex++;
    mesh.box(x, h / 2, z, w, h, d, colors[index % colors.length]);
    mesh.box(x, h + 0.16, z, w + 0.6, 0.32, d + 0.6, [0.86,0.87,0.80,0]);
    mesh.box(x, h + 0.50, z, w * 0.82, 0.34, d * 0.82, [0.41,0.47,0.46,0]);
    // Window ribbons and narrow mullions give the tall blocks a commercial character.
    const floors = Math.floor((h - 2) / 3.4);
    for (let floor = 0; floor < floors; floor++) {
      const y = 2.5 + floor * 3.4;
      const tint = floor % 3 === 0 ? [0.29,0.40,0.42,0] : [0.36,0.47,0.47,0];
      for (const sign of [-1, 1]) {
        mesh.box(x, y, z + sign * (d / 2 + 0.07), w - 1.3, 2.05, 0.14, tint);
        mesh.box(x + sign * (w / 2 + 0.07), y, z, 0.14, 2.05, d - 1.3, tint);
      }
    }
    for (let column = -w / 2 + 2.8; column < w / 2; column += 4.8) {
      for (const sign of [-1, 1]) mesh.box(x + column, h / 2, z + sign * (d / 2 + 0.17), 0.22, h, 0.12, colors[index % colors.length]);
    }
    // Signs face the intersection and are built from a tiny local bitmap alphabet, not fonts/assets.
    const inwardZ: Vec3 = [0,0,z < 0 ? 1 : -1];
    const inwardX: Vec3 = [x < 0 ? 1 : -1,0,0];
    const labels = ['SHIBUYA', 'TOKYO', 'CROSSING', 'CITY'];
    const signColors = [[0.10,0.33,0.38,3], [0.73,0.31,0.25,3], [0.30,0.35,0.53,3], [0.36,0.48,0.33,3]];
    const boardHeight = Math.min(7, h * 0.27);
    billboard([x, Math.max(4.2, h - boardHeight * 0.95), z + inwardZ[2] * (d / 2 + 0.35)],
      inwardZ, w * 0.84, boardHeight, labels[index % labels.length], signColors[index % signColors.length]);
    billboard([x + inwardX[0] * (w / 2 + 0.35), Math.max(4.2, h * 0.58), z],
      inwardX, d * 0.72, Math.min(5.5, h * 0.24), index % 2 ? 'FLUX' : 'CROSSING', signColors[(index + 1) % signColors.length]);
    // A second narrow street-level shop sign suggests the layers of a busy commercial district.
    if (h > 15) billboard([x, 4.2, z + inwardZ[2] * (d / 2 + 0.4)], inwardZ,
      w * 0.70, 2.4, index % 2 ? 'TOKYO' : 'CITY LAB', [0.88,0.78,0.48,3], [0.15,0.24,0.25,3]);
  }

  return mesh.finish();

  /** Upright quad, with a local horizontal coordinate that reads left-to-right from its front. */
  function panel(center: Vec3, normal: Vec3, w: number, h: number, color: number[]) {
    const right: Vec3 = [normal[2],0,-normal[0]];
    const p = (u: number, v: number): number[] => [center[0] + right[0] * u, center[1] + v, center[2] + right[2] * u];
    mesh.face([p(-w / 2,-h / 2),p(w / 2,-h / 2),p(w / 2,h / 2),p(-w / 2,h / 2)], normal, color);
  }

  function billboard(center: Vec3, normal: Vec3, w: number, h: number, text: string,
    background: number[], foreground = [0.95,0.95,0.85,3]) {
    panel(center, normal, w + 0.45, h + 0.45, [0.18,0.24,0.24,0]);
    panel([center[0] + normal[0] * 0.06,center[1],center[2] + normal[2] * 0.06], normal, w, h, background);
    const cell = Math.min(w / (text.length * 6 + 2), h / 10);
    const textWidth = (text.length * 6 - 1) * cell;
    const right: Vec3 = [normal[2],0,-normal[0]];
    for (let letter = 0; letter < text.length; letter++) {
      const glyph = GLYPHS[text[letter]] ?? GLYPHS[' '];
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
        if ((glyph[row] & (1 << (4 - col))) === 0) continue;
        const u = -textWidth / 2 + (letter * 6 + col + 0.5) * cell;
        const v = (3 - row) * cell;
        panel([center[0] + right[0] * u + normal[0] * 0.13, center[1] + v,
          center[2] + right[2] * u + normal[2] * 0.13], normal, cell * 0.92, cell * 0.92, foreground);
      }
    }
  }
}
