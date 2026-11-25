/** Short-lived, per-pedestrian encounter decisions. All timers use simulation seconds. */
export class EncounterState {
  readonly passSide: Int8Array;
  readonly gazeTarget: Int32Array;
  readonly gazeLife: Uint32Array;
  readonly lean: Float32Array;
  readonly horizon: Float32Array;
  readonly brakingCost: Float32Array;
  readonly reconsiderIn: Float32Array;
  readonly gazeLead: Float32Array;
  readonly yielding: Uint8Array;
  private readonly holdFor: Float32Array;
  private readonly contactLatch: Float32Array;
  contactEvents = 0;

  constructor(count: number, private readonly seed: number) {
    this.passSide = new Int8Array(count);
    this.gazeTarget = new Int32Array(count).fill(-1);
    this.gazeLife = new Uint32Array(count);
    this.lean = new Float32Array(count);
    this.horizon = new Float32Array(count);
    this.brakingCost = new Float32Array(count);
    this.reconsiderIn = new Float32Array(count);
    this.gazeLead = new Float32Array(count);
    this.yielding = new Uint8Array(count);
    this.holdFor = new Float32Array(count);
    this.contactLatch = new Float32Array(count);
    for (let id = 0; id < count; id++) this.reset(id, 0);
  }

  reset(id: number, generation: number): void {
    // A separate seed namespace keeps rendering, spawning and route sampling reproducible.
    let bits = this.seed ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(generation + 1, 0x85ebca6b);
    bits = Math.imul(bits ^ (bits >>> 16), 0x21f0aaad);
    bits = Math.imul(bits ^ (bits >>> 15), 0x735a2d97);
    bits ^= bits >>> 15;
    this.horizon[id] = 1.4 + (bits & 65535) * (0.45 / 65535);
    this.brakingCost[id] = 0.11 + (bits >>> 16) * (0.17 / 65535);
    this.passSide[id] = this.yielding[id] = 0;
    this.reconsiderIn[id] = this.gazeLead[id] = this.holdFor[id] = this.contactLatch[id] = this.lean[id] = 0;
    this.gazeTarget[id] = -1; this.gazeLife[id] = 0;
  }

  advance(id: number, dt: number): void {
    this.gazeTarget[id] = -1;
    if (this.lean[id]) {
      this.lean[id] *= Math.max(0, 1 - 6 * dt);
      if (Math.abs(this.lean[id]) < 0.002) this.lean[id] = 0;
    }
    this.contactLatch[id] = Math.max(0, this.contactLatch[id] - dt);
    this.reconsiderIn[id] = Math.max(0, this.reconsiderIn[id] - dt);
    if (this.gazeLead[id] > 0) this.gazeLead[id] = Math.max(0, this.gazeLead[id] - dt);
    if (this.holdFor[id] > 0) {
      this.holdFor[id] -= dt;
      if (this.holdFor[id] <= 0) {
        this.passSide[id] = this.yielding[id] = 0;
        this.reconsiderIn[id] = 0;
      }
    }
  }

  hold(id: number): void { this.holdFor[id] = 0.38; }

  /** A cluster of touching bodies produces one visible reaction until the person has separated. */
  contact(id: number, near: boolean, closing: number, side: number): void {
    if (!near) return;
    if (this.contactLatch[id] === 0 && closing > 0.22) {
      this.lean[id] = side * Math.min(1, 0.18 + (closing - 0.22) * 0.36);
      this.contactEvents++;
      this.contactLatch[id] = 0.24;
    } else if (this.contactLatch[id] > 0) {
      this.contactLatch[id] = 0.24;
    }
  }
}
