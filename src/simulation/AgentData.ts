/** Structure of arrays, with stable appearance/intent and two interchangeable motion states. */
export class MotionState {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  readonly heading: Float32Array;
  readonly phase: Float32Array;
  constructor(count: number) {
    this.x = new Float32Array(count); this.z = new Float32Array(count);
    this.vx = new Float32Array(count); this.vz = new Float32Array(count);
    this.heading = new Float32Array(count); this.phase = new Float32Array(count);
  }
}

export class AgentData {
  current: MotionState;
  next: MotionState;
  readonly id: Uint32Array;
  readonly generation: Uint32Array;
  readonly portalStage: Uint8Array;
  readonly opacity: Float32Array;
  readonly radius: Float32Array;
  readonly preferredSpeed: Float32Array;
  readonly speedFactor: Float32Array;
  readonly preferredVX: Float32Array;
  readonly preferredVZ: Float32Array;
  readonly targetId: Uint16Array;
  readonly targetX: Float32Array;
  readonly targetZ: Float32Array;
  readonly scale: Float32Array;
  readonly appearance: Uint16Array;
  readonly tint: Float32Array;
  readonly stalledTime: Float32Array;
  constructor(readonly count: number) {
    this.current = new MotionState(count); this.next = new MotionState(count);
    this.generation = new Uint32Array(count);
    this.portalStage = new Uint8Array(count);
    this.opacity = new Float32Array(count).fill(1);
    this.id = new Uint32Array(count); this.radius = new Float32Array(count);
    this.preferredSpeed = new Float32Array(count); this.speedFactor = new Float32Array(count);
    this.preferredVX = new Float32Array(count); this.preferredVZ = new Float32Array(count);
    this.targetId = new Uint16Array(count); this.targetX = new Float32Array(count); this.targetZ = new Float32Array(count);
    this.scale = new Float32Array(count); this.appearance = new Uint16Array(count);
    this.tint = new Float32Array(count * 3); this.stalledTime = new Float32Array(count);
  }
  swap(): void { const old = this.current; this.current = this.next; this.next = old; }
}
