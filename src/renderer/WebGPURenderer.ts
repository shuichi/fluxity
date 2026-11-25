import humanSource from '../shaders/human.wgsl?raw';
import environmentSource from '../shaders/environment.wgsl?raw';
import shadowSource from '../shaders/shadow.wgsl?raw';
import { MAX_AGENTS, SNAPSHOT_STRIDE } from '../types';
import type { PedestrianPortal, Quality, RenderStats, Scenario, SignalState } from '../types';
import { Camera, type PersonPose, STREET_NEAR_PLANE } from './Camera';
import { doorwayBlocksEye } from './Doorways';
import { createHumanMesh, HUMAN_VERTEX_STRIDE } from './HumanMesh';
import { createEnvironment, ENVIRONMENT_VERTEX_STRIDE } from './Environment';
import { InstanceBuffer, INSTANCE_STRIDE, samplePersonPose } from './InstanceBuffer';
import { LIGHTING } from './Lighting';
import { UrbanMeshLoader, mergeEnvironmentMeshes, untexturedCoordinates } from './UrbanMesh';
import type { EnvironmentMeshData } from './UrbanMesh';
import { createUrbanAppearance } from './UrbanAppearance';

interface Mesh {
  vertex: GPUBuffer;
  index: GPUBuffer;
  indexCount: number;
}
interface EnvironmentMesh extends Mesh {
  coordinates: GPUBuffer;
  texture: GPUTexture;
  appearanceGroup: GPUBindGroup;
}

export interface PickedPerson { id: number; life: number }

