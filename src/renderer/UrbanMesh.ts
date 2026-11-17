import type { UrbanMap } from '../types';

export interface EnvironmentMeshData {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  appearance?: {
    coordinates: Float32Array<ArrayBuffer>;
    width: number;
    height: number;
    /** Compressed images are cached; decoded ImageBitmaps are renderer-owned and closed after upload. */
    atlases: Blob[];
  };
}

const VERTEX_BYTES = 40;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_ATLAS_FILE_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export function untexturedCoordinates(vertexCount: number): Float32Array<ArrayBuffer> {
  const coordinates = new Float32Array(vertexCount * 3);
  for (let offset = 2; offset < coordinates.length; offset += 3) coordinates[offset] = -1;
  return coordinates;
}

function validateAppearance(map: UrbanMap): void {
  const appearance = map.appearance;
  if (!appearance) return;
  const { width, height, atlases } = appearance;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 8192 || height > 8192 || atlases.length < 1 || atlases.length > 16
    || width * height * 4 * atlases.length * 4 / 3 > MAX_ASSET_BYTES) {
    throw new Error('Photographic scenery exceeds the texture memory budget.');
  }
  if (!HASH.test(appearance.coordinateSha256) || atlases.some(atlas => !HASH.test(atlas.sha256))) {
    throw new Error('Photographic scenery is missing valid content hashes.');
  }
}

export function decodeAppearanceCoordinates(map: UrbanMap, buffer: ArrayBuffer, indices: Uint32Array): Float32Array<ArrayBuffer> {
  validateAppearance(map);
  if (!map.appearance || buffer.byteLength !== map.mesh.vertexCount * 12) {
    throw new Error('Photographic coordinates are incomplete or do not match the scenery.');
  }
  const coordinates = new Float32Array(buffer), pages = map.appearance.atlases.length;
  for (let offset = 0; offset < coordinates.length; offset += 3) {
    const u = coordinates[offset], v = coordinates[offset + 1], page = coordinates[offset + 2];
    if (!Number.isFinite(u + v) || u < 0 || u > 1 || v < 0 || v > 1
      || !Number.isInteger(page) || page < -1 || page >= pages) {
      throw new Error('Photographic scenery contains invalid UV coordinates or atlas pages.');
    }
  }
  // The shader uses a flat page index; a triangle must never span different atlas layers.
  for (let offset = 0; offset < indices.length; offset += 3) {
    const page = coordinates[indices[offset] * 3 + 2];
    if (page !== coordinates[indices[offset + 1] * 3 + 2] || page !== coordinates[indices[offset + 2] * 3 + 2]) {
      throw new Error('Photographic scenery assigns different atlas pages to one triangle.');
    }
  }
  return coordinates;
}

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
    if (!HASH.test(vertexSha256) || !HASH.test(indexSha256)) {
      return Promise.reject(new Error('Urban map is missing valid geometry content hashes. Rebuild the data files.'));
    }
    try { validateAppearance(map); } catch (error) { return Promise.reject(error); }
    const vertexURL = urbanAssetURL(map.mesh.vertices), indexURL = urbanAssetURL(map.mesh.indices);
    const key = `${vertexURL}:${indexURL}:${map.mesh.vertexCount}:${map.mesh.indexCount}:${vertexSha256}:${indexSha256}:${JSON.stringify(map.appearance)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const expectedVertexBytes = map.mesh.vertexCount * VERTEX_BYTES, expectedIndexBytes = map.mesh.indexCount * 4;
    if (!Number.isSafeInteger(expectedVertexBytes) || expectedVertexBytes < VERTEX_BYTES * 3
      || !Number.isSafeInteger(expectedIndexBytes) || expectedIndexBytes < 12
      || expectedVertexBytes + expectedIndexBytes > MAX_ASSET_BYTES) {
      return Promise.reject(new Error('Invalid urban mesh dimensions.'));
    }
    const read = async (url: string, expectedBytes: number | undefined, expectedHash: string): Promise<ArrayBuffer> => {
      // Binary filenames are stable across data rebuilds; revalidate a previous deployment.
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Could not load PLATEAU scenery (${response.status}). Check the data files and reload.`);
      const buffer = await response.arrayBuffer();
      if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) throw new Error('Urban mesh is incomplete or does not match its map metadata.');
      if (expectedBytes === undefined && (buffer.byteLength === 0 || buffer.byteLength > MAX_ATLAS_FILE_BYTES)) {
        throw new Error('Photographic atlas has an invalid file size.');
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== expectedHash) {
        throw new Error('PLATEAU scenery and the pedestrian map are different versions. Reload after updating the data files.');
      }
      return buffer;
    };
    const appearance = map.appearance;
    const files = [read(vertexURL, expectedVertexBytes, vertexSha256), read(indexURL, expectedIndexBytes, indexSha256)];
    if (appearance) {
      files.push(read(urbanAssetURL(appearance.coordinates), map.mesh.vertexCount * 12, appearance.coordinateSha256));
      for (const atlas of appearance.atlases) files.push(read(urbanAssetURL(atlas.path), undefined, atlas.sha256));
    }
    const pending = Promise.all(files)
      .then(([vertices, indices, coordinates, ...atlases]) => {
        const result = decodeUrbanMesh(map, vertices, indices);
        if (appearance) result.appearance = {
          coordinates: decodeAppearanceCoordinates(map, coordinates, result.indices),
          width: appearance.width, height: appearance.height,
          atlases: atlases.map(buffer => new Blob([buffer])),
        };
        return result;
      })
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
  if (first.appearance && second.appearance) throw new Error('Cannot merge independently packed photographic atlases.');
  const source = first.appearance ?? second.appearance;
  if (!source) return { vertices, indices };
  const coordinates = untexturedCoordinates(vertices.length / 10);
  if (first.appearance) coordinates.set(first.appearance.coordinates);
  if (second.appearance) coordinates.set(second.appearance.coordinates, vertexOffset * 3);
  return { vertices, indices, appearance: { ...source, coordinates } };
}
