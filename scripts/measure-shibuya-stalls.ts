// node --import tsx scripts/measure-shibuya-stalls.ts [endSecond=1109] [seed=42] [snapshot.json] [spanMetres=2] [count=1000] [screenshotSecond=160]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Simulation } from '../src/simulation/Simulation';
import { DEFAULT_CONFIG, FIXED_DT, MAX_AGENTS } from '../src/types';

const endSecond = Number(process.argv[2] ?? 1109);
const seed = Number(process.argv[3] ?? 42);
const spanMetres = Number(process.argv[5] ?? 2);
const count = Number(process.argv[6] ?? 1000);
const screenshotSecond = Number(process.argv[7] ?? 160);
if (process.argv.length > 8 || !Number.isInteger(count) || count < 1 || count > MAX_AGENTS
    || !Number.isSafeInteger(screenshotSecond) || screenshotSecond < 0
    || !(spanMetres > 0) || !Number.isFinite(spanMetres) || !Number.isSafeInteger(endSecond)
    || endSecond < 1 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
  throw new Error('Invalid duration, seed, span, population, or screenshot time.');
}
// This offline runner advances fixed simulation ticks directly, independent of the UI time scale.
const config = { ...DEFAULT_CONFIG, scenario: 'shibuya' as const, count, seed, simulationSpeed: 2,
  signalMode: 'auto' as const, walkingSpeed: 1.35, avoidanceStrength: 1 };
const sim = new Simulation(config);
sim.setPortalDeadlockRecovery(false);
const a = sim.agents, portals = sim.scenario.portals!;
const clockHz = Math.round(1 / FIXED_DT), windows = [30, 60, 300], maxWindow = 300;
const samples = Array.from({ length: maxWindow + 1 }, () => ({ x: new Float32Array(a.count), z: new Float32Array(a.count) }));
const points = portals.map(p => ({ id: p.id, kind: p.kind, assigned: 0, completed: 0, stalled300Ever: 0,
  stalled300AtEnd: 0, nearGoal300Ever: 0, nearGoal300AtEnd: 0 }));
const goalCenters = portals.map(p => p.kind === 'door' ? p.end : p.approach);
const generation = a.generation.slice(), firstSecond = new Int32Array(a.count), nearSince = new Int32Array(a.count).fill(-1);
const countedStall = new Uint8Array(a.count), countedNear = new Uint8Array(a.count);
const ids = Array.from(a.id), checkpoints = new Set([screenshotSecond, screenshotSecond + 300, endSecond]);
for (const target of a.targetId) points[target].assigned++;
function hashFields(...fields: ArrayBufferView[]) {
  const hash = createHash('sha256');
  for (const field of fields) hash.update(Buffer.from(field.buffer, field.byteOffset, field.byteLength));
  return hash.digest('hex');
}
const initial = { positions: hashFields(a.current.x, a.current.z), traits: hashFields(a.id, a.scale, a.speedFactor, a.appearance),
  routes: hashFields(a.targetId, a.targetX, a.targetZ, a.current.vx, a.current.vz, a.current.heading) };

// Measure the entire sampled trajectory, including loops that return to their starting point.
function confined(id: number, second: number, length: number) {
  if (second - firstSecond[id] < length) return false;
  let minX = a.current.x[id], maxX = minX, minZ = a.current.z[id], maxZ = minZ;
  for (let t = second - length; t < second; t++) {
    const sample = samples[t % samples.length], x = sample.x[id], z = sample.z[id];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    if ((maxX - minX) ** 2 + (maxZ - minZ) ** 2 > spanMetres ** 2) return false;
  }
  return true;
}

// Take the most occupied 5 m circle centred on a person, remove its members, and repeat.
function concentrations(candidates: number[]) {
  let remaining = candidates;
  const groups = [];
  for (let group = 0; group < 3 && remaining.length; group++) {
    let center = remaining[0], best = 0;
    const nearby = (id: number, other: number) => (a.current.x[id] - a.current.x[other]) ** 2
      + (a.current.z[id] - a.current.z[other]) ** 2 <= 25;
    for (const id of remaining) {
      let neighbours = 0;
      for (const other of remaining) if (nearby(id, other)) neighbours++;
      if (neighbours > best) { center = id; best = neighbours; }
    }
    groups.push({ x: a.current.x[center], z: a.current.z[center], people: best });
    remaining = remaining.filter(other => !nearby(center, other));
  }
  return groups;
}

function roundCenters(groups: ReturnType<typeof concentrations>) {
  return groups.map(({ x, z, people }) => ({ x: +x.toFixed(2), z: +z.toFixed(2), people }));
}

