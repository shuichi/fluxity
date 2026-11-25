import { vec3 } from 'gl-matrix';
import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../renderer/Camera';

function cameraFixture() {
  const canvas = Object.assign(new EventTarget(), { setPointerCapture: vi.fn() });
  const pick = vi.fn();
  const camera = new Camera(canvas as unknown as HTMLCanvasElement, pick);
  const pointer = (type: string, x = 40, y = 30, options: Partial<PointerEventInit> = {}) => {
    canvas.dispatchEvent(Object.assign(new Event(type), {
      clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      ...options,
    }));
  };
  return { canvas, camera, pick, pointer };
}

describe('pedestrian viewpoint', () => {
  it('treats a primary tap with slight jitter as a selection and keeps the orbit steady', () => {
    const { camera, pick, pointer } = cameraFixture();
    const initialYaw = camera.yaw;
    pointer('pointerdown');
    pointer('pointermove', 42, 31);
    pointer('pointerup', 42, 31);
    expect(pick).toHaveBeenCalledExactlyOnceWith(42, 31);
    expect(camera.yaw).toBe(initialYaw);
  });

  it('does not select on a drag, a modified click, a canceled contact or a multi-touch gesture', () => {
    const { camera, pick, pointer } = cameraFixture();
    const initialYaw = camera.yaw;
    pointer('pointerdown');
    pointer('pointermove', 65);
    expect(camera.yaw).not.toBe(initialYaw);
    pointer('pointermove');
    pointer('pointerup');
    for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { button: 2 }]) {
      pointer('pointerdown', 40, 30, options);
      pointer('pointerup', 40, 30, options);
    }
    for (const cancel of ['pointercancel', 'lostpointercapture']) {
      pointer('pointerdown');
      pointer(cancel);
      pointer('pointerup');
    }
    pointer('pointerdown');
    pointer('pointerdown', 80, 30, { isPrimary: false, pointerId: 2 });
    pointer('pointerup', 80, 30, { isPrimary: false, pointerId: 2 });
    pointer('pointerup');
    expect(pick).not.toHaveBeenCalled();
  });

  it('follows eye position and heading while preserving the customized orbit exactly', () => {
    const { canvas, camera, pick, pointer } = cameraFixture();
    camera.setView('street');
    camera.yaw = -0.34;
    camera.elevation = 0.16;
    camera.distance = 17;
    vec3.set(camera.target, 5.2, 1.4, -8.7);
    camera.update(1.5);
    const originalView = Array.from(camera.viewProjection);
    const originalPosition = Array.from(camera.position);
    camera.update(1.5, { x: -1, z: 7, scale: 1.2, heading: Math.PI / 4, headYaw: Math.PI / 4 });
    expect(camera.position[0]).toBe(-1);
    expect(camera.position[1]).toBeCloseTo(1.65 * 1.2);
    expect(camera.position[2]).toBe(7);
    const ahead = vec3.transformMat4(vec3.create(), [2, camera.position[1], 7], camera.view);
    expect(ahead[0]).toBeCloseTo(0);
    expect(ahead[2]).toBeCloseTo(-3);
    camera.update(1.5, { x: 4, z: -2, scale: 1.2, heading: 0, headYaw: 0 });
    expect(camera.position[0]).toBe(4);
    expect(camera.position[2]).toBe(-2);
    const afterTurn = vec3.transformMat4(vec3.create(), [4, camera.position[1], 1], camera.view);
    expect(afterTurn[0]).toBeCloseTo(0);
    expect(afterTurn[2]).toBeCloseTo(-3);
    pointer('pointerdown');
    pointer('pointermove', 80, 50);
    pointer('pointerup', 80, 50);
    pointer('pointerdown', 40, 30, { shiftKey: true });
    pointer('pointermove', 80, 50, { shiftKey: true });
    pointer('pointerup', 80, 50, { shiftKey: true });
    pointer('pointerdown');
    pointer('pointerup');
    canvas.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: 100 }));
    camera.update(1.5);
    expect(Array.from(camera.viewProjection)).toEqual(originalView);
    expect(Array.from(camera.position)).toEqual(originalPosition);
    expect(pick).not.toHaveBeenCalled();
  });
});
