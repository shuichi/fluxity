import { Controls } from './Controls';
import { StatsPanel } from './StatsPanel';
import { SnapshotTimeline } from './SnapshotTimeline';
import { WebGPURenderer } from '../renderer/WebGPURenderer';
import { getScenario } from '../scenarios';
import {
  DEFAULT_CONFIG, MAX_AGENTS,
  type AppStats, type Quality, type SimulationConfig,
  type WorkerInput, type WorkerOutput,
} from '../types';

interface BenchmarkRow {
  count: number;
  fps: number;
  frameMs: number;
  stepMs: number;
  drawCalls: number;
}
interface Benchmark {
  index: number;
  counts: number[];
  originalCount: number;
  originalPaused: boolean;
  startedAt: number;
  frames: number;
  elapsedMs: number;
  stepSum: number;
  stepSamples: number;
  draws: number;
  rows: BenchmarkRow[];
}

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

export class App {
  private config: SimulationConfig = { ...DEFAULT_CONFIG };
  private readonly controls: Controls;
  private readonly statsPanel: StatsPanel;
  private renderer: WebGPURenderer | null = null;
  private worker: Worker | null = null;
  private readonly timeline: SnapshotTimeline;
  private generation = 0;
  private scenarioRequest = 0;
  private sceneReady = false;
  private paused = false;
  private quality: Quality = 'balanced';
  private photographicAppearance = true;
  private debug = false;
  private frameId = 0;
  private lastFrame = 0;
  private frameMs = 1000 / 60;
  private lastStats = 0;
  private benchmark: Benchmark | null = null;
  private failed = false;
  private destroyed = false;
  private stats: AppStats = {
    visible: 0, lodCounts: [0, 0, 0], drawCalls: 0, triangles: 0,
    cpuMs: 0, resolution: '—', fps: 0, frameMs: 0, stepMs: 0,
    count: DEFAULT_CONFIG.count, meanSpeed: 0, congestion: 0,
    simulationTime: 0, paused: false,
  };

