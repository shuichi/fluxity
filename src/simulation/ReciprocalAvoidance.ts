import type { AgentData } from './AgentData';
import type { Velocity } from './Steering';

const MAX_PLANES = 12;
const EPS = 1e-8;
export const PEDESTRIAN_ACCELERATION = 3.8;

/** First entry of a relative velocity into the finite-horizon velocity obstacle of two discs. */
export function collisionTime(px: number, pz: number, vx: number, vz: number, radius: number, horizon: number): number {
  const separation = px * px + pz * pz - radius * radius;
  if (separation <= 0) return 0;
  const approach = px * vx + pz * vz, speed2 = vx * vx + vz * vz;
  if (approach <= 0 || speed2 < EPS) return Infinity;
  const discriminant = approach * approach - speed2 * separation;
  if (discriminant < 0) return Infinity;
  const entry = separation / (approach + Math.sqrt(discriminant));
  return entry <= horizon ? entry : Infinity;
}

/** Project a target onto both the speed disc and the one-step acceleration disc. */
function reachableVelocity(tx: number, tz: number, vx: number, vz: number, speed: number, delta: number, out: Velocity): void {
  const magnitude = Math.hypot(tx, tz), speedScale = magnitude > speed ? speed / magnitude : 1;
  let x = tx * speedScale, z = tz * speedScale;
  if ((x - vx) ** 2 + (z - vz) ** 2 > delta * delta + EPS) {
    const distance = Math.hypot(tx - vx, tz - vz);
    const accelerationScale = distance > delta ? delta / distance : 1;
    x = vx + (tx - vx) * accelerationScale; z = vz + (tz - vz) * accelerationScale;
    if (x * x + z * z > speed * speed + EPS) {
      // Both individual projections missed the lens. Its closest point is a circle intersection.
      const centers = Math.hypot(vx, vz), ux = vx / centers, uz = vz / centers;
      const along = (speed * speed + centers * centers - delta * delta) / (2 * centers);
      const across = Math.sqrt(Math.max(0, speed * speed - along * along)) * (tz * ux < tx * uz ? -1 : 1);
      x = ux * along - uz * across; z = uz * along + ux * across;
    }
  }
  out.x = x; out.z = z;
}

/** Scratch space reused for one pedestrian at a time in the worker. */
export class ReciprocalAvoidance {
  private count = 0;
  private readonly ids = new Int32Array(MAX_PLANES);
  private readonly ranks = new Float64Array(MAX_PLANES);
  private readonly nx = new Float64Array(MAX_PLANES);
  private readonly nz = new Float64Array(MAX_PLANES);
  private readonly offsets = new Float64Array(MAX_PLANES);
  private readonly preferred: Velocity = { x: 0, z: 0 };

  reset(): void { this.count = 0; }

  /** Earliest predicted contacts take precedence, followed by the nearest other bodies. */
  consider(id: number, distance: number, entry: number, horizon: number): void {
    const rank = Number.isFinite(entry) ? entry + distance * 0.0001 : horizon + 1 + distance;
    let at = this.count;
    if (at === MAX_PLANES) {
      if (rank >= this.ranks[at - 1]) return;
      at--;
    } else this.count++;
    while (at > 0 && rank < this.ranks[at - 1]) {
      this.ranks[at] = this.ranks[at - 1]; this.ids[at] = this.ids[at - 1]; at--;
    }
    this.ranks[at] = rank; this.ids[at] = id;
  }

  private makePlanes(id: number, agents: AgentData, horizon: number, dt: number, padding: number,
    stationary: Uint8Array | undefined, passSide: number): void {
    const state = agents.current, vx = state.vx[id], vz = state.vz[id];
    for (let i = 0; i < this.count; i++) {
      const j = this.ids[i], fixed = !!stationary?.[j];
      const px = state.x[j] - state.x[id], pz = state.z[j] - state.z[id];
      const rx = vx - state.vx[j], rz = vz - state.vz[j];
      const distance2 = px * px + pz * pz, radius = agents.radius[id] + agents.radius[j] + padding;
      const overlapping = distance2 <= radius * radius;
      const invTime = 1 / (overlapping ? dt : horizon);
      const wx = rx - px * invTime, wz = rz - pz * invTime;
      const w2 = wx * wx + wz * wz, dot = wx * px + wz * pz;
      let nx: number, nz: number, correction: number;
      if (overlapping || (dot < 0 && dot * dot > radius * radius * w2)) {
        // The nearest boundary of the truncated cone is on its circular cap.
        const w = Math.sqrt(w2);
        if (w > EPS) { nx = wx / w; nz = wz / w; }
        else if (distance2 > EPS) { const d = Math.sqrt(distance2); nx = -px / d; nz = -pz / d; }
        else { nx = id < j ? 1 : -1; nz = 0; }
        correction = radius * invTime - w;
      } else {
        // The two straight legs are tangent to the cap. A centered encounter uses the held passing side.
        const cross = px * wz - pz * wx;
        const side = Math.abs(cross) < EPS ? (passSide < 0 ? 1 : -1) : Math.sign(cross);
        const leg = Math.sqrt(Math.max(0, distance2 - radius * radius));
        nx = (-px * radius - side * pz * leg) / distance2;
        nz = (-pz * radius + side * px * leg) / distance2;
        correction = -(nx * rx + nz * rz);
      }
      this.nx[i] = nx; this.nz[i] = nz;
      this.offsets[i] = nx * vx + nz * vz + (fixed ? 1 : 0.5) * correction;
    }
  }

