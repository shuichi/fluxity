// Paired 1,000-person Shibuya comparison. See docs/results/shibuya-forecourt.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import layout from '../data/shibuya/layout.json';
import { shibuya } from '../src/scenarios/shibuya';
import { Navigation } from '../src/simulation/Navigation';
import { Simulation } from '../src/simulation/Simulation';
import { PolygonRegion } from '../src/simulation/UrbanGeometry';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';
import type { UrbanMap } from '../src/types';

const { values } = parseArgs({ options: {
  seed: { type: 'string', default: '42' }, seconds: { type: 'string', default: '360' },
  variant: { type: 'string', default: 'combined' }, 'reference-map': { type: 'string' },
} });
const seed = Number(values.seed), seconds = Number(values.seconds), variant = values.variant;
assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff);
assert.ok(Number.isSafeInteger(seconds) && seconds > 0);
assert.ok(variant === 'original' || variant === 'geometry' || variant === 'combined');
assert.ok(values['reference-map'], 'Provide the original Shibuya navigation JSON via --reference-map.');
const original: UrbanMap = JSON.parse(readFileSync(values['reference-map'], 'utf8'));
const config = { ...DEFAULT_CONFIG, seed, count: 1000, densityGuidance: false };
const originalScenario = { ...shibuya, urbanMap: original, forecourtRouting: false };

// Changing walkability changes spawn rejection draws. Run the usual initializer and
// initial activity casting with the reference navigator. Restore the travel navigator
// before the first step. This hook is local to this single-process benchmark.
function pairedSimulation(): Simulation {
  if (variant === 'original') return new Simulation(config, undefined, originalScenario);
  const reference = new Navigation(originalScenario);
  const initialize = Simulation.prototype['initialize'];
  let travel: Navigation | undefined;
  Simulation.prototype['initialize'] = function () {
    travel = this.navigation;
    Object.assign(this, { navigation: reference });
    initialize.call(this);
  };
  try {
    const scenario = { ...shibuya, forecourtRouting: variant === 'combined' };
    const sim = new Simulation(config, undefined, scenario);
    assert.ok(travel);
    Object.assign(sim, { navigation: travel });
    if (sim.activities) Object.assign(sim.activities, { nav: travel });
    for (let id = 0; id < sim.agents.count; id++) {
      const { x, z } = sim.agents.current;
      assert.ok(travel.isSpawnable(x[id], z[id], sim.agents.radius[id]));
    }
    return sim;
  } finally {
    Simulation.prototype['initialize'] = initialize;
  }
}

const sim = pairedSimulation(), { agents } = sim, count = agents.count;
const hash = createHash('sha256');
for (const field of [agents.current.x, agents.current.z, agents.current.heading, agents.current.vx, agents.current.vz,
  agents.current.phase, agents.scale, agents.tint, agents.appearance, agents.preferredSpeed, agents.targetId,
  agents.targetX, agents.targetZ, sim.activities!.role, sim.activities!.groupLeader]) hash.update(field);
const initialStateSha256 = hash.digest('hex');

