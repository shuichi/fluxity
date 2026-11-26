import { VehiclePath } from '../simulation/VehiclePath';
import { MeshBuilder, TAU } from '../math/geometry';
import type { Point2, Scenario, SignalState } from '../types';

export const LAMP = {
  pedestrian: { red: -1, green: -2 },
  eastWest: { green: -3, yellow: -4, red: -5 },
  northSouth: { green: -6, yellow: -7, red: -8 },
} as const;

const lightColor = { red: [1, 0.18, 0.08], green: [0.08, 1, 0.48], yellow: [1, 0.72, 0.04] };

// Both the HUD and the physical lamps freeze with the simulation clock.
export function pedestrianLamp(state: SignalState['pedestrian'], simulationTime: number) {
  if (state === 'flashingGreen') return Math.floor(simulationTime * 2) % 2 === 0 ? 'green' : undefined;
  return state;
}

/** One bit per negative material ID, shared with the environment shader. */
export function signalLampMask(state: SignalState | undefined, simulationTime: number): number {
  if (!state) return 0;
  const bit = (material: number) => 1 << (-material - 1);
  const pedestrian = pedestrianLamp(state.pedestrian, simulationTime);
  return (pedestrian ? bit(LAMP.pedestrian[pedestrian]) : 0)
    | bit(LAMP.eastWest[state.eastWest]) | bit(LAMP.northSouth[state.northSouth]);
}

type Vec3 = [number, number, number];
const casing = [0.17, 0.21, 0.20, 0];
const bracket = [0.34, 0.38, 0.35, 0];

/** Each head faces the people or vehicles approaching it from the opposite side. */
export function addTrafficLights(mesh: MeshBuilder, scenario: Scenario): void {
  const scramble = scenario.scramble;
  if (!scramble?.signalPositions.length) return;
  const poles = scramble.signalPositions;
  const vehiclePoles = new Set<Point2>();
  const pedestrianPoles = new Set<Point2>();

  function nearestPole(point: Point2) {
    return poles.reduce((best, pole) =>
      Math.hypot(pole.x - point.x, pole.z - point.z) < Math.hypot(best.x - point.x, best.z - point.z) ? pole : best);
  }

  function pedestrianHead(pole: Point2, toward: Point2) {
    const dx = toward.x - pole.x, dz = toward.z - pole.z, length = Math.hypot(dx, dz);
    if (length < 0.001) return;
    pedestrianPoles.add(pole);
    const normal: Vec3 = [dx / length, 0, dz / length];
    const center = (u: number, y: number, depth: number): Vec3 =>
      [pole.x + normal[2] * u + normal[0] * depth, y, pole.z - normal[0] * u + normal[2] * depth];
    // The two 25 cm square pedestrian lenses are mounted on a common backplate.
    housing(mesh, center(0, 3.15, 0.43), normal, 0.07, 0.09, 0.43, bracket);
    housing(mesh, center(0, 3.15, 0.55), normal, 0.32, 0.62, 0.13, casing);
    for (const color of ['red', 'green'] as const) {
      const y = color === 'red' ? 3.30 : 3.00;
      panel(mesh, center(0, y, 0.555), normal, 0.25, 0.25, [0.055, 0.075, 0.07, 0]);
      const ink = [...lightColor[color], LAMP.pedestrian[color]];
      const person = color === 'red'
        ? ['001100', '001100', '011110', '101101', '101101', '001100', '001100', '001100', '011110']
        : ['000110', '000110', '001100', '011100', '101101', '001110', '010010', '100010', '100001'];
      const pixel = 0.023;
      for (let row = 0; row < person.length; row++) {
        for (let col = 0; col < person[row].length; col++) {
          if (person[row][col] === '1') panel(mesh, center((col - 2.5) * pixel, y + (4 - row) * pixel, 0.558), normal, pixel, pixel, ink);
        }
      }
    }
  }

  for (const { from, to } of scramble.crosswalks) {
    pedestrianHead(nearestPole(from), to);
    pedestrianHead(nearestPole(to), from);
  }
  // A standalone fixture may specify its facing direction without a crosswalk.
  for (const pole of poles) {
    if (!pedestrianPoles.has(pole) && pole.direction) {
      pedestrianHead(pole, { x: pole.x + pole.direction.x, z: pole.z + pole.direction.z });
    }
  }

  for (const lane of scenario.vehicleLanes ?? []) {
    const path = new VehiclePath(lane);
    const approach = path.sample(lane.stop), far = path.sample(lane.clear);
    const pole = nearestPole({ x: far.x + 5 * far.uz, z: far.z - 5 * far.ux });
    // Aim each far-side head back at the driver waiting on its inbound approach.
    const dx = approach.x - pole.x, dz = approach.z - pole.z;
    const distance = Math.hypot(dx, dz);
    const normal: Vec3 = distance > 0 ? [dx / distance, 0, dz / distance] : [-approach.ux, 0, -approach.uz];
    vehiclePoles.add(pole);
    const side = (far.x - pole.x) * normal[2] - (far.z - pole.z) * normal[0] >= 0 ? 1 : -1;
    const center = (u: number, y: number, depth: number): Vec3 =>
      [pole.x + normal[2] * u + normal[0] * depth, y, pole.z - normal[0] * u + normal[2] * depth];
    housing(mesh, center(side * 0.65, 5.05, 0.03), normal, 1.30, 0.10, 0.10, bracket);
    housing(mesh, center(side * 1.25, 5.05, 0.22), normal, 1.10, 0.41, 0.20, casing);
    const colors = ['green', 'yellow', 'red'] as const;
    for (const [i, color] of colors.entries()) {
      const lensX = side * 1.25 + (i - 1) * 0.35;
      const points = Array.from({ length: 20 }, (_, j) => {
        const theta = TAU * j / 20;
        return center(lensX + 0.15 * Math.cos(theta), 5.05 + 0.15 * Math.sin(theta), 0.224);
      });
      mesh.face(points, normal, [...lightColor[color], LAMP[lane.axis][color]]);
    }
  }

  for (const pole of poles) {
    const height = vehiclePoles.has(pole) ? 5.20 : 3.51;
    mesh.prism(pole.x, height / 2, pole.z, 0.15, height, 0.15, bracket, 8);
    mesh.prism(pole.x, 0.07, pole.z, 0.26, 0.14, 0.26, casing, 8);
  }
}

