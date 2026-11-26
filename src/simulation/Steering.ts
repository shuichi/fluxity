import type { UrbanGeometry } from './UrbanGeometry';
import type { Scenario, SimulationSettings } from '../types';
import type { AgentData } from './AgentData';
import type { Direction, Navigation } from './Navigation';
import type { EncounterState } from './EncounterState';
import type { SpatialGrid } from './SpatialGrid';

const MAX_CANDIDATES = 96;
const FORWARD_SPEED = [1, 0.88, 0.88, 0.35] as const;
const SIDE_SPEED = [0, 0.64, -0.64, 0] as const;
const GAZE_LEAD_SECONDS = 0.12;

export interface Velocity { x: number; z: number }

/** Current crossing waypoints, in world coordinates. A missing waypoint uses NaN. */
export interface CrossingPriority {
  readonly clearing: Uint8Array;
  readonly blocked: Uint8Array;
  readonly waypointX: Float32Array;
  readonly waypointZ: Float32Array;
}

/** Replace this boundary with ORCA without changing state, worker transport, or navigation. */
export interface LocalAvoidance {
  /** The most recent compute call chose to clear space for a walker leaving the road. */
  readonly yieldingAtCurb?: boolean;
  /** This pedestrian is passing someone at a zebra edge or returning from its margin. */
  readonly allowCrossingMargin?: boolean;
  compute(id: number, agents: AgentData, grid: SpatialGrid, direction: Direction, settings: SimulationSettings, result: Velocity, speedScale?: number, sidewalkOnly?: boolean): void;
}

export class Steering implements LocalAvoidance {
  candidateChecks = 0;
  yieldingAtCurb = false;
  allowCrossingMargin = false;
  private readonly wallPush = { x: 0, z: 0 };
  constructor(private readonly scenario: Scenario, private readonly urban?: UrbanGeometry,
    private readonly doorwayCells?: Uint8Array, private readonly encounters?: EncounterState,
    private readonly navigation?: Navigation, private readonly crossing?: CrossingPriority) {}
  private readonly neighbors = new Int32Array(MAX_CANDIDATES);
  private readonly costs = new Float64Array(4);

  /** Compare future clearances only on encounter onset and when a held decision is due for review. */
  private chooseManeuver(id: number, agents: AgentData, count: number, dirX: number, dirZ: number,
    speed: number, sidewalkOnly: boolean): void {
    const e = this.encounters!, s = agents.current, x = s.x[id], z = s.z[id], oldSide = e.passSide[id];
    const horizon = e.horizon[id];
    for (let option = 0; option < 4; option++) {
      const side = SIDE_SPEED[option], forward = FORWARD_SPEED[option];
      const vx = (dirX * forward + dirZ * side) * speed, vz = (dirZ * forward - dirX * side) * speed;
      // Deviating costs some progress. A little extra cost on the left resolves a symmetric encounter.
      let cost = option === 0 ? 0 : option === 3 ? e.brakingCost[id] : side > 0 ? 0.08 : 0.25;
      if (oldSide && Math.sign(side) !== oldSide) cost += 0.36;
      let risk = 0;
      for (let k = 0; k < count; k++) {
        const other = this.neighbors[k], dx = s.x[other] - x, dz = s.z[other] - z;
        // Someone following us cannot take the gap in front; nearby bodies still exert separation below.
        if (dx * dirX + dz * dirZ < -0.3) continue;
        const rvx = vx - s.vx[other], rvz = vz - s.vz[other], approach = dx * rvx + dz * rvz;
        if (approach <= 0) continue;
        const t = Math.min(horizon, approach / (rvx * rvx + rvz * rvz));
        const px = dx - rvx * t, pz = dz - rvz * t;
        const bodyRadius = agents.radius[id] + agents.radius[other], clearance = bodyRadius + 0.34;
        const separation2 = px * px + pz * pz;
        if (separation2 < clearance * clearance) {
          const separation = Math.sqrt(separation2);
          const proximity = (1 - separation / clearance) * (1.8 - 0.6 * t / horizon);
          // When both trials predict contact, walking into it at full speed is costlier than yielding.
          risk = Math.max(risk, proximity + Math.max(0, 1 - separation / bodyRadius) * forward * 0.5);
        }
      }
      this.costs[option] = cost + risk;
    }
    // Sweep in order of preference. An unobstructed first choice needs just one geometry query.
    let chosen = 3;
    for (let attempt = 0; attempt < 4; attempt++) {
      let best = 0;
      for (let option = 1; option < 4; option++) if (this.costs[option] < this.costs[best]) best = option;
      const step = speed * 0.65, side = SIDE_SPEED[best], forward = FORWARD_SPEED[best];
      const tx = x + (dirX * forward + dirZ * side) * step, tz = z + (dirZ * forward - dirX * side) * step;
      if (!this.navigation || this.canStep(x, z, tx, tz, agents.radius[id] + 0.015, sidewalkOnly, side !== 0)) {
        chosen = best; break;
      }
      this.costs[best] = Infinity;
    }
    e.passSide[id] = Math.sign(SIDE_SPEED[chosen]);
    e.yielding[id] = chosen === 3 ? 1 : 0;
    e.reconsiderIn[id] = 0.42 + (horizon - 1.4) * 0.45;
  }

