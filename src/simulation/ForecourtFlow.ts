import { Random } from '../math/random';
import type { Point2 } from '../types';
import type { AgentData } from './AgentData';
import { CrossingTraffic } from './CrossingTraffic';
import type { Direction, Navigation } from './Navigation';

// Local metres. The two perimeter sidewalks, the crossing landings and the
// open bands on either side of the planting all compete for the same trip.
const BANDS: Point2[] = [
  { x: 5.5, z: 39 }, { x: 8.1, z: 30 }, { x: 10.5, z: 23 }, { x: 14.5, z: 17 },
  { x: 21, z: 14.5 }, { x: 30, z: 15.2 }, { x: 39, z: 15.8 }, { x: 46, z: 16.5 },
  { x: 15.8, z: 21 }, { x: 19, z: 23.5 }, { x: 24, z: 20.5 }, { x: 32, z: 20.4 },
  { x: 39, z: 23 }, { x: 18.5, z: 28.5 }, { x: 20, z: 34 }, { x: 29, z: 33.5 },
  { x: 36, z: 32 }, { x: 44, z: 32 }, { x: 20, z: 40 }, { x: 38, z: 36 },
];
const BOUNDS = { minX: -4, maxX: 53, minZ: 9, maxZ: 48 };
const LINK_REACH = 13;
const PLAN_REACH = 27;
const WALKER = 0.34;
const distance = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.z - b.z);
const inDistrict = (x: number, z: number) =>
  x >= BOUNDS.minX && x <= BOUNDS.maxX && z >= BOUNDS.minZ && z <= BOUNDS.maxZ;

interface Link { from: number; to: number; length: number; cost: number }
interface Route { via: Point2[]; next: number; until: number; generation: number; target: number }

/** Choose a short sidewalk detour, anchored at both ends to the pedestrian's own trip. */
export class ForecourtFlow {
  readonly traffic = new CrossingTraffic(BOUNDS);
  private readonly bands: Point2[];
  private readonly links: Link[] = [];
  private readonly routes: (Route | undefined)[];
  private readonly review: Float32Array;
  private readonly widthPenalty: Float32Array;
  // The worker evaluates one walker at a time. Reuse these edge scores across route decisions.
  private readonly startCosts: Float64Array;
  private readonly endCosts: Float64Array;
  private readonly startLengths: Float64Array;
  private readonly endLengths: Float64Array;
  private readonly edge = { x: 0, z: 0, distance: 0 };
  private time = 0;

  constructor(private readonly nav: Navigation, private readonly agents: AgentData, private readonly seed: number) {
    const sidewalk = nav.urban!.sidewalks;
    this.bands = BANDS.filter(p => sidewalk.contains(p.x, p.z, WALKER));
    this.startCosts = new Float64Array(this.bands.length);
    this.endCosts = new Float64Array(this.bands.length);
    this.startLengths = new Float64Array(this.bands.length);
    this.endLengths = new Float64Array(this.bands.length);
    this.routes = new Array(agents.count);
    this.review = Float32Array.from({ length: agents.count }, (_, id) => (id % 31) / 30);
    this.widthPenalty = new Float32Array(nav.walkable.length).fill(-1);
    for (let i = 0; i < this.bands.length; i++) for (let j = 0; j < this.bands.length; j++) {
      const a = this.bands[i], b = this.bands[j], length = distance(a, b);
      if (i !== j && length <= LINK_REACH && sidewalk.lineInside(a.x, a.z, b.x, b.z, WALKER)) {
        this.links.push({ from: i, to: j, length, cost: this.cost(a, b, length) });
      }
    }
  }

  update(dt: number): void {
    this.time += dt;
    if (this.traffic.update(this.agents, dt)) {
      for (const link of this.links) link.cost = this.cost(this.bands[link.from], this.bands[link.to], link.length);
    }
  }

  reset(id: number): void { this.routes[id] = undefined; }

  private cost(a: Point2, b: Point2, length: number): number {
    if (length < 0.001) return length;
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
    const samples = Math.ceil(length / 2), stride = length / samples;
    let cost = length;
    for (let i = 0; i < samples; i++) {
      const x = a.x + (i + 0.5) * stride * ux, z = a.z + (i + 0.5) * stride * uz;
      const cell = this.nav.cellAt(x, z);
      if (this.widthPenalty[cell] < 0) {
        const { minX, minZ } = this.nav.scenario.bounds;
        const cx = minX + (cell % this.nav.columns + 0.5) * this.nav.cellSize;
        const cz = minZ + (Math.floor(cell / this.nav.columns) + 0.5) * this.nav.cellSize;
        const near = this.nav.urban!.sidewalks.nearest(cx, cz, 2.8, this.edge);
        this.widthPenalty[cell] = near ? 0.65 * (1 - this.edge.distance / 2.8) : 0;
      }
      const crowd = Math.max(0, this.traffic.cost(x, z, ux, uz) - 0.35);
      cost += stride * (this.widthPenalty[cell] + 1.8 * Math.min(3, crowd));
    }
    return cost;
  }