function panel(mesh: MeshBuilder, center: Vec3, normal: Vec3, w: number, h: number, color: number[]) {
  const point = (u: number, v: number) => [center[0] + normal[2] * u, center[1] + v, center[2] - normal[0] * u];
  mesh.face([point(-w / 2, -h / 2), point(w / 2, -h / 2), point(w / 2, h / 2), point(-w / 2, h / 2)], normal, color);
}

function housing(mesh: MeshBuilder, front: Vec3, normal: Vec3, w: number, h: number, d: number, color: number[]) {
  const right: Vec3 = [normal[2], 0, -normal[0]];
  const p = (u: number, v: number, depth: number): Vec3 =>
    [front[0] + right[0] * u + normal[0] * depth, front[1] + v, front[2] + right[2] * u + normal[2] * depth];
  const left = -w / 2, rightEdge = w / 2, bottom = -h / 2, top = h / 2;
  panel(mesh, front, normal, w, h, color);
  panel(mesh, p(0, 0, -d), [-normal[0], 0, -normal[2]], w, h, color);
  mesh.face([p(left, bottom, -d), p(left, bottom, 0), p(left, top, 0), p(left, top, -d)], [-right[0], 0, -right[2]], color);
  mesh.face([p(rightEdge, bottom, 0), p(rightEdge, bottom, -d), p(rightEdge, top, -d), p(rightEdge, top, 0)], right, color);
  mesh.face([p(left, top, 0), p(rightEdge, top, 0), p(rightEdge, top, -d), p(left, top, -d)], [0, 1, 0], color);
  mesh.face([p(left, bottom, -d), p(rightEdge, bottom, -d), p(rightEdge, bottom, 0), p(left, bottom, 0)], [0, -1, 0], color);
}
