import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Simulation } from '../src/simulation/Simulation';
import { SpatialGrid } from '../src/simulation/SpatialGrid';
import { PolygonRegion } from '../src/simulation/UrbanGeometry';
import { SIGNAL_CYCLE_SECONDS } from '../src/simulation/TrafficSignal';
import { DEFAULT_CONFIG, FIXED_DT, SNAPSHOT_STRIDE } from '../src/types';

// Pair, route and timing observations are independent of the local avoidance implementation.
const count = 1000;
const { values } = parseArgs({ options: {
  seed: { type: 'string', default: '42' }, seconds: { type: 'string', default: String(SIGNAL_CYCLE_SECONDS) },
  model: { type: 'string', default: 'baseline' }, preset: { type: 'string', default: 'none' },
  density: { type: 'string', default: 'off' },
} });
const seed = Number(values.seed), seconds = Number(values.seconds);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must fit in an unsigned 32-bit integer.');
if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Seconds must be a positive whole number.');
const model = values.model, preset = values.preset, density = values.density;
if (model !== 'baseline' && model !== 'enhanced') throw new Error('Use --model=baseline or --model=enhanced.');
if (preset !== 'none' && preset !== 'runner' && preset !== 'selfie' && preset !== 'group' && preset !== 'mixed') {
  throw new Error('Use --preset=none, runner, selfie, group, or mixed.');
}
if (density !== 'on' && density !== 'off') throw new Error('Use --density=on or --density=off.');
const densityGuidance = density === 'on' && model === 'enhanced';
const sim = new Simulation({ ...DEFAULT_CONFIG, scenario: 'shibuya', signalMode: 'auto', count, seed,
  crowdModel: model, crowdPreset: preset, densityGuidance });
const agents = sim.agents;
// Hash the original 13 packed fields and additional simulation inputs. New
// pose-only fields are deliberately outside this shared initial-state check.
function initialDigest(): string {
  const snapshot = new Float32Array(count * SNAPSHOT_STRIDE);
  sim.writeSnapshot(snapshot);
  const hash = createHash('sha256');
  for (let i = 0; i < count; i++) hash.update(snapshot.subarray(i * SNAPSHOT_STRIDE, i * SNAPSHOT_STRIDE + 13));
  for (const field of [agents.current.vx, agents.current.vz, agents.targetX, agents.targetZ, agents.targetId,
    agents.radius, agents.speedFactor, agents.preferredSpeed, agents.portalStage]) hash.update(field);
  return hash.digest('hex');
}
const initialStateSha256 = initialDigest();
const grid = new SpatialGrid(sim.scenario.bounds, count);
const sidewalks = sim.scenario.urbanMap!.sidewalks.map(polygon => new PolygonRegion([polygon]));
const generations = new Uint32Array(agents.generation);
const walking = new Uint8Array(count);
const onSidewalk = new Uint8Array(count);
const entrySidewalk = new Int16Array(count).fill(-1);
const opposingPeer = new Int32Array(count);
const opposingDistance = new Float64Array(count);
const side = new Int8Array(count);
const lastPeer = new Int32Array(count).fill(-1);
const lastStep = new Int32Array(count);
const lastDirX = new Float32Array(count), lastDirZ = new Float32Array(count);
let activeContacts = new Set<number>();
let activeEncounters = new Set<number>(), activeCrossingEncounters = new Set<number>();
let bodyEncounters = 0, headOnEncounters = 0, flashingEntries = 0, completedCrossings = 0;
let crossingContacts = 0, crossingEncounters = 0, crossingReversals = 0, crossingHeadOnEncounters = 0;
const crossingHeadOn = new Uint8Array(count);
const crossesRoad = new Uint8Array(count);
const stepMs: number[] = [];
let cameraStopPersonSeconds = 0, nearbyPhotoSamples = 0, nearbySlowSamples = 0;
const nearPhotoAtStep = new Int32Array(count);
const enteredAt = new Float32Array(count);
let roadSpeed = 0, roadSamples = 0, tripSeconds = 0, turnbacks = 0, greenEntries = 0;
let clearedAt: number | null = null;
const returnsByLight: Record<string, number> = {};
const greenEntryByFiveSeconds: number[] = [];
const entryHistory = new Float32Array(count * 90), approachSpeed = new Float64Array(count);
let entrySpeedSamples = 0, entrySpeed = 0;
let greenCrossings = 0, redEntries = 0, contacts = 0, reversals = 0, peakWaiting = 0;
let totalSpeed = 0, gazeAboveThreshold = 0;
const greenStepMs: number[] = [];

