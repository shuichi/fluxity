import type { Scenario } from '../types';

export const plaza: Scenario = {
  id: 'plaza', name: 'City Plaza',
  description: 'Everyday encounters in an open urban square.',
  bounds: { minX: -90, maxX: 90, minZ: -75, maxZ: 75 },
  obstacles: [
    { x: 0, z: 0, width: 13, depth: 13, height: 0.7, kind: 'planter' },
    ...[-35, 35].flatMap(x => [-28, 28].map(z => ({ x, z, width: 11, depth: 9, height: 0.7, kind: 'planter' as const }))),
    ...[-74, 74].flatMap(x => [-60, 60].map(z => ({ x, z, width: 19, depth: 18, height: 9 + (x > 0 ? 5 : 0), kind: 'building' as const }))),
  ],
  spawnZones: [
    { x: -42, z: 0, width: 78, depth: 132 },
    { x: 42, z: 0, width: 78, depth: 132 },
  ],
  targets: [
    { x: -82, z: 0 }, { x: 82, z: 0 },
    { x: 0, z: -67 }, { x: 0, z: 67 },
    { x: -42, z: -67 }, { x: 42, z: 67 },
    { x: 42, z: -67 }, { x: -42, z: 67 },
  ],
};