  /** The closest feasible point lies on the newly violated line, clipped by both discs and earlier lines. */
  private project(vx: number, vz: number, speed: number, delta: number, slack: number, out: Velocity): boolean {
    out.x = this.preferred.x; out.z = this.preferred.z;
    for (let i = 0; i < this.count; i++) {
      const nx = this.nx[i], nz = this.nz[i], offset = this.offsets[i] - slack;
      if (nx * out.x + nz * out.z >= offset - EPS) continue;
      // Points on the line are offset * normal + t * tangent, with tangent = (-nz, nx).
      const speedSpan2 = speed * speed - offset * offset;
      const normalGap = offset - nx * vx - nz * vz;
      const deltaSpan2 = delta * delta - normalGap * normalGap;
      if (Math.min(speedSpan2, deltaSpan2) < -EPS) return false;
      const speedSpan = Math.sqrt(Math.max(0, speedSpan2)), deltaSpan = Math.sqrt(Math.max(0, deltaSpan2));
      const center = -nz * vx + nx * vz;
      let lower = Math.max(-speedSpan, center - deltaSpan), upper = Math.min(speedSpan, center + deltaSpan);
      for (let j = 0; j < i; j++) {
        const slope = -this.nx[j] * nz + this.nz[j] * nx;
        const gap = this.offsets[j] - slack - offset * (this.nx[j] * nx + this.nz[j] * nz);
        if (Math.abs(slope) < EPS) { if (gap > EPS) return false; }
        else if (slope > 0) lower = Math.max(lower, gap / slope);
        else upper = Math.min(upper, gap / slope);
      }
      if (lower > upper + EPS) return false;
      const t = Math.max(lower, Math.min(upper, -nz * this.preferred.x + nx * this.preferred.z));
      out.x = offset * nx - t * nz; out.z = offset * nz + t * nx;
    }
    return true;
  }

  solve(id: number, agents: AgentData, desiredX: number, desiredZ: number, speedLimit: number, dt: number,
    horizon: number, padding: number, stationary: Uint8Array | undefined, passSide: number, out: Velocity): void {
    const vx = agents.current.vx[id], vz = agents.current.vz[id], delta = PEDESTRIAN_ACCELERATION * dt;
    const speed = Math.max(speedLimit, Math.hypot(vx, vz) - delta);
    // Normal walking eases toward its preferred velocity. Encounters can use the full reachable disc.
    const blend = Math.min(1, dt / 0.3);
    reachableVelocity(vx + (desiredX - vx) * blend, vz + (desiredZ - vz) * blend, vx, vz, speed, delta, this.preferred);
    this.makePlanes(id, agents, horizon, dt, padding, stationary, passSide);
    if (this.project(vx, vz, speed, delta, 0, out)) return;

    // A dense queue or late detection can make the half-planes incompatible with limited acceleration.
    // Find the least common relaxation to within 1/256 of the initial maximum velocity violation.
    let lower = 0, upper = 0;
    for (let i = 0; i < this.count; i++) {
      upper = Math.max(upper, this.offsets[i] - this.nx[i] * this.preferred.x - this.nz[i] * this.preferred.z);
    }
    let bestX = this.preferred.x, bestZ = this.preferred.z;
    for (let attempt = 0; attempt < 8; attempt++) {
      const middle = (lower + upper) * 0.5;
      if (this.project(vx, vz, speed, delta, middle, out)) {
        bestX = out.x; bestZ = out.z; upper = middle;
      } else lower = middle;
    }
    out.x = bestX; out.z = bestZ;
  }
}
