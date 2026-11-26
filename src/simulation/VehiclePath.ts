import { VEHICLE_LENGTH, VEHICLE_WIDTH, type Point2, type TrafficAxis } from '../types';
import type { VehicleLane } from './VehicleLanes';

export function measuredLane(axis: TrafficAxis, points: Point2[], stopIndex: number, clearIndex: number): VehicleLane {
  if (!(stopIndex > 0 && stopIndex < clearIndex && clearIndex < points.length)) throw new Error('Invalid stop or clearance waypoint.');
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return { axis, start: points[0], end: points[points.length - 1], via: points.slice(1, -1),
    stop: distances[stopIndex], clear: distances[clearIndex] };
}

type Segment = {
  x: number; z: number; endX: number; endZ: number; ux: number; uz: number;
  start: number; end: number; turnAllowance: number;
};

const STEERING_REACH = 1.4;
// At 30 km/h even the longest supported physics step (0.1s) travels less than 0.84m.
const MAX_STEP_TRAVEL = 0.84;

/** Arc length along the lane controls speed, bumper gaps, stop lines and the rendered pose. */
export class VehiclePath {
  readonly segments: Segment[] = [];
  readonly length: number;

  constructor(lane: VehicleLane) {
    const points = [lane.start, ...(lane.via ?? []), lane.end];
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (!(Number.isFinite(length) && length > 0)) throw new Error('Vehicle lane requires distinct finite waypoints.');
      this.segments.push({ x: a.x, z: a.z, endX: b.x, endZ: b.z, ux: dx / length, uz: dz / length,
        start: distance, end: distance + length, turnAllowance: 0 });
      distance += length;
    }
    this.length = distance;
    const reach = STEERING_REACH + MAX_STEP_TRAVEL;
    for (const segment of this.segments) {
      // A car straddling a bend faces a blended tangent. Bound the rotation of
      // its farthest corner and the linear interpolation between consecutive centers.
      let turn = 0;
      for (const adjacent of this.segments) {
        if (adjacent.end < segment.start - reach || adjacent.start > segment.end + reach) continue;
        turn = Math.max(turn, Math.hypot(segment.ux - adjacent.ux, segment.uz - adjacent.uz));
      }
      segment.turnAllowance = turn * (Math.hypot(VEHICLE_LENGTH, VEHICLE_WIDTH) / 2 + MAX_STEP_TRAVEL);
    }
  }

  private segmentAt(distance: number): Segment {
    return this.segments.find(s => distance <= s.end) ?? this.segments[this.segments.length - 1];
  }

  sample(distance: number) {
    const d = Math.max(0, Math.min(this.length, distance));
    const segment = this.segmentAt(d), offset = d - segment.start;
    const x = segment.x + offset * segment.ux, z = segment.z + offset * segment.uz;
    const from = Math.max(0, d - STEERING_REACH), to = Math.min(this.length, d + STEERING_REACH);
    const a = this.segmentAt(from), b = this.segmentAt(to);
    if (a === b) return { x, z, ux: segment.ux, uz: segment.uz };
    const dx = b.x + (to - b.start) * b.ux - (a.x + (from - a.start) * a.ux);
    const dz = b.z + (to - b.start) * b.uz - (a.z + (from - a.start) * a.uz);
    const length = Math.hypot(dx, dz);
    return { x, z, ux: dx / length, uz: dz / length };
  }

  distanceAt(x: number, z: number): number {
    let closest = Infinity, distance = 0;
    for (const s of this.segments) {
      const dx = x - s.x, dz = z - s.z;
      const along = Math.max(0, Math.min(s.end - s.start, dx * s.ux + dz * s.uz));
      const error = (dx - along * s.ux) ** 2 + (dz - along * s.uz) ** 2;
      if (error < closest) { closest = error; distance = s.start + along; }
    }
    return distance;
  }
}
