import type { UrbanGeometry } from './UrbanGeometry';
import type { Scenario, SimulationSettings } from '../types';
import type { AgentData } from './AgentData';
import type { Direction } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

export interface Velocity { x: number; z: number }

/** Replace this boundary with ORCA without changing state, worker transport, or navigation. */
export interface LocalAvoidance {
  compute(id: number, agents: AgentData, grid: SpatialGrid, direction: Direction, settings: SimulationSettings, result: Velocity): void;
}

export class Steering implements LocalAvoidance {
  candidateChecks = 0;
  private readonly wallPush = { x: 0, z: 0 };
  constructor(private readonly scenario: Scenario, private readonly urban?: UrbanGeometry,
    private readonly doorwayCells?: Uint8Array) {}
  compute(id: number, agents: AgentData, grid: SpatialGrid, direction: Direction, settings: SimulationSettings, result: Velocity): void {
    const state = agents.current;
    const x = state.x[id], z = state.z[id], dirX = direction.x, dirZ = direction.z;
    const preferredSpeed = agents.preferredSpeed[id];
    let pushX = 0, pushZ = 0, lateral = 0, brake = 0;
    const cell = grid.cells[id], cx = cell % grid.columns, cz = Math.floor(cell / grid.columns);
    let yieldX = 0, yieldZ = 0, yieldWeight = 0;
    let examined = 0;
    const range2 = grid.cellSize * grid.cellSize;
    // Bounded candidates ensure a pathological queue does not turn into an all-pairs loop.
    const maxCandidates = 96;
    for (let oz = -1; oz <= 1; oz++) {
      const nz = cz + oz;
      if (nz < 0 || nz >= grid.rows) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        if (nx < 0 || nx >= grid.columns) continue;
        const neighborCell = nz * grid.columns + nx;
        const start = grid.offsets[neighborCell], end = grid.offsets[neighborCell + 1], size = end - start;
        for (let n = 0; n < size && examined < maxCandidates; n++) {
          // Rotate a crowded cell's traversal by ID, avoiding always favoring low IDs.
          const j = grid.indices[start + ((n + id) % size)];
          if (j === id) continue;
          examined++;
          let dx = state.x[j] - x, dz = state.z[j] - z;
          let distance2 = dx * dx + dz * dz;
          if (distance2 > range2) continue;
          if (distance2 < 1e-8) {
            const sign = id < j ? 1 : -1;
            dx = sign * 0.001; dz = sign * 0.0007; distance2 = dx * dx + dz * dz;
          }
          const distance = Math.sqrt(distance2), radius = agents.radius[id] + agents.radius[j];
          // Give a person in the doorway room to pass even when they have slowed
          // to a stop. Step toward the nearer edge of their line of travel.
          if (this.doorwayCells?.[cell] && agents.portalStage[j]) {
            const intentX = agents.preferredVX[j], intentZ = agents.preferredVZ[j];
            const speed = Math.hypot(intentX, intentZ);
            if (speed > 0.01) {
              const ux = intentX / speed, uz = intentZ / speed;
              const ahead = -dx * ux - dz * uz, side = -dx * uz + dz * ux;
              const space = radius + 0.43;
              if (ahead > 0 && ahead < 1.9 && Math.abs(side) < space) {
                const weight = (1 - ahead / 2.2) * (1 - Math.abs(side) / space);
                if (weight > yieldWeight) {
                  const sign = side >= 0 ? 1 : -1;
                  yieldX = uz * sign; yieldZ = -ux * sign; yieldWeight = weight;
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
          if (forward > 0 && Math.abs(across) < radius + 0.2 && forward < 1.8) {
            const otherForward = state.vx[j] * dirX + state.vz[j] * dirZ;
            const closing = preferredSpeed - otherForward;
            if (closing > 0.15) brake = Math.max(brake, (1 - forward / 1.8) * Math.min(0.85, closing * 0.5));
          }
          // Predict a closest approach. Everyone consistently passes on their own right.
          const rvx = dirX * preferredSpeed - state.vx[j], rvz = dirZ * preferredSpeed - state.vz[j];
          const rv2 = rvx * rvx + rvz * rvz;
          if (forward > 0 && rv2 > 0.08) {
            const time = (dx * rvx + dz * rvz) / rv2;
            if (time > 0 && time < 1.6) {
              const closestX = dx - rvx * time, closestZ = dz - rvz * time;
              const clearance = radius + 0.35;
              const closest2 = closestX * closestX + closestZ * closestZ;
              if (closest2 < clearance * clearance) {
                const urgency = (1 - time / 1.6) * (1 - Math.sqrt(closest2) / clearance);
                lateral = Math.max(lateral, urgency * 1.25);
                brake = Math.max(brake, urgency * 0.3);
              }
            }
          }
        }
      }
    }
    this.candidateChecks += examined;
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
      this.urban.avoidance(x, z, agents.radius[id], this.wallPush);
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
