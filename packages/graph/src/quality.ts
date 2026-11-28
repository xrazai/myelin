// Adaptive quality (docs/graph-lib.md): while frames are too slow, the bloom is computed
// at a lower resolution, then not at all. Nodes and edges are never dropped. It only goes
// down: going back up would swing between the two.

/** Bloom resolution as a share of the frame's, best first; 0 is off. */
export const GLOW_STEPS: readonly number[] = [0.5, 0.25, 0];
/** Slower than 50 FPS. */
const SLOW_MS = 20;
/** Consecutive frame intervals judged at a time, by their median. */
const WINDOW = 30;
/** A longer gap is a pause (a hidden page, a debugger), not a slow frame. */
const PAUSE_MS = 250;

export class AdaptiveQuality {
  private step = 0;
  private intervals: number[] = [];

  /** The bloom resolution to draw with. */
  get glow(): number {
    return GLOW_STEPS[this.step]!;
  }

  /**
   * One interval between two frames drawn back to back. Gaps between frames drawn only
   * because something changed say nothing about speed and must not be given. Returns
   * whether the quality went down.
   */
  sample(milliseconds: number): boolean {
    if (this.step === GLOW_STEPS.length - 1 || milliseconds > PAUSE_MS) return false;
    this.intervals.push(milliseconds);
    if (this.intervals.length < WINDOW) return false;
    const median = this.intervals.sort((a, b) => a - b)[WINDOW >> 1]!;
    this.intervals = [];
    if (median <= SLOW_MS) return false;
    this.step++;
    return true;
  }
}
