import type { PedestrianPortal, Scenario } from '../types';

const portals: PedestrianPortal[] = [
  { id: 'west-end', kind: 'street', approach: { x: -93, z: 0 }, end: { x: -98, z: 0 }, width: 100 },
  { id: 'east-end', kind: 'street', approach: { x: 93, z: 0 }, end: { x: 98, z: 0 }, width: 100, entry: false },
];

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
  portals,
  targets: portals.map(portal => portal.approach),
  spawnTargets: [1, 1],
  targetTransitions: [1, 0],
};
