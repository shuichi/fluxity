import type { Obstacle, PedestrianPortal, Scenario } from '../types';

const shops: Obstacle[] = [-74, 74].flatMap(x => [-60, 60].map(z => ({
  x, z, width: 19, depth: 18, height: x > 0 ? 14 : 9, kind: 'building',
} as const)));

const portals: PedestrianPortal[] = [
  ...shops.map(shop => {
    const inward = -Math.sign(shop.z);
    const facade = shop.z + inward * shop.depth / 2;
    return {
      id: `${shop.z < 0 ? 'north' : 'south'}${shop.x < 0 ? 'west' : 'east'}-shop`, kind: 'door' as const,
      approach: { x: shop.x, z: facade + inward * 2.4 }, end: { x: shop.x, z: facade - inward * 0.8 }, width: 5.4,
    };
  }),
  { id: 'west-walk', kind: 'street', approach: { x: -88, z: 0 }, end: { x: -93, z: 0 }, width: 14 },
  { id: 'east-walk', kind: 'street', approach: { x: 88, z: 0 }, end: { x: 93, z: 0 }, width: 14 },
  { id: 'north-walk', kind: 'street', approach: { x: 0, z: -73 }, end: { x: 0, z: -78 }, width: 14 },
  { id: 'south-walk', kind: 'street', approach: { x: 0, z: 73 }, end: { x: 0, z: 78 }, width: 14 },
];

export const plaza: Scenario = {
  id: 'plaza', name: 'City Plaza',
  description: 'Everyday encounters in an open urban square.',
  bounds: { minX: -90, maxX: 90, minZ: -75, maxZ: 75 },
  obstacles: [
    { x: 0, z: 0, width: 13, depth: 13, height: 0.7, kind: 'planter' },
    ...[-35, 35].flatMap(x => [-28, 28].map(z => ({ x, z, width: 11, depth: 9, height: 0.7, kind: 'planter' as const }))),
    ...shops,
  ],
  spawnZones: [
    { x: -42, z: 0, width: 78, depth: 132 },
    { x: 42, z: 0, width: 78, depth: 132 },
  ],
  portals,
  targets: portals.map(portal => portal.approach),
};
