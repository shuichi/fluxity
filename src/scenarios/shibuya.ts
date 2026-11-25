import type { PedestrianPortal, Scenario } from '../types';
import map from './data/shibuya-map.json';
import layout from '../../data/shibuya/layout.json';

const portals: PedestrianPortal[] = [
  ...layout.doorways.map(door => ({ ...door, kind: 'door' as const })),
  ...layout.streetEnds.map(street => ({ ...street, kind: 'street' as const })),
];

/** PLATEAU FY2025 buildings/roads, with documented ground-level demo overlays. */
export const shibuya: Scenario = {
  id: 'shibuya',
  name: 'Shibuya Scramble',
  description: 'PLATEAU city geometry with signal-controlled pedestrian flow.',
  bounds: layout.bounds,
  obstacles: [], // Polygon obstacles are already removed from the shared urban walkable surfaces.
  spawnZones: layout.spawnZones,
  portals,
  targets: portals.map(portal => portal.approach),
  spawnTargets: layout.spawnTargets,
  targetTransitions: layout.targetTransitions,
  navigationCellSize: 0.75,
  urbanMap: map,
  scramble: {
    roadHalfWidth: 0,
    crosswalks: layout.crosswalks,
    signalPositions: layout.signalPositions,
  },
};
