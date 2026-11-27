// The graph on a canvas: composes the layout worker, the camera and its controls, and a
// graphics backend. It draws only when something changed.

import type { Backend, BackendFactory, Scene } from './backend/backend.ts';
import { WebGL2Backend } from './backend/webgl2.ts';
import { boundsOf, fit, pan, zoomAt, type Camera } from './camera.ts';
import { attachControls } from './controls.ts';
import { GraphLayout, type GraphLayoutOptions, type LayoutEvents } from './layout/graph-layout.ts';
import { checkGraph, type LayoutOptions } from './layout/forceatlas2.ts';
import { observeCanvasSize, type CanvasSize } from './resize.ts';
import { createStyle, type GraphColors, type SceneInput } from './scene.ts';
import { GraphStore } from './store.ts';

/** Furthest zoom out: this share of the zoom that shows the whole graph. */
const MIN_ZOOM_OF_FIT = 0.25;
const MAX_ZOOM = 16;
/** How freely the neighbors of a new node move, against 1 for the node itself. */
const NEIGHBOR_TEMPERATURE = 0.3;
/** Past this many movable nodes a local pass costs more than a full layout. */
const MAX_LOCAL = 2000;
/** Where a node with no place yet is uploaded: far outside any view. */
const NOWHERE = 1e30;

export interface MyelinGraphOptions {
  /** `#rgb` or `#rrggbb`. */
  colors?: Partial<GraphColors>;
  layout?: LayoutOptions;
  /** For bundlers that cannot follow the default worker URL, and for tests. */
  createWorker?: GraphLayoutOptions['createWorker'];
  /** For tests. */
  createBackend?: BackendFactory;
}

export interface GraphData extends SceneInput {
  /** `[x0, y0, ...]` to start from. A node with a non-finite coordinate gets a new one. */
  positions?: Float32Array;
}

export class MyelinGraph {
  private readonly canvas: HTMLCanvasElement;
  private readonly createBackend: () => Backend;
  private backend: Backend;
  private readonly layout: GraphLayout;
  private readonly detach: (() => void)[] = [];
  private readonly store = new GraphStore();
  private loaded = false;
  /** Some positions are known: there is something to draw and to frame. */
  private placed = false;
  /** A full layout is running; its node `i` is the slot `ids[i]` (`null`: the same). */
  private full: { ids: Uint32Array | null; running: boolean } = { ids: null, running: false };
  /** Nodes added and not yet laid out by a finished pass. */
  private readonly fresh = new Set<number>();
  private pending = false;
  private readonly changeListeners = new Set<LayoutEvents['layoutChange']>();
  private size: CanvasSize = { width: 0, height: 0, pixelWidth: 0, pixelHeight: 0 };
  private view: Camera = { x: 0, y: 0, zoom: 1 };
  /** The zoom that shows the whole graph. */
  private fitZoom = 1;
  /** The camera follows the graph until the user moves it. */
  private following = true;
  private frame = 0;
  private lost = false;
  private destroyed = false;

  /** The page gives the canvas its CSS size; the graph sets the backing size to match. */
  constructor(canvas: HTMLCanvasElement, options: MyelinGraphOptions = {}) {
    const style = createStyle(options.colors);
    const factory = options.createBackend ?? ((target, look) => new WebGL2Backend(target, look));
    this.canvas = canvas;
    this.createBackend = () => factory(canvas, style);
    this.backend = this.createBackend();
    this.layout = new GraphLayout({ ...options.layout, createWorker: options.createWorker });
    this.layout.on('layoutChange', (positions, status) => {
      this.receive(positions, status.done);
      // The graph is updated first. By node id; NaN for a removed or unplaced node.
      const byId = this.store.positions.subarray(0, this.store.nodeCount * 2);
      for (const listener of this.changeListeners) listener(byId, status);
    });

    this.detach.push(
      observeCanvasSize(canvas, (size) => this.resize(size)),
      attachControls(canvas, {
        pan: (dx, dy) => this.move(pan(this.view, dx, dy)),
        zoom: (x, y, factor) =>
          this.move(
            zoomAt(this.view, this.size, x, y, factor, {
              // A camera set from outside may already be past a limit: it is not snapped back.
              min: Math.min(this.view.zoom, this.fitZoom * MIN_ZOOM_OF_FIT),
              max: Math.max(this.view.zoom, MAX_ZOOM),
            }),
          ),
      }),
      this.listen('webglcontextlost', (event) => {
        // Without this the browser never restores it.
        event.preventDefault();
        this.lost = true;
      }),
      this.listen('webglcontextrestored', () => this.restore()),
    );
  }

