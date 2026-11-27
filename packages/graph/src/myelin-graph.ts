// The graph on a canvas: composes the layout worker, the camera and its controls, and a
// graphics backend. It draws only when something changed.

import type { Backend, BackendFactory, Scene } from './backend/backend.ts';
import { WebGL2Backend } from './backend/webgl2.ts';
import { boundsOf, fit, pan, zoomAt, type Camera } from './camera.ts';
import { attachControls } from './controls.ts';
import { GraphLayout, type GraphLayoutOptions, type LayoutEvents } from './layout/graph-layout.ts';
import { checkGraph, type LayoutOptions } from './layout/forceatlas2.ts';
import { observeCanvasSize, type CanvasSize } from './resize.ts';
import { buildScene, createStyle, type GraphColors, type SceneInput } from './scene.ts';

/** Furthest zoom out: this share of the zoom that shows the whole graph. */
const MIN_ZOOM_OF_FIT = 0.25;
const MAX_ZOOM = 16;

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
  private scene: Scene | null = null;
  /** The latest positions of every node; null until all of them are known. */
  private positions: Float32Array | null = null;
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
    // First listener: the host's ones see the graph already updated.
    this.layout.on('layoutChange', (positions) => this.place(positions));

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
    const scene = buildScene(data);
    this.backend.setGraph(scene);
    this.layout.setGraph(data);
    this.scene = scene;
    this.positions = null;
    this.following = true;
    // Saved positions are drawn at once; otherwise the first layout update does it.
    if (data.positions?.every(Number.isFinite)) this.place(data.positions);
    else this.invalidate();
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
    this.layout.on(event, listener);
  }

  off<K extends keyof LayoutEvents>(event: K, listener: LayoutEvents[K]): void {
    this.layout.off(event, listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    for (const detach of this.detach) detach();
    this.layout.destroy();
    this.backend.destroy();
    this.scene = null;
    this.positions = null;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('the graph was destroyed');
  }

  private listen(type: string, listener: (event: Event) => void): () => void {
    this.canvas.addEventListener(type, listener);
    return () => this.canvas.removeEventListener(type, listener);
  }

  /** `positions` may be reused by the caller once this returns: it is copied. */
  private place(positions: Float32Array): void {
    if (this.positions?.length === positions.length) this.positions.set(positions);
    else this.positions = positions.slice();
    this.backend.setPositions(this.positions);
    if (this.following) this.refit();
    this.invalidate();
  }

  private refit(): void {
    if (!this.positions || this.size.width <= 0 || this.size.height <= 0) return;
    const bounds = boundsOf(this.positions);
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
    if (this.scene) this.backend.setGraph(this.scene);
    if (this.positions) this.backend.setPositions(this.positions);
    this.invalidate();
  }
}