const snapshots = [];
// Follow the original people in the densest circle at the screenshot time. Re-entry counts as present.
let circle: { x: number; z: number; members: { id: number; life: number }[] } | undefined;
const circleCheckpoints = [];
const everOutside = new Set<number>();
for (let second = 0; second <= endSecond; second++) {
  if (second) for (let step = 0; step < clockHz; step++) sim.step();
  const latest = samples[second % samples.length];
  latest.x.set(a.current.x); latest.z.set(a.current.z);
  const snapshot = checkpoints.has(second), stalled = windows.map(() => [] as number[]);
  for (const id of ids) {
    const point = points[a.targetId[id]], goal = goalCenters[a.targetId[id]], x = a.current.x[id], z = a.current.z[id];
    if (generation[id] !== a.generation[id]) {
      assert.equal(a.generation[id], generation[id] + 1, 'More than one journey for a slot between samples.');
      generation[id] = a.generation[id];
      firstSecond[id] = second; nearSince[id] = -1; countedNear[id] = 0; countedStall[id] = 0;
      point.assigned++;
    }
    if ((x - goal.x) ** 2 + (z - goal.z) ** 2 < 144 && sim.navigation.scramble!.isSidewalk(x, z)) {
      if (nearSince[id] === -1) nearSince[id] = second;
      if (second - nearSince[id] >= 300) {
        if (!countedNear[id]) { point.nearGoal300Ever++; countedNear[id] = 1; }
        if (second === endSecond) point.nearGoal300AtEnd++;
      }
    } else nearSince[id] = -1;
    if ((!countedStall[id] || snapshot) && confined(id, second, maxWindow)) {
      if (!countedStall[id]) { point.stalled300Ever++; countedStall[id] = 1; }
      if (second === endSecond) point.stalled300AtEnd++;
      if (snapshot) stalled[2].push(id);
    }
    if (snapshot) {
      for (let i = 0; i < 2; i++) if (confined(id, second, windows[i])) stalled[i].push(id);
    }
  }
  if (snapshot) {
    const groups = concentrations(ids);
    if (second === screenshotSecond) {
      const { x, z } = groups[0];
      const members = ids.filter(id => (a.current.x[id] - x) ** 2 + (a.current.z[id] - z) ** 2 <= 25)
        .map(id => ({ id, life: a.generation[id] }));
      circle = { x, z, members };
    }
    const completed = points.map((_, i) => sim.completedPortalTrips(i));
    const record = { second, signal: { ...sim.signal, remaining: Math.round(sim.signal!.remaining!) },
      arrivals: sim.arrivals, shopEntries: completed.reduce((sum, n, i) => sum + (portals[i].kind === 'door' ? n : 0), 0),
      stalled: Object.fromEntries(windows.map((w, i) => [w, second < w ? null : stalled[i].length])),
      largestGroups: roundCenters(groups), largestStalled30Groups: roundCenters(concentrations(stalled[0])) };
    console.error(JSON.stringify(record)); snapshots.push(record);
    if (second === screenshotSecond && process.argv[4]) {
      const still = stalled.map(group => new Set(group));
      writeFileSync(process.argv[4], JSON.stringify(ids.map(id => ({ id, generation: generation[id], x: a.current.x[id],
        z: a.current.z[id], target: points[a.targetId[id]].id, stalled30: still[0].has(id), stalled60: still[1].has(id) }))));
    }
  } else if (second && second % 300 === 0) console.error(`${second}/${endSecond} simulated seconds`);
  const sinceScreenshot = second - screenshotSecond;
  if (circle && sinceScreenshot > 0 && sinceScreenshot <= 47) {
    const { x, z, members } = circle;
    const inside = (id: number) => (a.current.x[id] - x) ** 2 + (a.current.z[id] - z) ** 2 <= 25;
    let sameStillPresent = 0;
    for (const { id, life } of members) {
      if (a.generation[id] === life && inside(id)) sameStillPresent++;
      else everOutside.add(id);
    }
    if (sinceScreenshot === 15 || sinceScreenshot === 30 || sinceScreenshot === 47) circleCheckpoints.push({
      second, totalInCircle: ids.filter(inside).length, sameStillPresent, exitedAtLeastOnce: everOutside.size,
    });
  }
}
const active = new Uint32Array(points.length);
for (const target of a.targetId) active[target]++;
points.forEach((p, i) => {
  p.completed = sim.completedPortalTrips(i);
  assert.equal(p.assigned, p.completed + active[i], p.id);
});
assert.equal(points.reduce((sum, p) => sum + p.completed, 0), sim.arrivals);
console.log(JSON.stringify({ config, metaAI: false, clockHz, sampleSeconds: 1, spanMetres, groupRadiusMetres: 5,
  nearGoalRadiusMetres: 12, initial, snapshots, points,
  largestCircleTurnover: circle && { x: circle.x, z: circle.z, [`membersAt${screenshotSecond}`]: circle.members.length, checkpoints: circleCheckpoints } }, null, 2));
