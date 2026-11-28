// What moves on its own: breathing of active nodes, light along an edge, and the cascade
// from the hovered node to its neighbors. Each of them ends, so that the graph goes back
// to drawing only when something changes. Times are in milliseconds. Plain TS.

/** How long active nodes breathe after a state rose. */
const BREATHE_MS = 6000;
const BREATH_PERIOD_MS = 2000;
export const PULSE_MS = 900;
/** Light reaching one neighbor in the cascade, and between one neighbor and the next. */
const REACH_MS = 220;
const STAGGER_MS = 12;
const MAX_STAGGER_TOTAL_MS = 200;
const MAX_CASCADE = 500;
const MAX_PULSES = 200;

/** A beam is `[head, mode]`: a traveling light (0), or an edge lit from its start (1). */
export interface Beams {
  count: number;
  /** `[from0, to0, ...]` */
  ends: Uint32Array;
  /** `[head0, mode0, ...]`, the head from 0 at `from` to 1 and past it at `to`. */
  progress: Float32Array;
}

interface Pulse {
  from: number;
  to: number;
  start: number;
  duration: number;
}

export class Effects {
  private breathingSince: number | null = null;
  private pulses: Pulse[] = [];
  private cascade: { from: number; to: number[]; start: number } | null = null;

  breathe(now: number): void {
    this.breathingSince = now;
  }

  pulse(from: number, to: number, now: number, duration = PULSE_MS): void {
    this.pulses.push({ from, to, start: now, duration });
    if (this.pulses.length > MAX_PULSES) this.pulses.shift();
  }

  /** Lights the edges from `from` to its neighbors, one after the other; `null` ends it. */
  hover(from: number | null, neighbors: number[], now: number): void {
    this.cascade = from === null || neighbors.length === 0 ? null : { from, to: neighbors.slice(0, MAX_CASCADE), start: now };
  }

  /** Drops what involves a node that is gone. */
  forget(isAlive: (id: number) => boolean): void {
    this.pulses = this.pulses.filter(({ from, to }) => isAlive(from) && isAlive(to));
    if (this.cascade && !isAlive(this.cascade.from)) this.cascade = null;
    else if (this.cascade) this.cascade.to = this.cascade.to.filter(isAlive);
  }

  clear(): void {
    this.breathingSince = null;
    this.pulses = [];
    this.cascade = null;
  }

  /** The size change of active nodes, -1 to 1, fading to a stop. */
  breath(now: number): number {
    if (this.breathingSince === null) return 0;
    const elapsed = now - this.breathingSince;
    if (elapsed >= BREATHE_MS) {
      this.breathingSince = null;
      return 0;
    }
    return Math.sin((elapsed / BREATH_PERIOD_MS) * 2 * Math.PI) * (1 - elapsed / BREATHE_MS);
  }

  /** The beams to draw now; finished pulses are dropped. */
  beams(now: number): Beams {
    this.pulses = this.pulses.filter((pulse) => now - pulse.start < pulse.duration);
    const lit = this.cascade?.to.length ?? 0;
    const count = this.pulses.length + lit;
    const ends = new Uint32Array(count * 2);
    const progress = new Float32Array(count * 2);
    let at = 0;
    if (this.cascade) {
      const { from, to, start } = this.cascade;
      const stagger = Math.min(STAGGER_MS, MAX_STAGGER_TOTAL_MS / to.length);
      for (let i = 0; i < to.length; i++, at++) {
        ends.set([from, to[i]!], at * 2);
        progress.set([Math.min(1, Math.max(0, (now - start - i * stagger) / REACH_MS)), 1], at * 2);
      }
    }
    for (const pulse of this.pulses) {
      ends.set([pulse.from, pulse.to], at * 2);
      // Past 1, so that the tail leaves the edge too.
      progress.set([((now - pulse.start) / pulse.duration) * 1.3, 0], at * 2);
      at++;
    }
    return { count, ends, progress };
  }

  /** Whether the next frame will look different from this one. */
  moving(now: number): boolean {
    if (this.pulses.length > 0 || this.breathingSince !== null) return true;
    return this.cascade !== null && now - this.cascade.start < REACH_MS + MAX_STAGGER_TOTAL_MS;
  }
}