  /** Full load. Resets node ids; the caller keeps its arrays. */
  setGraph(data: GraphData): void {
    this.assertAlive();
    // The whole input is checked before anything changes.
    checkGraph(data);
    if (data.states && data.states.length !== data.nodeCount) throw new RangeError('states must hold one value per node');
    this.store.load(data, data.positions);
    this.store.takeChanges();
    this.backend.setGraph(this.store.scene());
    this.fresh.clear();
    this.pending = false;
    this.layout.setGraph(data);
    this.full = { ids: null, running: true };
    this.loaded = true;
    this.placed = false;
    this.following = true;
    // Saved positions are drawn at once; otherwise the first layout update does it.
    if (data.positions?.every(Number.isFinite)) this.showPositions();
    else this.invalidate();
  }

  /**
   * Adds nodes and returns their ids (removed slots are reused). Without `positions`, they
   * start among their neighbors once their edges arrive, in the same task.
   */
  addNodes(count: number, options: { positions?: Float32Array; states?: Float32Array } = {}): Uint32Array {
    this.assertLoaded();
    const ids = this.store.addNodes(count, options);
    for (const id of ids) this.fresh.add(id);
    this.schedule();
    return ids;
  }

  /** Removes nodes and their edges. Nothing else moves. */
  removeNodes(ids: ArrayLike<number>): void {
    this.assertLoaded();
    this.store.removeNodes(ids);
    for (let i = 0; i < ids.length; i++) this.fresh.delete(ids[i]!);
    this.schedule();
  }

  addEdges(pairs: Uint32Array, weights?: Float32Array): void {
    this.assertLoaded();
    this.store.addEdges(pairs, weights);
    this.schedule();
  }

  removeEdges(pairs: Uint32Array): void {
    this.assertLoaded();
    this.store.removeEdges(pairs);
    this.schedule();
  }

  updateWeights(pairs: Uint32Array, weights: Float32Array): void {
    this.assertLoaded();
    this.store.updateWeights(pairs, weights);
    this.schedule();
  }

  updateStates(ids: ArrayLike<number>, values: Float32Array): void {
    this.assertLoaded();
    this.store.updateStates(ids, values);
    this.schedule();
  }

  /** Where the camera is. Setting it stops it from following the layout. */
  get camera(): Camera {
    return { ...this.view };
  }

  set camera(camera: Camera) {
    this.move({ ...camera });
  }

  /** Shows the whole graph, and follows it again while the layout runs. */
  fit(): void {
    this.following = true;
    this.refit();
    this.invalidate();
  }

  on<K extends keyof LayoutEvents>(event: K, listener: LayoutEvents[K]): void {
    if (event === 'layoutChange') this.changeListeners.add(listener as LayoutEvents['layoutChange']);
    else this.layout.on(event, listener);
  }

  off<K extends keyof LayoutEvents>(event: K, listener: LayoutEvents[K]): void {
    if (event === 'layoutChange') this.changeListeners.delete(listener as LayoutEvents['layoutChange']);
    else this.layout.off(event, listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    for (const detach of this.detach) detach();
    this.layout.destroy();
    this.backend.destroy();
    this.loaded = false;
    this.placed = false;
    this.changeListeners.clear();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('the graph was destroyed');
  }

  private listen(type: string, listener: (event: Event) => void): () => void {
    this.canvas.addEventListener(type, listener);
    return () => this.canvas.removeEventListener(type, listener);
  }

  private assertLoaded(): void {
    this.assertAlive();
    if (!this.loaded) throw new Error('setGraph comes first');
  }

  /** The changes of one task go to the GPU and to the layout together. */
  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    if (!this.pending || this.destroyed) return;
    this.pending = false;
    const { grown, nodes, edges } = this.store.takeChanges();
    const scene = this.store.scene();
    if (grown) this.backend.setGraph(scene);
    else this.backend.updateGraph(scene, nodes, edges);
    if (this.placed && (grown || nodes)) this.upload();
    this.arrange();
    this.invalidate();
  }

  /** Lays out what the changes call for. */
  private arrange(): void {
    // A full layout does not know the new graph: it starts again from where it was.
    if (this.full.running) this.relayout();
    else if (this.fresh.size > 0) this.relaxFresh();
  }

