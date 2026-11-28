// The graph on a canvas: composes the layout worker, the camera and its controls, and a
// graphics backend. It draws only when something changed.

import type { Backend, BackendFactory, Frame } from './backend/backend.ts';
import { WebGL2Backend } from './backend/webgl2.ts';
import { boundsOf, fit, pan, screenToWorld, zoomAt, type Camera } from './camera.ts';
import { describeCommunity, keepIds, NO_COMMUNITY, type Assignment, type Community } from './communities.ts';
import { HitGrid, type HitStyle } from './hit-grid.ts';
import { drawLabels, placeLabels, type LabelStyle } from './labels.ts';
import { AdaptiveQuality } from './quality.ts';
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
/** A press that moves less than this, in CSS pixels, is a click. */
const CLICK_SLOP = 4;
const FOCUS_MS = 600;
/** Focusing a node zooms in at least this much. */
const FOCUS_ZOOM = 1;
/** Frames drawn back to back after a load's layout, to learn how fast this GPU draws it. */
const PROBE_FRAMES = 40;
/** Communities are computed again once the graph has been quiet this long. */
const COMMUNITIES_IDLE_MS = 1000;

export interface PointerEvents {
  /** The node under the pointer, or `null` when it leaves every node. */
  nodeHover: (id: number | null) => void;
  nodeClick: (id: number) => void;
}

export interface CommunityEvents {
  /** A new computation: save it by your own keys, and give it back to `setGraph`. */
  communitiesChange: (assignment: Assignment) => void;
}

export type GraphEvents = Omit<LayoutEvents, 'communities'> & PointerEvents & CommunityEvents;

export interface MyelinGraphOptions {
  /** `#rgb` or `#rrggbb`. */
  colors?: Partial<GraphColors>;
  layout?: LayoutOptions;
  /**
   * Bloom resolution as a share of the frame's, 0 for no glow. `'auto'` (the default)
   * starts at 1/2 and, below about 50 FPS, goes to 1/4 and then off.
   */
  glow?: 'auto' | number;
  /** For bundlers that cannot follow the default worker URL, and for tests. */
  createWorker?: GraphLayoutOptions['createWorker'];
  /** For tests. */
  createBackend?: BackendFactory;
  /** The title of a node; only asked for nodes that may show. An array is `id => labels[id]`. */
  getLabel?: ((id: number) => string) | string[];
  /**
   * A transparent canvas stacked exactly over the graph's, with `pointer-events: none`:
   * labels are drawn on it. Needed for `getLabel`.
   */
  labelCanvas?: HTMLCanvasElement;
  /** Neutral by default: the host brings its own. */
  labelStyle?: Partial<LabelStyle>;
}

export interface GraphData extends SceneInput {
  /** A saved assignment, by node id: drawn from at once, with no computation on load. */
  communities?: Assignment;
  /** `[x0, y0, ...]` to start from. A node with a non-finite coordinate gets a new one. */
  positions?: Float32Array;
}

export class MyelinGraph {
  private readonly canvas: HTMLCanvasElement;
  private readonly createBackend: () => Backend;
  private readonly hitStyle: HitStyle;
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
  private readonly hits: HitGrid;
  /** The grid and the label order are rebuilt when next needed. */
  private staleHits = true;
  private staleOrder = true;
  private order: Uint32Array = new Uint32Array(0);
  private hovered: number | null = null;
  private readonly labels: {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    label: (id: number) => string;
    style: LabelStyle;
  } | null = null;
  /** A camera glide in progress. */
  private glide: { from: Camera; to: Camera; start: number; duration: number } | null = null;
  private readonly pointerListeners = {
    nodeHover: new Set<PointerEvents['nodeHover']>(),
    nodeClick: new Set<PointerEvents['nodeClick']>(),
    communitiesChange: new Set<CommunityEvents['communitiesChange']>(),
  };
  private communities: Assignment | null = null;
  private nextCommunity = 0;
  private communityTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changeListeners = new Set<LayoutEvents['layoutChange']>();
  private size: CanvasSize = { width: 0, height: 0, pixelWidth: 0, pixelHeight: 0 };
  private view: Camera = { x: 0, y: 0, zoom: 1 };
  /** The zoom that shows the whole graph. */
  private fitZoom = 1;
  /** The camera follows the graph until the user moves it. */
  private following = true;
  private frame = 0;
  /** `null` with a fixed glow. */
  private readonly quality: AdaptiveQuality | null;
  private readonly fixedGlow: number;
  /** When the last frame ran, if it asked for the next one itself; else `null`. */
  private chained: number | null = null;
  /** Frames still to draw back to back to measure the speed. */
  private probe = 0;
  private probed = false;
  private lost = false;
  private destroyed = false;