  private canStep(x: number, z: number, tx: number, tz: number, radius: number, sidewalkOnly: boolean, passing: boolean): boolean {
    const b = this.scenario.bounds;
    if (tx < b.minX + radius || tx > b.maxX - radius || tz < b.minZ + radius || tz > b.maxZ - radius) return false;
    if (this.urban) {
      if (sidewalkOnly) return this.urban.sidewalks.lineInside(x, z, tx, tz, radius);
      if (passing && this.urban.canPassOnCrossing(x, z, radius)) return this.urban.crossingLine(x, z, tx, tz, radius);
      return this.urban.lineWalkable(x, z, tx, tz, radius);
    }
    const nav = this.navigation!;
    return (!sidewalkOnly || !nav.scramble || nav.scramble.isSidewalk(tx, tz, radius))
      && nav.lineOfSight(x, z, tx, tz, radius);
  }

  compute(id: number, agents: AgentData, grid: SpatialGrid, direction: Direction, settings: SimulationSettings, result: Velocity, speedScale = 1, sidewalkOnly = false): void {
    this.yieldingAtCurb = false;
    this.allowCrossingMargin = false;
    const state = agents.current;
    const x = state.x[id], z = state.z[id], dirX = direction.x, dirZ = direction.z;
    const preferredSpeed = agents.preferredSpeed[id] * speedScale;
    let pushX = 0, pushZ = 0, lateral = 0, brake = 0;
    const cell = grid.cells[id], cx = cell % grid.columns, cz = Math.floor(cell / grid.columns);
    let yieldX = 0, yieldZ = 0, yieldWeight = 0;
    const curb = sidewalkOnly ? this.crossing : undefined;
    const nearDoorway = this.doorwayCells?.[cell];
    const encounters = this.encounters;
    const mayChoose = !!encounters && !nearDoorway && settings.avoidanceStrength > 0 && preferredSpeed > 0;
    const reconsider = mayChoose && encounters!.reconsiderIn[id] <= 0;
    const horizon = mayChoose ? encounters!.horizon[id] : 1.6;
    let nearContact = false, contactClosing = 0, contactSide = 0;
    let gazeRisk = 0, gazeTarget = -1, nearestConflictTime = Infinity, neighborCount = 0;
    let examined = 0;
    const range2 = grid.cellSize * grid.cellSize;
    // Bounded candidates ensure a pathological queue does not turn into an all-pairs loop.
    for (let oz = -1; oz <= 1; oz++) {
      const nz = cz + oz;
      if (nz < 0 || nz >= grid.rows) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        if (nx < 0 || nx >= grid.columns) continue;
        const neighborCell = nz * grid.columns + nx;
        const start = grid.offsets[neighborCell], end = grid.offsets[neighborCell + 1], size = end - start;
        for (let n = 0; n < size && examined < MAX_CANDIDATES; n++) {
          // Rotate a crowded cell's traversal by ID, avoiding always favoring low IDs.
          const j = grid.indices[start + ((n + id) % size)];
          if (j === id) continue;
          examined++;
          let dx = state.x[j] - x, dz = state.z[j] - z;
          let distance2 = dx * dx + dz * dz;
          if (distance2 > range2) continue;
          if (reconsider) this.neighbors[neighborCount++] = j;
          if (distance2 < 1e-8) {
            const sign = id < j ? 1 : -1;
            dx = sign * 0.001; dz = sign * 0.0007; distance2 = dx * dx + dz * dz;
          }
          const distance = Math.sqrt(distance2), radius = agents.radius[id] + agents.radius[j];
          // Use the intended path even when a doorway or crossing queue has stopped moving.
          const clearingCurb = curb?.clearing[j] && Number.isFinite(curb.waypointX[j]);
          if (clearingCurb || (nearDoorway && agents.portalStage[j])) {
            const intentX = clearingCurb ? curb.waypointX[j] - state.x[j] : agents.preferredVX[j];
            const intentZ = clearingCurb ? curb.waypointZ[j] - state.z[j] : agents.preferredVZ[j];
            const length = Math.hypot(intentX, intentZ);
            if (length > 0.01) {
              const ux = intentX / length, uz = intentZ / length;
              const ahead = -dx * ux - dz * uz, side = -dx * uz + dz * ux;
              // If the first row has had no room to yield, involve another row
              // of the sidewalk queue and give them time to step farther back.
              const blocked = clearingCurb && curb.blocked[j];
              const space = radius + (blocked ? 1.1 : 0.43);
              if (ahead > 0 && ahead < (blocked ? grid.cellSize : 1.9) && Math.abs(side) < space) {
                const weight = (1 - ahead / (blocked ? 3.5 : 2.2)) * (1 - Math.abs(side) / space);
                // A real curb can cut across the intended path before the chosen landing.
                // Yield wherever the two walkers can actually reach one another.
                if (weight > yieldWeight && (!clearingCurb || !this.navigation
                  || this.navigation.lineOfSight(x, z, state.x[j], state.z[j], Math.min(agents.radius[id], agents.radius[j]) + 0.015))) {
                  const sign = side >= 0 ? 1 : -1;
                  yieldX = uz * sign; yieldZ = -ux * sign; yieldWeight = weight;
                  this.yieldingAtCurb = !!clearingCurb;
                  if (clearingCurb) {
                    // Step diagonally back onto the sidewalk to open space at the lip of the curb.
                    const aside = blocked ? 0.55 : 0.8, back = blocked ? 0.85 : 0.6;
                    yieldX = aside * yieldX + back * ux;
                    yieldZ = aside * yieldZ + back * uz;
                  }
                }
              }
            }
          }
          const personalSpace = radius + 0.34;
          if (distance < personalSpace) {
            // Pedestrians on the public sidewalk yield to a walker committed to the narrow doorway.
            const stiffness = agents.portalStage[j] ? 8 : 3.6;
            const strength = Math.min(2.4, (personalSpace - distance) * stiffness);
            pushX -= dx / distance * strength; pushZ -= dz / distance * strength;
          }
          const forward = dx * dirX + dz * dirZ;
          const across = dx * dirZ - dz * dirX;
          if (encounters) {
            // Use measured motion for impacts: intending to walk into a static queue is not an impact.
            if (distance < radius + 0.055) {
              nearContact = true;
              if (distance <= radius) {
                const closing = (dx * (state.vx[id] - state.vx[j]) + dz * (state.vz[id] - state.vz[j])) / distance;
                if (closing > contactClosing) {
                  contactClosing = closing;
                  const localX = dx * Math.cos(state.heading[id]) - dz * Math.sin(state.heading[id]);
                  contactSide = localX > 0 ? -1 : 1;
                }
              }
            }
          }
          if (forward > 0 && Math.abs(across) < radius + 0.2 && forward < 1.8) {
            const otherForward = state.vx[j] * dirX + state.vz[j] * dirZ;
            const closing = preferredSpeed - otherForward;
            if (closing > 0.15) brake = Math.max(brake, (1 - forward / 1.8) * Math.min(0.85, closing * 0.5));
          }
          // Predict the closest approach to the walker at our current intended speed.
          const rvx = dirX * preferredSpeed - state.vx[j], rvz = dirZ * preferredSpeed - state.vz[j];
          const rv2 = rvx * rvx + rvz * rvz;
          if (forward > 0 && rv2 > 0.08) {
            const time = (dx * rvx + dz * rvz) / rv2;
            if (time > 0 && time < horizon) {
              const closestX = dx - rvx * time, closestZ = dz - rvz * time;
              const clearance = radius + 0.35;
              const closest2 = closestX * closestX + closestZ * closestZ;
              if (closest2 < clearance * clearance) {
                const urgency = (1 - time / horizon) * (1 - Math.sqrt(closest2) / clearance);
                if (urgency > gazeRisk) { gazeRisk = urgency; gazeTarget = j; }
                nearestConflictTime = Math.min(nearestConflictTime, time);
                lateral = Math.max(lateral, urgency * 1.25);
                brake = Math.max(brake, urgency * 0.3);
              }
            }
          }
        }
      }
    }
    this.candidateChecks += examined;
    if (encounters) {
      encounters.contact(id, nearContact, contactClosing, contactSide);
      encounters.gazeTarget[id] = gazeTarget;
      if (gazeTarget >= 0) encounters.gazeLife[id] = agents.generation[gazeTarget];
      if (mayChoose) {
        // Keep the decision for continuity, but release its speed penalty as soon as the conflict clears.
        const brakeAmount = Math.min(0.62, 0.22 + gazeRisk * 0.46);
        if (lateral > 0.075) {
          encounters.hold(id);
          if (reconsider) {
            const previous = encounters.passSide[id];
            this.chooseManeuver(id, agents, neighborCount, dirX, dirZ, preferredSpeed, sidewalkOnly);
            if (encounters.passSide[id] && encounters.passSide[id] !== previous && nearestConflictTime > 0.65) {
              encounters.gazeLead[id] = GAZE_LEAD_SECONDS;
            }
          }
        }
        const side = encounters.passSide[id];
        lateral = side * Math.max(lateral, gazeTarget >= 0 ? preferredSpeed * 0.30 : 0);
        if (nearestConflictTime > 0.65 && encounters.gazeLead[id] > 0) {
          lateral *= Math.max(0, 1 - encounters.gazeLead[id] / GAZE_LEAD_SECONDS);
        }
        if (gazeTarget >= 0 && encounters.yielding[id]) brake = Math.max(brake, brakeAmount);
        brake = Math.max(brake, Math.abs(encounters.lean[id]) * 0.3);
      }
    }
    const avoidance = settings.avoidanceStrength;
    let desiredX = dirX * preferredSpeed * (1 - brake * Math.min(1, avoidance));
    let desiredZ = dirZ * preferredSpeed * (1 - brake * Math.min(1, avoidance));
    desiredX += (pushX + dirZ * lateral) * avoidance;
    desiredZ += (pushZ - dirX * lateral) * avoidance;
    desiredX += yieldX * yieldWeight * preferredSpeed * 2;
    desiredZ += yieldZ * yieldWeight * preferredSpeed * 2;
    // A persistent gentle lateral drift helps congested pedestrians escape symmetric locks.
    if (agents.stalledTime[id] > 2 && preferredSpeed > 0) {
      desiredX += dirZ * 0.3; desiredZ -= dirX * 0.3;
    }
    if (this.urban) {
      const passing = avoidance > 0 && (Math.abs(lateral) > 0.01 || Math.abs(pushX * dirZ - pushZ * dirX) > 0.04);
      this.allowCrossingMargin = this.urban.avoidance(x, z, agents.radius[id], this.wallPush, passing,
        sidewalkOnly, !!this.crossing?.clearing[id]);
      desiredX += this.wallPush.x; desiredZ += this.wallPush.z;
    }
    for (const obstacle of this.scenario.obstacles) {
      const halfX = obstacle.width * 0.5, halfZ = obstacle.depth * 0.5;
      const nearestX = Math.max(obstacle.x - halfX, Math.min(obstacle.x + halfX, x));
      const nearestZ = Math.max(obstacle.z - halfZ, Math.min(obstacle.z + halfZ, z));
      const dx = x - nearestX, dz = z - nearestZ, distance2 = dx * dx + dz * dz;
      const safe = agents.radius[id] + 0.75;
      if (distance2 > 1e-8 && distance2 < safe * safe) {
        const distance = Math.sqrt(distance2), weight = (safe - distance) * 1.8;
        desiredX += dx / distance * weight; desiredZ += dz / distance * weight;
      }
    }
    const b = this.scenario.bounds, margin = agents.radius[id] + 0.8;
    if (x < b.minX + margin) desiredX += (b.minX + margin - x) * 2;
    if (x > b.maxX - margin) desiredX -= (x - b.maxX + margin) * 2;
    if (z < b.minZ + margin) desiredZ += (b.minZ + margin - z) * 2;
    if (z > b.maxZ - margin) desiredZ -= (z - b.maxZ + margin) * 2;
    const speed = Math.hypot(desiredX, desiredZ), limit = preferredSpeed * 1.12;
    if (speed > limit && speed > 0) { desiredX *= limit / speed; desiredZ *= limit / speed; }
    result.x = desiredX; result.z = desiredZ;
  }
}
