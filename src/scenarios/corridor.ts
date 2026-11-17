import type { Scenario } from '../types';

export const corridor: Scenario = {
  id: 'corridor', name: 'Bidirectional Corridor',
  description: 'Two opposing streams find their own lanes.',
  bounds: { minX: -120, maxX: 120, minZ: -32, maxZ: 32 },
  obstacles: [
    { x: 0, z: -30, width: 240, depth: 4, height: 1.25, kind: 'barrier' },
    { x: 0, z: 30, width: 240, depth: 4, height: 1.25, kind: 'barrier' },
  ],
  spawnZones: [
    { x: -58, z: 0, width: 112, depth: 50 },
    { x: 58, z: 0, width: 112, depth: 50 },
  ],
  targets: [{ x: -111, z: 0 }, { x: 111, z: 0 }],
  spawnTargets: [1, 0],
};