  /** Trace the ordinary trip field up to its next crossing, goal or the planning horizon. */
  private rejoin(id: number, start: Point2, radius: number) {
    const nav = this.nav, sidewalk = nav.urban!.sidewalks, field = nav.fields[this.agents.targetId[id]];
    let cell = nav.cellAt(start.x, start.z), end = start, length = 0, cost = 0;
    while (length < PLAN_REACH) {
      const ox = Math.sign(field.x[cell]), oz = Math.sign(field.z[cell]);
      if (!ox && !oz) break;
      cell += ox + oz * nav.columns;
      const next = { x: nav.scenario.bounds.minX + (cell % nav.columns + 0.5) * nav.cellSize,
        z: nav.scenario.bounds.minZ + (Math.floor(cell / nav.columns) + 0.5) * nav.cellSize };
      if (!sidewalk.lineInside(end.x, end.z, next.x, next.z, radius)) break;
      const step = distance(end, next);
      length += step; cost += this.cost(end, next, step); end = next;
      if (!inDistrict(next.x, next.z)) break;
    }
    return { end, length, cost };
  }

  private plan(id: number, start: Point2, direction: Direction, radius: number): Route | undefined {
    const sidewalk = this.nav.urban!.sidewalks;
    if (!sidewalk.contains(start.x, start.z, radius)) return;
    const { end, length, cost } = this.rejoin(id, start, radius);
    if (length < 6 || distance(start, end) < 4) return;
    // Up to two adjacent bands are enough to skirt the planting and rejoin the
    // original approach. Compare travel in metres before including preferences.
    const limit = 1.3 * length + 1;
    const starts = this.startCosts.fill(Infinity), ends = this.endCosts.fill(Infinity);
    const startLength = this.startLengths, endLength = this.endLengths;
    let best = cost - Math.max(0.8, cost * 0.05), first = -1, second = -1;
    for (let i = 0; i < this.bands.length; i++) {
      const node = this.bands[i], ahead = (node.x - start.x) * direction.x + (node.z - start.z) * direction.z;
      const s = startLength[i] = distance(start, node), e = endLength[i] = distance(node, end);
      if (s >= 1 && s <= LINK_REACH && ahead > -0.25 * s && sidewalk.lineInside(start.x, start.z, node.x, node.z, radius)) {
        starts[i] = this.cost(start, node, s);
      }
      if (e <= LINK_REACH && sidewalk.lineInside(node.x, node.z, end.x, end.z, radius)) ends[i] = this.cost(node, end, e);
      const score = starts[i] + ends[i];
      if (s + e <= limit && score < best) { best = score; first = i; second = -1; }
    }
    for (const link of this.links) {
      const score = starts[link.from] + link.cost + ends[link.to];
      if (score >= best || startLength[link.from] + link.length + endLength[link.to] > limit) continue;
      best = score; first = link.from; second = link.to;
    }
    if (first < 0) return;
    const via = [this.bands[first]];
    if (second >= 0) via.push(this.bands[second]);
    via.push(end);
    // Sample space across the chosen bands once for this life. Keep the centre
    // if the shifted pair of segments clips a curb, planting or building.
    const rng = new Random(this.seed ^ Math.imul(id + 1, 0x9e3779b1) ^ this.agents.generation[id]);
    for (let i = 0; i < via.length - 1; i++) {
      const prev = i ? via[i - 1] : start, node = via[i], next = via[i + 1];
      const span = distance(prev, next);
      if (span < 0.1) continue;
      const offset = rng.range(-1.25, 1.25);
      const p = { x: node.x + (next.z - prev.z) / span * offset, z: node.z - (next.x - prev.x) / span * offset };
      if (sidewalk.lineInside(prev.x, prev.z, p.x, p.z, radius) && sidewalk.lineInside(p.x, p.z, next.x, next.z, radius)) via[i] = p;
    }
    return { via, next: 0, until: this.time + limit / Math.max(0.5, this.agents.preferredSpeed[id]) * 1.7 + 3,
      generation: this.agents.generation[id], target: this.agents.targetId[id] };
  }

  guide(id: number, direction: Direction): boolean {
    const a = this.agents, x = a.current.x[id], z = a.current.z[id], radius = a.radius[id] + 0.015;
    if (!inDistrict(x, z) || a.portalStage[id]) { this.routes[id] = undefined; return false; }
    // The assigned doorway lane can sit several metres from the trip-field goal.
    if (Math.hypot(a.targetX[id] - x, a.targetZ[id] - z) < 6
      && this.nav.urban!.sidewalks.lineInside(x, z, a.targetX[id], a.targetZ[id], radius)) {
      this.reset(id);
      return false;
    }
    let route = this.routes[id];
    if (route && (route.generation !== a.generation[id] || route.target !== a.targetId[id] || this.time > route.until)) {
      this.routes[id] = route = undefined;
    }
    if (!route) {
      if (this.time < this.review[id]) return false;
      this.review[id] = this.time + 2.5;
      this.routes[id] = route = this.plan(id, { x, z }, direction, radius);
      if (!route) return false;
    }
    let target = route.via[route.next];
    if (Math.hypot(target.x - x, target.z - z) < 0.8) target = route.via[++route.next];
    if (!target || !this.nav.urban!.sidewalks.lineInside(x, z, target.x, target.z, radius)) {
      this.routes[id] = undefined;
      this.review[id] = this.time + 2.5;
      return false;
    }
    const length = Math.hypot(target.x - x, target.z - z);
    if (length < 0.001) return false;
    direction.x = (target.x - x) / length; direction.z = (target.z - z) / length;
    return true;
  }
}
