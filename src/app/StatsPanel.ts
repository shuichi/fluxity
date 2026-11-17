import type { AppStats } from '../types';

const numberFormat = new Intl.NumberFormat('en-US');

/** UI refresh is intentionally throttled by App, independently from the render loop. */
export class StatsPanel {
  private readonly fields = new Map<string, HTMLElement>();
  private readonly bars: HTMLElement[];
  private readonly graph: SVGPolylineElement;
  private readonly samples = new Float32Array(40);
  private sampleCount = 0;
  private graphIndex = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <section class="stats-strip" aria-label="Live performance statistics">
        <div class="stats-live"><span class="eyebrow"><i class="live-dot"></i><span data-stat="state">LIVE</span></span><span class="stats-clock" data-stat="clock">00:00</span><span class="stats-clock-label">SIMULATION TIME</span></div>
        <div class="stat-cell fps-cell"><span class="stat-label">Frame rate</span><div class="stat-value"><strong data-stat="fps">—</strong><span>fps</span><svg class="fps-graph" viewBox="0 0 78 24" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points=""/></svg></div><span class="stat-caption"><span data-stat="frameMs">—</span> ms / frame</span></div>
        <div class="stat-cell"><span class="stat-label">Simulation</span><div class="stat-value"><strong data-stat="stepMs">—</strong><span>ms</span></div><span class="stat-caption">CPU · fixed 30 Hz</span></div>
        <div class="stat-cell population-stat"><span class="stat-label">In view</span><div class="stat-value"><strong data-stat="visible">—</strong></div><span class="stat-caption">of <span data-stat="count">—</span> people</span></div>
        <div class="stat-cell lod-stat"><div class="stat-label-row"><span class="stat-label">Level of detail</span><span class="lod-badges"><i></i><i></i><i></i></span></div><div class="lod-bars" aria-hidden="true"><i data-lod-bar="0"></i><i data-lod-bar="1"></i><i data-lod-bar="2"></i></div><span class="stat-caption lod-counts"><span data-stat="lod0">—</span><span data-stat="lod1">—</span><span data-stat="lod2">—</span></span></div>
        <button class="stats-details-button" id="stats-toggle" aria-label="Show detailed performance metrics" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 19V9m7 10V4m7 15v-7"/></svg><span>Details</span></button>
      </section>
      <section class="stats-details" id="stats-details" aria-label="Detailed performance metrics" hidden>
        <div class="details-heading"><span class="eyebrow">UNDER THE HOOD</span><span class="details-badge">CPU METRICS</span></div>
        <dl><div><dt>Render submission</dt><dd><span data-stat="cpuMs">—</span> ms</dd></div><div><dt>GPU execution</dt><dd class="muted">Not sampled</dd></div><div><dt>Draw calls</dt><dd data-stat="drawCalls">—</dd></div><div><dt>Triangles</dt><dd data-stat="triangles">—</dd></div><div><dt>Render resolution</dt><dd data-stat="resolution">—</dd></div><div class="metric-divider"><dt>Mean walking speed</dt><dd><span data-stat="meanSpeed">—</span> m/s</dd></div><div><dt>Slow / stopped</dt><dd><span data-stat="congestion">—</span>%</dd></div></dl>
        <div class="lod-legend"><span><i></i>Near <b data-stat="detailsLod0">—</b></span><span><i></i>Mid <b data-stat="detailsLod1">—</b></span><span><i></i>Far <b data-stat="detailsLod2">—</b></span></div>
        <p>Instanced geometry · Frustum culling<br/>Worker simulation · Interpolated snapshots</p>
      </section>`;
    root.querySelectorAll<HTMLElement>('[data-stat]').forEach(element => this.fields.set(element.dataset.stat!, element));
    this.bars = [...root.querySelectorAll<HTMLElement>('[data-lod-bar]')];
    this.graph = root.querySelector<SVGPolylineElement>('.fps-graph polyline')!;
    const button = root.querySelector<HTMLButtonElement>('#stats-toggle')!;
    const details = root.querySelector<HTMLElement>('#stats-details')!;
    button.addEventListener('click', () => {
      details.hidden = !details.hidden;
      button.setAttribute('aria-expanded', String(!details.hidden));
      button.setAttribute('aria-label', details.hidden ? 'Show detailed performance metrics' : 'Hide detailed performance metrics');
      button.classList.toggle('active', !details.hidden);
    });
  }

  update(stats: AppStats): void {
    const seconds = Math.floor(stats.simulationTime);
    const values: Record<string, string> = {
      fps: Math.round(stats.fps).toString(),
      frameMs: stats.frameMs.toFixed(1),
      stepMs: stats.stepMs.toFixed(1),
      cpuMs: stats.cpuMs.toFixed(2),
      visible: numberFormat.format(stats.visible),
      count: numberFormat.format(stats.count),
      drawCalls: String(stats.drawCalls),
      triangles: numberFormat.format(stats.triangles),
      resolution: stats.resolution,
      meanSpeed: stats.meanSpeed.toFixed(2),
      congestion: (stats.congestion * 100).toFixed(0),
      state: stats.paused ? 'PAUSED' : 'LIVE',
      clock: `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`,
      lod0: numberFormat.format(stats.lodCounts[0]),
      lod1: numberFormat.format(stats.lodCounts[1]),
      lod2: numberFormat.format(stats.lodCounts[2]),
      detailsLod0: numberFormat.format(stats.lodCounts[0]),
      detailsLod1: numberFormat.format(stats.lodCounts[1]),
      detailsLod2: numberFormat.format(stats.lodCounts[2]),
    };
    for (const [key, value] of Object.entries(values)) {
      const element = this.fields.get(key);
      if (element && element.textContent !== value) element.textContent = value;
    }
    for (let i = 0; i < 3; i++) this.bars[i].style.flexGrow = String(Math.max(0.01, stats.lodCounts[i] / Math.max(stats.visible, 1)));
    this.samples[this.graphIndex] = Math.min(120, stats.fps);
    this.graphIndex = (this.graphIndex + 1) % this.samples.length;
    this.sampleCount = Math.min(this.samples.length, this.sampleCount + 1);
    let points = '';
    for (let i = 0; i < this.sampleCount; i++) {
      const at = (this.graphIndex - this.sampleCount + i + this.samples.length) % this.samples.length;
      points += `${(i * 78 / (this.samples.length - 1)).toFixed(1)},${(23 - this.samples[at] / 120 * 22).toFixed(1)} `;
    }
    this.graph.setAttribute('points', points);
  }
}
