import type { Scenario } from '../types';
import map from './data/shibuya-map.json';
import layout from '../../data/shibuya/layout.json';

/** PLATEAU FY2025 buildings/roads, with documented ground-level demo overlays. */
export const shibuya: Scenario = {
  id: 'shibuya',
  name: 'Shibuya Scramble',
  description: 'PLATEAU city geometry with signal-controlled pedestrian flow.',
  bounds: layout.bounds,
  obstacles: [], // Polygon obstacles are already removed from the shared urban walkable surfaces.
  spawnZones: layout.spawnZones,
  targets: layout.targets,
  spawnTargets: layout.spawnTargets,
  targetTransitions: layout.targetTransitions,
  targetSpread: layout.targetSpread,
  navigationCellSize: 0.75,
  urbanMap: map,
  scramble: {
    roadHalfWidth: 0,
    crosswalks: layout.crosswalks,
    signalPositions: layout.signalPositions,
  },
};
