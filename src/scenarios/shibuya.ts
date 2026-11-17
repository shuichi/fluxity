import type { Scenario } from '../types';

/** Shibuya-inspired layout, not a survey or a scale reconstruction of the real intersection. */
export const shibuya: Scenario = {
  id: 'shibuya', name: 'Shibuya Scramble',
  description: 'Four corners gather, then cross together on the pedestrian signal.',
  bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
  obstacles: [
    { x: -77, z: -77, width: 36, depth: 36, height: 42, kind: 'building' },
    { x: 77, z: -77, width: 36, depth: 36, height: 34, kind: 'building' },
    { x: -77, z: 77, width: 36, depth: 36, height: 26, kind: 'building' },
    { x: 77, z: 77, width: 36, depth: 36, height: 10, kind: 'building' },
  ],
  spawnZones: [
    { x: -57, z: -57, width: 74, depth: 74 },
    { x: 57, z: -57, width: 74, depth: 74 },
    { x: -57, z: 57, width: 74, depth: 74 },
    { x: 57, z: 57, width: 74, depth: 74 },
  ],
  targets: [{ x: -52, z: -52 }, { x: 52, z: -52 }, { x: -52, z: 52 }, { x: 52, z: 52 }],
  spawnTargets: [3, 2, 1, 0],
  scramble: {
    roadHalfWidth: 18,
    crosswalks: [
      { from: { x: -27, z: -27 }, to: { x: -27, z: 27 }, width: 10 },
      { from: { x: 27, z: -27 }, to: { x: 27, z: 27 }, width: 10 },
      { from: { x: -27, z: -27 }, to: { x: 27, z: -27 }, width: 10 },
      { from: { x: -27, z: 27 }, to: { x: 27, z: 27 }, width: 10 },
      { from: { x: -27, z: 27 }, to: { x: 27, z: -27 }, width: 10 },
    ],
    signalPositions: [{ x: -23, z: -23 }, { x: 23, z: -23 }, { x: -23, z: 23 }, { x: 23, z: 23 }],
  },
};