  constructor(container: HTMLElement) {
    this.timeline = new SnapshotTimeline(message => {
      if (message.generation === this.generation && this.worker) {
        this.send({ type: 'recycle', buffer: message.buffer, generation: message.generation }, [message.buffer]);
      }
    });
    this.controls = new Controls(container, this.config, {
      onConfig: (patch, reset) => {
        this.cancelBenchmark('Benchmark stopped: settings changed.');
        this.configure(patch, reset);
      },
      onPause: () => {
        const requestedPause = !this.paused;
        this.cancelBenchmark('Benchmark stopped.');
        this.paused = requestedPause;
        this.controls.setPaused(this.paused);
        this.sendPauseState();
      },
      onReset: () => {
        this.cancelBenchmark('Benchmark stopped.');
        this.resetSimulation();
      },
      onQuality: quality => {
        this.cancelBenchmark('Benchmark stopped: quality changed.');
        this.quality = quality;
      },
      onDebug: enabled => { this.debug = enabled; },
      onAppearance: enabled => {
        this.cancelBenchmark('Benchmark stopped: appearance changed.');
        this.photographicAppearance = enabled;
        this.renderer?.setPhotographicAppearance(enabled);
      },
      onCamera: view => {
        if (view === 'reset') this.renderer?.camera.reset();
        else this.renderer?.camera.setView(view);
      },
      onBenchmark: () => this.startBenchmark(),
    });
    this.statsPanel = new StatsPanel(this.controls.statsElement);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  async start(): Promise<void> {
    try {
      this.controls.setStatus('Connecting to your GPU', 'loading');
      this.renderer = await WebGPURenderer.create(this.controls.canvas, message => this.fail(message));
      if (this.destroyed || this.failed) { this.renderer.destroy(); this.renderer = null; return; }
      this.renderer.setPhotographicAppearance(this.photographicAppearance);
      this.worker = new Worker(new URL('../simulation/SimulationWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerOutput>) => this.onWorkerMessage(event.data);
      this.worker.onerror = event => this.fail(`Simulation worker: ${event.message || 'could not start'}`);
      this.frameId = requestAnimationFrame(this.frame);
      await this.prepareScenario();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private send(message: WorkerInput, transfer: Transferable[] = []): void {
    this.worker?.postMessage(message, transfer);
  }

  private configure(patch: Partial<SimulationConfig>, reset: boolean): void {
    const next = { ...this.config, ...patch };
    next.count = Math.round(clamp(Number.isFinite(next.count) ? next.count : DEFAULT_CONFIG.count, 1, MAX_AGENTS));
    next.seed = Number.isFinite(next.seed) ? next.seed >>> 0 : 42;
    next.simulationSpeed = clamp(next.simulationSpeed, 0.25, 3);
    next.walkingSpeed = clamp(next.walkingSpeed, 0.3, 3);
    next.avoidanceStrength = clamp(next.avoidanceStrength, 0, 3);
    const scenarioChanged = next.scenario !== this.config.scenario;
    const requiresReset = reset || scenarioChanged || next.count !== this.config.count || next.seed !== this.config.seed;
    this.config = next;
    this.controls.setConfig(this.config);
    if (scenarioChanged && this.renderer) {
      void this.prepareScenario();
      return;
    }
    if (requiresReset) this.resetSimulation();
    else this.send({ type: 'settings', settings: {
      simulationSpeed: next.simulationSpeed,
      walkingSpeed: next.walkingSpeed,
      avoidanceStrength: next.avoidanceStrength,
      signalMode: next.signalMode,
    } });
  }

  /** An old map request must never initialize a crowd on a newer map. */
  private prepareScenario(): void | Promise<void> {
    if (!this.renderer || this.failed || this.destroyed) return;
    const request = ++this.scenarioRequest;
    this.sceneReady = false;
    this.timeline.clear();
    this.generation++;
    this.sendPauseState();
    const scenario = getScenario(this.config.scenario);
    this.controls.setStatus(scenario.urbanMap ? 'Loading PLATEAU scenery' : 'Preparing the scene', 'loading');
    const complete = (): void => {
      if (request !== this.scenarioRequest || this.destroyed || this.failed) return;
      this.sceneReady = true;
      this.resetSimulation();
    };
    const failed = (error: unknown): void => {
      if (request !== this.scenarioRequest || this.destroyed) return;
      this.fail(error instanceof Error ? error.message : String(error));
    };
    try {
      const loading = this.renderer.setScenario(scenario);
      if (loading) return loading.then(complete).catch(failed);
      complete();
    } catch (error) { failed(error); }
  }

  private resetSimulation(): void {
    if (!this.worker || this.failed || !this.sceneReady) return;
    this.timeline.clear();
    this.generation++;
    this.stats.count = this.config.count;
    this.stats.simulationTime = 0;
    this.controls.setSignal(undefined);
    this.controls.setStatus('Preparing the crowd', 'loading');
    this.send({ type: 'init', config: this.config, generation: this.generation, paused: this.paused || document.hidden });
  }

  private onWorkerMessage(message: WorkerOutput): void {
    if (message.type === 'error') { this.fail(message.message); return; }
    if (message.generation !== this.generation || this.failed) return;
    try {
      const first = !this.timeline.current;
      const stepped = message.step - (this.timeline.current?.message.step ?? message.step);
      this.timeline.accept(message, performance.now());
      this.stats.stepMs = message.stepMs;
      this.stats.meanSpeed = message.meanSpeed;
      this.stats.congestion = message.congestion;
      this.stats.simulationTime = message.simulationTime;
      this.controls.setSignal(message.signal);
      if (first) {
        this.controls.setStatus('WebGPU active', 'ready');
        if (this.benchmark) this.benchmark.startedAt = performance.now();
      }
      if (this.benchmark && stepped > 0 && performance.now() - this.benchmark.startedAt >= 2000) {
        this.benchmark.stepSum += message.stepMs * stepped;
        this.benchmark.stepSamples += stepped;
      }
    } catch (error) { this.fail(String(error)); }
  }

  private readonly frame = (now: number): void => {
    if (this.destroyed || this.failed || !this.renderer) return;
    const elapsed = this.lastFrame ? now - this.lastFrame : 1000 / 60;
    this.lastFrame = now;
    if (elapsed < 1000) this.frameMs += (elapsed - this.frameMs) * 0.06;
    const { previous, current } = this.timeline;
    if (previous && current) {
      try {
        const render = this.renderer.render(previous.data, current.data, current.message.count,
          this.timeline.alpha(now, this.config.simulationSpeed), {
            quality: this.quality, debug: this.debug, signal: current.message.signal,
          });
        Object.assign(this.stats, render, {
          fps: 1000 / this.frameMs, frameMs: this.frameMs, count: current.message.count, paused: this.paused,
        });
        if (now - this.lastStats >= 250) {
          this.statsPanel.update(this.stats);
          this.lastStats = now;
        }
        this.sampleBenchmark(now, elapsed, render.drawCalls);
      } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return; }
    }
    this.frameId = requestAnimationFrame(this.frame);
  };

  private startBenchmark(): void {
    if (this.benchmark) { this.cancelBenchmark('Benchmark stopped.'); return; }
    if (!this.worker || this.failed || !this.timeline.current) return;
    this.benchmark = {
      index: 0, counts: [1000, 5000, 10000, 20000], originalCount: this.config.count,
      originalPaused: this.paused, startedAt: Infinity, frames: 0, elapsedMs: 0,
      stepSum: 0, stepSamples: 0, draws: 0, rows: [],
    };
    this.controls.renderBenchmark([]);
    this.controls.setBenchmarkRunning(true);
    this.paused = false;
    this.controls.setPaused(false);
    this.nextBenchmarkCount();
  }

  private nextBenchmarkCount(): void {
    const benchmark = this.benchmark;
    if (!benchmark) return;
    benchmark.startedAt = Infinity;
    benchmark.frames = benchmark.elapsedMs = benchmark.stepSum = benchmark.stepSamples = benchmark.draws = 0;
    this.configure({ count: benchmark.counts[benchmark.index] }, true);
    this.controls.setConfig(this.config);
    this.controls.setBenchmarkStatus(`${this.config.count.toLocaleString()} agents · warming up (2s), sampling (4s)`);
  }

  private sampleBenchmark(now: number, elapsed: number, drawCalls: number): void {
    const benchmark = this.benchmark;
    if (!benchmark || now - benchmark.startedAt < 2000) return;
    benchmark.frames++;
    benchmark.elapsedMs += elapsed;
    benchmark.draws += drawCalls;
    if (now - benchmark.startedAt < 6000) return;
    benchmark.rows.push({
      count: this.config.count,
      fps: benchmark.frames * 1000 / benchmark.elapsedMs,
      frameMs: benchmark.elapsedMs / benchmark.frames,
      stepMs: benchmark.stepSum / Math.max(1, benchmark.stepSamples),
      drawCalls: Math.round(benchmark.draws / benchmark.frames),
    });
    this.controls.renderBenchmark(benchmark.rows);
    benchmark.index++;
    if (benchmark.index < benchmark.counts.length) this.nextBenchmarkCount();
    else {
      this.benchmark = null;
      this.controls.setBenchmarkRunning(false);
      this.controls.setBenchmarkStatus('Complete · 4s samples after 2s warmup. Results reflect this view and device.');
      this.paused = benchmark.originalPaused;
      this.controls.setPaused(this.paused);
      this.configure({ count: benchmark.originalCount }, true);
      this.controls.setConfig(this.config);
    }
  }

  private cancelBenchmark(message: string): void {
    if (!this.benchmark) return;
    const { originalPaused, originalCount } = this.benchmark;
    this.benchmark = null;
    this.paused = originalPaused;
    this.controls.setPaused(this.paused);
    this.configure({ count: originalCount }, true);
    this.controls.setConfig(this.config);
    this.controls.setBenchmarkRunning(false);
    this.controls.setBenchmarkStatus(message);
  }

  private sendPauseState(): void {
    this.send({ type: 'pause', paused: this.paused || document.hidden || !this.sceneReady });
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.cancelBenchmark('Benchmark stopped: keep the tab visible while measuring.');
    this.lastFrame = 0;
    this.sendPauseState();
  };

  private fail(message: string): void {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    this.benchmark = null;
    console.error('[Fluxity]', message);
    cancelAnimationFrame(this.frameId);
    this.worker?.terminate();
    this.worker = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.controls.showError(message);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scenarioRequest++;
    cancelAnimationFrame(this.frameId);
    this.worker?.terminate();
    this.worker = null;
    this.timeline.clear();
    this.renderer?.destroy();
    this.controls.destroy();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
