import type { PedestrianPortal, Scenario } from '../types';
import { Random } from '../math/random';

type TripPurpose = 'through' | 'shopping' | 'outbound';

/** Demand is sampled per person and trip, independently of the number of candidate doors and lane retries. */
export class PortalTripDemand {
  private readonly streets: number[] = [];
  private readonly doors: number[] = [];
  constructor(private readonly portals: PedestrianPortal[], private readonly mix: NonNullable<Scenario['portalTripMix']>,
    private readonly seed: number) {
    if (mix.through < 0 || mix.shopping < 0 || !(mix.through + mix.shopping <= 1)) {
      throw new Error('Invalid pedestrian trip shares.');
    }
    portals.forEach((p, index) => {
      (p.kind === 'street' ? this.streets : this.doors).push(index);
    });
    if (!this.streets.length || !this.doors.length) throw new Error('Mixed street and shopping trips require both types of portal.');
  }

  private tripSeed(id: number, generation: number): number {
    return this.seed ^ Math.imul(id + 1, 0x85ebca6b) ^ Math.imul(generation + 1, 0xc2b2ae35);
  }

  purpose(id: number, generation: number): TripPurpose {
    const sample = new Random(this.tripSeed(id, generation)).next();
    if (sample < this.mix.through) return 'through';
    return sample < this.mix.through + this.mix.shopping ? 'shopping' : 'outbound';
  }

  preferredOrigin(purpose: TripPurpose): PedestrianPortal['kind'] {
    // One street end cannot represent a trip between two edges. Use an interior origin for it.
    return purpose === 'outbound' || (purpose === 'through' && this.streets.length === 1) ? 'door' : 'street';
  }

  target(id: number, generation: number, x: number, z: number, origin = -1): number {
    const purpose = this.purpose(id, generation);
    let candidates = purpose === 'shopping' ? this.doors : this.streets;
    if (candidates.length === 1 && candidates[0] === origin) {
      // Even when only the substitute origin was available, never send someone back through their own mouth.
      candidates = purpose === 'shopping' ? this.streets : this.doors;
    }
    const originEdge = this.portals[origin]?.edge;
    const useOtherEdge = originEdge && candidates === this.streets && this.streets.some(i => this.portals[i].edge !== originEdge);
    const weights: number[] = [];
    let total = 0;
    for (const index of candidates) {
      const portal = this.portals[index];
      const distance = Math.hypot(portal.approach.x - x, portal.approach.z - z);
      // Prefer nearer shops and substantial cross-map trips. Width is a proxy for relative demand.
      const distanceWeight = portal.kind === 'door' ? 1 / (1 + distance / 80) : 0.3 + distance / (50 + distance);
      const weight = index === origin || (useOtherEdge && portal.edge === originEdge) ? 0 : portal.width * distanceWeight;
      weights.push(weight);
      total += weight;
    }
    const quantile = new Random(this.tripSeed(id, generation) ^ 0x27d4eb2f).next();
    let draw = total * quantile;
    for (let i = 0; i < candidates.length; i++) {
      if (draw < weights[i]) return candidates[i];
      draw -= weights[i];
    }
    throw new Error('No distinct pedestrian destination is available.');
  }
}
