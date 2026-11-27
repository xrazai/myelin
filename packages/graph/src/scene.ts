// What the backend draws: the graph's buffers, derived from the host's, and the style.

import type { Scene, Style } from './backend/backend.ts';

export interface GraphColors {
  background: string;
  node: string;
  /** Nodes mix toward this as their state goes from 0 to 1. */
  activeNode: string;
  edge: string;
  /** Edges mix toward this as their weight grows. */
  strongEdge: string;
}

/** Neutral: the host brings its own palette. */
export const DEFAULT_COLORS: GraphColors = {
  background: '#111111',
  node: '#9a9a9a',
  activeNode: '#ffffff',
  edge: '#666666',
  strongEdge: '#cccccc',
};

/** World radius of a node with no edges, in layout units. */
export const NODE_RADIUS = 14;
/** How much the square root of the degree adds to it. */
const DEGREE_GROWTH = 0.35;

/** Sizes in CSS pixels; each pair of edge values goes from the weakest to the strongest. */
const LOOK = {
  /** Smallest radius of a node with no edges; hubs keep a little more. */
  minNodeRadius: 0.9,
  maxNodeRadius: 32,
  edgeWidth: [0.5, 2] as [number, number],
  edgeAlpha: [0.05, 0.45] as [number, number],
};

/** `#rgb` or `#rrggbb` to `[r, g, b]` in 0..1. */
export function parseColor(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) throw new RangeError(`a color must be #rgb or #rrggbb, not "${color}"`);
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number];
}

export function createStyle(colors: Partial<GraphColors> = {}): Style {
  const all = { ...DEFAULT_COLORS, ...colors };
  return {
    ...LOOK,
    nodeRadius: NODE_RADIUS,
    background: parseColor(all.background),
    node: parseColor(all.node),
    activeNode: parseColor(all.activeNode),
    edge: parseColor(all.edge),
    strongEdge: parseColor(all.strongEdge),
  };
}

/**
 * A weight to a strength in 0..1: `w / (w + 1)`. It does not depend on the other weights,
 * so one edge changing never restyles the rest. Weight 1 gives 0.5.
 */
export function strength(weight: number): number {
  if (!(weight > 0)) return 0;
  return weight === Infinity ? 1 : weight / (weight + 1);
}

export interface SceneInput {
  nodeCount: number;
  /** `[source0, target0, source1, target1, ...]` */
  edges: Uint32Array;
  /** One per edge; 1 when absent. */
  weights?: Float32Array;
  /** One per node, 0 to 1; 0 when absent. */
  states?: Float32Array;
}

/** Copies what it keeps: the caller's arrays stay the caller's. */
export function buildScene({ nodeCount, edges, weights, states }: SceneInput): Scene {
  if (states && states.length !== nodeCount) throw new RangeError('states must hold one value per node');
  const degrees = new Uint32Array(nodeCount);
  for (let i = 0; i < edges.length; i += 2) {
    const source = edges[i]!;
    const target = edges[i + 1]!;
    // A self-loop is not drawn and links to nothing.
    if (source === target) continue;
    degrees[source]!++;
    degrees[target]!++;
  }
  const strengths = new Float32Array(edges.length / 2);
  for (let e = 0; e < strengths.length; e++) strengths[e] = strength(weights ? weights[e]! : 1);
  const radii = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) radii[i] = NODE_RADIUS * (1 + DEGREE_GROWTH * Math.sqrt(degrees[i]!));
  const glow = new Float32Array(nodeCount);
  if (states) {
    for (let i = 0; i < nodeCount; i++) glow[i] = states[i]! > 0 ? Math.min(1, states[i]!) : 0;
  }
  return { nodeCount, edges: edges.slice(), strengths, radii, states: glow };
}