export class WebGPURenderer {
  readonly camera: Camera;
  readonly capabilities: string;
  private readonly context: GPUCanvasContext;
  private readonly sceneBuffer: GPUBuffer;
  private readonly sceneGroup: GPUBindGroup;
  private readonly instanceGroup: GPUBindGroup;
  private readonly instances: InstanceBuffer;
  private readonly followedPose: PersonPose = { x: 0, z: 0, heading: 0, scale: 1 };
  private doors: PedestrianPortal[] = [];
  private readonly uniforms = new Float32Array(32);
  private readonly humans: Mesh[] = [];
  private environment: EnvironmentMesh | null = null;
  private depth: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private personIds: GPUTexture | null = null;
  private personIdView: GPUTextureView | null = null;
  private humanPipeline!: GPURenderPipeline;
  private environmentPipeline!: GPURenderPipeline;
  private shadowPipeline!: GPURenderPipeline;
  private readonly sceneLayout: GPUBindGroupLayout;
  private readonly instanceLayout: GPUBindGroupLayout;
  private readonly appearanceLayout: GPUBindGroupLayout;
  private readonly appearanceSampler: GPUSampler;
  private width = 0;
  private height = 0;
  private dead = false;
  private disposed = false;
  private scenarioRequest = 0;
  private readonly urbanMeshes = new UrbanMeshLoader();
  private roadHalfWidth = 0;
  private photographicAppearance = true;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    adapter: GPUAdapter,
    onFatal?: (message: string) => void,
    onPersonClick?: (clientX: number, clientY: number) => void,
  ) {
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('This browser could not create a WebGPU canvas. Try a current Chrome or Edge browser with hardware acceleration enabled.');
    this.context = context;
    this.context.configure({ device, format, alphaMode: 'opaque' });
    this.camera = new Camera(canvas, onPersonClick);
    const adapterName = adapter.info?.description || adapter.info?.device || adapter.info?.architecture || 'WebGPU device';
    const timestampStatus = adapter.features.has('timestamp-query') ? 'supported, not measured' : 'unsupported';
    this.capabilities = `${adapterName} · native WebGPU · ${Math.round(device.limits.maxStorageBufferBindingSize / 1048576)} MB storage limit · GPU timing: ${timestampStatus}`;
    device.addEventListener('uncapturederror', (event) => {
      console.error('[Fluxity / WebGPU validation]', event.error.message);
      onFatal?.(`WebGPU validation error: ${event.error.message}`);
    });
    void device.lost.then((info) => {
      this.dead = true;
      if (info.reason !== 'destroyed') onFatal?.(`The GPU device was lost: ${info.message || info.reason}. Reload the page to reconnect.`);
    });
    this.sceneLayout = device.createBindGroupLayout({ label: 'Scene uniform layout · 128 bytes', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 128 } },
    ] });
    this.instanceLayout = device.createBindGroupLayout({ label: 'Instance storage layout · 64 bytes per agent', entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: INSTANCE_STRIDE } },
    ] });
    this.appearanceLayout = device.createBindGroupLayout({ label: 'Photographic environment appearance', entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    this.appearanceSampler = device.createSampler({
      minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 4,
    });
    this.sceneBuffer = device.createBuffer({ label: 'Scene uniforms', size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sceneGroup = device.createBindGroup({ layout: this.sceneLayout, entries: [{ binding: 0, resource: { buffer: this.sceneBuffer } }] });
    this.instances = new InstanceBuffer(device);
    this.instanceGroup = device.createBindGroup({ layout: this.instanceLayout, entries: [{ binding: 0, resource: { buffer: this.instances.buffer } }] });
    for (let i = 0; i < 3; i++) this.humans.push(this.uploadMesh(createHumanMesh(i), `Human LOD ${i}`));
  }

  static async create(canvas: HTMLCanvasElement, onFatal?: (message: string) => void,
    onPersonClick?: (clientX: number, clientY: number) => void): Promise<WebGPURenderer> {
    if (!window.isSecureContext) throw new Error('WebGPU needs a secure context. Open this app on localhost or HTTPS.');
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser. Use a current desktop Chrome or Edge on Windows/macOS with hardware acceleration enabled, or Safari with WebGPU support.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available. Enable browser hardware acceleration and update your graphics drivers.');
    const bytes = MAX_AGENTS * INSTANCE_STRIDE;
    if (adapter.limits.maxStorageBufferBindingSize < bytes || adapter.limits.maxBufferSize < bytes || adapter.limits.maxStorageBuffersPerShaderStage < 1) {
      throw new Error(`This GPU cannot allocate the ${Math.ceil(bytes / 1048576)} MB instance buffer required for 20,000 people.`);
    }
    // No optional features are requested. Baseline instanced draws work without timestamp queries or indirect-first-instance.
    const device = await adapter.requestDevice({ label: 'Fluxity crowd renderer' });
    if (device.limits.maxStorageBufferBindingSize < bytes || device.limits.maxBufferSize < bytes) {
      device.destroy();
      throw new Error('The GPU device has insufficient buffer limits for this scene.');
    }
    let renderer: WebGPURenderer | undefined;
    try {
      renderer = new WebGPURenderer(canvas, device, navigator.gpu.getPreferredCanvasFormat(), adapter, onFatal, onPersonClick);
      await renderer.createPipelines();
      return renderer;
    } catch (error) {
      renderer?.destroy();
      device.destroy();
      throw error;
    }
  }

  private async shader(label: string, code: string): Promise<GPUShaderModule> {
    const module = this.device.createShaderModule({ label, code });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === 'error');
    for (const message of compilation.messages) {
      if (message.type === 'warning') console.warn(`[${label}:${message.lineNum}:${message.linePos}] ${message.message}`);
    }
    if (errors.length) throw new Error(`${label} could not compile:\n${errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n')}`);
    return module;
  }

  private async createPipelines(): Promise<void> {
    const [human, environment, shadow] = await Promise.all([
      this.shader('human.wgsl', humanSource), this.shader('environment.wgsl', environmentSource), this.shader('shadow.wgsl', shadowSource),
    ]);
    const humanoidLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout, this.instanceLayout] });
    const depthStencil: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
    this.device.pushErrorScope('validation');
    const pipelines = await Promise.all([
      this.device.createRenderPipelineAsync({
        label: 'Articulated instanced humans', layout: humanoidLayout,
        vertex: { module: human, entryPoint: 'vertexMain', buffers: [{ arrayStride: HUMAN_VERTEX_STRIDE, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' },
        ] }] },
        fragment: { module: human, entryPoint: 'fragmentMain', targets: [{ format: this.format }, { format: 'r16uint' }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' }, depthStencil,
      }),
      this.device.createRenderPipelineAsync({
        label: 'Urban environment', layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout, this.appearanceLayout] }),
        vertex: { module: environment, entryPoint: 'vertexMain', buffers: [{ arrayStride: ENVIRONMENT_VERTEX_STRIDE, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' },
        ] }, { arrayStride: 12, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x3' }] }] },
        fragment: { module: environment, entryPoint: 'fragmentMain', targets: [{ format: this.format }, { format: 'r16uint', writeMask: 0 }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' }, depthStencil,
      }),
      this.device.createRenderPipelineAsync({
        label: 'Soft instanced contact shadows', layout: humanoidLayout,
        vertex: { module: shadow, entryPoint: 'vertexMain' },
        fragment: { module: shadow, entryPoint: 'fragmentMain', targets: [{ format: this.format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }, { format: 'r16uint', writeMask: 0 }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { ...depthStencil, depthWriteEnabled: false, depthCompare: 'less-equal' },
      }),
    ]);
    const validation = await this.device.popErrorScope();
    if (validation) throw new Error(`GPU pipeline validation: ${validation.message}`);
    [this.humanPipeline, this.environmentPipeline, this.shadowPipeline] = pipelines;
  }

  private uploadMesh(data: EnvironmentMeshData, label: string): Mesh {
    if (data.vertices.byteLength > this.device.limits.maxBufferSize || data.indices.byteLength > this.device.limits.maxBufferSize) {
      throw new Error('This GPU cannot allocate the urban scenery buffer.');
    }
    const vertex = this.device.createBuffer({ label: `${label} vertices`, size: data.vertices.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    let index: GPUBuffer | undefined;
    try {
      new Float32Array(vertex.getMappedRange()).set(data.vertices); vertex.unmap();
      index = this.device.createBuffer({ label: `${label} indices`, size: data.indices.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
      new Uint32Array(index.getMappedRange()).set(data.indices); index.unmap();
      return { vertex, index, indexCount: data.indices.length };
    } catch (error) { vertex.destroy(); index?.destroy(); throw error; }
  }

  private uploadEnvironment(data: EnvironmentMeshData, images: readonly ImageBitmap[], label: string): EnvironmentMesh {
    const mesh = this.uploadMesh(data, label);
    let coordinates: GPUBuffer | undefined, texture: GPUTexture | undefined;
    try {
      const values = data.appearance?.coordinates ?? untexturedCoordinates(data.vertices.length / 10);
      if (values.byteLength > this.device.limits.maxBufferSize) throw new Error('This GPU cannot allocate photographic coordinates.');
      coordinates = this.device.createBuffer({ label: `${label} photographic coordinates`, size: values.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
      new Float32Array(coordinates.getMappedRange()).set(values); coordinates.unmap();
      texture = createUrbanAppearance(this.device, images, data.appearance?.width ?? 1, data.appearance?.height ?? 1);
      const appearanceGroup = this.device.createBindGroup({ layout: this.appearanceLayout, entries: [
        { binding: 0, resource: texture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.appearanceSampler },
      ] });
      return { ...mesh, coordinates, texture, appearanceGroup };
    } catch (error) {
      mesh.vertex.destroy(); mesh.index.destroy(); coordinates?.destroy(); texture?.destroy();
      throw error;
    }
  }

  private releaseEnvironment(): void {
    this.environment?.vertex.destroy(); this.environment?.index.destroy();
    this.environment?.coordinates.destroy(); this.environment?.texture.destroy();
    this.environment = null;
  }

  setPhotographicAppearance(enabled: boolean): void { this.photographicAppearance = enabled; }

  setScenario(scenario: Scenario): void | Promise<void> {
    if (this.dead) return;
    const request = ++this.scenarioRequest;
    const install = (data: EnvironmentMeshData, images: readonly ImageBitmap[] = []): void => {
      if (this.dead || request !== this.scenarioRequest) return;
      const next = this.uploadEnvironment(data, images, scenario.name);
      this.releaseEnvironment();
      this.environment = next;
      this.doors = scenario.portals?.filter(p => p.kind === 'door') ?? [];
      this.roadHalfWidth = scenario.urbanMap ? 0 : scenario.scramble?.roadHalfWidth ?? 0;
      this.camera.setBounds(scenario.bounds, Boolean(scenario.scramble), Boolean(scenario.urbanMap));
      this.instances.lod.reset();
    };
    if (scenario.urbanMap) {
      return this.urbanMeshes.load(scenario.urbanMap).then(async (data) => {
        if (this.dead || request !== this.scenarioRequest) return;
        const merged = mergeEnvironmentMeshes(data, createEnvironment(scenario));
        if (!merged.appearance) { install(merged); return; }
        // Wait for every decode even after one fails, so no late ImageBitmap leaks.
        const decoded = await Promise.allSettled(merged.appearance.atlases.map(atlas => Promise.resolve().then(() => createImageBitmap(atlas, {
          imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'default',
        }))));
        const images = decoded.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        try {
          if (this.dead || request !== this.scenarioRequest) return;
          if (images.length !== decoded.length) throw new Error('Could not decode PLATEAU photographs. Check the atlas image files and reload.');
          install(merged, images);
        } finally { for (const image of images) image.close(); }
      });
    }
    install(createEnvironment(scenario));
  }

  private resize(quality: Quality): void {
    const rect = this.canvas.getBoundingClientRect();
    const multiplier = quality === 'performance' ? 0.75 : quality === 'ultra' ? 1.5 : 1;
    const ratio = Math.min(window.devicePixelRatio || 1, multiplier);
    const limit = this.device.limits.maxTextureDimension2D;
    const width = Math.max(1, Math.min(limit, Math.round(rect.width * ratio)));
    const height = Math.max(1, Math.min(limit, Math.round(rect.height * ratio)));
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    this.canvas.width = width; this.canvas.height = height;
    this.depth?.destroy();
    this.depth = this.device.createTexture({ label: 'Scene depth', size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depthView = this.depth.createView();
    this.personIds?.destroy();
    this.personIds = this.device.createTexture({
      label: 'Visible pedestrian IDs', size: [width, height], format: 'r16uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.personIdView = this.personIds.createView();
  }

  async pickPerson(clientX: number, clientY: number): Promise<PickedPerson | null> {
    if (this.dead || !this.personIds) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) * this.width / rect.width);
    const y = Math.floor((clientY - rect.top) * this.height / rect.height);
    if (!(x >= 0 && x < this.width && y >= 0 && y < this.height)) return null;

    // Preserve identities for this exact frame while the asynchronous pixel read is in flight.
    const lives = this.instances.visibleLives.slice();
    const pixel = this.device.createBuffer({
      label: 'Pedestrian under pointer', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: this.personIds, origin: [x, y] }, { buffer: pixel }, [1, 1]);
      this.device.queue.submit([encoder.finish()]);
      await pixel.mapAsync(GPUMapMode.READ);
      if (this.dead) return null;
      const encodedId = new Uint16Array(pixel.getMappedRange())[0];
      if (encodedId === 0) return null;
      const id = encodedId - 1;
      return { id, life: lives[id] };
    } catch (error) {
      if (this.dead) return null;
      throw error;
    } finally {
      pixel.destroy();
    }
  }

  canPlacePersonCamera(previous: Float32Array, current: Float32Array, id: number, alpha: number): boolean {
    if (!this.doors.length) return true;
    samplePersonPose(this.followedPose, previous, current, id * SNAPSHOT_STRIDE, alpha);
    const aspect = this.width / Math.max(1, this.height);
    const nearRadius = STREET_NEAR_PLANE * Math.hypot(1, Math.tan(this.camera.fov / 2) * aspect);
    return !this.doors.some(door => doorwayBlocksEye(door, this.followedPose, nearRadius));
  }

  render(previous: Float32Array, current: Float32Array, count: number, alpha: number,
    options: { quality: Quality; debug: boolean; signal?: SignalState; followedId?: number }): RenderStats {
    const start = performance.now();
    if (this.dead) return { visible: 0, lodCounts: [0,0,0], drawCalls: 0, triangles: 0, cpuMs: 0, resolution: 'GPU disconnected' };
    this.resize(options.quality);
    const { followedId } = options;
    const n = Math.min(count, MAX_AGENTS, Math.floor(current.length / SNAPSHOT_STRIDE));
    const from = previous.length >= n * SNAPSHOT_STRIDE ? previous : current;
    const t = Math.max(0, Math.min(1, alpha));
    let person: PersonPose | undefined;
    if (followedId !== undefined && followedId >= 0 && followedId < n) {
      samplePersonPose(this.followedPose, from, current, followedId * SNAPSHOT_STRIDE, t);
      person = this.followedPose;
    }
    this.camera.update(this.width / this.height, person);
    this.instances.update(from, current, n, t, this.camera, this.height, options.quality, followedId);
    this.uniforms.set(this.camera.viewProjection, 0);
    this.uniforms.set(this.camera.position, 16); this.uniforms[19] = Number(this.photographicAppearance);
    this.uniforms.set(LIGHTING.direction, 20); this.uniforms[23] = LIGHTING.ambient;
    this.uniforms[24] = Number(options.debug);
    this.uniforms[25] = Number(options.signal?.phase !== 'red');
    this.uniforms[26] = this.roadHalfWidth;
    this.uniforms[27] = LIGHTING.fogNear;
    this.uniforms[28] = LIGHTING.background.r; this.uniforms[29] = LIGHTING.background.g;
    this.uniforms[30] = LIGHTING.background.b; this.uniforms[31] = LIGHTING.fogFar;
    this.device.queue.writeBuffer(this.sceneBuffer, 0, this.uniforms);
    const encoder = this.device.createCommandEncoder({ label: 'Fluxity frame' });
    const pass = encoder.beginRenderPass({
      label: 'Environment, soft shadows, and articulated crowd',
      colorAttachments: [
        { view: this.context.getCurrentTexture().createView(), clearValue: LIGHTING.background, loadOp: 'clear', storeOp: 'store' },
        { view: this.personIdView!, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.depthView!, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setBindGroup(0, this.sceneGroup);
    let drawCalls = 0, triangles = 0;
    if (this.environment) {
      pass.setPipeline(this.environmentPipeline);
      pass.setBindGroup(1, this.environment.appearanceGroup);
      pass.setVertexBuffer(0, this.environment.vertex); pass.setIndexBuffer(this.environment.index, 'uint32');
      pass.setVertexBuffer(1, this.environment.coordinates);
      pass.drawIndexed(this.environment.indexCount);
      drawCalls++; triangles += this.environment.indexCount / 3;
    }
    if (this.instances.visible > 0) {
      pass.setBindGroup(1, this.instanceGroup);
      pass.setPipeline(this.shadowPipeline); pass.draw(6, this.instances.visible);
      drawCalls++; triangles += this.instances.visible * 2;
      pass.setPipeline(this.humanPipeline);
      for (let lod = 0; lod < 3; lod++) {
        const visible = this.instances.counts[lod];
        if (visible === 0) continue;
        const mesh = this.humans[lod];
        pass.setVertexBuffer(0, mesh.vertex); pass.setIndexBuffer(mesh.index, 'uint32');
        pass.drawIndexed(mesh.indexCount, visible, 0, 0, this.instances.offsets[lod]);
        drawCalls++; triangles += mesh.indexCount / 3 * visible;
      }
    }
    pass.end(); this.device.queue.submit([encoder.finish()]);
    return {
      visible: this.instances.visible,
      lodCounts: [...this.instances.counts], drawCalls, triangles,
      cpuMs: performance.now() - start,
      resolution: `${this.width} × ${this.height}`,
    };
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dead = true;
    this.scenarioRequest++;
    this.urbanMeshes.clear();
    this.camera.destroy(); this.instances.destroy(); this.sceneBuffer.destroy(); this.depth?.destroy();
    this.personIds?.destroy();
    this.releaseEnvironment();
    for (const mesh of this.humans) { mesh.vertex.destroy(); mesh.index.destroy(); }
    this.context.unconfigure(); this.device.destroy();
  }
}
