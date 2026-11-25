// Run in each checkout: node --import tsx scripts/measure-shibuya-flow.ts [seed] [seconds]
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT } from '../src/types';

const seed = Number(process.argv[2] ?? 42);
const duration = Number(process.argv[3] ?? 146);
if (process.argv.length > 4 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
  || !Number.isSafeInteger(duration) || duration < 1) {
  throw new Error('Usage: node --import tsx scripts/measure-shibuya-flow.ts [unsigned-32-bit-seed] [positive-whole-seconds]');
}
const warmup = 60, stepsPerSecond = Math.round(1 / FIXED_DT);
const simulation = new Simulation({ ...DEFAULT_CONFIG, count: 1000, seed, scenario: 'shibuya',
  walkingSpeed: 1.35, avoidanceStrength: 1, signalMode: 'auto' });
const { agents, scenario } = simulation;
const portals = scenario.portals!;
const gates = portals.map(() => ({ entered: 0, emerged: 0, near: [] as number[], slow: [] as number[],
  slow12m: [] as number[], enteredSinceSample: 0, emergedSinceSample: 0,
  intervals: [] as { endSecond: number; entered: number; emerged: number }[] }));
const crossings = scenario.scramble!.crosswalks.map(({ from, to, width }) => {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  return { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2,
    ux: (to.x - from.x) / length, uz: (to.z - from.z) / length, width, positions: [] as number[] };
});
const generations = agents.generation.slice(), visited = new Uint8Array(agents.count);
const emergingFrom = new Int16Array(agents.count).fill(-1);
const lastX = agents.current.x.slice(), lastZ = agents.current.z.slice(), lastLife = generations.slice();

function nearestPortal(x: number, z: number) {
  let nearest = -1, best = Infinity;
  for (let i = 0; i < portals.length; i++) {
    const { end } = portals[i];
    const distance = (x - end.x) ** 2 + (z - end.z) ** 2;
    if (distance < best) { nearest = i; best = distance; }
  }
  return nearest;
}

function observeStep() {
  // The published current state and the previous state are opposite buffers after step().
  const previous = agents.next, current = agents.current;
  for (let id = 0; id < agents.count; id++) {
    const x = current.x[id], z = current.z[id], oldX = previous.x[id], oldZ = previous.z[id];
    if (agents.generation[id] !== generations[id]) {
      const gate = gates[nearestPortal(oldX, oldZ)];
      gate.entered++; gate.enteredSinceSample++;
      emergingFrom[id] = nearestPortal(x, z);
      generations[id] = agents.generation[id];
      visited[id] = 0;
      continue;
    }
    const portal = emergingFrom[id];
    if (portal >= 0 && !simulation.isInPassage(id)) {
      gates[portal].emerged++; gates[portal].emergedSinceSample++;
      emergingFrom[id] = -1;
    }
    // Each person contributes at most one observation per zebra. Linear interpolation
    // records the body center where the step actually crosses the painted midsection.
    for (let i = 0; i < crossings.length; i++) {
      if (visited[id] & (1 << i)) continue;
      const c = crossings[i], dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > c.width || Math.abs(dz) > c.width) continue;
      const before = (oldX - c.x) * c.ux + (oldZ - c.z) * c.uz;
      const after = dx * c.ux + dz * c.uz;
      if ((before < 0) === (after < 0)) continue;
      const t = before / (before - after);
      const lateral = ((oldX - c.x + t * (x - oldX)) * c.uz - (oldZ - c.z + t * (z - oldZ)) * c.ux);
      const fraction = 0.5 + lateral / c.width;
      if (fraction < 0 || fraction > 1) continue;
      c.positions.push(fraction);
      visited[id] |= 1 << i;
    }
  }
}

function observeSecond(second: number) {
  const { current } = agents;
  if (second % 60 === 0 || second === duration) {
    for (const gate of gates) {
      gate.intervals.push({ endSecond: second, entered: gate.enteredSinceSample, emerged: gate.emergedSinceSample });
      gate.enteredSinceSample = 0; gate.emergedSinceSample = 0;
    }
  }
  // Circular neighborhoods use the fixed passage ends. Only people on the sidewalk
  // are visible queue candidates. A 12 m window also detects queues spreading out.
  if (second > warmup) {
    for (let i = 0; i < portals.length; i++) {
      if (portals[i].kind !== 'door') continue;
      const { end } = portals[i];
      let near = 0, slow = 0, slow12m = 0;
      for (let id = 0; id < agents.count; id++) {
        const x = current.x[id], z = current.z[id];
        const r2 = (x - end.x) ** 2 + (z - end.z) ** 2;
        if (r2 > 12 ** 2 || !simulation.navigation.scramble!.isSidewalk(x, z)) continue;
        const stalled = agents.generation[id] === lastLife[id] && (x - lastX[id]) ** 2 + (z - lastZ[id]) ** 2 < 0.35 ** 2;
        if (r2 <= 6 ** 2) { near++; if (stalled) slow++; }
        if (stalled) slow12m++;
      }
      gates[i].near.push(near);
      gates[i].slow.push(slow);
      gates[i].slow12m.push(slow12m);
    }
  }
  lastX.set(current.x); lastZ.set(current.z); lastLife.set(agents.generation);
}

for (let step = 1; step <= duration * stepsPerSecond; step++) {
  simulation.step();
  observeStep();
  if (step % stepsPerSecond === 0) observeSecond(step / stepsPerSecond);
}
const round = (n: number) => Number(n.toFixed(2));
const mean = (samples: number[]) => samples.length ? round(samples.reduce((sum, n) => sum + n, 0) / samples.length) : null;
const quantile = (sorted: number[], p: number) => sorted[Math.floor((sorted.length - 1) * p)];
function widthSummary(positions: number[]) {
  const sorted = [...positions].sort((a, b) => a - b);
  const quintiles = [0, 0, 0, 0, 0];
  for (const x of sorted) quintiles[Math.min(4, Math.floor(x * 5))]++;
  const p10 = quantile(sorted, 0.1), p90 = quantile(sorted, 0.9);
  return { crossings: sorted.length, quintiles, outer40Pct: sorted.length ? round(100 * (quintiles[0] + quintiles[4]) / sorted.length) : null,
    p10ToP90WidthPct: sorted.length ? round(100 * (p90 - p10)) : null };
}

console.log(JSON.stringify({ seed, population: agents.count, seconds: duration, doorSampleSeconds: duration > warmup ? [warmup + 1, duration] : null,
  crossings: crossings.map((c, i) => ({ id: ['west', 'south', 'east', 'north', 'diagonal'][i], ...widthSummary(c.positions) })),
  allCrossings: widthSummary(crossings.flatMap(c => c.positions)),
  doors: portals.flatMap((portal, i) => {
    if (portal.kind !== 'door') return [];
    const { entered, emerged, near, slow, slow12m, intervals } = gates[i];
    return [{ id: portal.id, entered, emerged, meanNear6m: mean(near), meanSlow6m: mean(slow),
      meanSlow12m: mean(slow12m), endSlow6m: slow.at(-1) ?? null, intervals }];
  }),
}, null, 2));
