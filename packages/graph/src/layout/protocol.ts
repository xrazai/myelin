// Messages between GraphLayout (main thread) and the layout worker. Every buffer is
// transferred, never copied. `run` tells the graphs of successive `start`s apart.

import type { LayoutGraph, LayoutOptions } from './forceatlas2.ts';
import type { RelaxGraph } from './relax.ts';

export type ToWorker =
  | { type: 'start'; run: number; graph: LayoutGraph; options: LayoutOptions }
  /** Moves a few nodes of a settled graph; answers with one final `positions`. */
  | { type: 'relax'; run: number; graph: RelaxGraph; options: LayoutOptions }
  /** Gives back a positions buffer the main thread is done with. */
  | { type: 'buffer'; run: number; buffer: ArrayBuffer }
  | { type: 'stop' };

export type FromWorker =
  | {
      type: 'positions';
      run: number;
      /** A `Float32Array` of `[x0, y0, ...]`. */
      buffer: ArrayBuffer;
      iteration: number;
      done: boolean;
      converged: boolean;
    }
  | { type: 'error'; run: number; message: string };

/** One end of the channel: the worker scope, a `Worker` or a `MessagePort`. */
export interface Port<Out> {
  postMessage(message: Out, transfer: ArrayBuffer[]): void;
  // `any`: the three kinds of port type this handler differently.
  onmessage: ((event: any) => void) | null;
}