// New state is optional so the exact observer can also run on the baseline.
const instrumented = sim as unknown as {
  attention?: { counts: { waitLookStarts: number; hesitationStarts: number }; headYaw: Float32Array };
  encounters?: { contactEvents: number };
};
function pedestrianLight() {
  // The baseline exported its walking indication as phase.
  const state = sim.signal as { pedestrian?: string; phase?: string };
  return state.pedestrian ?? state.phase;
}
function sidewalkIndex(x: number, z: number): number {
  return sidewalks.findIndex(region => region.contains(x, z));
}
function observeCrossings(id: number, reset: boolean, step: number): void {
  const now = agents.current, old = agents.next;
  const radius = agents.radius[id] + 0.015;
  const on = sim.navigation.scramble!.isSidewalk(now.x[id], now.z[id], radius);
  const onRoad = !on && sim.navigation.urban!.occupiesCrossing(now.x[id], now.z[id], radius);
  const speed = Math.hypot(now.vx[id], now.vz[id]);
  if (walking[id] && onRoad && pedestrianLight() === 'green' && step > 0) { roadSpeed += speed; roadSamples++; }
  if (reset || !walking[id]) {
    entrySidewalk[id] = -1;
  } else if (onSidewalk[id] && onRoad) {
    entrySidewalk[id] = sidewalkIndex(old.x[id], old.z[id]);
    enteredAt[id] = sim.time;
    if (pedestrianLight() === 'green') {
      greenEntries++;
      const bin = Math.floor(sim.time / 5);
      greenEntryByFiveSeconds[bin] = (greenEntryByFiveSeconds[bin] ?? 0) + 1;
      // Each sample has three seconds of measured speeds from the same pedestrian.
      if (step > 90 && agents.generation[id] === 0) { entrySpeed += approachSpeed[id] / 90; entrySpeedSamples++; }
    }
    if (pedestrianLight() === 'red') redEntries++;
    if (pedestrianLight() === 'flashingGreen') flashingEntries++;
  } else if (!onSidewalk[id] && on && entrySidewalk[id] >= 0) {
    const exit = sidewalkIndex(now.x[id], now.z[id]);
    if (exit >= 0 && exit !== entrySidewalk[id]) {
      completedCrossings++; tripSeconds += sim.time - enteredAt[id];
      if (pedestrianLight() === 'green') greenCrossings++;
    } else if (exit === entrySidewalk[id]) {
      turnbacks++;
      const light = pedestrianLight()!;
      returnsByLight[light] = (returnsByLight[light] ?? 0) + 1;
    }
    entrySidewalk[id] = -1;
  }
  const history = (step % 90) * count + id;
  approachSpeed[id] += speed - entryHistory[history]; entryHistory[history] = speed;
  onSidewalk[id] = Number(on);
  crossesRoad[id] = Number(onRoad);
}

function registerPeer(i: number, j: number, dx: number, dz: number, distance2: number): void {
  if (distance2 >= opposingDistance[i] || dx * agents.preferredVX[i] + dz * agents.preferredVZ[i] <= 0) return;
  opposingPeer[i] = j;
  opposingDistance[i] = distance2;
}

