import type { Scenario } from '../types';

export const bottleneck: Scenario = {
  id: 'bottleneck', name: 'Bottleneck',
  description: 'An eight-meter opening reveals the limits of flow.',
  bounds: { minX: -95, maxX: 95, minZ: -60, maxZ: 60 },
  obstacles: [
    { x: 0, z: -32, width: 6, depth: 56, height: 2.4, kind: 'barrier' },
    { x: 0, z: 32, width: 6, depth: 56, height: 2.4, kind: 'barrier' },
  ],
  spawnZones: [
    { x: -48, z: 0, width: 82, depth: 110 },
    { x: 48, z: 0, width: 82, depth: 110 },
  ],
  targets: [{ x: -85, z: 0 }, { x: 85, z: 0 }],
  spawnTargets: [1, 1],
};
