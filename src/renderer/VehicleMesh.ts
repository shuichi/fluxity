import { MeshBuilder, TAU } from '../math/geometry';
import { VEHICLE_BODY_WIDTH, VEHICLE_HEIGHT, VEHICLE_LENGTH, VEHICLE_WIDTH } from '../types';

// Corolla Sport G dimensions from Toyota's July 2026 specification and parking FAQ.
const WHEELBASE = 2.640;
const FRONT_OVERHANG = 0.940;
const TRACK = 1.530;
const TIRE_WIDTH = 0.205;
const RIM_RADIUS = 16 * 0.0254 / 2;
const TIRE_RADIUS = RIM_RADIUS + TIRE_WIDTH * 0.55; // 205/55R16, nominal unloaded radius

/** A passenger car centered on its collision footprint, facing local +Z. */
export function createVehicleMesh() {
  const mesh = new MeshBuilder(10);
  const paint = [1, 1, 1, 1], glass = [0.19, 0.30, 0.37, 0], trim = [0.10, 0.12, 0.14, 0];
  const tire = [0.12, 0.13, 0.13, 0], alloy = [0.61, 0.64, 0.65, 0];
  const halfWidth = VEHICLE_BODY_WIDTH / 2, halfLength = VEHICLE_LENGTH / 2;
  function face(points: number[][], material: number[]): void {
    const [a, b, c] = points;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    mesh.face(points, [nx / length, ny / length, nz / length], material);
  }
  // Octagonal sections round the corners of the hood, bumpers and cabin.
  function ring(y: number, w: number, rear: number, front: number, bevel: number): number[][] {
    return [[-w + bevel, y, front], [w - bevel, y, front], [w, y, front - bevel], [w, y, rear + bevel],
      [w - bevel, y, rear], [-w + bevel, y, rear], [-w, y, rear + bevel], [-w, y, front - bevel]];
  }
  function panels(lower: number[][], upper: number[][], colors: number[][]): void {
    for (let i = 0; i < lower.length; i++) {
      const j = (i + 1) % lower.length;
      face([lower[i], lower[j], upper[j], upper[i]], colors[i % colors.length]);
    }
  }
  const underside = ring(0.135, 0.61, -1.35, 1.20, 0.16);
  const sill = ring(0.31, halfWidth - 0.12, -halfLength + 0.10, halfLength - 0.12, 0.17);
  const bumper = ring(0.49, halfWidth - 0.05, -halfLength, halfLength, 0.18);
  const belt = ring(0.87, halfWidth, -halfLength + 0.08, halfLength - 0.16, 0.22);
  face([...underside].reverse(), trim);
  panels(underside, sill, [trim]);
  panels(sill, bumper, [trim]);
  panels(bumper, belt, [paint]);
  face(belt, paint);
  const windowBase = ring(0.872, halfWidth - 0.11, -1.64, 1.06, 0.13);
  const roof = ring(VEHICLE_HEIGHT, halfWidth - 0.27, -1.05, 0.48, 0.12);
  panels(windowBase, roof, [glass, paint]);
  face(roof, paint);
  for (const side of [-1, 1]) {
    const outerX = side * (halfWidth - 0.108), roofX = side * (halfWidth - 0.268);
    const pillar = [[outerX, 0.872, -0.31], [outerX, 0.872, -0.20], [roofX, VEHICLE_HEIGHT, -0.17], [roofX, VEHICLE_HEIGHT, -0.28]];
    face(side === 1 ? pillar.reverse() : pillar, trim);
    mesh.box(side * 0.56, 0.69, halfLength - 0.095, 0.34, 0.13, 0.10, [0.96, 0.94, 0.74, 0]);
    mesh.box(side * 0.59, 0.69, -halfLength + 0.055, 0.32, 0.13, 0.065, [0.83, 0.14, 0.10, 0]);
    // The mirror tip is the widest point of the car while driving.
    mesh.box(side * 0.85, 0.995, 0.73, 0.20, 0.045, 0.065, trim);
    mesh.box(side * (VEHICLE_WIDTH / 2 - 0.078), 1.035, 0.73, 0.156, 0.10, 0.15, trim);
    const frontAxle = halfLength - FRONT_OVERHANG;
    for (const axle of [frontAxle - WHEELBASE, frontAxle]) {
      const disc = (x: number, radius: number) => Array.from({ length: 16 }, (_, i) => {
        const angle = (side * i / 16) * TAU;
        return [side * x, TIRE_RADIUS + radius * Math.cos(angle), axle + radius * Math.sin(angle)];
      });
      const outerX = (TRACK + TIRE_WIDTH) / 2, innerX = (TRACK - TIRE_WIDTH) / 2;
      const outer = disc(outerX, TIRE_RADIUS), inner = disc(innerX, TIRE_RADIUS);
      panels(inner, outer, [tire]);
      face(outer, tire);
      face(disc(outerX + 0.001, RIM_RADIUS), alloy);
      face(disc(outerX + 0.002, 0.074), trim);
    }
  }
  return mesh.finish();
}
