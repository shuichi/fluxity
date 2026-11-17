import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGPURenderer } from '../renderer/WebGPURenderer';

describe('WebGPU initialization failures', () => {
  const getContext = vi.fn();
  const canvas = { getContext } as unknown as HTMLCanvasElement;
  const sufficientLimits = {
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxBufferSize: 256 * 1024 * 1024,
    maxStorageBuffersPerShaderStage: 8,
  };

  beforeEach(() => {
    getContext.mockClear();
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {});
  });

  afterEach(() => {
    // None of these unsupported environments should attempt a canvas or WebGL fallback.
    expect(getContext).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('explains the secure-context requirement before accessing an adapter', async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    await expect(WebGPURenderer.create(canvas)).rejects.toThrow('localhost or HTTPS');
  });

  it('recommends a supported browser when navigator.gpu is absent', async () => {
    await expect(WebGPURenderer.create(canvas)).rejects.toThrow('current desktop Chrome or Edge');
  });

  it('explains a missing adapter without requesting a device', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    await expect(WebGPURenderer.create(canvas)).rejects.toThrow('No WebGPU adapter is available');
    expect(requestAdapter).toHaveBeenCalledOnce();
  });

  it.each([
    ['maxStorageBufferBindingSize', 1024],
    ['maxBufferSize', 1024],
    ['maxStorageBuffersPerShaderStage', 0],
  ])('rejects insufficient adapter %s before requesting a device', async (limit, value) => {
    const requestDevice = vi.fn();
    vi.stubGlobal('navigator', { gpu: {
      requestAdapter: vi.fn().mockResolvedValue({
        limits: { ...sufficientLimits, [limit]: value }, requestDevice,
      }),
    } });
    await expect(WebGPURenderer.create(canvas)).rejects.toThrow('instance buffer required for 20,000 people');
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('propagates the browser diagnostic when requesting a device fails', async () => {
    const requestDevice = vi.fn().mockRejectedValue(new Error('Device creation denied by the graphics driver'));
    vi.stubGlobal('navigator', { gpu: {
      requestAdapter: vi.fn().mockResolvedValue({ limits: sufficientLimits, requestDevice }),
    } });
    await expect(WebGPURenderer.create(canvas)).rejects.toThrow('Device creation denied by the graphics driver');
    expect(requestDevice).toHaveBeenCalledOnce();
  });

  it('cleans up a returned device whose effective limits are insufficient', async () => {
    const destroy = vi.fn();
    vi.stubGlobal('navigator', { gpu: {
      requestAdapter: vi.fn().mockResolvedValue({
        limits: sufficientLimits,
        requestDevice: vi.fn().mockResolvedValue({ limits: { ...sufficientLimits, maxBufferSize: 1024 }, destroy }),
      }),
    } });
    await expect(WebGPURenderer.create(canvas)).rejects.toThrow('GPU device has insufficient buffer limits');
    expect(destroy).toHaveBeenCalledOnce();
  });
});
