import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlCallbacks } from '../app/Controls';
import type { PickedPerson } from '../renderer/WebGPURenderer';
import type { SimulationConfig, SnapshotMessage, WorkerInput, WorkerOutput } from '../types';
import { DEFAULT_CONFIG, SNAPSHOT_STRIDE } from '../types';

const harness = vi.hoisted(() => ({
  callbacks: null as ControlCallbacks | null,
  clickPerson: (_x: number, _y: number) => {},
  controls: {
    setPaused: vi.fn(), setConfig: vi.fn(), setStatus: vi.fn(),
    renderBenchmark: vi.fn(), setBenchmarkRunning: vi.fn(), setBenchmarkStatus: vi.fn(),
    showError: vi.fn(), destroy: vi.fn(),
    setSignal: vi.fn(), setPersonView: vi.fn(), setCameraActive: vi.fn(), setSubjectAvailable: vi.fn(),
  },
  renderer: {
    setScenario: vi.fn(), destroy: vi.fn(), camera: { reset: vi.fn(), setView: vi.fn(), frameParticipant: vi.fn(), target: new Float32Array(3) },
    setPhotographicAppearance: vi.fn(),
    canPlacePersonCamera: vi.fn(() => true),
    pickPerson: vi.fn<(x: number, y: number) => Promise<PickedPerson | null>>(),
    render: vi.fn((_previous: Float32Array, _current: Float32Array, count: number) => ({
      visible: count, lodCounts: [count, 0, 0], drawCalls: 5, triangles: count * 100,
      cpuMs: 1, resolution: '1280 × 720',
    })),
  },
  updateStats: vi.fn(),
}));

vi.mock('../app/Controls', () => ({
  Controls: class {
    readonly canvas = {};
    readonly statsElement = {};
    readonly setPaused = harness.controls.setPaused;
    readonly setConfig = harness.controls.setConfig;
    readonly setStatus = harness.controls.setStatus;
    readonly setSignal = harness.controls.setSignal;
    readonly setSubjectAvailable = harness.controls.setSubjectAvailable;
    readonly setCameraActive = harness.controls.setCameraActive;
    readonly setPersonView = harness.controls.setPersonView;
    readonly renderBenchmark = harness.controls.renderBenchmark;
    readonly setBenchmarkRunning = harness.controls.setBenchmarkRunning;
    readonly setBenchmarkStatus = harness.controls.setBenchmarkStatus;
    readonly showError = harness.controls.showError;
    readonly destroy = harness.controls.destroy;
    constructor(_container: HTMLElement, _config: SimulationConfig, callbacks: ControlCallbacks) { harness.callbacks = callbacks; }
  },
}));
vi.mock('../app/StatsPanel', () => ({ StatsPanel: class { readonly update = harness.updateStats; } }));
vi.mock('../renderer/WebGPURenderer', () => ({ WebGPURenderer: {
  create: async (_canvas: HTMLCanvasElement, _fail: (message: string) => void, click: typeof harness.clickPerson) => {
    harness.clickPerson = click;
    return harness.renderer;
  },
} }));

import { App } from '../app/App';

type InitMessage = Extract<WorkerInput, { type: 'init' }>;