function observePairs(step: number): void {
  const now = agents.current, old = agents.next;
  const nextContacts = new Set<number>(), nextEncounters = new Set<number>(), nextCrossingEncounters = new Set<number>();
  opposingDistance.fill(1.8 ** 2);
  opposingPeer.fill(-1);
  grid.rebuild(now.x, now.z, count);
  for (let i = 0; i < count; i++) {
    if (!walking[i]) continue;
    const cell = grid.cells[i], col = cell % grid.columns, row = Math.floor(cell / grid.columns);
    for (let z = Math.max(0, row - 1); z <= Math.min(grid.rows - 1, row + 1); z++) {
      for (let x = Math.max(0, col - 1); x <= Math.min(grid.columns - 1, col + 1); x++) {
        const neighborCell = z * grid.columns + x;
        for (let index = grid.offsets[neighborCell]; index < grid.offsets[neighborCell + 1]; index++) {
          const j = grid.indices[index];
          if (j <= i || !walking[j]) continue;
          const dx = now.x[j] - now.x[i], dz = now.z[j] - now.z[i], distance2 = dx * dx + dz * dz;
          const radius = agents.radius[i] + agents.radius[j], key = i * count + j;
          const stationary = sim.activities?.stationary;
          if (step && stationary && distance2 <= 4 && stationary[i] !== stationary[j]) {
            const peer = stationary[i] ? j : i;
            if (nearPhotoAtStep[peer] !== step && agents.preferredSpeed[peer] > 0) {
              nearPhotoAtStep[peer] = step; nearbyPhotoSamples++;
              if (Math.hypot(now.vx[peer], now.vz[peer]) < 0.45 * agents.preferredSpeed[peer]) nearbySlowSamples++;
            }
          }
          const crossing = crossesRoad[i] || crossesRoad[j];
          // Start at the body envelope plus 35 cm while closing, rearm beyond a further 15 cm.
          const previous2 = (old.x[j] - old.x[i]) ** 2 + (old.z[j] - old.z[i]) ** 2;
          const continuing = activeEncounters.has(key);
          if ((continuing && distance2 <= (radius + 0.50) ** 2) ||
            (distance2 <= (radius + 0.35) ** 2 && (!step || distance2 < previous2))) {
            nextEncounters.add(key);
            if (!continuing) bodyEncounters++;
            if (crossing) {
              nextCrossingEncounters.add(key);
              if (!activeCrossingEncounters.has(key)) crossingEncounters++;
            }
          }
          const within = distance2 <= radius * radius;
          if (within || activeContacts.has(key) && distance2 <= (radius + 0.05) ** 2) {
            nextContacts.add(key);
            if (step && within && !activeContacts.has(key)) {
              const previous = Math.sqrt(previous2);
              if (previous >= radius && previous - Math.sqrt(distance2) >= 0.10 * FIXED_DT) {
                contacts++; if (crossing) crossingContacts++;
              }
            }
          }
          if (distance2 >= 1.8 ** 2) continue;
          const dot = agents.preferredVX[i] * agents.preferredVX[j] + agents.preferredVZ[i] * agents.preferredVZ[j];
          const speedProduct = Math.hypot(agents.preferredVX[i], agents.preferredVZ[i]) * Math.hypot(agents.preferredVX[j], agents.preferredVZ[j]);
          if (speedProduct < 0.25 || dot >= -0.5 * speedProduct) continue;
          registerPeer(i, j, dx, dz, distance2);
          registerPeer(j, i, -dx, -dz, distance2);
        }
      }
    }
  }
  activeContacts = nextContacts; activeEncounters = nextEncounters; activeCrossingEncounters = nextCrossingEncounters;
}

// Observable proxy for left/right indecision. A significant lateral velocity
// changes sign in the same head-on encounter, on a near-constant route.
function observeReversal(id: number, step: number): void {
  const peer = opposingPeer[id];
  if (peer < 0) { lastPeer[id] = -1; return; }
  const scale = 1 / Math.hypot(agents.preferredVX[id], agents.preferredVZ[id]);
  const dx = agents.preferredVX[id] * scale, dz = agents.preferredVZ[id] * scale;
  const now = agents.current, across = now.vx[id] * dz - now.vz[id] * dx;
  if (lastPeer[id] !== peer) {
    headOnEncounters++;
    crossingHeadOn[id] = Number(crossesRoad[id] || crossesRoad[peer]);
    crossingHeadOnEncounters += crossingHeadOn[id];
    lastPeer[id] = peer; side[id] = 0;
  }
  if (Math.abs(across) < 0.20) return;
  const sign = Math.sign(across);
  if (side[id] === -sign && (step - lastStep[id]) * FIXED_DT <= 1 && dx * lastDirX[id] + dz * lastDirZ[id] >= 0.95) {
    reversals++; crossingReversals += crossingHeadOn[id];
  }
  side[id] = sign; lastStep[id] = step; lastDirX[id] = dx; lastDirZ[id] = dz;
}

