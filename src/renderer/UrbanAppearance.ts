const MAX_APPEARANCE_BYTES = 128 * 1024 * 1024;

/** Exact RGBA8 allocation across all mip levels, including non-square pages. */
export function urbanAppearanceBytes(width: number, height: number, layers: number): number {
  if (![width, height, layers].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid PLATEAU texture dimensions.');
  }
  let bytes = 0;
  for (;;) {
    bytes += width * height * layers * 4;
    if (width === 1 && height === 1) return bytes;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

const MIP_SHADER = `
@group(0) @binding(0) var page: texture_2d<f32>;
@group(0) @binding(1) var pageSampler: sampler;
struct Output {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Output {
  let corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let point = corners[index];
  var output: Output;
  output.position = vec4<f32>(point, 0.0, 1.0);
  output.uv = vec2<f32>((point.x + 1.0) * 0.5, (1.0 - point.y) * 0.5);
  return output;
}
@fragment fn fragmentMain(input: Output) -> @location(0) vec4<f32> {
  return textureSampleLevel(page, pageSampler, input.uv, 0.0);
}
`;

/** The caller owns/ closes decoded bitmaps. The returned GPU texture is caller-owned. */
export function createUrbanAppearance(
  device: GPUDevice,
  images: readonly ImageBitmap[],
  width: number,
  height: number,
): GPUTexture {
  const layers = Math.max(1, images.length);
  if (!images.length) { width = 1; height = 1; }
  const allocation = urbanAppearanceBytes(width, height, layers);
  if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D
    || layers > device.limits.maxTextureArrayLayers || allocation > MAX_APPEARANCE_BYTES) {
    throw new Error('PLATEAU photographs exceed the texture memory or GPU dimensions supported by this scene.');
  }
  for (const image of images) {
    if (image.width !== width || image.height !== height) {
      throw new Error('PLATEAU atlas dimensions do not match the map metadata.');
    }
  }
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  // The existing canvas and lighting operate on display-encoded RGB values.
  // Keep the photos in that same space; an -srgb view here would decode them
  // without a matching output encoding and make the photographs too dark.
  const texture = device.createTexture({
    label: images.length ? 'PLATEAU photographic atlases' : 'Untextured environment fallback',
    size: [width, height, layers], dimension: '2d', format: 'rgba8unorm', mipLevelCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  try {
    if (!images.length) {
      device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
      return texture;
    }
    for (let layer = 0; layer < images.length; layer++) {
      // UVs have already been converted to top-left image coordinates offline.
      device.queue.copyExternalImageToTexture(
        { source: images[layer], flipY: false },
        { texture, mipLevel: 0, origin: [0, 0, layer], colorSpace: 'srgb', premultipliedAlpha: false },
        [width, height, 1],
      );
    }
    if (mipLevelCount === 1) return texture;
    const module = device.createShaderModule({ label: 'Photographic atlas mip generation', code: MIP_SHADER });
    const pipeline = device.createRenderPipeline({
      label: 'Photographic atlas downsampling', layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const encoder = device.createCommandEncoder({ label: 'Build photographic atlas mipmaps' });
    for (let layer = 0; layer < layers; layer++) {
      for (let mip = 1; mip < mipLevelCount; mip++) {
        const source = texture.createView({ dimension: '2d', baseMipLevel: mip - 1, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const destination = texture.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: source }, { binding: 1, resource: sampler },
        ] });
        const pass = encoder.beginRenderPass({
          label: `Atlas ${layer} mip ${mip}`,
          colorAttachments: [{ view: destination, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
        });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      }
    }
    device.queue.submit([encoder.finish()]);
    return texture;
  } catch (error) {
    texture.destroy();
    throw error;
  }
}
