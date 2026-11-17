import type { SignalMode, SignalState } from '../types';

export const SIGNAL_RED_SECONDS = 12;
export const SIGNAL_GREEN_SECONDS = 35;

/** Signal time advances only with the simulation's clock, so pause and time scale stay coherent. */
export class TrafficSignal {
  readonly state: SignalState = { mode: 'auto', phase: 'red', remaining: SIGNAL_RED_SECONDS, waiting: 0, crossing: 0 };
  setMode(mode: SignalMode, simulationTime: number): void {
    this.state.mode = mode;
    this.update(simulationTime);
  }
  update(simulationTime: number): void {
    const mode = this.state.mode;
    if (mode !== 'auto') {
      this.state.phase = mode;
      this.state.remaining = null;
    } else {
      const cycle = SIGNAL_RED_SECONDS + SIGNAL_GREEN_SECONDS;
      const time = ((simulationTime + 1e-9) % cycle + cycle) % cycle;
      this.state.phase = time < SIGNAL_RED_SECONDS ? 'red' : 'green';
      this.state.remaining = Math.max(0, (this.state.phase === 'red' ? SIGNAL_RED_SECONDS : cycle) - time);
    }
    if (this.state.phase === 'green') this.state.waiting = 0;
  }
}
