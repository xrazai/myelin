// The main-thread side of the layout. It needs no canvas: MyelinGraph composes it.

import { checkGraph, type LayoutGraph, type LayoutOptions } from './forceatlas2.ts';
import type { FromWorker, Naming, Port, ToWorker } from './protocol.ts';
import type { RelaxGraph } from './relax.ts';

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
  /** The answer to `detectCommunities`: labels per level, the finest first. */
  communities: (levels: Uint32Array[], named: { nextId: number; colors: Float32Array[] }) => void;
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
    communities: new Set(),
  };
  private communityRun = 0;

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

  /**
   * Moves only `graph.movable`, in the worker; one `layoutChange` brings every position.
   * Takes the place of a running layout. The arrays are transferred: give copies.
   */
  relax(graph: RelaxGraph): void {
    this.worker ??= this.connect();
    this.front = null;
    const transfer = [graph.alive, graph.edges, graph.weights, graph.positions, graph.movable, graph.temperatures]
      .flatMap((array) => (array ? [array.buffer as ArrayBuffer] : []));
    this.send({ type: 'relax', run: ++this.run, graph, options: this.options }, transfer);
  }

  /** Detects communities in the worker; the latest request wins. The arrays are transferred. */
  detectCommunities(graph: { nodeCount: number; edges: Uint32Array; weights?: Float32Array }, naming?: Naming): void {
    this.worker ??= this.connect();
    const arrays = [graph.edges, graph.weights, naming?.alive, ...(naming?.previous ?? [])];
    const transfer = arrays.flatMap((array) => (array ? [array.buffer as ArrayBuffer] : []));
    this.send({ type: 'communities', run: ++this.communityRun, graph, naming }, transfer);
  }

  /** Stops the current layout; no more events come from it. */
  stop(): void {
    this.run++;
    if (this.worker) this.send({ type: 'stop' }, []);
  }

  destroy(): void {
    this.run++;
    this.communityRun++;
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
    if (message.type === 'communities') {
      if (message.run !== this.communityRun) return;
      const levels = message.levels.map((buffer) => new Uint32Array(buffer));
      const colors = message.colors.map((buffer) => new Float32Array(buffer));
      for (const listener of this.listeners.communities) listener(levels, { nextId: message.nextId, colors });
      return;
    }
    // Late messages of a replaced or stopped layout.
    if (message.run !== this.run) return;
    if (message.type === 'error') {
      this.fail(message.message);
      return;
    }
    const previous = message.done && this.front === null ? null : this.front;
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