const steps = Math.round(seconds / FIXED_DT);
for (let step = 0; step <= steps; step++) {
  if (step) {
    const start = performance.now();
    sim.step(FIXED_DT);
    const elapsed = performance.now() - start;
    stepMs.push(elapsed);
    if (pedestrianLight() === 'green') greenStepMs.push(elapsed);
  }
  for (let i = 0; i < count; i++) {
    const reset = !step || generations[i] !== agents.generation[i];
    const wasWalking = walking[i];
    walking[i] = Number(!sim.isInPassage(i) && (!step || !reset));
    observeCrossings(i, reset || !wasWalking, step);
    generations[i] = agents.generation[i];
    if (step && sim.activities?.stationary[i] && Math.hypot(agents.current.vx[i], agents.current.vz[i]) < 0.12) {
      cameraStopPersonSeconds += FIXED_DT;
    }
    if (step && instrumented.attention && Math.abs(instrumented.attention.headYaw[i]) >= Math.PI / 12) gazeAboveThreshold++;
  }
  observePairs(step);
  for (let i = 0; i < count; i++) observeReversal(i, step);
  if (clearedAt === null && pedestrianLight() !== 'green' && sim.signal!.crossing === 0) clearedAt = +sim.time.toFixed(2);
  peakWaiting = Math.max(peakWaiting, sim.signal!.waiting);
  if (step) totalSpeed += sim.stats.meanSpeed;
}
greenStepMs.sort((a, b) => a - b);
stepMs.sort((a, b) => a - b);
const per100 = (events: number, exposure: number) => exposure ? +(events * 100 / exposure).toFixed(2) : null;
console.log(JSON.stringify({
  scenario: 'shibuya', model, preset, densityGuidance, seed, count, steps, seconds: steps * FIXED_DT, initialStateSha256,
  greenCrossings, completedCrossings, greenEntries, sameSidewalkReturns: turnbacks, firstClearedAt: clearedAt,
  returnsByLight, greenEntryByFiveSeconds,
  greenMeanRoadSpeed: roadSamples ? +(roadSpeed / roadSamples).toFixed(3) : null,
  meanSpeedThreeSecondsBeforeGreenEntry: entrySpeedSamples ? +(entrySpeed / entrySpeedSamples).toFixed(3) : null,
  preEntrySpeedSamples: entrySpeedSamples, meanCompletedCrossingSeconds: completedCrossings ? +(tripSeconds / completedCrossings).toFixed(2) : null,
  redEntries, flashingEntries, bodyEncounterStarts: bodyEncounters,
  contactsPer100Encounters: per100(contacts, bodyEncounters), directedHeadOnEncounters: headOnEncounters,
  reversalsPer100HeadOnEncounters: per100(reversals, headOnEncounters),
  onCrossing: { contactPairStarts: crossingContacts, bodyEncounterStarts: crossingEncounters,
    contactsPer100Encounters: per100(crossingContacts, crossingEncounters), lateralReversals: crossingReversals,
    directedHeadOnEncounters: crossingHeadOnEncounters, reversalsPer100HeadOnEncounters: per100(crossingReversals, crossingHeadOnEncounters) },
  activityStarts: sim.activities?.counts, cameraStopPersonSeconds: +cameraStopPersonSeconds.toFixed(2),
  // Each other walker within 2 m of a photographer intentionally braking or holding counts once per tick.
  nearbyPhotoPersonSeconds: +(nearbyPhotoSamples * FIXED_DT).toFixed(2),
  nearbyPhotoSlowPersonSeconds: +(nearbySlowSamples * FIXED_DT).toFixed(2),
  nearbyPhotoSlowPct: per100(nearbySlowSamples, nearbyPhotoSamples),
  p95StepMs: +stepMs[Math.floor(stepMs.length * 0.95)].toFixed(2),
  contactPairStarts: contacts, lateralReversals: reversals, peakWaiting, meanSpeed: +(totalSpeed / steps).toFixed(3),
  waitLookStarts: instrumented.attention?.counts.waitLookStarts ?? 0,
  hesitationStarts: instrumented.attention?.counts.hesitationStarts ?? 0,
  headTurnPersonSeconds: +(gazeAboveThreshold * FIXED_DT).toFixed(2),
  contactReactions: instrumented.encounters?.contactEvents ?? 0,
  greenSteps: greenStepMs.length,
  greenMeanStepMs: +(greenStepMs.reduce((sum, ms) => sum + ms, 0) / greenStepMs.length).toFixed(2),
  greenP95StepMs: +greenStepMs[Math.floor(greenStepMs.length * 0.95)].toFixed(2),
}, null, 2));
