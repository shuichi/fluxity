import type { PedestrianPortal, Scenario } from '../types';

const portals: PedestrianPortal[] = [
  { id: 'west-end', kind: 'street', approach: { x: -88, z: 0 }, end: { x: -93, z: 0 }, width: 50 },
  { id: 'east-end', kind: 'street', approach: { x: 88, z: 0 }, end: { x: 93, z: 0 }, width: 50 },
  { id: 'north-end', kind: 'street', approach: { x: 0, z: -88 }, end: { x: 0, z: -93 }, width: 50 },
  { id: 'south-end', kind: 'street', approach: { x: 0, z: 88 }, end: { x: 0, z: 93 }, width: 50 },
];

export const crossing: Scenario = {
  id: 'crossing', name: 'Crossing Flow',
  description: 'Four directions. One shared intersection.',
  bounds: { minX: -90, maxX: 90, minZ: -90, maxZ: 90 },
  obstacles: [-65, 65].flatMap(x => [-65, 65].map(z => ({
    x, z, width: 74, depth: 74, height: 7 + (x * z > 0 ? 4 : 0), kind: 'building' as const,
  }))),
  spawnZones: [
    { x: -52, z: 0, width: 70, depth: 52 },
    { x: 52, z: 0, width: 70, depth: 52 },
    { x: 0, z: -52, width: 52, depth: 70 },
    { x: 0, z: 52, width: 52, depth: 70 },
  ],
  portals,
  targets: portals.map(portal => portal.approach),
  spawnTargets: [1, 0, 3, 2],
  targetTransitions: [1, 0, 3, 2],
};
