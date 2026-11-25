import { Simulation } from '../src/simulation/Simulation';
import { SIGNAL_GREEN_SECONDS, SIGNAL_RED_SECONDS } from '../src/simulation/TrafficSignal';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';

// Seed 42 reproduces the crowd that had 42 people on the road after two minutes of red.
const seed = process.argv[2] === undefined ? 42 : Number(process.argv[2]);
const firstGreen = Math.round(SIGNAL_RED_SECONDS / FIXED_DT);
const lastGreen = Math.round((SIGNAL_RED_SECONDS + SIGNAL_GREEN_SECONDS) / FIXED_DT) - 1;
const greenSteps = process.argv[3] === undefined ? lastGreen : Number(process.argv[3]);
if (process.argv.length > 4 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
  || !Number.isInteger(greenSteps) || greenSteps < firstGreen || greenSteps > lastGreen) {
  throw new Error(`Usage: node --import tsx scripts/check-crossing-clearance.ts [seed] [red-after-step ${firstGreen}..${lastGreen}]`);
}
const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1000, seed, scenario: 'shibuya',
  walkingSpeed: 1.35, avoidanceStrength: 1, signalMode: 'auto' });
const agents = simulation.agents, geometry = simulation.navigation.scramble!;
for (let step = 0; step < greenSteps; step++) simulation.step();
if (simulation.signal!.phase !== 'green') throw new Error('Expected a green signal before the manual red.');

const inCrossing = (id: number) => !simulation.isInPassage(id)
  && !geometry.isSidewalk(agents.current.x[id], agents.current.z[id], agents.radius[id] + 0.015);
const previous = new Uint8Array(agents.count);
const generations = agents.generation.slice();
const remaining = new Set<number>();
let redEntries = 0;
let clearedAt = 0;
for (let id = 0; id < agents.count; id++) {
  previous[id] = Number(inCrossing(id));
  if (previous[id]) remaining.add(id);
}
const initial = remaining.size;
if (initial !== simulation.signal!.crossing || !initial) throw new Error('Invalid initial crossing count.');
simulation.updateSettings({ signalMode: 'red' });
const checkpoints = new Set([0, 12, 30, 60, 120].map(seconds => Math.round(seconds / FIXED_DT)));
console.log('redSeconds  remainingFromGreen  crossing  redEntries');
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
  console.log(`Seed ${seed}, red after step ${greenSteps}: all ${initial} pedestrians reached a sidewalk within ${clearedAt.toFixed(2)} simulated seconds.`);
}
