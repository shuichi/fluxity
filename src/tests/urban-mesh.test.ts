import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UrbanMap } from '../types';
import { decodeUrbanMesh, mergeEnvironmentMeshes, UrbanMeshLoader, urbanAssetURL } from '../renderer/UrbanMesh';
import { WebGPURenderer } from '../renderer/WebGPURenderer';
import { plaza } from '../scenarios/plaza';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import shibuyaMap from '../scenarios/data/shibuya-map.json';
import { createEnvironment } from '../renderer/Environment';

const sha256 = (buffer: ArrayBuffer): string => createHash('sha256').update(new Uint8Array(buffer)).digest('hex');

function fixture(): { map: UrbanMap; vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const vertices = new Float32Array([
    0,0,0, 0,1,0, 0.7,0.7,0.7,4,
    0,0,1, 0,1,0, 0.7,0.7,0.7,4,
    1,0,0, 0,1,0, 0.7,0.7,0.7,4,
  ]);
  const indices = new Uint32Array([0,1,2]);
  return {
    map: {
      schemaVersion: 1, origin: { latitude: 35.6595, longitude: 139.7005, crs: 'EPSG:6677' },
      renderBounds: { minX: -250, maxX: 250, minZ: -250, maxZ: 250 },
      sidewalks: [], walkable: [], roads: [], buildingFootprints: [],
      mesh: {
        vertices: 'data/shibuya/vertices.bin', indices: 'data/shibuya/indices.bin', vertexCount: 3, indexCount: 3,
        vertexSha256: sha256(vertices.buffer), indexSha256: sha256(indices.buffer),
      },
      statistics: { buildings: 1, lod2Buildings: 1, lod1Buildings: 0, triangles: 1 },
    },
    vertices, indices,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('PLATEAU static mesh loading', () => {
  it('loads the checked-in city asset with the exact metadata used by the simulation', () => {
    const read = (path: string): ArrayBuffer => {
      const buffer = readFileSync(resolve('public', path));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    };
    const vertexBytes = read(shibuyaMap.mesh.vertices), indexBytes = read(shibuyaMap.mesh.indices);
    expect(sha256(vertexBytes)).toBe(shibuyaMap.mesh.vertexSha256);
    expect(sha256(indexBytes)).toBe(shibuyaMap.mesh.indexSha256);
    const mesh = decodeUrbanMesh(shibuyaMap, vertexBytes, indexBytes);
    expect(mesh.indices.length / 3).toBe(shibuyaMap.statistics.triangles);
    expect(shibuyaMap.statistics.lod2Buildings).toBeGreaterThan(0);
    expect(shibuyaMap.statistics.buildings).toBe(shibuyaMap.statistics.lod2Buildings + shibuyaMap.statistics.lod1Buildings);
  });

  it('resolves same-origin assets under GitHub Pages and rejects escaping paths', () => {
    expect(urbanAssetURL('data/shibuya/vertices.bin', 'https://example.com/fluxity/', './'))
      .toBe('https://example.com/fluxity/data/shibuya/vertices.bin');
    expect(urbanAssetURL('data/shibuya/vertices.bin', 'https://example.com/fluxity/index.html?x=1', '/fluxity/'))
      .toBe('https://example.com/fluxity/data/shibuya/vertices.bin');
    expect(() => urbanAssetURL('https://elsewhere.example/data.bin', 'https://example.com/', './')).toThrow('asset path');
    expect(() => urbanAssetURL('data/../../secret', 'https://example.com/', './')).toThrow('asset path');
  });

  it('rejects truncated buffers, invalid geometry and mismatched index ranges before GPU upload', () => {
    const { map, vertices, indices } = fixture();
    expect(decodeUrbanMesh(map, vertices.buffer, indices.buffer).vertices).toEqual(vertices);
    expect(() => decodeUrbanMesh(map, vertices.buffer.slice(4), indices.buffer)).toThrow('incomplete');
    indices[2] = 3;
    expect(() => decodeUrbanMesh(map, vertices.buffer, indices.buffer)).toThrow('out-of-range');
    indices[2] = 2; vertices[0] = NaN;
    expect(() => decodeUrbanMesh(map, vertices.buffer, indices.buffer)).toThrow('non-finite');
    vertices[0] = 0; vertices[4] = 0;
    expect(() => decodeUrbanMesh(map, vertices.buffer, indices.buffer)).toThrow('surface normal');
  });

  it('shares in-flight and decoded assets and retries failed requests', async () => {
    const { map, vertices, indices } = fixture();
    vi.stubGlobal('document', { baseURI: 'https://example.com/fluxity/' });
    const fetcher = vi.fn(async (url: string) => new Response(url.endsWith('vertices.bin') ? vertices.buffer : indices.buffer));
    vi.stubGlobal('fetch', fetcher);
    const loader = new UrbanMeshLoader();
    const first = loader.load(map), second = loader.load(map);
    expect(first).toBe(second);
    const result = await first;
    expect(await loader.load(map)).toBe(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
    loader.clear();
    fetcher.mockImplementationOnce(async () => new Response('missing', { status: 404 }));
    await expect(loader.load(map)).rejects.toThrow('404');
    expect((await loader.load(map)).indices).toEqual(indices);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('rejects same-size geometry from a different deployment before decoding', async () => {
    const { map, vertices, indices } = fixture();
    vi.stubGlobal('document', { baseURI: 'https://example.com/fluxity/' });
    vertices[0] = 10; // Same counts and valid geometry, different world coordinates.
    const fetcher = vi.fn(async (url: string) => new Response(url.endsWith('vertices.bin') ? vertices.buffer : indices.buffer));
    vi.stubGlobal('fetch', fetcher);
    const loader = new UrbanMeshLoader();
    await expect(loader.load(map)).rejects.toThrow('different versions');
    vertices[0] = 0;
    await expect(loader.load(map)).resolves.toMatchObject({ vertices, indices });
    expect(fetcher).toHaveBeenCalledTimes(4); // A rejected version never poisons the cache.
    loader.clear();
    indices[2] = 1; // In-range indices of the same size are also content-checked.
    await expect(loader.load(map)).rejects.toThrow('different versions');
  });

  it('keys cached mesh data by both content hashes when coordinates change without new counts', async () => {
    const { map, vertices, indices } = fixture();
    vi.stubGlobal('document', { baseURI: 'https://example.com/fluxity/' });
    const fetcher = vi.fn(async (url: string) => new Response(url.endsWith('vertices.bin') ? vertices.buffer : indices.buffer));
    vi.stubGlobal('fetch', fetcher);
    const loader = new UrbanMeshLoader();
    const first = await loader.load(map);
    vertices[0] = 10;
    const updated = { ...map, mesh: { ...map.mesh, vertexSha256: sha256(vertices.buffer) } };
    const second = await loader.load(updated);
    expect(second).not.toBe(first);
    expect(second.vertices[0]).toBe(10);
    expect(first.vertices[0]).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(loader.load({ ...map, mesh: { ...map.mesh, indexSha256: '' } })).rejects.toThrow('content hashes');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('merges fixtures without mutating cached city geometry or leaving local indices unshifted', () => {
    const { vertices, indices } = fixture();
    const result = mergeEnvironmentMeshes({ vertices, indices }, { vertices, indices });
    expect(result.vertices.length).toBe(60);
    expect(Array.from(result.indices)).toEqual([0,1,2,3,4,5]);
    expect(Array.from(indices)).toEqual([0,1,2]);
    expect(result.vertices.buffer).not.toBe(vertices.buffer);
  });

  it('adds only signal fixtures to mapped scenery and honors an explicit facing direction', () => {
    const { map } = fixture();
    const mesh = createEnvironment({
      ...syntheticShibuya, urbanMap: map,
      scramble: { roadHalfWidth: 0, crosswalks: [], signalPositions: [{ x: 0, z: 0, direction: { x: 1, z: 0 } }] },
    });
    const materials = new Set<number>();
    for (let offset = 0; offset < mesh.vertices.length; offset += 10) {
      materials.add(mesh.vertices[offset + 9]);
      expect(Math.hypot(mesh.vertices[offset + 3], mesh.vertices[offset + 4], mesh.vertices[offset + 5])).toBeCloseTo(1);
      expect(Math.hypot(mesh.vertices[offset], mesh.vertices[offset + 2])).toBeLessThan(1);
    }
    expect(materials).toEqual(new Set([0,-1,-2]));
  });
});

async function gpuHarness() {
  const buffers: { destroy: ReturnType<typeof vi.fn> }[] = [];
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  const limits = { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024, maxStorageBuffersPerShaderStage: 8 };
  const device = Object.assign(new EventTarget(), {
    limits, lost: new Promise(() => {}), destroy: vi.fn(),
    createBuffer: vi.fn(({ size }: { size: number }) => {
      const buffer = { getMappedRange: () => new ArrayBuffer(size), unmap: vi.fn(), destroy: vi.fn() };
      buffers.push(buffer); return buffer;
    }),
    createBindGroupLayout: () => ({}), createBindGroup: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    pushErrorScope: vi.fn(), popErrorScope: async () => null, createRenderPipelineAsync: async () => ({}),
  });
  vi.stubGlobal('GPUBufferUsage', { VERTEX: 1, INDEX: 2, UNIFORM: 4, COPY_DST: 8, STORAGE: 16 });
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('document', { baseURI: 'https://example.com/fluxity/' });
  vi.stubGlobal('navigator', { gpu: {
    requestAdapter: async () => ({ limits, features: new Set(), requestDevice: async () => device }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  } });
  const canvas = Object.assign(new EventTarget(), { getContext: () => context });
  return { renderer: await WebGPURenderer.create(canvas as unknown as HTMLCanvasElement), buffers, device };
}

describe('scenery GPU lifetime', () => {
  it('never uploads a late map over a newer scene and destroys all allocated buffers exactly once', async () => {
    const { map, vertices, indices } = fixture();
    const { renderer, buffers } = await gpuHarness();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', async (url: string) => {
      await pending;
      return new Response(url.endsWith('vertices.bin') ? vertices.buffer : indices.buffer);
    });
    const loading = renderer.setScenario({ ...syntheticShibuya, urbanMap: map });
    renderer.setScenario(plaza);
    const allocated = buffers.length, distance = renderer.camera.distance;
    release();
    await loading;
    expect(buffers).toHaveLength(allocated);
    expect(renderer.camera.distance).toBe(distance);
    renderer.destroy(); renderer.destroy();
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it('does not allocate GPU resources after destruction during a map download', async () => {
    const { map, vertices, indices } = fixture();
    const { renderer, buffers, device } = await gpuHarness();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', async (url: string) => {
      await pending;
      return new Response(url.endsWith('vertices.bin') ? vertices.buffer : indices.buffer);
    });
    const loading = renderer.setScenario({ ...syntheticShibuya, urbanMap: map });
    renderer.destroy();
    const allocated = buffers.length;
    release();
    await loading;
    expect(buffers).toHaveLength(allocated);
    expect(device.destroy).toHaveBeenCalledOnce();
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
