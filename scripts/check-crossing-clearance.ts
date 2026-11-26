import { Simulation } from '../src/simulation/Simulation';
import { CrossingExits } from '../src/simulation/CrossingExits';
import { SIGNAL_TIMINGS } from '../src/simulation/TrafficSignal';
import { PolygonRegion } from '../src/simulation/UrbanGeometry';
import { DEFAULT_CONFIG, FIXED_DT, MAX_AGENTS } from '../src/types';

const seed = process.argv[2] === undefined ? 42 : Number(process.argv[2]);
const lastGreen = Math.round(SIGNAL_TIMINGS.pedestrian.green / FIXED_DT) - 1;
const lastFlashing = Math.round((SIGNAL_TIMINGS.pedestrian.green + SIGNAL_TIMINGS.pedestrian.warning) / FIXED_DT) - 1;
const redAfterStep = Number(process.argv[3] ?? lastGreen);
const count = Number(process.argv[4] ?? 1000);
if (process.argv.length > 5 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
  || !Number.isInteger(count) || count < 1 || count > MAX_AGENTS
  || !Number.isInteger(redAfterStep) || redAfterStep < 1 || redAfterStep > lastFlashing) {
  throw new Error(`Usage: node --import tsx scripts/check-crossing-clearance.ts [seed] [red-after-step 1..${lastFlashing}] [count]`);
}
const simulation = new Simulation({ ...DEFAULT_CONFIG, count, seed, scenario: 'shibuya',
  walkingSpeed: 1.35, avoidanceStrength: 1, signalMode: 'auto' });
const agents = simulation.agents, geometry = simulation.navigation.scramble!;
const inCrossing = (id: number) => simulation.navigation.urban!.occupiesCrossing(
  agents.current.x[id], agents.current.z[id], agents.radius[id] + 0.015);
const previous = new Uint8Array(agents.count);
const sidewalks = simulation.scenario.urbanMap!.sidewalks.map(polygon => new PolygonRegion([polygon]));
const bankAt = (x: number, z: number) => sidewalks.findIndex(sidewalk => sidewalk.contains(x, z));
const expectedBank = new Int16Array(count).fill(-1);
const exits = new CrossingExits(simulation.navigation, simulation.grid);
const landing = { x: 0, z: 0 }, waypoint = { x: 0, z: 0 };
function rememberLanding(id: number): void {
  const found = exits.choose(agents.current.x[id], agents.current.z[id], agents.radius[id] + 0.015, landing, waypoint);
  expectedBank[id] = found ? bankAt(landing.x, landing.z) : -1;
  if (expectedBank[id] < 0) throw new Error(`No reachable sidewalk for pedestrian ${id}.`);
}
for (let step = 1; step <= redAfterStep; step++) {
  if (step > lastGreen) {
    for (let id = 0; id < count; id++) {
      previous[id] = Number(inCrossing(id));
      if (previous[id] && step === lastGreen + 1) rememberLanding(id);
    }
  }
  simulation.step();
  if (simulation.signal!.pedestrian !== 'flashingGreen') continue;
  for (let id = 0; id < count; id++) {
    if (!previous[id] && inCrossing(id)) throw new Error(`Pedestrian ${id} entered the road on flashing green at step ${step}.`);
    if (previous[id] && Math.hypot(agents.preferredVX[id], agents.preferredVZ[id]) < 1e-3) {
      throw new Error(`Pedestrian ${id} lost their clearance direction on flashing green at step ${step}.`);
    }
  }
}
const generations = agents.generation.slice();
const remaining = new Set<number>();
let redEntries = 0;
let clearedAt = 0;
for (let id = 0; id < agents.count; id++) {
  previous[id] = Number(inCrossing(id));
  if (previous[id]) {
    remaining.add(id);
    if (expectedBank[id] < 0) rememberLanding(id);
  }
}
const initial = remaining.size;
if (initial !== simulation.signal!.crossing || !initial) throw new Error('Invalid initial crossing count.');
simulation.updateSettings({ signalMode: 'allRed' });
const checkpoints = new Set([0, 12, 30, 60, 120].map(seconds => Math.round(seconds / FIXED_DT)));
console.log('secondsSinceClosure  remainingFromStart  crossing  newEntries');
console.log(0, initial, simulation.signal!.crossing, redEntries);
for (let step = 1; step <= Math.round(120 / FIXED_DT); step++) {
  simulation.step();
  let crossing = 0;
  for (let id = 0; id < agents.count; id++) {
    const onRoad = inCrossing(id);
    const samePerson = generations[id] === agents.generation[id];
    if (!samePerson && remaining.has(id)) throw new Error(`Pedestrian ${id} was replaced before reaching a sidewalk.`);
    if (onRoad) {
      crossing++;
      if (!previous[id] || !samePerson) redEntries++;
    } else if (remaining.has(id)) {
      // A slot replacement or transfer must never masquerade as a successful crossing.
      if (!geometry.isSidewalk(agents.current.x[id], agents.current.z[id], agents.radius[id] + 0.015)) {
        throw new Error(`Pedestrian ${id} left the crossing without reaching a sidewalk at red step ${step}.`);
      }
      if (bankAt(agents.current.x[id], agents.current.z[id]) !== expectedBank[id]) {
        throw new Error(`Pedestrian ${id} reached a different sidewalk at red step ${step}.`);
      }
      remaining.delete(id);
    }
    previous[id] = Number(onRoad);
    generations[id] = agents.generation[id];
  }
  if (crossing !== simulation.signal!.crossing) throw new Error(`Signal count differs from occupied positions at red step ${step}.`);
  if (!remaining.size && !clearedAt) clearedAt = step * FIXED_DT;
  if (checkpoints.has(step)) console.log(Math.round(step * FIXED_DT), remaining.size, crossing, redEntries);
}
if (remaining.size || redEntries) {
  console.error(`Clearance failed. ${remaining.size} original pedestrians remain, with ${redEntries} red entries.`);
  process.exitCode = 1;
} else {
  console.log(`Seed ${seed}, red after step ${redAfterStep}: all ${initial} pedestrians reached a sidewalk within ${clearedAt.toFixed(2)} simulated seconds.`);
}