  /** The page gives the canvas its CSS size; the graph sets the backing size to match. */
  constructor(canvas: HTMLCanvasElement, options: MyelinGraphOptions = {}) {
    const style = createStyle(options.colors);
    const factory = options.createBackend ?? ((target, look) => new WebGL2Backend(target, look));
    this.canvas = canvas;
    this.createBackend = () => factory(canvas, style);
    this.backend = this.createBackend();
    this.hitStyle = style;
    const glow = options.glow ?? 'auto';
    if (glow !== 'auto' && !(glow >= 0 && glow <= 1)) throw new RangeError('glow must be "auto" or between 0 and 1');
    this.quality = glow === 'auto' ? new AdaptiveQuality() : null;
    this.fixedGlow = glow === 'auto' ? 0 : glow;
    this.hits = new HitGrid(style);
    const { getLabel, labelCanvas } = options;
    if (getLabel && labelCanvas) {
      const context = labelCanvas.getContext('2d');
      if (!context) throw new Error('the label canvas has no 2d context');
      this.labels = {
        canvas: labelCanvas,
        context,
        label: Array.isArray(getLabel) ? (id) => getLabel[id] ?? '' : getLabel,
        style: { color: '#dddddd', font: 'sans-serif', ...options.labelStyle },
      };
    }
    this.layout = new GraphLayout({ ...options.layout, createWorker: options.createWorker });
    this.layout.on('layoutChange', (positions, status) => {
      this.receive(positions, status.done);
      // The graph is updated first. By node id; NaN for a removed or unplaced node.
      const byId = this.store.positions.subarray(0, this.store.nodeCount * 2);
      for (const listener of this.changeListeners) listener(byId, status);
    });

    this.layout.on('communities', (levels) => this.name(levels));

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
      this.pointing(),
    );
  }

  /** Hover and click. Panning and zooming are `attachControls`'. */
  private pointing(): () => void {
    let pressed: { id: number; x: number; y: number } | null = null;
    const nodeAt = (event: PointerEvent): number | null => {
      if (!this.placed) return null;
      if (this.staleHits) {
        this.hits.build(this.store.positions, this.store.radii, this.store.nodeCount);
        this.staleHits = false;
      }
      const box = this.canvas.getBoundingClientRect();
      const [x, y] = screenToWorld(
        this.view,
        this.size,
        event.clientX - box.left - this.canvas.clientLeft,
        event.clientY - box.top - this.canvas.clientTop,
      );
      return this.hits.at(x, y, this.view.zoom);
    };
    const stops = [
      this.listen('pointerdown', (event) => {
        const pointer = event as PointerEvent;
        this.glide = null;
        // A second finger makes it a pinch, not a click.
        pressed = pressed === null && pointer.button === 0
          ? { id: pointer.pointerId, x: pointer.clientX, y: pointer.clientY }
          : null;
      }),
      this.listen('pointermove', (event) => {
        const pointer = event as PointerEvent;
        if (pressed && pointer.pointerId === pressed.id) {
          if (Math.hypot(pointer.clientX - pressed.x, pointer.clientY - pressed.y) >= CLICK_SLOP) pressed = null;
          return;
        }
        if (pointer.buttons) return;
        this.hover(nodeAt(pointer));
      }),
      this.listen('pointerup', (event) => {
        const pointer = event as PointerEvent;
        const click = pressed && pointer.pointerId === pressed.id;
        pressed = null;
        if (!click) return;
        const id = nodeAt(pointer);
        if (id !== null) for (const listener of this.pointerListeners.nodeClick) listener(id);
      }),
      this.listen('pointercancel', () => (pressed = null)),
      this.listen('pointerleave', () => this.hover(null)),
    ];
    return () => stops.forEach((stop) => stop());
  }

  private hover(id: number | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    // Its label shows first.
    if (this.labels) this.invalidate();
    for (const listener of this.pointerListeners.nodeHover) listener(id);
  }

  /** Glides the camera to a node, zooming in if it is far out. */
  focusNode(id: number, { duration = FOCUS_MS }: { duration?: number } = {}): void {
    this.assertLoaded();
    this.flush();
    const x = this.store.positions[id * 2]!;
    const y = this.store.positions[id * 2 + 1]!;
    if (!this.store.isAlive(id)) throw new RangeError(`there is no node ${id}`);
    // Not placed yet: there is nowhere to go.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.following = false;
    const to = { x, y, zoom: Math.max(this.view.zoom, FOCUS_ZOOM) };
    if (duration <= 0) {
      this.glide = null;
      this.view = to;
    } else this.glide = { from: this.camera, to, start: performance.now(), duration };
    this.invalidate();
  }

  private advanceGlide(): void {
    if (!this.glide) return;
    const { from, to, start, duration } = this.glide;
    const t = Math.min(1, (performance.now() - start) / duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    // The zoom moves by ratios, so that it feels even.
    this.view = {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      zoom: from.zoom * (to.zoom / from.zoom) ** eased,
    };
    if (t >= 1) {
      this.view = { ...to };
      this.glide = null;
    }
  }

  /** Node ids, the best linked first: which labels win. */
  private labelOrder(): Uint32Array {
    if (!this.staleOrder) return this.order;
    this.staleOrder = false;
    const { store } = this;
    const strength = new Float64Array(store.nodeCount);
    for (let e = 0; e < store.edgeCount; e++) {
      const weight = store.weights[e]!;
      const added = weight > 0 && weight < Infinity ? weight : 0;
      strength[store.ends[e * 2]!]! += added;
      strength[store.ends[e * 2 + 1]!]! += added;
    }
    this.order = Uint32Array.from({ length: store.nodeCount }, (_, id) => id).sort(
      (a, b) => store.radii[b]! - store.radii[a]! || strength[b]! - strength[a]! || a - b,
    );
    return this.order;
  }

  private drawLabelLayer(frame: Frame): void {
    if (!this.labels) return;
    const { canvas, context, label, style } = this.labels;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.placed) return;
    context.font = `12px ${style.font}`;
    const boxes = placeLabels({
      order: this.labelOrder(),
      positions: this.store.positions,
      radii: this.store.radii,
      first: this.hovered,
      frame,
      style: this.hitStyle,
      label,
      measure: (text) => context.measureText(text).width,
    });
    drawLabels(context, boxes, frame, style);
  }

  /** Full load. Resets node ids; the caller keeps its arrays. */
  setGraph(data: GraphData): void {
    this.assertAlive();
    // The whole input is checked before anything changes.
    checkGraph(data);
    if (data.states && data.states.length !== data.nodeCount) throw new RangeError('states must hold one value per node');
    if (data.communities?.levels.some((level) => level.length !== data.nodeCount)) {
      throw new RangeError('each level of communities must hold one id per node');
    }
    this.store.load(data, data.positions);
    this.store.takeChanges();
    this.backend.setGraph(this.store.scene());
    this.fresh.clear();
    this.pending = false;
    this.staleHits = this.staleOrder = true;
    this.hovered = null;
    this.glide = null;
    clearTimeout(this.communityTimer);
    this.communities = data.communities ? { levels: data.communities.levels.map((level) => level.slice()) } : null;
    this.nextCommunity = 0;
    this.layout.setGraph(data);
    this.probe = 0;
    this.probed = false;
    if (this.communities) this.layout.detectCommunities({ nodeCount: 0, edges: new Uint32Array(0) });
    else this.scheduleCommunities();
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
    for (let i = 0; i < ids.length; i++) {
      this.fresh.delete(ids[i]!);
      // The slot may be reused: whatever comes next belongs to nothing yet.
      for (const level of this.communities?.levels ?? []) if (ids[i]! < level.length) level[ids[i]!] = NO_COMMUNITY;
    }
    this.scheduleCommunities();
    this.schedule();
  }

  addEdges(pairs: Uint32Array, weights?: Float32Array): void {
    this.assertLoaded();
    this.store.addEdges(pairs, weights);
    this.scheduleCommunities();
    this.schedule();
  }

  removeEdges(pairs: Uint32Array): void {
    this.assertLoaded();
    this.store.removeEdges(pairs);
    this.scheduleCommunities();
    this.schedule();
  }

  updateWeights(pairs: Uint32Array, weights: Float32Array): void {
    this.assertLoaded();
    this.store.updateWeights(pairs, weights);
    this.scheduleCommunities();
    this.schedule();
  }

  updateStates(ids: ArrayLike<number>, values: Float32Array): void {
    this.assertLoaded();
    this.store.updateStates(ids, values);
    this.schedule();
  }

  /** A community of the latest computation, or `null`. */
  getCommunity(id: number): Community | null {
    this.assertAlive();
    if (!this.communities) return null;
    return describeCommunity(this.communities, id, this.store.ends, this.store.weights, this.store.edgeCount);
  }

  private scheduleCommunities(): void {
    clearTimeout(this.communityTimer);
    this.communityTimer = setTimeout(() => {
      const { store } = this;
      // Removed slots are isolated here and marked as belonging to nothing on the way back.
      this.layout.detectCommunities({
        nodeCount: store.nodeCount,
        edges: store.ends.slice(0, store.edgeCount * 2),
        weights: store.weights.slice(0, store.edgeCount),
      });
    }, COMMUNITIES_IDLE_MS);
  }

  private name(labels: Uint32Array[]): void {
    // The empty request that outdates an older computation after a load with saved ones.
    if (labels[0]!.length === 0) return;
    for (const level of labels) {
      for (let id = 0; id < level.length; id++) if (!this.store.isAlive(id)) level[id] = NO_COMMUNITY;
    }
    const { assignment, nextId } = keepIds(this.communities, labels, this.nextCommunity);
    this.communities = assignment;
    this.nextCommunity = nextId;
    for (const listener of this.pointerListeners.communitiesChange) {
      listener({ levels: assignment.levels.map((level) => level.slice()) });
    }
  }

  /** The bloom resolution frames are drawn with now. */
  get glow(): number {
    return this.quality ? this.quality.glow : this.fixedGlow;
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

  on<K extends keyof GraphEvents>(event: K, listener: GraphEvents[K]): void {
    if (event === 'layoutChange') this.changeListeners.add(listener as LayoutEvents['layoutChange']);
    else if (event === 'layoutError') this.layout.on('layoutError', listener as LayoutEvents['layoutError']);
    else (this.pointerListeners[event as keyof PointerEvents] as Set<unknown>).add(listener);
  }

  off<K extends keyof GraphEvents>(event: K, listener: GraphEvents[K]): void {
    if (event === 'layoutChange') this.changeListeners.delete(listener as LayoutEvents['layoutChange']);
    else if (event === 'layoutError') this.layout.off('layoutError', listener as LayoutEvents['layoutError']);
    else (this.pointerListeners[event as keyof PointerEvents] as Set<unknown>).delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.communityTimer);
    for (const detach of this.detach) detach();
    this.layout.destroy();
    this.backend.destroy();
    this.loaded = false;
    this.placed = false;
    this.changeListeners.clear();
    for (const listeners of Object.values(this.pointerListeners)) listeners.clear();
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
    this.staleHits = this.staleOrder = true;
    if (this.hovered !== null && !this.store.isAlive(this.hovered)) this.hover(null);
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
      // Once per load, with the whole graph in place.
      if (this.quality && !this.probed) {
        this.probed = true;
        this.probe = PROBE_FRAMES;
      }
    }
    this.showPositions();
  }

  private showPositions(): void {
    this.placed = true;
    this.staleHits = true;
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
    this.glide = null;
    this.view = camera;
    this.invalidate();
  }

  private resize(size: CanvasSize): void {
    this.size = size;
    if (this.canvas.width !== size.pixelWidth) this.canvas.width = size.pixelWidth;
    if (this.canvas.height !== size.pixelHeight) this.canvas.height = size.pixelHeight;
    if (this.labels) {
      this.labels.canvas.width = size.pixelWidth;
      this.labels.canvas.height = size.pixelHeight;
    }
    if (this.following) this.refit();
    // Resizing cleared the canvas: drawing now, before the paint, avoids a blank frame.
    this.draw();
  }

  /** Draws at the next frame, once however often it is asked. */
  private invalidate(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame((time) => this.draw(time));
  }

  /** `time` is the frame's, absent when drawing outside an animation frame. */
  private draw(time?: number): void {
    // Only the interval after a frame that asked for this one tells how fast frames are.
    if (this.quality && time !== undefined && this.chained !== null) this.quality.sample(time - this.chained);
    this.chained = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const { pixelWidth, pixelHeight, width } = this.size;
    if (this.lost || this.destroyed || pixelWidth === 0 || pixelHeight === 0) return;
    this.advanceGlide();
    const frame = {
      width: pixelWidth,
      height: pixelHeight,
      pixelRatio: pixelWidth / width,
      camera: this.view,
      glow: this.glow,
    };
    this.backend.render(frame);
    // The same camera, in the same frame: labels never float behind their nodes.
    this.drawLabelLayer(frame);
    const measuring = this.probe > 0;
    if (measuring) this.probe--;
    if (this.glide || measuring) {
      this.invalidate();
      this.chained = time ?? null;
    }
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