  /** The new nodes, and a little their neighbors, move; every other node stays. */
  private relaxFresh(): void {
    const { store } = this;
    const temperature = new Map<number, number>();
    for (const id of this.fresh) for (const other of store.neighbors(id)) temperature.set(other, NEIGHBOR_TEMPERATURE);
    for (const id of this.fresh) temperature.set(id, 1);
    if (temperature.size > MAX_LOCAL) {
      this.relayout();
      return;
    }
    this.layout.relax({
      nodeCount: store.nodeCount,
      alive: store.alive.slice(0, store.nodeCount),
      edges: store.ends.slice(0, store.edgeCount * 2),
      weights: store.weights.slice(0, store.edgeCount),
      positions: store.positions.slice(0, store.nodeCount * 2),
      movable: Uint32Array.from(temperature.keys()),
      temperatures: Float32Array.from(temperature.values()),
    });
  }

  /** A full layout of the living nodes, from where they are. */
  private relayout(): void {
    const { store } = this;
    const ids = Uint32Array.from(
      Array.from({ length: store.nodeCount }, (_, id) => id).filter((id) => store.isAlive(id)),
    );
    const dense = new Int32Array(store.nodeCount).fill(-1);
    ids.forEach((id, i) => (dense[id] = i));
    const positions = new Float32Array(ids.length * 2);
    ids.forEach((id, i) => {
      positions[i * 2] = store.positions[id * 2]!;
      positions[i * 2 + 1] = store.positions[id * 2 + 1]!;
    });
    this.layout.setGraph({
      nodeCount: ids.length,
      edges: store.ends.slice(0, store.edgeCount * 2).map((id) => dense[id]!),
      weights: store.weights.slice(0, store.edgeCount),
      positions,
    });
    this.full = { ids, running: true };
  }

  /** `positions` may be reused by the caller once this returns: it is copied. */
  private receive(positions: Float32Array, done: boolean): void {
    const { store } = this;
    const ids = this.full.running ? this.full.ids : null;
    const count = positions.length / 2;
    for (let i = 0; i < count; i++) {
      const id = ids ? ids[i]! : i;
      if (!store.isAlive(id)) continue;
      store.positions[id * 2] = positions[i * 2]!;
      store.positions[id * 2 + 1] = positions[i * 2 + 1]!;
    }
    if (done) {
      this.full.running = false;
      this.fresh.clear();
    }
    this.showPositions();
  }

  private showPositions(): void {
    this.placed = true;
    this.upload();
    if (this.following) this.refit();
    this.invalidate();
  }

  private upload(): void {
    const positions = this.store.positions.slice(0, this.store.nodeCount * 2);
    for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) positions[i] = NOWHERE;
    this.backend.setPositions(positions);
  }

  private refit(): void {
    if (!this.placed || this.size.width <= 0 || this.size.height <= 0) return;
    // NaN (removed or unplaced nodes) is not part of the bounds.
    const bounds = boundsOf(this.store.positions.subarray(0, this.store.nodeCount * 2));
    if (!bounds) return;
    this.view = fit(bounds, this.size);
    this.fitZoom = this.view.zoom;
  }

  private move(camera: Camera): void {
    this.following = false;
    this.view = camera;
    this.invalidate();
  }

  private resize(size: CanvasSize): void {
    this.size = size;
    if (this.canvas.width !== size.pixelWidth) this.canvas.width = size.pixelWidth;
    if (this.canvas.height !== size.pixelHeight) this.canvas.height = size.pixelHeight;
    if (this.following) this.refit();
    // Resizing cleared the canvas: drawing now, before the paint, avoids a blank frame.
    this.draw();
  }

  /** Draws at the next frame, once however often it is asked. */
  private invalidate(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const { pixelWidth, pixelHeight, width } = this.size;
    if (this.lost || this.destroyed || pixelWidth === 0 || pixelHeight === 0) return;
    this.backend.render({
      width: pixelWidth,
      height: pixelHeight,
      pixelRatio: pixelWidth / width,
      camera: this.view,
    });
  }

  /** A restored context is empty: everything is created and uploaded again. */
  private restore(): void {
    this.lost = false;
    this.backend = this.createBackend();
    if (this.loaded) {
      this.store.takeChanges();
      this.backend.setGraph(this.store.scene());
    }
    if (this.placed) this.upload();
    this.invalidate();
  }
}
