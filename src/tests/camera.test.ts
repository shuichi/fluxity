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
    const person = { x: -1, z: 7, scale: 1.2, heading: Math.PI / 2, headYaw: Math.PI / 4 };
    camera.update(1.5, 0, person);
    expect(camera.position[0]).toBe(-1);
    expect(camera.position[1]).toBeCloseTo(1.535 * 1.2);
    expect(camera.position[2]).toBe(7);
    const ahead = vec3.transformMat4(vec3.create(), [2, camera.position[1], 7], camera.view);
    expect(ahead[0]).toBeCloseTo(0);
    expect(ahead[2]).toBeCloseTo(-3);
    const firstPersonView = Array.from(camera.viewProjection);
    camera.update(1.5, 1 / 60, { ...person, headYaw: -Math.PI / 4 });
    expect(Array.from(camera.viewProjection)).toEqual(firstPersonView);
    camera.update(1.5, 1 / 60, { ...person, x: 4, z: -2 });
    expect(camera.position[0]).toBe(4);
    expect(camera.position[2]).toBe(-2);
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

  it('eases toward body turns over the shortest arc at different render rates', () => {
    const headingAfterTurn = (fps: number) => {
      const { camera } = cameraFixture();
      const person = { x: 0, z: 0, scale: 1, heading: Math.PI - 0.1, headYaw: 0 };
      camera.update(1.5, 0, person);
      person.heading = -Math.PI + 0.1;
      for (let frame = 0; frame < fps / 2; frame++) camera.update(1.5, 1 / fps, person);
      return Math.atan2(-camera.view[2], -camera.view[10]);
    };
    const heading = headingAfterTurn(30);
    expect(heading).toBeGreaterThan(-Math.PI);
    expect(heading).toBeLessThan(-Math.PI + 0.1);
    expect(headingAfterTurn(60)).toBeCloseTo(heading, 5);
  });

  it('projects gaze relative to the camera at each aspect ratio and pins off-screen glances to their side', () => {
    const { camera } = cameraFixture();
    const person = { x: 3, z: -7, scale: 1, heading: 0.7, headYaw: 0 };
    camera.update(1, 0, person);
    expect(camera.gazeScreenX).toBeCloseTo(0);
    person.headYaw = 0.15;
    camera.update(1, 1 / 60, person);
    const squareX = camera.gazeScreenX;
    expect(squareX).toBeLessThan(0);
    const gaze = person.heading + person.headYaw;
    const point = vec3.transformMat4(vec3.create(),
      [person.x + Math.sin(gaze), camera.position[1], person.z + Math.cos(gaze)], camera.viewProjection);
    expect(squareX).toBeCloseTo(point[0], 5);
    camera.update(2, 1 / 60, person);
    expect(camera.gazeScreenX).toBeCloseTo(squareX / 2);
    person.headYaw *= -1;
    camera.update(2, 1 / 60, person);
    expect(camera.gazeScreenX).toBeCloseTo(-squareX / 2);
    for (const yaw of [0.9, -0.9, 2.5, -2.5]) {
      camera.update(1, 1 / 60, { ...person, headYaw: yaw });
      expect(camera.gazeScreenX).toBe(-Math.sign(yaw));
    }
  });

  it('limits a sudden body turn and starts each newly selected view facing its own pedestrian', () => {
    const { camera } = cameraFixture();
    const person = { x: 0, z: 0, scale: 1, heading: 0, headYaw: 0 };
    camera.update(1.5, 0, person);
    person.heading = Math.PI / 2;
    camera.update(1.5, 0.05, person);
    const heading = Math.atan2(-camera.view[2], -camera.view[10]);
    expect(heading).toBeCloseTo(Math.PI / 2 * 0.05);
    expect(camera.gazeScreenX).toBe(-1);
    camera.update(1.5);
    camera.update(1.5, 0, person);
    expect(Math.atan2(-camera.view[2], -camera.view[10])).toBeCloseTo(person.heading);
    expect(camera.gazeScreenX).toBeCloseTo(0);
  });

  it('holds the view and gaze marker mid-turn while paused and resumes from the same heading', () => {
    const { camera } = cameraFixture();
    const person = { x: 0, z: 0, scale: 1, heading: 0, headYaw: 0 };
    camera.update(1.5, 0, person);
    person.heading = 0.25;
    camera.update(1.5, 1 / 60, person);
    const view = Array.from(camera.viewProjection);
    const gazeX = camera.gazeScreenX;
    camera.update(1.5, 0, person);
    expect(Array.from(camera.viewProjection)).toEqual(view);
    expect(camera.gazeScreenX).toBe(gazeX);
    camera.update(1.5, 1 / 60, person);
    expect(camera.gazeScreenX).toBeGreaterThan(gazeX);
    expect(camera.gazeScreenX).toBeLessThan(0);
  });
});
