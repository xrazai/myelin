// The main-thread side of the layout. It needs no canvas: MyelinGraph composes it.

import { checkGraph, type LayoutGraph, type LayoutOptions } from './forceatlas2.ts';
import type { FromWorker, Port, ToWorker } from './protocol.ts';

export interface LayoutWorker extends Port<ToWorker> {
  onerror?: ((event: any) => void) | null;
  terminate(): void;
}

export interface LayoutStatus {
  iteration: number;
  /** The layout stopped: these positions are its last. */
  done: boolean;
  /** It stopped because it settled, not at `maxIterations`. */
  converged: boolean;
}

export interface LayoutEvents {
  /**
   * `positions` is `[x0, y0, ...]` by node id. It is only valid until the next event: its
   * buffer then goes back to the worker. Copy what must be kept.
   */
  layoutChange: (positions: Float32Array, status: LayoutStatus) => void;
  layoutError: (error: Error) => void;
}

export interface GraphLayoutOptions extends LayoutOptions {
  /** For bundlers that cannot follow the default worker URL, and for tests. */
  createWorker?: () => LayoutWorker;
}

const defaultWorker = (): LayoutWorker =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

export class GraphLayout {
  private readonly options: LayoutOptions;
  private readonly createWorker: () => LayoutWorker;
  private worker: LayoutWorker | null = null;
  private run = 0;
  private front: Float32Array<ArrayBuffer> | null = null;
  private readonly listeners: { [K in keyof LayoutEvents]: Set<LayoutEvents[K]> } = {
    layoutChange: new Set(),
    layoutError: new Set(),
  };

  constructor({ createWorker = defaultWorker, ...options }: GraphLayoutOptions = {}) {
    this.createWorker = createWorker;
    this.options = options;
  }

  /** The latest positions, valid until the next `layoutChange`; null before the first. */
  get positions(): Float32Array | null {
    return this.front;
  }

  on<K extends keyof LayoutEvents>(event: K, listener: LayoutEvents[K]): void {
    this.listeners[event].add(listener);
  }

  off<K extends keyof LayoutEvents>(event: K, listener: LayoutEvents[K]): void {
    this.listeners[event].delete(listener);
  }

  /** Full load: lays the graph out until it settles. The arrays stay with the caller. */
  setGraph(graph: LayoutGraph): void {
    checkGraph(graph);
    this.worker ??= this.connect();
    this.front = null;
    const copy: LayoutGraph = {
      nodeCount: graph.nodeCount,
      edges: graph.edges.slice(),
      weights: graph.weights?.slice(),
      positions: graph.positions?.slice(),
    };
    const transfer = [copy.edges, copy.weights, copy.positions].flatMap((array) =>
      array ? [array.buffer as ArrayBuffer] : [],
    );
    this.send({ type: 'start', run: ++this.run, graph: copy, options: this.options }, transfer);
  }

  /** Stops the current layout; no more events come from it. */
  stop(): void {
    this.run++;
    if (this.worker) this.send({ type: 'stop' }, []);
  }

  destroy(): void {
    this.run++;
    this.worker?.terminate();
    this.worker = null;
    this.front = null;
    for (const set of Object.values(this.listeners)) set.clear();
  }

  private send(message: ToWorker, transfer: ArrayBuffer[]): void {
    this.worker!.postMessage(message, transfer);
  }

  private connect(): LayoutWorker {
    const worker = this.createWorker();
    worker.onmessage = (event: { data: FromWorker }) => this.receive(event.data);
    // The worker did not load or died; the next `setGraph` makes a new one.
    worker.onerror = (event: { message?: string }) => {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.fail(event.message || 'the layout worker failed');
    };
    return worker;
  }

  private fail(message: string): void {
    const error = new Error(message);
    if (this.listeners.layoutError.size === 0) console.error(error);
    for (const listener of this.listeners.layoutError) listener(error);
  }

  private receive(message: FromWorker): void {
    // Late messages of a replaced or stopped layout.
    if (message.run !== this.run) return;
    if (message.type === 'error') {
      this.fail(message.message);
      return;
    }
    const previous = this.front;
    const positions = new Float32Array(message.buffer);
    this.front = positions;
    const { iteration, done, converged } = message;
    try {
      for (const listener of this.listeners.layoutChange) listener(positions, { iteration, done, converged });
    } finally {
      // After the listeners, so that they may still read the previous array.
      if (previous && message.run === this.run) {
        this.send({ type: 'buffer', run: message.run, buffer: previous.buffer }, [previous.buffer]);
      }
    }
  }
}
