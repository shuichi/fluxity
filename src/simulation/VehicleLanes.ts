import { stopBars } from '../../data/shibuya/road-markings.json';
import { VEHICLE_LENGTH, VEHICLE_WIDTH, type Point2, type TrafficAxis } from '../types';
import { measuredLane, VehiclePath } from './VehiclePath';

export interface VehicleLane {
  axis: TrafficAxis;
  start: Point2;
  end: Point2;
  /** Intermediate points on the carriageway, ordered in the direction of travel. */
  via?: Point2[];
  /** Bumper stations in meters along the route. A waiting car stops just before the entry edge. */
  stop: number;
  entry?: number;
  clear: number;
}

type Coordinate = [number, number];

function lane(axis: TrafficAxis, approach: Coordinate[], junction: Coordinate[], departure: Coordinate[]): VehicleLane {
  const points = [...approach, ...junction, ...departure].map(([x, z]) => ({ x, z }));
  return measuredLane(axis, points, approach.length, approach.length + junction.length - 1);
}

function matchStopBar(lane: VehicleLane, index: number): VehicleLane {
  const bar = stopBars.find(bar => bar.lane === index);
  if (!bar) throw new Error(`Missing stop stripe for Shibuya approach ${index}.`);
  const [[ax, az], [bx, bz]] = bar.points;
  const path = new VehiclePath(lane), approaching = path.sample(lane.stop - VEHICLE_LENGTH / 2);
  const dx = bx - ax, dz = bz - az;
  const sign = Math.sign(dz * approaching.ux - dx * approaching.uz);
  const nx = sign * dz / Math.hypot(dx, dz), nz = -sign * dx / Math.hypot(dx, dz);

  // Perpendicular distance from the leading corner of the full-width car to the stripe's near edge.
  function frontProjection(station: number): number {
    const p = path.sample(station - VEHICLE_LENGTH / 2);
    const frontX = p.x + p.ux * VEHICLE_LENGTH / 2, frontZ = p.z + p.uz * VEHICLE_LENGTH / 2;
    return (frontX - ax) * nx + (frontZ - az) * nz + Math.abs(p.uz * nx - p.ux * nz) * VEHICLE_WIDTH / 2;
  }

  // Over the last 10 cm the heading can still change on the gently curving approach.
  const projection = frontProjection(lane.stop);
  const rate = (projection - frontProjection(lane.stop - 0.1)) / 0.1;
  if (!(rate > 0)) throw new Error(`Stop stripe must span Shibuya approach ${index}.`);
  const entry = lane.stop - projection / rate;
  return { ...lane, entry, stop: entry - 0.03 };
}

// Local east/south meters. The first junction point locates the stripe and the last clears the far zebra.
// The stop bars, apron and guiding paint use the same registration in data/shibuya/road-markings.json.
export const SHIBUYA_VEHICLE_LANES: VehicleLane[] = [
  // Eastbound from Dogenzaka.
  lane('eastWest', [
    [-102, -2.3], [-86.94, -4.77], [-79.14, -6.41], [-72.55, -7.68], [-65.42, -8.48],
    [-59.37, -8.86], [-53.99, -8.77], [-48.0, -8.32], [-42.62, -7.75], [-37.48, -6.88]
  ], [
    [-32.51, -5.91], [-18.1, -3.35], [3.43, 0.36], [16.59, 2.0], [27.36, 2.6],
    [32.54, 2.94]
  ], [
    [44.11, 3.77], [51.89, 4.3], [69, 2.75], [82, 2.15], [99, 0.55],
    [114, -1.05]
  ]),
  // Westbound from the rail underpass.
  lane('eastWest', [
    [114, 2.8], [99, 4.5], [82, 6.25], [69, 6.9], [51.87, 7.65],
    [42.9, 7.24], [34.82, 6.65]
  ], [
    [32.18, 6.4], [27.34, 5.95], [12.98, 4.61], [1.62, 2.99], [-14.53, 0.26],
    [-29.6, -2.28], [-32.95, -2.92]
  ], [
    [-36.72, -3.64], [-43.59, -4.82], [-50.53, -5.52], [-57.6, -5.74], [-64.9, -5.36],
    [-72.45, -4.51], [-79.64, -3.3], [-86.95, -1.9], [-102, 2.0]
  ]),
  // Southbound past the north chevron and down the station side of the bus terminal.
  lane('northSouth', [
    [29.4, -105], [30.45, -96], [29.15, -88], [26.5, -77], [23.35, -63],
    [22.26, -56.82], [20.48, -48.98], [18.64, -41.27], [16.79, -33.44]
  ], [
    [14.66, -25.09], [13.36, -19.03], [11.71, -13.96], [9.95, -10.07], [7.77, -4.94],
    [5.7, 1.09], [4.46, 7.13], [3.35, 13.71], [1.94, 18.79], [1.74, 22.62],
    [1.46, 27.0]
  ], [
    [0.79, 31.36], [-0.2, 36.74], [-1.97, 43.61], [-4.65, 50.48], [-7.38, 57.35],
    [-8.78, 60.93], [-9.8, 64]
  ]),
  // Northbound past the west side of the bus terminal and across the south zebra.
  lane('northSouth', [
    [-29.7, 64], [-29.37, 60.21], [-27.04, 50.95], [-25.19, 42.1], [-23.72, 35.16],
    [-22.43, 29.72], [-20.9, 25.0]
  ], [
    [-19.49, 22.28], [-18.0, 19.57], [-15.76, 16.29], [-12.75, 12.42], [-8.47, 7.18],
    [-3.77, 2.06], [1.59, -3.54], [5.45, -8.43], [8.17, -12.78], [9.94, -17.38],
    [11.23, -23.18], [12.39, -28.0]
  ], [
    [13.07, -30.83], [15.03, -39.02], [16.81, -46.61], [18.9, -55.82], [20.4, -65],
    [22.7, -75], [24.9, -85], [26.8, -94], [26.1, -105]
  ]),
].map(matchStopBar);
