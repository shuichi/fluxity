import type { PedestrianPortal, Scenario } from '../types';
import map from './data/shibuya-map.json';
import layout from '../../data/shibuya/layout.json';
import expanded from '../../data/shibuya/expanded-portals.json';
import { SHIBUYA_VEHICLE_LANES } from '../simulation/VehicleLanes';

const originalDoors: PedestrianPortal[] = layout.doorways.map(door => ({ ...door, kind: 'door' }));
const originalStreets: PedestrianPortal[] = layout.streetEnds.map(street => ({ ...street, kind: 'street', edge: 'north' }));
const extraDoors: PedestrianPortal[] = expanded.doorways.map(door => ({ ...door, kind: 'door' }));
function streetPortal(street: Omit<PedestrianPortal, 'kind' | 'edge'> & { edge?: string }): PedestrianPortal {
  const { edge } = street;
  if (edge !== 'north' && edge !== 'south' && edge !== 'east' && edge !== 'west') {
    throw new Error(`Missing street direction for ${street.id}.`);
  }
  return { ...street, kind: 'street', edge };
}
const extraStreets = expanded.streetEnds.map(streetPortal);
const allDoors = [...originalDoors, ...extraDoors];
const portals = [...originalDoors, ...originalStreets];

/** Original routes for replaying the recorded six-portal crowd and historical comparisons. */
export const legacyShibuya: Scenario = {
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

/** Ground-level Shibuya variants share their starting population and trip-purpose distribution. */
export function createShibuyaScenario(shopLayout: 'five' | 'expanded', streetLayout: 'north' | 'all'): Scenario {
  const selected = [...portals];
  if (shopLayout === 'expanded') selected.push(...extraDoors);
  if (streetLayout === 'all') selected.push(...extraStreets);
  return {
    ...legacyShibuya,
    roadMarkings: 'shibuya',
    forecourtRouting: true,
    vehicleLanes: SHIBUYA_VEHICLE_LANES,
    portals: selected,
    targets: selected.map(p => p.approach),
    spawnTargets: undefined,
    targetTransitions: undefined,
    initialDoorways: allDoors,
    portalTripMix: { through: 0.50, shopping: 0.25 },
    portalRecoveryByDefault: false,
  };
}

export const shibuya = createShibuyaScenario('expanded', 'all');
