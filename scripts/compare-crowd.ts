import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Simulation } from '../src/simulation/Simulation';
import { SpatialGrid } from '../src/simulation/SpatialGrid';
import { PolygonRegion } from '../src/simulation/UrbanGeometry';
import { SIGNAL_CYCLE_SECONDS } from '../src/simulation/TrafficSignal';
import { DEFAULT_CONFIG, FIXED_DT, SNAPSHOT_STRIDE } from '../src/types';

// Copy this observer to the same scripts/ path in both revisions. Geometry and
// velocity observations use identical definitions, independently of the steering.
const count = 1000;
const options = process.argv.slice(2);
if (options.length > 1 || options.some(option => !/^--seed=\d+$/.test(option))) {
  throw new Error('Use node --import tsx scripts/compare-crowd.ts [--seed=42]');
}
const seed = options.length ? Number(options[0].slice('--seed='.length)) : 42;
if (!Number.isSafeInteger(seed) || seed > 0xffffffff) throw new Error('Seed must fit in an unsigned 32-bit integer.');
const sim = new Simulation({ ...DEFAULT_CONFIG, scenario: 'shibuya', signalMode: 'auto', count, seed });
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
function observeCrossings(id: number, reset: boolean): void {
  const now = agents.current, old = agents.next;
  const radius = agents.radius[id] + 0.015;
  const on = sim.navigation.scramble!.isSidewalk(now.x[id], now.z[id], radius);
  if (reset || !walking[id]) {
    entrySidewalk[id] = -1;
  } else if (onSidewalk[id] && !on) {
    entrySidewalk[id] = sidewalkIndex(old.x[id], old.z[id]);
    if (pedestrianLight() === 'red') redEntries++;
  } else if (!onSidewalk[id] && on && entrySidewalk[id] >= 0) {
    const exit = sidewalkIndex(now.x[id], now.z[id]);
    if (pedestrianLight() === 'green' && exit >= 0 && exit !== entrySidewalk[id]) greenCrossings++;
    entrySidewalk[id] = -1;
  }
  onSidewalk[id] = Number(on);
}

function registerPeer(i: number, j: number, dx: number, dz: number, distance2: number): void {
  if (distance2 >= opposingDistance[i] || dx * agents.preferredVX[i] + dz * agents.preferredVZ[i] <= 0) return;
  opposingPeer[i] = j;
  opposingDistance[i] = distance2;
}

function observePairs(step: number): void {
  const now = agents.current, old = agents.next;
  const nextContacts = new Set<number>();
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
          const within = distance2 <= radius * radius;
          if (within || activeContacts.has(key) && distance2 <= (radius + 0.05) ** 2) {
            nextContacts.add(key);
            if (step && within && !activeContacts.has(key)) {
              const previous = Math.hypot(old.x[j] - old.x[i], old.z[j] - old.z[i]);
              if (previous >= radius && previous - Math.sqrt(distance2) >= 0.10 * FIXED_DT) contacts++;
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
  activeContacts = nextContacts;
}

// Observable proxy for left/right indecision. A significant lateral velocity
// changes sign in the same head-on encounter, on a near-constant route.
function observeReversal(id: number, step: number): void {
  const peer = opposingPeer[id];
  if (peer < 0) { lastPeer[id] = -1; return; }
  const scale = 1 / Math.hypot(agents.preferredVX[id], agents.preferredVZ[id]);
  const dx = agents.preferredVX[id] * scale, dz = agents.preferredVZ[id] * scale;
  const now = agents.current, across = now.vx[id] * dz - now.vz[id] * dx;
  if (lastPeer[id] !== peer) { lastPeer[id] = peer; side[id] = 0; }
  if (Math.abs(across) < 0.20) return;
  const sign = Math.sign(across);
  if (side[id] === -sign && (step - lastStep[id]) * FIXED_DT <= 1 && dx * lastDirX[id] + dz * lastDirZ[id] >= 0.95) reversals++;
  side[id] = sign; lastStep[id] = step; lastDirX[id] = dx; lastDirZ[id] = dz;
}

const steps = Math.round(SIGNAL_CYCLE_SECONDS / FIXED_DT);
for (let step = 0; step <= steps; step++) {
  if (step) {
    const start = performance.now();
    sim.step(FIXED_DT);
    const elapsed = performance.now() - start;
    if (pedestrianLight() === 'green') greenStepMs.push(elapsed);
  }
  for (let i = 0; i < count; i++) {
    const reset = !step || generations[i] !== agents.generation[i];
    const wasWalking = walking[i];
    walking[i] = Number(!sim.isInPassage(i) && (!step || !reset));
    observeCrossings(i, reset || !wasWalking);
    generations[i] = agents.generation[i];
    if (step && instrumented.attention && Math.abs(instrumented.attention.headYaw[i]) >= Math.PI / 12) gazeAboveThreshold++;
  }
  observePairs(step);
  for (let i = 0; i < count; i++) observeReversal(i, step);
  peakWaiting = Math.max(peakWaiting, sim.signal!.waiting);
  if (step) totalSpeed += sim.stats.meanSpeed;
}
greenStepMs.sort((a, b) => a - b);
console.log(JSON.stringify({
  scenario: 'shibuya', seed, count, steps, seconds: steps * FIXED_DT, initialStateSha256, greenCrossings, redEntries,
  contactPairStarts: contacts, lateralReversals: reversals, peakWaiting, meanSpeed: +(totalSpeed / steps).toFixed(3),
  waitLookStarts: instrumented.attention?.counts.waitLookStarts ?? 0,
  hesitationStarts: instrumented.attention?.counts.hesitationStarts ?? 0,
  headTurnPersonSeconds: +(gazeAboveThreshold * FIXED_DT).toFixed(2),
  contactReactions: instrumented.encounters?.contactEvents ?? 0,
  greenSteps: greenStepMs.length,
  greenMeanStepMs: +(greenStepMs.reduce((sum, ms) => sum + ms, 0) / greenStepMs.length).toFixed(2),
  greenP95StepMs: +greenStepMs[Math.floor(greenStepMs.length * 0.95)].toFixed(2),
}, null, 2));
