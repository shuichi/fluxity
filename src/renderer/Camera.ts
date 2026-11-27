import { mat4, vec3 } from 'gl-matrix';
import { clamp } from '../math/geometry';
import { HUMAN_EYE_HEIGHT } from './HumanAnimation';
import type { Bounds, CameraView } from '../types';

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  pan: boolean;
  moved: boolean;
  canPick: boolean;
}

export interface PersonPose {
  x: number;
  z: number;
  heading: number;
  headYaw: number;
  scale: number;
  eyeHeight?: number;
}

export const STREET_NEAR_PLANE = 0.15;
const CLICK_SLOP = 4; // CSS pixels, independent of render resolution.
const modified = (event: PointerEvent) => event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;

export class Camera {
  readonly viewProjection = mat4.create();
  readonly view = mat4.create();
  readonly projection = mat4.create();
  readonly position = vec3.create();
  readonly target = vec3.fromValues(0, 0, 0);
  readonly fov = 42 * Math.PI / 180;
  distance = 185;
  yaw = 0.62;
  elevation = 0.73;
  private extent = 180;
  private scramble = false;
  private urban = false;
  private centerX = 0;
  private centerZ = 0;
  private drag: Drag | null = null;
  private firstPerson = false;
  private readonly gaze = vec3.create();
  private readonly events = new AbortController();

  constructor(canvas: HTMLCanvasElement, onPersonClick?: (clientX: number, clientY: number) => void) {
    const signal = this.events.signal;
    canvas.addEventListener('pointerdown', (event) => {
      if (this.firstPerson) return;
      if (!event.isPrimary || this.drag) {
        this.drag = null;
        return;
      }
      this.drag = {
        pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        x: event.clientX, y: event.clientY, pan: event.button === 2 || event.shiftKey,
        moved: false, canPick: event.button === 0 && !modified(event),
      };
      canvas.setPointerCapture(event.pointerId);
    }, { signal });
    canvas.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (event.buttons !== 1 || modified(event)) drag.canPick = false;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= CLICK_SLOP) return;
      drag.moved = true;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.x = event.clientX; drag.y = event.clientY;
      if (drag.pan) {
        const scale = this.distance * 0.0012;
        this.target[0] += (-Math.cos(this.yaw) * dx + Math.sin(this.yaw) * dy) * scale;
        this.target[2] += (Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dy) * scale;
      } else {
        this.yaw -= dx * 0.005;
        this.elevation = clamp(this.elevation + dy * 0.004, 0.04, 1.53);
      }
    }, { signal });
    canvas.addEventListener('pointerup', event => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.drag = null;
      if (drag.canPick && !drag.moved && event.button === 0 && !modified(event)
        && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= CLICK_SLOP) {
        onPersonClick?.(event.clientX, event.clientY);
      }
    }, { signal });
    const cancel = (event: PointerEvent) => {
      if (this.drag?.pointerId === event.pointerId) this.drag = null;
    };
    canvas.addEventListener('pointercancel', cancel, { signal });
    canvas.addEventListener('lostpointercapture', cancel, { signal });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (this.firstPerson) return;
      if (this.drag) this.drag.canPick = false;
      this.distance = clamp(this.distance * Math.exp(event.deltaY * 0.001), 5, this.extent * 3.8);
    }, { passive: false, signal });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  }

  setBounds(bounds: Bounds, scramble = false, urban = false): void {
    this.scramble = scramble;
    this.urban = urban;
    this.extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    this.centerX = (bounds.minX + bounds.maxX) / 2;
    this.centerZ = (bounds.minZ + bounds.maxZ) / 2;
    this.reset();
  }

  reset(): void { this.setView('perspective'); }

  frameParticipant(x: number, z: number, heading: number): void {
    vec3.set(this.target, x, 1.05, z);
    this.yaw = heading + 1.1;
    this.elevation = 0.20;
    this.distance = 8.5;
  }

  setView(view: CameraView): void {
    this.target[0] = this.centerX; this.target[1] = 0; this.target[2] = this.centerZ;
    if (view === 'overview') {
      this.yaw = 0; this.elevation = 1.53; this.distance = this.extent * 1.35;
    } else if (view === 'street') {
      this.yaw = 0.58; this.elevation = 0.085; this.distance = 22;
      this.target[0] += -this.extent * 0.12;
      this.target[2] += this.extent * 0.13;
      this.target[1] = 1.15;
      if (this.urban) {
        this.target[0] = this.centerX - 4;
        this.target[2] = this.centerZ + 7;
        this.yaw = -1.0; this.distance = 24; this.elevation = 0.055;
      }
    } else {
      this.yaw = this.urban ? -0.55 : this.scramble ? 0.52 : 0.62;
      this.elevation = this.urban ? 1.05 : this.scramble ? 0.84 : 0.73;
      this.distance = this.extent * (this.urban ? 0.85 : this.scramble ? 0.82 : 1.02);
    }
  }

  update(aspect: number, person?: PersonPose): void {
    this.firstPerson = person !== undefined;
    if (person) {
      this.drag = null;
      vec3.set(this.position, person.x, (person.eyeHeight ?? HUMAN_EYE_HEIGHT) * person.scale, person.z);
      const gazeHeading = person.heading + person.headYaw;
      vec3.set(this.gaze, person.x + Math.sin(gazeHeading), this.position[1], person.z + Math.cos(gazeHeading));
      mat4.lookAt(this.view, this.position, this.gaze, [0, 1, 0]);
    } else {
      const horizontal = Math.cos(this.elevation) * this.distance;
      this.position[0] = this.target[0] + Math.sin(this.yaw) * horizontal;
      this.position[1] = this.target[1] + Math.sin(this.elevation) * this.distance;
      this.position[2] = this.target[2] + Math.cos(this.yaw) * horizontal;
      mat4.lookAt(this.view, this.position, this.target, [0, 1, 0]);
    }
    // A larger near plane at aerial distances preserves depth precision for paving/roofs.
    const near = person || this.distance < 35 ? STREET_NEAR_PLANE : 0.75;
    mat4.perspectiveZO(this.projection, this.fov, aspect, near, 1400);
    mat4.multiply(this.viewProjection, this.projection, this.view);
  }

  destroy(): void { this.events.abort(); }
}
