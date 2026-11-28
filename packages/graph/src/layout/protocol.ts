// Messages between GraphLayout (main thread) and the layout worker. Every buffer is
// transferred, never copied. `run` tells the graphs of successive `start`s apart.

import type { LayoutGraph, LayoutOptions } from './forceatlas2.ts';
import type { CommunityGraph } from './leiden.ts';
import type { RelaxGraph } from './relax.ts';

/** What the worker needs to give new communities their ids and colors. */
export interface Naming {
  /** The assignment their ids are kept from. */
  previous: Uint32Array[] | null;
  nextId: number;
  /** By node id: a removed slot is in no community. */
  alive: Uint8Array;
  /** Colors there are to choose from. */
  palette: number;
  /** Length of the color arrays. */
  capacity: number;
}

export type ToWorker =
  | { type: 'start'; run: number; graph: LayoutGraph; options: LayoutOptions }
  /** Moves a few nodes of a settled graph; answers with one final `positions`. */
  /** Detects communities; has its own run numbers, apart from the layout's. */
  | { type: 'communities'; run: number; graph: CommunityGraph; naming?: Naming }
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
  | { type: 'error'; run: number; message: string }
  /**
   * One `Uint32Array` per level, the finest first. With `naming`: ids are the host's, and
   * `colors` holds the coarsest and the finest level's color per node (`Float32Array`).
   */
  | { type: 'communities'; run: number; levels: ArrayBuffer[]; nextId: number; colors: ArrayBuffer[] };

/** One end of the channel: the worker scope, a `Worker` or a `MessagePort`. */
export interface Port<Out> {
  postMessage(message: Out, transfer: ArrayBuffer[]): void;
  // `any`: the three kinds of port type this handler differently.
  onmessage: ((event: any) => void) | null;
}
