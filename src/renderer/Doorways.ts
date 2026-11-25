import type { MeshBuilder } from '../math/geometry';
import type { PedestrianPortal, Point2 } from '../types';

/** The authored door lane ends 0.8 m behind its facade so a whole walker can pass out of sight. */
const DEPTH_BEHIND_FACADE = 0.8;
const BACK_PANEL_DEPTH = 0.065;

/** The body can still be partly visible after the camera's near plane reaches the door. */
export function doorwayBlocksEye(door: PedestrianPortal, eye: Point2, nearRadius: number): boolean {
  const dx = door.approach.x - door.end.x, dz = door.approach.z - door.end.z;
  const length = Math.hypot(dx, dz);
  const x = eye.x - door.end.x, z = eye.z - door.end.z;
  const depth = (x * dx + z * dz) / length;
  return depth >= -nearRadius && depth <= DEPTH_BEHIND_FACADE + BACK_PANEL_DEPTH + nearRadius
    && Math.abs(x * dz - z * dx) <= door.width * length / 2;
}

export function addDoorways(mesh: MeshBuilder, portals: readonly PedestrianPortal[] = []): void {
  for (const door of portals) {
    if (door.kind !== 'door') continue;
    const dx = door.approach.x - door.end.x, dz = door.approach.z - door.end.z;
    const length = Math.hypot(dx, dz);
    const nx = dx / length, nz = dz / length;
    const x = door.end.x + nx * DEPTH_BEHIND_FACADE, z = door.end.z + nz * DEPTH_BEHIND_FACADE;
    const right = [nz, 0, -nx], front = [nx, 0, nz];
    const point = (u: number, y: number, depth: number) =>
      [x + nz * u + nx * depth, y, z - nx * u + nz * depth];
    const half = door.width / 2, trim = 0.12, height = 2.45;
    const back = BACK_PANEL_DEPTH, lip = 0.68;
    const entrance = [0.095, 0.12, 0.13, 0], frame = [0.30, 0.32, 0.31, 0];
    const reveal = [0.23, 0.25, 0.24, 0], sill = [0.50, 0.50, 0.46, 0];
    const panel = (left: number, bottom: number, right: number, top: number, depth: number, color: number[]) =>
      mesh.face([point(left,bottom,depth), point(right,bottom,depth),
        point(right,top,depth), point(left,top,depth)], front, color);

    // A shallow projecting entrance gives the textured, solid facade a visible threshold.
    // Its recessed, depth-writing back hides the walker just before the original wall.
    panel(-half, 0, half, height, back, entrance);
    panel(-half - trim, 0, -half, height, lip, frame);
    panel(half, 0, half + trim, height, lip, frame);
    panel(-half - trim, height, half + trim, height + trim, lip, frame);
    for (const side of [-1, 1]) {
      for (const [edge, normalSign] of [[half, -side], [half + trim, side]]) {
        const u = edge * side, top = edge === half ? height : height + trim;
        const vertices = [point(u,0,lip), point(u,0,back), point(u,top,back), point(u,top,lip)];
        mesh.face(normalSign > 0 ? vertices : vertices.reverse(), right.map(n => n * normalSign), reveal);
      }
    }
    mesh.face([point(-half,height,lip), point(-half,height,back), point(half,height,back),
      point(half,height,lip)], [0,-1,0], reveal);
    mesh.face([point(-half-trim,height+trim,lip), point(half+trim,height+trim,lip),
      point(half+trim,height+trim,back), point(-half-trim,height+trim,back)], [0,1,0], frame);
    mesh.face([point(-half,0.025,lip), point(half,0.025,lip),
      point(half,0.025,back), point(-half,0.025,back)], [0,1,0], sill);
  }
}
