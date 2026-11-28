// What MyelinGraph needs from a graphics API. WebGL2 implements it now; a WebGPU backend
// can be added behind it without touching the public API.

import type { Camera } from '../camera.ts';
import type { Beams } from '../effects.ts';

export type Rgb = readonly [number, number, number];

export interface Style {
  background: Rgb;
  node: Rgb;
  activeNode: Rgb;
  edge: Rgb;
  strongEdge: Rgb;
  /** World radius that `minNodeRadius` refers to. */
  nodeRadius: number;
  /** CSS pixels. */
  minNodeRadius: number;
  maxNodeRadius: number;
  /** CSS pixels, at strength 0 and 1. */
  edgeWidth: readonly [number, number];
  /** Opacity at strength 0 and 1. */
  edgeAlpha: readonly [number, number];
  /** Light along edges. */
  pulse: Rgb;
  /** The colors constellations glow in. */
  constellations: readonly Rgb[];
}

/**
 * The arrays may be longer than the counts need (room to grow): only the first
 * `nodeCount` nodes and `edgeCount` edges are drawn. A node of radius 0 is not.
 */
export interface Scene {
  nodeCount: number;
  edgeCount: number;
  /** `[source0, target0, source1, target1, ...]` */
  edges: Uint32Array;
  /** One per edge, 0 to 1. */
  strengths: Float32Array;
  /** World radius, one per node. */
  radii: Float32Array;
  /** Glow / activity, one per node, 0 to 1. */
  states: Float32Array;
}

export interface Frame {
  /** Size of the target in device pixels. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel. */
  pixelRatio: number;
  camera: Camera;
  /** Bloom resolution as a share of the frame's; 0 or absent: no glow. */
  glow?: number;
  /** Strength of the constellation glow of each level, 0 to 1. */
  constellations?: { coarse: number; fine: number };
  /** The size change of active nodes, -1 to 1. */
  breath?: number;
  beams?: Beams;
}

export interface Backend {
  /** Replaces the graph. Nothing is drawn until `setPositions`. The arrays may be reused. */
  setGraph(scene: Scene): void;
  /**
   * Uploads what changed in a scene whose arrays are the ones of the last `setGraph`:
   * `[from, to)` of nodes and of edges, and the new counts.
   */
  updateGraph(scene: Scene, nodes: [number, number] | null, edges: [number, number] | null): void;
  /**
   * The constellation color of each node at the coarsest and the finest level, as an
   * index into `style.constellations` (255: none). As long as the scene's node arrays;
   * given again after every `setGraph`.
   */
  setColors(coarse: Float32Array, fine: Float32Array): void;
  /** `[x0, y0, ...]` for every node of the graph, all finite. The array may be reused. */
  setPositions(positions: Float32Array): void;
  render(frame: Frame): void;
  destroy(): void;
}

export type BackendFactory = (canvas: HTMLCanvasElement, style: Style) => Backend;
