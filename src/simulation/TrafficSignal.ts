import type { SignalMode, SignalService, SignalState } from '../types';

// Shibuya Station, 25 August 2020 at about 18:00. Clearance is a minimum.
// https://www.shingou-saikuru.com/2019/01/shibuya-sta.html
export const SIGNAL_TIMINGS = {
  pedestrian: { green: 37, warning: 10, clearance: 4 },
  eastWest: { green: 44, warning: 3, clearance: 3 },
  northSouth: { green: 33, warning: 3, clearance: 3 },
} as const;
export const SIGNAL_CYCLE_SECONDS = Object.values(SIGNAL_TIMINGS)
  .reduce((total, interval) => total + interval.green + interval.warning + interval.clearance, 0);

const NEXT_SERVICE: Record<SignalService, SignalService> = {
  pedestrian: 'eastWest', eastWest: 'northSouth', northSouth: 'pedestrian',
};
type Stage = 'green' | 'warning' | 'clearance';

/** Accept the original single-signal names when replaying older configurations. */
export function parseSignalMode(value: unknown): SignalMode | undefined {
  switch (value) {
    case 'auto': case 'pedestrian': case 'eastWest': case 'northSouth': case 'allRed': return value;
    case 'green': return 'pedestrian';
    case 'red': return 'eastWest'; // The original traffic model only served the east–west lanes.
    case 'yellow': return 'allRed'; // Request closure through the normal warning sequence.
    default: return undefined;
  }
}

/** One simulation clock drives all three independent indications. */
export class TrafficSignal {
  readonly state: SignalState;
  private service: SignalService;
  private stage: Stage;
  private startedAt = 0;
  private clearanceHeld = false;

  constructor(mode: SignalMode = 'auto') {
    // A fresh, empty scene can start directly on its selected service.
    this.service = mode === 'auto' ? 'pedestrian' : mode === 'allRed' ? 'northSouth' : mode;
    this.stage = mode === 'allRed' ? 'clearance' : 'green';
    this.clearanceHeld = mode === 'allRed';
    this.state = { mode, pedestrian: 'red', eastWest: 'red', northSouth: 'red', remaining: null, waiting: 0, crossing: 0 };
    this.update(0);
  }

  setMode(mode: SignalMode, time: number, vehiclesInCrossing = false, pedestriansInCrossing = false): void {
    this.update(time, vehiclesInCrossing, pedestriansInCrossing);
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    if (this.stage === 'green') {
      if (mode !== 'auto' && mode !== this.service) this.stage = 'warning';
      this.startedAt = time;
    }
    this.update(time, vehiclesInCrossing, pedestriansInCrossing);
  }

  update(time: number, vehiclesInCrossing = false, pedestriansInCrossing = false): void {
    if (!Number.isFinite(time)) throw new RangeError('Signal time must be finite.');
    const state = this.state;
    while (true) {
      const end = this.startedAt + SIGNAL_TIMINGS[this.service][this.stage];
      if (this.stage === 'green' && state.mode === this.service) {
        state.remaining = null;
        break;
      }
      if (!this.clearanceHeld && time + 1e-9 < end) {
        state.remaining = end - time;
        break;
      }
      if (this.stage === 'clearance') {
        if (state.mode === 'allRed' || vehiclesInCrossing || pedestriansInCrossing) {
          this.clearanceHeld = true;
          state.remaining = null;
          break;
        }
        this.service = state.mode === 'auto' ? NEXT_SERVICE[this.service] : state.mode;
        this.stage = 'green';
        // After a hold, grant a full green interval starting when the junction is observed clear.
        this.startedAt = this.clearanceHeld ? time : end;
        this.clearanceHeld = false;
      } else {
        this.stage = this.stage === 'green' ? 'warning' : 'clearance';
        this.startedAt = end;
      }
    }
    state.pedestrian = state.eastWest = state.northSouth = 'red';
    if (this.stage === 'green') {
      state[this.service] = 'green';
      if (this.service === 'pedestrian') state.waiting = 0;
    } else if (this.stage === 'warning') {
      if (this.service === 'pedestrian') state.pedestrian = 'flashingGreen';
      else state[this.service] = 'yellow';
    }
  }
}