// Fixed geographic masks in all variants. Flood the original shoulder-clear sidewalk
// from its narrow strip and plaza. The added connection is measured separately.
const originalSide = original.sidewalks.map(p => new PolygonRegion([p])).find(p => p.contains(19, 23))!;
const side = sim.scenario.urbanMap!.sidewalks.map(p => new PolygonRegion([p]));
const stationSide = side.find(p => p.contains(19, 23))!;
const plazaOverlay = new PolygonRegion([layout.pedestrianAreas[0]]);
const mouths = [1, 2, 4].map(i => shibuya.scramble!.crosswalks[i].to);
const cellSize = 0.125, x0 = -5, z0 = 12, width = 500, height = 450;
const mask = new Int8Array(width * height), queue = new Int32Array(mask.length);
const maskCell = (x: number, z: number) => Math.floor((z - z0) / cellSize) * width + Math.floor((x - x0) / cellSize);
const cellX = (i: number) => x0 + (i % width + 0.5) * cellSize;
const cellZ = (i: number) => z0 + (Math.floor(i / width) + 0.5) * cellSize;
for (let i = 0; i < mask.length; i++) if (originalSide.contains(cellX(i), cellZ(i), 0.34)) mask[i] = -1;
function flood(x: number, z: number, label: number): number {
  const source = maskCell(x, z);
  assert.equal(mask[source], -1);
  let head = 0, tail = 1;
  mask[source] = label; queue[0] = source;
  while (head < tail) {
    const cell = queue[head++];
    const col = cell % width;
    for (const next of [cell - width, cell + width, col > 0 ? cell - 1 : -1, col + 1 < width ? cell + 1 : -1]) {
      if (next >= 0 && next < mask.length && mask[next] === -1) { mask[next] = label; queue[tail++] = next; }
    }
  }
  return tail * cellSize ** 2;
}
const stripArea = flood(5, 40, 1), plazaArea = flood(20, 40, 2);
assert.ok(!mask.includes(-1), 'Unexpected additional station-side component');
function zone(x: number, z: number): number {
  if (!stationSide.contains(x, z)) return 0;
  if (!originalSide.contains(x, z)) return 3;
  const col = Math.floor((x - x0) / cellSize), row = Math.floor((z - z0) / cellSize);
  if (col < 0 || col >= width || row < 0 || row >= height) return 0;
  const cell = row * width + col;
  if (mask[cell] > 0) return mask[cell];
  // The exact simulated radii are smaller than the route grid's 34 cm envelope.
  let best = Infinity, nearest = 0;
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    if (col + dx < 0 || col + dx >= width || row + dz < 0 || row + dz >= height) continue;
    const i = cell + dz * width + dx;
    if (!(mask[i] > 0)) continue;
    const d = (x - cellX(i)) ** 2 + (z - cellZ(i)) ** 2;
    if (d < best) { best = d; nearest = mask[i]; }
  }
  return nearest;
}
function inInterior(x: number, z: number) {
  return plazaOverlay.contains(x, z, 3) && mouths.every(p => (x - p.x) ** 2 + (z - p.z) ** 2 > 64);
}
const roadSide = new Int16Array(count).fill(-1), previousSide = new Int16Array(count).fill(-1);
const arrivedAtStation = new Uint8Array(count), usedInterior = new Uint8Array(count);
const lastLife = agents.generation.slice();
const geometry = sim.navigation.urban!;
const leavesStation = sim.scenario.targets.map(target => !stationSide.contains(target.x, target.z));
const redArrival = new Float64Array(count).fill(-1), roadEntry = new Float64Array(count).fill(-1);
const waitSeconds: number[] = [];
const reachedRoadInterior = new Uint8Array(count);
const edge = { x: 0, z: 0, distance: 0 };
let returned = 0, deepReturns = 0, changedLife = 0;
let crossings = 0, redEntries = 0, flashingEntries = 0, stationLandings = 0, toInterior = 0;
let greenStarts = 1, priorLight = sim.signal!.pedestrian, maxWaiting = 0;
const stepMs: number[] = [], redStrip: number[] = [], redPlaza: number[] = [], redPeakCell: number[] = [];
const sample = { second: 0, pedestrian: '', strip: 0, plaza: 0, link: 0, interior: 0, globalWaiting: 0, crossing: 0 };

