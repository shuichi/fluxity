import type { UrbanMap } from '../types';

export interface EnvironmentMeshData {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

const VERTEX_BYTES = 40;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;

/** Public assets must resolve beneath Vite's base, including a GitHub Pages subpath. */
export function urbanAssetURL(path: string, documentURL = document.baseURI, base = import.meta.env.BASE_URL): string {
  if (!/^data\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) {
    throw new Error('Invalid urban mesh asset path.');
  }
  return new URL(path, new URL(base, documentURL)).href;
}

export function decodeUrbanMesh(map: UrbanMap, vertexBuffer: ArrayBuffer, indexBuffer: ArrayBuffer): EnvironmentMeshData {
  if (map.schemaVersion !== 1) throw new Error('Unsupported urban map format.');
  const { vertexCount, indexCount } = map.mesh;
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 3
    || !Number.isSafeInteger(indexCount) || indexCount < 3 || indexCount % 3 !== 0
    || vertexCount * VERTEX_BYTES + indexCount * 4 > MAX_ASSET_BYTES) {
    throw new Error('Invalid urban mesh dimensions.');
  }
  if (vertexBuffer.byteLength !== vertexCount * VERTEX_BYTES || indexBuffer.byteLength !== indexCount * 4) {
    throw new Error('Urban mesh is incomplete or does not match its map metadata. Reload after updating the data files.');
  }
  const vertices = new Float32Array(vertexBuffer), indices = new Uint32Array(indexBuffer);
  for (let offset = 0; offset < vertices.length; offset += 10) {
    for (let component = 0; component < 10; component++) {
      if (!Number.isFinite(vertices[offset + component])) throw new Error('Urban mesh contains a non-finite vertex.');
    }
    const normalLength = Math.hypot(vertices[offset + 3], vertices[offset + 4], vertices[offset + 5]);
    if (normalLength < 0.99 || normalLength > 1.01) throw new Error('Urban mesh contains an invalid surface normal.');
  }
  for (const index of indices) if (index >= vertexCount) throw new Error('Urban mesh contains an out-of-range index.');
  return { vertices, indices };
}

/** Retains only decoded CPU assets; switching scenarios never shares GPU buffers. */
export class UrbanMeshLoader {
  private readonly cache = new Map<string, Promise<EnvironmentMeshData>>();

  load(map: UrbanMap): Promise<EnvironmentMeshData> {
    if (map.schemaVersion !== 1) return Promise.reject(new Error('Unsupported urban map format.'));
    const { vertexSha256, indexSha256 } = map.mesh;
    if (!/^[a-f0-9]{64}$/.test(vertexSha256) || !/^[a-f0-9]{64}$/.test(indexSha256)) {
      return Promise.reject(new Error('Urban map is missing valid geometry content hashes. Rebuild the data files.'));
    }
    const vertexURL = urbanAssetURL(map.mesh.vertices), indexURL = urbanAssetURL(map.mesh.indices);
    const key = `${vertexURL}:${indexURL}:${map.mesh.vertexCount}:${map.mesh.indexCount}:${vertexSha256}:${indexSha256}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const expectedVertexBytes = map.mesh.vertexCount * VERTEX_BYTES, expectedIndexBytes = map.mesh.indexCount * 4;
    if (!Number.isSafeInteger(expectedVertexBytes) || expectedVertexBytes < VERTEX_BYTES * 3
      || !Number.isSafeInteger(expectedIndexBytes) || expectedIndexBytes < 12
      || expectedVertexBytes + expectedIndexBytes > MAX_ASSET_BYTES) {
      return Promise.reject(new Error('Invalid urban mesh dimensions.'));
    }
    const read = async (url: string, expectedBytes: number, expectedHash: string): Promise<ArrayBuffer> => {
      // Binary filenames are stable across data rebuilds; revalidate a previous deployment.
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Could not load PLATEAU scenery (${response.status}). Check the data files and reload.`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== expectedBytes) throw new Error('Urban mesh is incomplete or does not match its map metadata.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== expectedHash) {
        throw new Error('PLATEAU scenery and the pedestrian map are different versions. Reload after updating the data files.');
      }
      return buffer;
    };
    const pending = Promise.all([read(vertexURL, expectedVertexBytes, vertexSha256), read(indexURL, expectedIndexBytes, indexSha256)])
      .then(([vertices, indices]) => decodeUrbanMesh(map, vertices, indices))
      .catch((error: unknown) => { this.cache.delete(key); throw error; });
    this.cache.set(key, pending);
    return pending;
  }

  clear(): void { this.cache.clear(); }
}

export function mergeEnvironmentMeshes(first: EnvironmentMeshData, second: EnvironmentMeshData): EnvironmentMeshData {
  const vertices = new Float32Array(first.vertices.length + second.vertices.length);
  vertices.set(first.vertices); vertices.set(second.vertices, first.vertices.length);
  const indices = new Uint32Array(first.indices.length + second.indices.length);
  indices.set(first.indices);
  const vertexOffset = first.vertices.length / 10;
  for (let i = 0; i < second.indices.length; i++) indices[first.indices.length + i] = second.indices[i] + vertexOffset;
  return { vertices, indices };
}
