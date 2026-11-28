// Semantic zoom: which communities glow and are named at a zoom, which color each one
// takes, and where its name goes. Plain TS.

import { NO_COMMUNITY } from './communities.ts';

/** A node that is in no constellation. */
export const NO_COLOR = 255;
/** Smaller communities are not constellations. */
export const MIN_CONSTELLATION = 3;

/** Zoom is CSS px per world unit: a node with no edges is 14 units wide in radius. */
const FAR: [number, number] = [0.08, 0.16];
const NEAR: [number, number] = [0.35, 0.6];
/** Which names show: subjects, then their parts, then only nodes. */
const COARSE_NAMES_BELOW = 0.12;
const FINE_NAMES_BELOW = 0.45;
/** Between subjects and notes only the hubs are named. */
const HUB_LABELS = 30;

export interface ZoomView {
  /** Strength of the glow of the coarsest level, 0 to 1. */
  coarse: number;
  /** Of the finest level. */
  fine: number;
  /** Which level is named, if any. */
  names: 'coarse' | 'fine' | null;
  /** How many node labels at most; `null`: no limit of its own. */
  nodeLabels: number | null;
}

function smooth(value: number, [from, to]: [number, number]): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** What shows at `zoom`: far, the subjects; between, their parts and the hubs; near, notes. */
export function zoomView(zoom: number): ZoomView {
  const leaving = smooth(zoom, FAR);
  const names = zoom < COARSE_NAMES_BELOW ? 'coarse' : zoom < FINE_NAMES_BELOW ? 'fine' : null;
  return {
    coarse: 1 - leaving,
    fine: leaving * (1 - smooth(zoom, NEAR)),
    names,
    nodeLabels: names === 'coarse' ? 0 : names === 'fine' ? HUB_LABELS : null,
  };
}

/**
 * The color index of each node (`NO_COLOR` for none), so that communities that link to
 * each other take different colors where the palette allows. A community keeps the color
 * of its id unless a larger neighbor has it.
 */
export function communityColors(
  level: Uint32Array,
  edges: Uint32Array,
  weights: Float32Array,
  edgeCount: number,
  palette: number,
  capacity: number,
): Float32Array {
  const colors = new Float32Array(capacity).fill(NO_COLOR);
  if (palette < 1) return colors;
  const sizes = new Map<number, number>();
  for (const id of level) if (id !== NO_COMMUNITY) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  const links = new Map<number, Map<number, number>>();
  const link = (from: number, to: number, weight: number) => {
    let row = links.get(from);
    if (!row) links.set(from, (row = new Map()));
    row.set(to, (row.get(to) ?? 0) + weight);
  };
  for (let e = 0; e < edgeCount; e++) {
    const a = level[edges[e * 2]!] ?? NO_COMMUNITY;
    const b = level[edges[e * 2 + 1]!] ?? NO_COMMUNITY;
    const weight = weights[e]!;
    if (a === b || a === NO_COMMUNITY || b === NO_COMMUNITY || !(weight > 0 && weight < Infinity)) continue;
    link(a, b, weight);
    link(b, a, weight);
  }
  const chosen = new Map<number, number>();
  const order = [...sizes]
    .filter(([, size]) => size >= MIN_CONSTELLATION)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const taken = new Float64Array(palette);
  for (const [id] of order) {
    taken.fill(0);
    for (const [other, weight] of links.get(id) ?? []) {
      const color = chosen.get(other);
      if (color !== undefined) taken[color]! += weight;
    }
    // From the id's own color on: the first that is free, else the least taken.
    let best = id % palette;
    for (let i = 1; i < palette; i++) {
      const color = (id + i) % palette;
      if (taken[color]! < taken[best]!) best = color;
    }
    chosen.set(id, best);
  }
  for (let node = 0; node < level.length && node < capacity; node++) {
    colors[node] = chosen.get(level[node]!) ?? NO_COLOR;
  }
  return colors;
}

export interface Constellation {
  id: number;
  size: number;
  /** Its best linked node. */
  topNode: number;
  /** World position of its center. */
  x: number;
  y: number;
}

/** The constellations of a level with at least one placed node, the largest first. */
export function constellations(level: Uint32Array, positions: Float32Array, radii: Float32Array): Constellation[] {
  const found = new Map<number, Constellation>();
  for (let node = 0; node < level.length; node++) {
    const id = level[node]!;
    const x = positions[node * 2]!;
    const y = positions[node * 2 + 1]!;
    if (id === NO_COMMUNITY || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const entry = found.get(id);
    if (!entry) found.set(id, { id, size: 1, topNode: node, x, y });
    else {
      entry.size++;
      entry.x += x;
      entry.y += y;
      // The radius grows with the degree.
      if (radii[node]! > radii[entry.topNode]!) entry.topNode = node;
    }
  }
  return [...found.values()]
    .filter((entry) => entry.size >= MIN_CONSTELLATION)
    .map((entry) => ({ ...entry, x: entry.x / entry.size, y: entry.y / entry.size }))
    .sort((a, b) => b.size - a.size || a.id - b.id);
}