function observeCrossings() {
  const s = agents.current;
  for (let id = 0; id < count; id++) {
    if (lastLife[id] !== agents.generation[id] || sim.isInPassage(id)) {
      if (redArrival[id] >= 0) changedLife++;
      redArrival[id] = roadEntry[id] = -1; reachedRoadInterior[id] = 0;
      lastLife[id] = agents.generation[id]; previousSide[id] = roadSide[id] = -1;
      arrivedAtStation[id] = usedInterior[id] = 0;
      continue;
    }
    const x = s.x[id], z = s.z[id], radius = agents.radius[id] + 0.015;
    if (arrivedAtStation[id] && !usedInterior[id] && inInterior(x, z) && stationSide.contains(x, z)) {
      usedInterior[id] = 1; toInterior++;
    }
    // Only the junction has a signal. Keep body-clear sidewalk classification through
    // a substep near its landings, including the short interval touching neither surface.
    if (x < -41 || x > 38 || z < -32 || z > 31) { previousSide[id] = roadSide[id] = -1; continue; }
    const onSide = geometry.isSidewalk(x, z, radius);
    const onRoad = !onSide && geometry.occupiesCrossing(x, z, radius);
    if (onSide) {
      if (roadSide[id] >= 0) {
        const exit = side.findIndex(region => region.contains(x, z));
        if (exit >= 0 && exit !== roadSide[id]) {
          crossings++;
          if (side[exit] === stationSide) { stationLandings++; arrivedAtStation[id] = 1; usedInterior[id] = 0; }
        }
        if (roadEntry[id] >= 0) {
          if (exit >= 0 && exit !== roadSide[id]) {
            waitSeconds.push(roadEntry[id] - redArrival[id]);
            redArrival[id] = -1;
          } else {
            returned++;
            if (reachedRoadInterior[id]) deepReturns++;
          }
          roadEntry[id] = -1; reachedRoadInterior[id] = 0;
        }
        roadSide[id] = -1; previousSide[id] = exit;
      } else if (previousSide[id] < 0) {
        previousSide[id] = side.findIndex(region => region.contains(x, z));
      }
    } else if (onRoad && previousSide[id] >= 0) {
      roadSide[id] = previousSide[id]; previousSide[id] = -1;
      if (side[roadSide[id]] === stationSide) {
        if (redArrival[id] >= 0) roadEntry[id] = sim.time;
        arrivedAtStation[id] = 0;
      }
      if (sim.signal!.pedestrian === 'red') redEntries++;
      if (sim.signal!.pedestrian === 'flashingGreen') flashingEntries++;
    }
    if (onRoad && roadEntry[id] >= 0 && !reachedRoadInterior[id] && !stationSide.contains(x, z)
      && !stationSide.nearest(x, z, 2, edge)) reachedRoadInterior[id] = 1;
  }
}
function observeSecond(second: number) {
  const bins = new Map<number, number>(), counts = [0, 0, 0, 0];
  let interior = 0, peak = 0;
  for (let id = 0; id < count; id++) {
    if (sim.isInPassage(id)) continue;
    const x = agents.current.x[id], z = agents.current.z[id], location = zone(x, z);
    if (!location) continue;
    if (sim.signal!.pedestrian === 'red' && redArrival[id] < 0 && leavesStation[agents.targetId[id]]
      && x >= 0 && x <= 52 && z >= 12 && z <= 49 && geometry.isSidewalk(x, z, agents.radius[id] + 0.015)) {
      redArrival[id] = second;
    }
    counts[location]++;
    if (inInterior(x, z)) interior++;
    const bin = Math.floor((z - z0) / 3) * 100 + Math.floor((x - x0) / 3);
    const n = (bins.get(bin) ?? 0) + 1;
    bins.set(bin, n); peak = Math.max(peak, n);
  }
  const signal = sim.signal!;
  if (signal.pedestrian === 'red') {
    redStrip.push(counts[1]); redPlaza.push(counts[2]); redPeakCell.push(peak);
  }
  maxWaiting = Math.max(signal.waiting, maxWaiting);
  if (second === 276) Object.assign(sample, { second, pedestrian: signal.pedestrian, strip: counts[1], plaza: counts[2], link: counts[3],
    interior, globalWaiting: signal.waiting, crossing: signal.crossing });
}
observeCrossings();
for (let step = 1; step <= seconds / FIXED_DT; step++) {
  const start = performance.now();
  sim.step(); stepMs.push(performance.now() - start);
  observeCrossings();
  if (sim.signal!.pedestrian === 'green' && priorLight !== 'green') greenStarts++;
  priorLight = sim.signal!.pedestrian;
  if (step % 30 === 0) observeSecond(step / 30);
}
function quantile(values: number[], fraction = 0.95): number | null {
  if (!values.length) return null;
  const sorted = values.sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2));
}
console.log(JSON.stringify({ seed, count, seconds, variant, initialStateSha256, greenStarts,
  sample: sample.second ? sample : null, stripArea, plazaArea, redStripP95: quantile(redStrip), redPlazaP95: quantile(redPlaza),
  redPeak3mCellP95: quantile(redPeakCell), stationLandings, toInterior, crossings, arrivals: sim.arrivals,
  redEntries, flashingEntries, maxWaiting,
  stationWait: { completed: waitSeconds.length, medianSeconds: quantile(waitSeconds, 0.5), p95Seconds: quantile(waitSeconds),
    awaitingEntry: redArrival.filter((value, id) => value >= 0 && roadEntry[id] < 0).length,
    onRoad: roadEntry.filter(value => value >= 0).length, returned, deepReturns, changedLife },
  contactReactions: sim.encounters.contactEvents, p95StepMs: quantile(stepMs) }));
