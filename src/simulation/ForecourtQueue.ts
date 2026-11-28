import { Random } from '../math/random';
import type { Point2 } from '../types';
import type { AgentData } from './AgentData';
import type { CrossingTraffic } from './CrossingTraffic';
import { FRONT_ROW_DEPTH, type CrosswalkFlow } from './CrosswalkFlow';
import type { Direction, Navigation } from './Navigation';

interface Place extends Point2 { taken: boolean }
const CLEARANCE = 0.34;
// Bound the walk back to the physical curb so the queue can reach the crossing on the following green.
const MAX_CURB_DISTANCE = 14;

/** Overflow from the three station-side crossing mouths can wait behind the curb on the square. */
export class ForecourtQueue {
  readonly route: Int16Array;
  readonly settled: Uint8Array;
  private readonly places: Place[] = [];
  private readonly visibleFromEntrance = new Map<Point2, { place: Place; curbDistance: number }[]>();
  private readonly assigned: (Place | undefined)[];

  constructor(private readonly nav: Navigation, private readonly agents: AgentData, private readonly crossings: CrosswalkFlow,
    private readonly density: CrossingTraffic, private readonly seed: number) {
    this.route = new Int16Array(agents.count);
    this.settled = new Uint8Array(agents.count);
    this.assigned = new Array(agents.count);
    const random = new Random(seed);
    // Space waiting bodies across the apron and the interior, leaving the mouths themselves free.
    for (let z = 18; z <= 38; z += 1.05) for (let x = 12; x <= 41; x += 1.05) {
      const px = x + random.range(-0.22, 0.22), pz = z + random.range(-0.22, 0.22);
      if (nav.urban!.isSidewalk(px, pz, 0.8)) this.places.push({ x: px, z: pz, taken: false });
    }
  }

  reset(id: number): void {
    const place = this.assigned[id];
    if (place) place.taken = false;
    this.assigned[id] = undefined;
    this.route[id] = this.settled[id] = 0;
  }

  private choose(id: number, step: number, x: number, z: number, entrance: Point2, route: number): Place | undefined {
    const sidewalk = this.nav.urban!.sidewalks;
    let places = this.visibleFromEntrance.get(entrance);
    if (!places) {
      places = [];
      for (const place of this.places) {
        if (Math.hypot(place.x - entrance.x, place.z - entrance.z) < 3) continue;
        const curb = this.crossings.nearestLanding(route, place.x, place.z);
        const curbDistance = Math.hypot(place.x - curb.x, place.z - curb.z);
        if (curbDistance <= MAX_CURB_DISTANCE && sidewalk.lineInside(place.x, place.z, entrance.x, entrance.z, CLEARANCE)) {
          places.push({ place, curbDistance });
        }
      }
      this.visibleFromEntrance.set(entrance, places);
    }
    const random = new Random(this.seed ^ Math.imul(id + 1, 0x9e3779b1) ^ this.agents.generation[id] ^ step);
    let choice: Place | undefined, best = Infinity;
    for (let n = 0; n < Math.min(48, places.length); n++) {
      const { place, curbDistance } = places[random.int(places.length)];
      if (place.taken) continue;
      const distance = Math.hypot(place.x - x, place.z - z);
      if (distance > 19) continue;
      const score = distance + 0.9 * curbDistance
        + 6 * this.density.cost(place.x, place.z, 0, 0);
      if (score < best && sidewalk.lineInside(x, z, place.x, place.z, this.agents.radius[id] + 0.015)) {
        best = score; choice = place;
      }
    }
    return choice;
  }

  guide(id: number, step: number, out: Direction): boolean {
    const a = this.agents, x = a.current.x[id], z = a.current.z[id];
    let place = this.assigned[id];
    if (!place) {
      if ((step + id) % 24 || x < 4 || x > 44 || z < 11 || z > 40) return false;
      const route = this.crossings.plannedRoute(id, x, z, a.targetId[id]);
      if (!route) return false;
      const entrance = this.crossings.entrance(route);
      if (entrance.x < 14 || entrance.x > 25 || entrance.z < 17 || entrance.z > 22) return false;
      // Front rows keep their place. Later arrivals consider the density at their mouth and along its approach.
      const curb = this.crossings.nearestLanding(route, x, z);
      if (Math.hypot(curb.x - x, curb.z - z) < FRONT_ROW_DEPTH) return false;
      const apronX = 0.7 * curb.x + 0.3 * entrance.x, apronZ = 0.7 * curb.z + 0.3 * entrance.z;
      if (Math.max(this.density.cost(x, z, 0, 0), this.density.cost(apronX, apronZ, 0, 0),
        this.density.cost(curb.x, curb.z, 0, 0)) < 0.55) return false;
      place = this.choose(id, step, x, z, entrance, route);
      if (!place) return false;
      this.crossings.reset(id);
      this.route[id] = route; this.assigned[id] = place; place.taken = true;
    }
    const dx = place.x - x, dz = place.z - z, distance = Math.hypot(dx, dz);
    if (!this.nav.urban!.sidewalks.lineInside(x, z, place.x, place.z, a.radius[id] + 0.015)) {
      this.reset(id); return false;
    }
    // Hysteresis lets a queue yield to passing people without pacing around each waiting position.
    this.settled[id] = Number(distance <= (this.settled[id] ? 0.75 : 0.4));
    const scale = this.settled[id] ? 0 : 1 / Math.max(1, distance);
    out.x = dx * scale; out.z = dz * scale;
    return true;
  }

  /** A distant waiting pedestrian walks back to their chosen crossing until ordinary lane guidance takes over. */
  approach(id: number, out: Direction): boolean {
    const entrance = this.crossings.entrance(this.route[id]);
    const a = this.agents, x = a.current.x[id], z = a.current.z[id];
    const dx = entrance.x - x, dz = entrance.z - z, length = Math.hypot(dx, dz);
    if (length < 0.5 || !this.nav.urban!.sidewalks.lineInside(x, z, entrance.x, entrance.z, a.radius[id] + 0.015)) {
      this.reset(id); return false;
    }
    out.x = dx / length; out.z = dz / length;
    return true;
  }
}
