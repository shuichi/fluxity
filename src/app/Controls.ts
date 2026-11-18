import type { CameraView, Quality, ScenarioId, SignalMode, SignalState, SimulationConfig } from '../types';

export interface ControlCallbacks {
  onConfig: (patch: Partial<SimulationConfig>, reset: boolean) => void;
  onPause: () => void;
  onReset: () => void;
  onQuality: (quality: Quality) => void;
  onAppearance: (photographic: boolean) => void;
  onDebug: (enabled: boolean) => void;
  onCamera: (view: CameraView | 'reset') => void;
  onBenchmark: () => void;
}

export interface BenchmarkRow {
  count: number;
  fps: number;
  frameMs: number;
  stepMs: number;
  drawCalls: number;
}

const icon = (paths: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
  pause: icon('<path d="M9 5v14M15 5v14"/>'),
  play: icon('<path d="m8 5 11 7-11 7V5Z"/>'),
  reset: icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>'),
  perspective: icon('<path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v8l9 5 9-5V8M12 13v8"/>'),
  overview: icon('<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>'),
  street: icon('<circle cx="12" cy="5" r="2"/><path d="m7 12 5-3 5 3M12 9v6m-4 6 4-6 4 6"/>'),
  sliders: icon('<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  arrow: icon('<path d="M5 12h14m-6-6 6 6-6 6"/>'),
  close: icon('<path d="m6 6 12 12M6 18 18 6"/>'),
  chart: icon('<path d="M4 4v16h16M8 16v-5m5 5V7m5 9v-8"/>'),
  mouse: icon('<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6"/>'),
  shuffle: icon('<path d="M4 7h3c4 0 6 10 10 10h3m-4-4 4 4-4 4M4 17h3c1 0 2-1 3-2m4-6c1-1 2-2 3-2h3m-4-4 4 4-4 4"/>'),
};

const scenarioDetails: Record<ScenarioId, { index: string; name: string; description: string; note: string }> = {
  shibuya: { index: '01', name: 'Shibuya Scramble', description: 'Real city geometry. Individual journeys.', note: 'PLATEAU 2025 · LOD2 buildings · Flat-ground study' },
  plaza: { index: '02', name: 'City Plaza', description: 'A city in constant motion.', note: 'Shared destinations · Open urban space' },
  corridor: { index: '03', name: 'Bidirectional Corridor', description: 'Two directions. A shared path.', note: 'Opposing streams · Lane formation' },
  bottleneck: { index: '04', name: 'Bottleneck', description: 'When movement meets resistance.', note: 'Narrow passage · Emerging congestion' },
  crossing: { index: '05', name: 'Crossing Flow', description: 'Where individual paths intersect.', note: 'Crossing streams · Local avoidance' },
};

export class Controls {
  readonly canvas: HTMLCanvasElement;
  readonly statsElement: HTMLElement;
  private readonly root: HTMLElement;
  private readonly abort = new AbortController();
  private config: SimulationConfig;
  private signalAnnouncement = '';

  constructor(container: HTMLElement, config: SimulationConfig, callbacks: ControlCallbacks) {
    this.root = container;
    this.config = { ...config };
    container.innerHTML = `
      <header class="app-header">
        <a class="brand" href="#" aria-label="Fluxity home" id="brand-home">
          <span class="brand-symbol" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="brand-name">fluxity<span class="brand-dot">.</span></span>
        </a>
        <span class="brand-divider" aria-hidden="true"></span>
        <span class="header-tagline">People in motion.</span>
        <div class="header-right">
          <a class="algorithms-link" href="${import.meta.env.BASE_URL}docs/algorithms.html" target="_blank" rel="noopener noreferrer" aria-label="アルゴリズム解説（新しいタブで開く）" title="アルゴリズム解説（新しいタブで開く）"><span class="algorithms-label">アルゴリズム解説</span><span class="algorithms-label-short">解説</span><span class="algorithms-link-arrow" aria-hidden="true">↗</span></a>
          <span class="runtime-status" id="runtime-status" data-kind="loading"><span class="status-dot"></span><span id="runtime-label">INITIALIZING</span></span>
          <button class="icon-button mobile-controls" id="panel-toggle" aria-label="Toggle simulation controls" aria-controls="control-panel" aria-expanded="true">${icons.sliders}</button>
        </div>
      </header>
      <main class="workspace" aria-label="Interactive crowd simulation">
        <canvas id="scene" aria-label="Interactive three-dimensional crowd. Drag to orbit, right-drag to pan, scroll to zoom." tabindex="0"></canvas>
        <div class="scene-shade" aria-hidden="true"></div>
        <aside class="control-panel" id="control-panel" aria-label="Simulation controls">
          <div class="panel-heading"><span class="eyebrow">SIMULATION</span><span class="panel-number">01—05</span></div>
          <section class="control-section scene-section">
            <label class="field-label" for="scenario">Environment</label>
            <div class="select-wrap"><select id="scenario" class="simulation-control"><option value="shibuya">Shibuya Scramble</option><option value="plaza">City Plaza</option><option value="corridor">Bidirectional Corridor</option><option value="bottleneck">Bottleneck</option><option value="crossing">Crossing Flow</option></select></div>
            <p class="field-hint" id="scenario-note">PLATEAU 2025 · LOD2 buildings · Flat-ground study</p>
            <div class="map-credit" id="map-credit"><a href="https://www.geospatial.jp/ckan/dataset/plateau-13113-shibuya-ku-2025" target="_blank" rel="noopener noreferrer" title="3D都市モデル（Project PLATEAU）渋谷区（2025年度）を加工して作成">PLATEAU · Shibuya 2025 · adapted</a><span> / </span><a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a><span class="map-reference"> · Crossings calibrated with <a href="https://maps.gsi.go.jp/development/ichiran.html#seamlessphoto" target="_blank" rel="noopener noreferrer">GSI imagery</a></span></div>
            <div class="field-row appearance-row" id="appearance-controls"><label for="building-appearance">Building appearance</label><div class="select-wrap compact-select"><select id="building-appearance" class="simulation-control"><option value="photo" selected>Photo</option><option value="solid">Solid</option></select></div></div>
          </section>
          <details class="control-section signal-section" id="signal-controls" open hidden>
            <summary><span class="field-label">Pedestrian signal</span><span class="signal-control-phase" id="signal-control-phase">Syncing</span></summary>
            <div class="segmented signal-options" role="group" aria-label="Pedestrian signal mode">
              <button class="simulation-control" data-signal-mode="auto" aria-pressed="true" title="Cycle pedestrian signals automatically">Auto</button>
              <button class="simulation-control" data-signal-mode="green" aria-pressed="false" title="Green: pedestrians may cross">Green</button>
              <button class="simulation-control" data-signal-mode="red" aria-pressed="false" title="Red: pedestrians wait at the crossing">Red</button>
            </div>
            <p class="signal-help">Red holds new arrivals; people already crossing continue. Demo timing: 12s red / 35s green.</p>
          </details>
          <section class="control-section population-section">
            <div class="field-row"><span class="field-label" id="population-label">Population</span><span class="field-unit">AGENTS</span></div>
            <div class="population-value"><span id="population-value">${config.count.toLocaleString('en-US')}</span><span class="population-unit">people</span></div>
            <div class="segmented population-options" role="group" aria-labelledby="population-label">
              ${[1000, 5000, 10000, 20000].map(n => `<button class="simulation-control" data-count="${n}" aria-pressed="${n === config.count}">${n / 1000}k</button>`).join('')}
            </div>
          </section>
          <div class="playback-row"><button class="primary-button simulation-control" id="pause-button">${icons.pause}<span id="pause-label">Pause simulation</span></button><button class="icon-button reset-button simulation-control" id="reset-button" aria-label="Reset simulation with current seed" title="Reset simulation">${icons.reset}</button></div>
          <section class="control-section behavior-section">
            <div class="section-heading"><span class="eyebrow">MOVEMENT</span><span class="tiny-label">LIVE CONTROLS</span></div>
            <div class="range-field"><div class="field-row"><label for="simulation-speed">Time scale</label><output id="simulation-speed-value" for="simulation-speed">1.0×</output></div><input class="simulation-control" id="simulation-speed" type="range" min="0.25" max="2" step="0.25" value="1"/><div class="range-captions"><span>0.25×</span><span>2×</span></div></div>
            <div class="range-field"><div class="field-row"><label for="walking-speed">Walking speed</label><output id="walking-speed-value" for="walking-speed">1.35 <span>m/s</span></output></div><input class="simulation-control" id="walking-speed" type="range" min="0.3" max="3" step="0.05" value="1.35"/><div class="range-captions"><span>Stroll</span><span>Run</span></div></div>
            <div class="range-field"><div class="field-row"><label for="avoidance">Personal space</label><output id="avoidance-value" for="avoidance">1.0×</output></div><input class="simulation-control" id="avoidance" type="range" min="0" max="2.5" step="0.1" value="1"/><div class="range-captions"><span>Relaxed</span><span>Cautious</span></div></div>
          </section>
          <section class="control-section rendering-section">
            <div class="section-heading"><span class="eyebrow">RENDERING</span><span class="tiny-label">NATIVE WEBGPU</span></div>
            <div class="field-row quality-row"><label for="quality">Detail level</label><div class="select-wrap compact-select"><select id="quality" class="simulation-control"><option value="performance">Performance</option><option value="balanced" selected>Balanced</option><option value="ultra">Ultra</option></select></div></div>
            <div class="field-row debug-row"><label for="debug">LOD debug colors</label><label class="switch"><input class="simulation-control" id="debug" type="checkbox"/><span class="switch-track"></span></label></div>
            <div class="seed-row"><label for="seed">Random seed</label><div class="seed-input-wrap"><span aria-hidden="true">#</span><input class="simulation-control" id="seed" type="number" min="0" max="4294967295" step="1" value="42" aria-label="Random seed"/><button class="seed-shuffle simulation-control" id="shuffle-seed" aria-label="Generate and apply a new random seed" title="New random seed">${icons.shuffle}</button></div></div>
          </section>
          <button class="compare-button simulation-control" id="benchmark-button">${icons.chart}<span>Compare performance</span>${icons.arrow}</button>
          <div class="panel-footnote"><span class="small-dot"></span>30 Hz simulation · Independent rendering</div>
        </aside>
        <div class="scene-caption" aria-live="polite"><div class="scene-kicker"><span class="scene-index" id="scene-index">01</span><span>URBAN DYNAMICS</span><span class="caption-line"></span></div><h1 id="scene-title">Shibuya Scramble</h1><p id="scene-description">Real city geometry. Individual journeys.</p></div>
        <div class="signal-badge" id="scene-signal" data-phase="pending" role="group" aria-label="Live pedestrian signal" hidden>
          <div class="signal-badge-state"><span class="signal-lamps" aria-hidden="true"><i></i><i></i></span><div><span class="signal-badge-kicker" id="signal-cycle-label">PEDESTRIAN SIGNAL</span><div class="signal-phase-line"><strong id="signal-phase">SYNCING</strong><span id="signal-countdown">—</span></div></div></div>
          <div class="signal-badge-metrics"><span>Waiting <b id="signal-waiting">—</b></span><span>Crossing <b id="signal-crossing">—</b></span></div>
        </div>
        <span class="visually-hidden" id="signal-announcement" role="status" aria-live="polite" aria-atomic="true"></span>
        <nav class="camera-toolbar" aria-label="Camera views"><span class="camera-label">VIEW</span><div class="camera-buttons"><button class="icon-button active" data-camera="perspective" aria-label="Perspective view" aria-pressed="true" title="Perspective">${icons.perspective}</button><button class="icon-button" data-camera="overview" aria-label="Overhead view" aria-pressed="false" title="Overhead">${icons.overview}</button><button class="icon-button" data-camera="street" aria-label="Street level view" aria-pressed="false" title="Street level">${icons.street}</button><span class="toolbar-divider"></span><button class="icon-button" data-camera="reset" aria-label="Reset camera" title="Reset camera">${icons.reset}</button></div></nav>
        <div class="navigation-hint">${icons.mouse}<div><span><b>Drag</b> to orbit <i>·</i> <b>Scroll</b> to zoom</span><span><b>Right drag</b> to pan <i>·</i> <kbd>space</kbd> to pause</span></div></div>
        <div id="stats"></div>
        <div class="loading-overlay" id="loading-overlay" role="status"><span class="loader-symbol" aria-hidden="true"><i></i><i></i><i></i></span><h2>Setting Shibuya in motion</h2><p id="loading-message">Preparing WebGPU, the city map and ${config.count.toLocaleString('en-US')} pedestrians.</p></div>
        <div class="error-overlay" id="error-overlay" role="alert" hidden><div class="error-card"><span class="error-icon">${icons.perspective}</span><span class="eyebrow">RENDERER UNAVAILABLE</span><h2>This city needs WebGPU.</h2><p id="error-message"></p><p class="error-help">Use a current desktop Chrome or Edge with hardware acceleration enabled. WebGPU requires HTTPS or localhost.</p><button class="primary-button" id="retry-button">${icons.reset}<span>Try again</span></button><span class="error-detail">No WebGL fallback is used.</span></div></div>
        <section class="benchmark-panel" id="benchmark-panel" aria-label="Population performance comparison" hidden>
          <div class="benchmark-heading"><div><span class="eyebrow">PERFORMANCE STUDY</span><h2>People &amp; performance</h2></div><button class="icon-button" id="benchmark-close" aria-label="Close performance comparison">${icons.close}</button></div>
          <p class="benchmark-intro">Same scene. Four population sizes. Measured on this device.</p>
          <div class="benchmark-status" id="benchmark-status" role="status">Ready to compare.</div>
          <button class="benchmark-stop" id="benchmark-stop" hidden>Stop study</button>
          <div class="benchmark-table-wrap"><table class="benchmark-table"><thead><tr><th scope="col">People</th><th scope="col">FPS</th><th scope="col">Frame</th><th scope="col">Sim step</th><th scope="col">Draws</th></tr></thead><tbody id="benchmark-rows"></tbody></table></div>
          <p class="benchmark-note">Frame and simulation step times are in milliseconds. GPU execution time is not measured. Camera, visibility, and hardware affect these results.</p>
        </section>
      </main>`;
    this.canvas = this.get<HTMLCanvasElement>('scene');
    this.statsElement = this.get('stats');
    this.setConfig(config);
    this.setSignal(undefined);
    const on = (element: EventTarget, type: string, listener: EventListener) => element.addEventListener(type, listener, { signal: this.abort.signal });
    on(this.get('brand-home'), 'click', event => {
      event.preventDefault();
      this.setCameraActive('perspective');
      callbacks.onCamera('reset');
    });
    on(this.get('scenario'), 'change', () => {
      const scenario = this.get<HTMLSelectElement>('scenario').value as ScenarioId;
      this.setConfig({ ...this.config, scenario });
      this.setCameraActive('perspective');
      callbacks.onConfig({ scenario }, true);
    });
    container.querySelectorAll<HTMLButtonElement>('[data-count]').forEach(button => on(button, 'click', () => {
      const count = Number(button.dataset.count);
      this.setConfig({ ...this.config, count });
      callbacks.onConfig({ count }, true);
    }));
    container.querySelectorAll<HTMLButtonElement>('[data-signal-mode]').forEach(button => on(button, 'click', () => {
      const signalMode = button.dataset.signalMode as SignalMode;
      this.setConfig({ ...this.config, signalMode });
      callbacks.onConfig({ signalMode }, false);
    }));
    on(this.get('pause-button'), 'click', () => callbacks.onPause());
    on(this.get('reset-button'), 'click', () => callbacks.onReset());
    const bindRange = (id: string, key: 'simulationSpeed' | 'walkingSpeed' | 'avoidanceStrength') => {
      on(this.get(id), 'input', () => {
        const value = Number(this.get<HTMLInputElement>(id).value);
        this.config[key] = value;
        this.updateRanges();
        callbacks.onConfig({ [key]: value }, false);
      });
    };
    bindRange('simulation-speed', 'simulationSpeed');
    bindRange('walking-speed', 'walkingSpeed');
    bindRange('avoidance', 'avoidanceStrength');
    on(this.get('quality'), 'change', () => callbacks.onQuality(this.get<HTMLSelectElement>('quality').value as Quality));
    on(this.get('building-appearance'), 'change', () => callbacks.onAppearance(this.get<HTMLSelectElement>('building-appearance').value === 'photo'));
    on(this.get('debug'), 'change', () => {
      const enabled = this.get<HTMLInputElement>('debug').checked;
      this.root.classList.toggle('lod-debug', enabled);
      callbacks.onDebug(enabled);
    });
    const applySeed = (value: number) => {
      const seed = Number.isFinite(value) ? Math.min(4294967295, Math.max(0, Math.floor(value))) : 42;
      this.setConfig({ ...this.config, seed });
      callbacks.onConfig({ seed }, true);
    };
    on(this.get('seed'), 'change', () => applySeed(Number(this.get<HTMLInputElement>('seed').value)));
    on(this.get('shuffle-seed'), 'click', () => applySeed(Math.floor(Math.random() * 100000)));
    container.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach(button => on(button, 'click', () => {
      const view = button.dataset.camera as CameraView | 'reset';
      this.setCameraActive(view === 'reset' ? 'perspective' : view);
      callbacks.onCamera(view);
    }));
    on(this.get('benchmark-button'), 'click', () => {
      this.get('benchmark-panel').hidden = false;
      callbacks.onBenchmark();
    });
    on(this.get('benchmark-close'), 'click', () => { this.get('benchmark-panel').hidden = true; });
    on(this.get('benchmark-stop'), 'click', () => callbacks.onBenchmark());
    const narrowViewport = matchMedia('(max-width: 720px)');
    const syncPanelAccessibility = () => {
      const panel = this.get('control-panel');
      const collapsed = narrowViewport.matches && panel.classList.contains('is-collapsed');
      if (collapsed && panel.contains(document.activeElement)) this.get('panel-toggle').focus();
      panel.inert = collapsed;
      this.get('panel-toggle').setAttribute('aria-expanded', String(!collapsed));
    };
    on(this.get('panel-toggle'), 'click', () => {
      this.get('control-panel').classList.toggle('is-collapsed');
      syncPanelAccessibility();
    });
    on(narrowViewport, 'change', syncPanelAccessibility);
    on(this.get('retry-button'), 'click', () => location.reload());
    on(window, 'keydown', event => {
      const key = event as KeyboardEvent;
      const target = key.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button, summary, [contenteditable]') || key.repeat || key.altKey || key.ctrlKey || key.metaKey) return;
      if (key.code === 'Space') {
        key.preventDefault();
        if (!this.get<HTMLButtonElement>('pause-button').disabled) callbacks.onPause();
      } else if (key.code === 'KeyR') {
        this.setCameraActive('perspective');
        callbacks.onCamera('reset');
      }
    });
  }

  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing UI element: ${id}`);
    return element;
  }

  private updateRanges(): void {
    const values = [
      ['simulation-speed', this.config.simulationSpeed, `${this.config.simulationSpeed.toFixed(2).replace(/0$/, '')}×`],
      ['walking-speed', this.config.walkingSpeed, `${this.config.walkingSpeed.toFixed(2)} m/s`],
      ['avoidance', this.config.avoidanceStrength, `${this.config.avoidanceStrength.toFixed(1)}×`],
    ] as const;
    for (const [id, value, text] of values) {
      const input = this.get<HTMLInputElement>(id);
      input.value = String(value);
      input.style.setProperty('--range-progress', `${100 * (value - Number(input.min)) / (Number(input.max) - Number(input.min))}%`);
      this.get(`${id}-value`).textContent = text;
    }
  }

  setConfig(config: SimulationConfig): void {
    const changedScenario = config.scenario !== this.config.scenario;
    this.config = { ...config };
    this.get<HTMLSelectElement>('scenario').value = config.scenario;
    this.get('population-value').textContent = config.count.toLocaleString('en-US');
    this.root.querySelectorAll<HTMLButtonElement>('[data-count]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.count) === config.count)));
    this.get<HTMLInputElement>('seed').value = String(config.seed);
    const details = scenarioDetails[config.scenario];
    this.get('scene-index').textContent = details.index;
    this.get('scene-title').textContent = details.name;
    this.get('scene-description').textContent = details.description;
    this.get('scenario-note').textContent = details.note;
    this.get('map-credit').hidden = config.scenario !== 'shibuya';
    this.get('appearance-controls').hidden = config.scenario !== 'shibuya';
    this.get('signal-controls').hidden = config.scenario !== 'shibuya';
    this.root.classList.toggle('signal-scene', config.scenario === 'shibuya');
    this.root.querySelectorAll<HTMLButtonElement>('[data-signal-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.signalMode === config.signalMode));
    });
    if (changedScenario || config.scenario !== 'shibuya') this.setSignal(undefined);
    this.get('loading-overlay').querySelector('h2')!.textContent = config.scenario === 'shibuya' ? 'Setting Shibuya in motion' : 'Setting the city in motion';
    this.updateRanges();
  }

  /** Phase and counts are taken from worker snapshots, including manual updates while paused. */
  setSignal(state: SignalState | undefined): void {
    const badge = this.get('scene-signal');
    badge.hidden = this.config.scenario !== 'shibuya';
    if (badge.hidden) {
      this.signalAnnouncement = '';
      this.get('signal-announcement').textContent = '';
      return;
    }
    const updateText = (id: string, text: string) => {
      const element = this.get(id);
      if (element.textContent !== text) element.textContent = text;
    };
    const phase = state?.phase ?? 'pending';
    badge.dataset.phase = phase;
    this.get('signal-controls').dataset.phase = phase;
    updateText('signal-phase', state ? state.phase === 'green' ? 'CROSS' : 'WAIT' : 'SYNCING');
    updateText('signal-control-phase', state ? state.phase === 'green' ? 'Cross' : 'Wait' : 'Syncing');
    updateText('signal-cycle-label', state ? `PEDESTRIAN SIGNAL · ${state.mode === 'auto' ? 'AUTO' : 'MANUAL'}` : 'PEDESTRIAN SIGNAL');
    updateText('signal-countdown', state ? state.remaining === null ? 'HELD' : `${Math.max(0, Math.ceil(state.remaining))}s` : '—');
    updateText('signal-waiting', state ? state.waiting.toLocaleString('en-US') : '—');
    updateText('signal-crossing', state ? state.crossing.toLocaleString('en-US') : '—');
    const announcement = state ? `${state.phase}:${state.mode}` : 'pending';
    if (announcement !== this.signalAnnouncement) {
      this.signalAnnouncement = announcement;
      updateText('signal-announcement', state
        ? `Pedestrian signal ${state.phase}: ${state.phase === 'green' ? 'cross' : 'wait'}. ${state.mode === 'auto' ? 'Automatic cycle.' : 'Manual hold.'}`
        : 'Synchronizing pedestrian signal.');
    }
  }

  setPaused(paused: boolean): void {
    const button = this.get<HTMLButtonElement>('pause-button');
    button.innerHTML = `${paused ? icons.play : icons.pause}<span id="pause-label">${paused ? 'Resume simulation' : 'Pause simulation'}</span>`;
    button.classList.toggle('is-paused', paused);
    button.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
    this.root.classList.toggle('simulation-paused', paused);
  }

  setCameraActive(view: CameraView): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-camera]').forEach(button => {
      if (button.dataset.camera === 'reset') return;
      const active = button.dataset.camera === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  setStatus(text: string, kind: 'loading' | 'ready' | 'error' = 'ready'): void {
    this.get('runtime-status').dataset.kind = kind;
    this.get('runtime-label').textContent = kind === 'ready' ? 'WEBGPU READY' : kind === 'error' ? 'UNAVAILABLE' : 'INITIALIZING';
    this.get('runtime-status').title = text;
    this.get('loading-overlay').hidden = kind !== 'loading';
    this.get('loading-message').textContent = text;
  }

  showError(message: string): void {
    this.setStatus(message, 'error');
    this.setBenchmarkRunning(false);
    this.get('benchmark-panel').hidden = true;
    const details = this.root.querySelector<HTMLElement>('#stats-details');
    if (details) details.hidden = true;
    this.statsElement.inert = true;
    this.root.querySelector<HTMLElement>('.camera-toolbar')!.inert = true;
    this.get('error-message').textContent = message;
    this.get('error-overlay').hidden = false;
    this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.simulation-control').forEach(element => { element.disabled = true; });
    this.get('retry-button').focus();
  }

  setBenchmarkStatus(text: string): void {
    this.get('benchmark-status').textContent = text;
    this.get('benchmark-panel').hidden = false;
  }

  setBenchmarkRunning(running: boolean): void {
    this.get<HTMLButtonElement>('benchmark-button').disabled = running;
    this.get('benchmark-panel').classList.toggle('is-running', running);
    this.get('benchmark-button').setAttribute('aria-busy', String(running));
    this.get('benchmark-stop').hidden = !running;
    this.get('benchmark-button').querySelector('span')!.textContent = running ? 'Measuring populations…' : 'Compare performance';
  }

  renderBenchmark(rows: BenchmarkRow[]): void {
    const body = this.get('benchmark-rows');
    body.replaceChildren(...rows.map(row => {
      const tr = document.createElement('tr');
      for (const value of [row.count.toLocaleString('en-US'), row.fps.toFixed(1), row.frameMs.toFixed(1), row.stepMs.toFixed(2), String(row.drawCalls)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      return tr;
    }));
  }

  destroy(): void { this.abort.abort(); }
}
