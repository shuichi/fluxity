import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUrbanAppearance, urbanAppearanceBytes } from '../renderer/UrbanAppearance';

function harness() {
  const views: GPUTextureViewDescriptor[] = [];
  const texture = { createView: vi.fn((descriptor: GPUTextureViewDescriptor) => { views.push(descriptor); return { descriptor }; }), destroy: vi.fn() };
  const passes: { draw: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
  const encoder = {
    beginRenderPass: vi.fn(() => { const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }; passes.push(pass); return pass; }),
    finish: vi.fn(() => ({})),
  };
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
    createTexture: vi.fn(() => texture),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})), createCommandEncoder: vi.fn(() => encoder),
    queue: { writeTexture: vi.fn(), copyExternalImageToTexture: vi.fn(), submit: vi.fn() },
  };
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
  return { device, texture, views, passes, encoder };
}
const bitmap = (width: number, height: number): ImageBitmap => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
afterEach(() => vi.unstubAllGlobals());

describe('PLATEAU atlas GPU upload', () => {
  it('uploads top-left image data and renders every mip independently for each array layer', () => {
    const { device, texture, views, passes } = harness();
    const images = [bitmap(8, 4), bitmap(8, 4)];
    expect(urbanAppearanceBytes(8, 4, 2)).toBe(344);
    expect(createUrbanAppearance(device as unknown as GPUDevice, images, 8, 4)).toBe(texture);
    expect(device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: [8, 4, 2], mipLevelCount: 4, format: 'rgba8unorm' }));
    expect(device.queue.copyExternalImageToTexture).toHaveBeenNthCalledWith(2,
      { source: images[1], flipY: false },
      expect.objectContaining({ origin: [0, 0, 1], colorSpace: 'srgb', premultipliedAlpha: false }), [8, 4, 1]);
    expect(passes).toHaveLength(6);
    for (let i = 0; i < views.length; i += 2) {
      expect(views[i].baseArrayLayer).toBe(views[i + 1].baseArrayLayer);
      expect(views[i + 1].baseMipLevel).toBe(views[i].baseMipLevel! + 1);
      expect(views[i].mipLevelCount).toBe(1);
      expect(views[i].arrayLayerCount).toBe(1);
    }
    for (const pass of passes) { expect(pass.draw).toHaveBeenCalledWith(3); expect(pass.end).toHaveBeenCalledOnce(); }
    expect(device.queue.submit).toHaveBeenCalledOnce();
    for (const image of images) expect(image.close).not.toHaveBeenCalled();
    expect(texture.destroy).not.toHaveBeenCalled();
  });

  it('uses a single white texel for an untextured scene without constructing a mip pipeline', () => {
    const { device, texture } = harness();
    createUrbanAppearance(device as unknown as GPUDevice, [], 0, 0);
    expect(device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: [1, 1, 1], mipLevelCount: 1 }));
    expect(device.queue.writeTexture).toHaveBeenCalledWith({ texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
  });

  it('rejects image mismatch, invalid dimensions and excessive GPU allocation before allocating', () => {
    const { device } = harness();
    const gpu = device as unknown as GPUDevice;
    expect(() => createUrbanAppearance(gpu, [bitmap(2048, 2048)], 1024, 1024)).toThrow('dimensions do not match');
    expect(() => createUrbanAppearance(gpu, [bitmap(1, 1)], 0, 1)).toThrow('Invalid');
    expect(() => createUrbanAppearance(gpu, [bitmap(16384, 1)], 16384, 1)).toThrow('memory or GPU');
    expect(() => createUrbanAppearance(gpu, Array.from({ length: 257 }, () => bitmap(1, 1)), 1, 1)).toThrow('memory or GPU');
    expect(() => createUrbanAppearance(gpu, [bitmap(8192, 8192)], 8192, 8192)).toThrow('memory or GPU');
    expect(device.createTexture).not.toHaveBeenCalled();
  });

  it('releases its texture when image upload or mip encoding throws', () => {
    const first = harness();
    first.device.queue.copyExternalImageToTexture.mockImplementation(() => { throw new Error('closed bitmap'); });
    expect(() => createUrbanAppearance(first.device as unknown as GPUDevice, [bitmap(2, 2)], 2, 2)).toThrow('closed bitmap');
    expect(first.texture.destroy).toHaveBeenCalledOnce();
    const second = harness();
    second.device.createBindGroup.mockImplementation(() => { throw new Error('encoding failed'); });
    expect(() => createUrbanAppearance(second.device as unknown as GPUDevice, [bitmap(2, 2)], 2, 2)).toThrow('encoding failed');
    expect(second.texture.destroy).toHaveBeenCalledOnce();
    expect(second.device.queue.submit).not.toHaveBeenCalled();
  });
});