class FakeWorker {
  static instance: FakeWorker;
  onmessage: ((event: MessageEvent<WorkerOutput>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: WorkerInput[] = [];
  readonly terminate = vi.fn();
  constructor() { FakeWorker.instance = this; }
  postMessage(message: WorkerInput, transfer: Transferable[] = []): void {
    // Emulate actual buffer detachment so a recycled state cannot accidentally remain renderable.
    this.messages.push(structuredClone(message, { transfer }));
  }
  emit(message: WorkerOutput): void { this.onmessage?.({ data: message } as MessageEvent<WorkerOutput>); }
  latestInit(): InitMessage {
    const message = [...this.messages].reverse().find((entry): entry is InitMessage => entry.type === 'init');
    if (!message) throw new Error('App did not initialize its worker.');
    return message;
  }
  snapshot(step = 0, stepMs = 2, init = this.latestInit()): SnapshotMessage {
    return {
      type: 'snapshot', generation: init.generation, count: init.config.count, vehicleCapacity: 0, step,
      simulationTime: step / 30, stepMs, meanSpeed: 1.35, congestion: 0.1,
      buffer: new ArrayBuffer(init.config.count * SNAPSHOT_STRIDE * 4),
    };
  }
}

describe('application / worker integration', () => {
  let app: App;
  let documentStub: EventTarget & { hidden: boolean };
  let scheduledFrame: FrameRequestCallback | null;
  let nextFrameId: number;

  const controls = (): ControlCallbacks => {
    if (!harness.callbacks) throw new Error('Controls have not been initialized.');
    return harness.callbacks;
  };
  const frame = (elapsed = 17): void => {
    vi.advanceTimersByTime(elapsed);
    const callback = scheduledFrame;
    if (!callback) throw new Error('App did not request a frame.');
    scheduledFrame = null;
    callback(performance.now());
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    harness.renderer.setScenario.mockReset();
    vi.useFakeTimers({ toFake: ['performance'] });
    documentStub = Object.assign(new EventTarget(), { hidden: false });
    scheduledFrame = null; nextFrameId = 0;
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { scheduledFrame = callback; return ++nextFrameId; });
    vi.stubGlobal('cancelAnimationFrame', () => { scheduledFrame = null; });
    app = new App({} as HTMLElement);
    await app.start();
    FakeWorker.instance.emit(FakeWorker.instance.snapshot());
    frame();
  });
  afterEach(() => { app.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('frames the featured participant in the current replay and drops the old subject on reset', () => {
    const worker = FakeWorker.instance;
    const snapshot = worker.snapshot(3);
    snapshot.subjectId = 7;
    new Float32Array(snapshot.buffer).set([4, 8, 0.5], 7 * SNAPSHOT_STRIDE);
    worker.emit(snapshot);
    controls().onFrameSubject();
    expect(harness.renderer.camera.frameParticipant).toHaveBeenCalledWith(4, 8, 0.5);
    const moved = worker.snapshot(4);
    new Float32Array(moved.buffer).set([6, 9], 7 * SNAPSHOT_STRIDE);
    new Float32Array(moved.buffer)[7 * SNAPSHOT_STRIDE + 12] = 1;
    worker.emit(moved);
    frame(70);
    expect(Array.from(harness.renderer.camera.target)).toEqual([6, 0, 9]);
    expect(harness.controls.setSubjectAvailable).toHaveBeenLastCalledWith(false, true);
    controls().onConfig({ crowdPreset: 'runner', crowdModel: 'baseline' }, true);
    expect(worker.latestInit().config).toMatchObject({ seed: 42, crowdPreset: 'runner', crowdModel: 'baseline' });
    expect(harness.controls.setSubjectAvailable).toHaveBeenLastCalledWith(false);
    controls().onFrameSubject();
    expect(harness.renderer.camera.frameParticipant).toHaveBeenCalledTimes(1);
  });

  it('follows the picked person across snapshots and returns without resetting the camera or crowd', async () => {
    const worker = FakeWorker.instance;
    const init = worker.latestInit();
    harness.renderer.pickPerson.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 0, life: 0 });
    harness.clickPerson(20, 35);
    await Promise.resolve();
    expect(harness.controls.setPersonView).not.toHaveBeenCalled();
    harness.clickPerson(50, 100);
    await Promise.resolve();
    expect(harness.renderer.pickPerson).toHaveBeenLastCalledWith(50, 100);
    expect(harness.controls.setPersonView).toHaveBeenLastCalledWith(true);
    worker.emit(worker.snapshot(1));
    frame();
    expect(harness.renderer.render.mock.lastCall).toContainEqual(expect.objectContaining({ followedId: 0 }));
    controls().onReturnView();
    frame();
    expect(harness.controls.setPersonView).toHaveBeenLastCalledWith(false);
    expect(harness.renderer.render.mock.lastCall).toContainEqual(expect.objectContaining({ followedId: undefined }));
    expect(harness.renderer.camera.reset).not.toHaveBeenCalled();
    expect(worker.latestInit()).toBe(init);
  });

  it('invalidates in-flight picks and waits for the replacement crowd to be drawn after a reset', async () => {
    let finishPick!: (person: PickedPerson) => void;
    harness.renderer.pickPerson.mockReturnValueOnce(new Promise(resolve => { finishPick = resolve; }));
    harness.clickPerson(50, 100);
    controls().onReset();
    const worker = FakeWorker.instance;
    worker.emit(worker.snapshot());
    harness.clickPerson(50, 100);
    expect(harness.renderer.pickPerson).toHaveBeenCalledTimes(1);
    frame();
    finishPick({ id: 12, life: 0 });
    await Promise.resolve();
    expect(harness.controls.setPersonView).not.toHaveBeenCalled();
    harness.renderer.pickPerson.mockResolvedValueOnce({ id: 12, life: 0 });
    harness.clickPerson(50, 100);
    await Promise.resolve();
    controls().onConfig({ count: 5000 }, true);
    expect(harness.controls.setPersonView.mock.calls).toEqual([[true], [false]]);
  });

  it('leaves a followed pedestrian at the end of their trip and rejects a stale click on that life', async () => {
    const worker = FakeWorker.instance;
    const person = { id: 2, life: 0 };
    harness.renderer.pickPerson.mockResolvedValueOnce(person).mockResolvedValueOnce(person);
    harness.clickPerson(30, 50);
    await Promise.resolve();
    expect(harness.controls.setPersonView).toHaveBeenLastCalledWith(true);
    const snapshot = worker.snapshot(12);
    new Float32Array(snapshot.buffer)[person.id * SNAPSHOT_STRIDE + 11] = 1;
    worker.emit(snapshot);
    frame();
    expect(harness.renderer.render.mock.lastCall).toContainEqual(expect.objectContaining({ followedId: undefined }));
    expect(harness.controls.setPersonView).toHaveBeenLastCalledWith(false);
    expect(harness.renderer.camera.reset).not.toHaveBeenCalled();
    harness.clickPerson(30, 50);
    await Promise.resolve();
    expect(harness.controls.setPersonView.mock.calls).toEqual([[true], [false]]);
  });

  it('refuses first person inside the doorway and restores the saved view as a walker reaches the wall', async () => {
    const person = { id: 0, life: 0 };
    harness.renderer.pickPerson.mockResolvedValueOnce(person).mockResolvedValueOnce(person);
    harness.renderer.canPlacePersonCamera.mockReturnValueOnce(false);
    harness.clickPerson(30, 50);
    await Promise.resolve();
    expect(harness.controls.setPersonView).not.toHaveBeenCalled();
    harness.clickPerson(30, 50);
    await Promise.resolve();
    expect(harness.controls.setPersonView).toHaveBeenLastCalledWith(true);
    harness.renderer.canPlacePersonCamera.mockReturnValueOnce(false);
    frame();
    expect(harness.controls.setPersonView).toHaveBeenLastCalledWith(false);
    expect(harness.renderer.render.mock.lastCall).toContainEqual(expect.objectContaining({ followedId: undefined }));
    expect(harness.renderer.camera.reset).not.toHaveBeenCalled();
  });

  it('honors Pause during a study that was started from a paused simulation', () => {
    const worker = FakeWorker.instance;
    controls().onPause();
    expect(harness.controls.setPaused).toHaveBeenLastCalledWith(true);
    controls().onBenchmark();
    expect(worker.latestInit().config.count).toBe(1000);
    expect(worker.latestInit().paused).toBe(false);
    worker.emit(worker.snapshot());
    controls().onPause();
    expect(worker.latestInit().config.count).toBe(DEFAULT_CONFIG.count);
    expect(worker.latestInit().paused).toBe(true);
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: true });
    expect(harness.controls.setPaused).toHaveBeenLastCalledWith(true);
    expect(harness.controls.setBenchmarkRunning).toHaveBeenLastCalledWith(false);
  });

  it('changes a signal without resetting agents and renders the worker-confirmed phase while paused', () => {
    const worker = FakeWorker.instance;
    const initial = worker.latestInit();
    controls().onPause();
    controls().onConfig({ signalMode: 'pedestrian' }, false);
    expect(worker.latestInit()).toBe(initial);
    expect(worker.messages.at(-1)).toMatchObject({ type: 'settings', settings: { signalMode: 'pedestrian' } });
    const signal = { mode: 'pedestrian' as const, pedestrian: 'green' as const, eastWest: 'red' as const, northSouth: 'red' as const, remaining: null, waiting: 0, crossing: 12 };
    worker.emit({ ...worker.snapshot(), signal });
    frame();
    expect(harness.controls.setSignal).toHaveBeenLastCalledWith(signal, 0);
    expect(harness.renderer.render).toHaveBeenLastCalledWith(
      expect.any(Float32Array), expect.any(Float32Array), initial.config.count, expect.any(Number),
      expect.objectContaining({ signal }),
    );
    expect(harness.controls.setPaused).toHaveBeenLastCalledWith(true);
  });

  it('changes building appearance while paused without resetting or advancing the crowd', () => {
    const worker = FakeWorker.instance;
    controls().onPause();
    const initial = worker.latestInit(), messageCount = worker.messages.length;
    controls().onAppearance(false);
    expect(harness.renderer.setPhotographicAppearance).toHaveBeenLastCalledWith(false);
    controls().onAppearance(true);
    expect(harness.renderer.setPhotographicAppearance).toHaveBeenLastCalledWith(true);
    expect(worker.latestInit()).toBe(initial);
    expect(worker.messages).toHaveLength(messageCount);
    expect(harness.controls.setPaused).toHaveBeenLastCalledWith(true);
  });

  it('recycles both old snapshots and ignores in-flight messages after a reset', () => {
    const worker = FakeWorker.instance, oldInit = worker.latestInit();
    const oldSnapshot = worker.snapshot(1);
    worker.emit(oldSnapshot);
    controls().onConfig({ count: 1000 }, true);
    expect(oldSnapshot.buffer.byteLength).toBe(0);
    expect(worker.messages.filter(message => message.type === 'recycle')).toHaveLength(2);
    expect(worker.latestInit().generation).toBe(oldInit.generation + 1);
    const before = harness.renderer.render.mock.calls.length;
    worker.emit(worker.snapshot(2, 2, oldInit));
    frame();
    expect(harness.renderer.render).toHaveBeenCalledTimes(before);
    worker.emit(worker.snapshot());
    frame();
    expect(harness.renderer.render.mock.calls.at(-1)?.[2]).toBe(1000);
    expect(harness.controls.showError).not.toHaveBeenCalled();
  });

  it('completes all populations, weights step timings, and restores original count and pause', () => {
    const worker = FakeWorker.instance;
    controls().onConfig({ count: 10000 }, true);
    worker.emit(worker.snapshot());
    frame();
    controls().onPause();
    controls().onBenchmark();
    for (const count of [1000, 5000, 10000, 20000]) {
      const init = worker.latestInit();
      expect(init.config.count).toBe(count);
      expect(init.paused).toBe(false);
      worker.emit(worker.snapshot());
      for (let i = 0; i < 120; i++) frame(); // Pass the two-second warmup.
      worker.emit(worker.snapshot(1, 2));
      frame();
      worker.emit(worker.snapshot(4, 8)); // Three steps at 8 ms, one at 2 ms => 6.5 ms.
      for (let i = 0; i < 260 && worker.latestInit().generation === init.generation; i++) frame();
      expect(worker.latestInit().generation).toBeGreaterThan(init.generation);
    }
    const rows = harness.controls.renderBenchmark.mock.calls.at(-1)?.[0] as { count: number; fps: number; stepMs: number; drawCalls: number }[];
    expect(rows.map(row => row.count)).toEqual([1000, 5000, 10000, 20000]);
    for (const row of rows) {
      expect(row.stepMs).toBe(6.5); expect(row.fps).toBeGreaterThan(0); expect(row.drawCalls).toBe(5);
    }
    expect(worker.latestInit().config.count).toBe(10000);
    expect(worker.latestInit().paused).toBe(true);
    expect(harness.controls.setPaused).toHaveBeenLastCalledWith(true);
    expect(harness.controls.setBenchmarkRunning).toHaveBeenLastCalledWith(false);
  });

  it('cancels a study when hidden and resumes only according to the user pause state', () => {
    const worker = FakeWorker.instance;
    controls().onBenchmark();
    worker.emit(worker.snapshot());
    documentStub.hidden = true;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    expect(worker.latestInit().config.count).toBe(DEFAULT_CONFIG.count);
    expect(worker.latestInit().paused).toBe(true);
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: true });
    expect(harness.controls.setBenchmarkRunning).toHaveBeenLastCalledWith(false);
    documentStub.hidden = false;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: false });
    controls().onPause();
    documentStub.hidden = true;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    documentStub.hidden = false;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: true });
  });

  it('waits for scenery and applies the latest population and pause settings after loading', async () => {
    const worker = FakeWorker.instance;
    const previous = worker.latestInit();
    let ready!: () => void;
    harness.renderer.setScenario.mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve; }));
    controls().onConfig({ scenario: 'plaza' }, true);
    expect(worker.latestInit()).toBe(previous);
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: true });
    controls().onConfig({ count: 5000 }, true);
    controls().onPause();
    expect(worker.latestInit()).toBe(previous);
    ready();
    await Promise.resolve();
    expect(worker.latestInit().config).toMatchObject({ scenario: 'plaza', count: 5000 });
    expect(worker.latestInit().paused).toBe(true);
    expect(harness.controls.showError).not.toHaveBeenCalled();
  });

  it('ignores failure from a scenery request superseded by a later scenario', async () => {
    const worker = FakeWorker.instance;
    const previous = worker.latestInit();
    let reject!: (error: Error) => void;
    harness.renderer.setScenario.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    controls().onConfig({ scenario: 'plaza' }, true);
    controls().onConfig({ scenario: 'corridor' }, true);
    const newest = worker.latestInit();
    expect(newest.config.scenario).toBe('corridor');
    worker.emit(worker.snapshot(1, 2, previous));
    reject(new Error('Old asset request failed'));
    await Promise.resolve(); await Promise.resolve();
    expect(worker.latestInit()).toBe(newest);
    expect(harness.controls.showError).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('does not revive the worker or UI when destroyed during an asset request', async () => {
    const worker = FakeWorker.instance;
    const previous = worker.latestInit();
    let ready!: () => void;
    harness.renderer.setScenario.mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve; }));
    controls().onConfig({ scenario: 'plaza' }, true);
    app.destroy();
    const statusCalls = harness.controls.setStatus.mock.calls.length;
    ready();
    await Promise.resolve();
    expect(worker.latestInit()).toBe(previous);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(harness.controls.setStatus).toHaveBeenCalledTimes(statusCalls);
    expect(harness.controls.showError).not.toHaveBeenCalled();
  });
});
