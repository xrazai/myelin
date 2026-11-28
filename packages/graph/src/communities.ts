// Communities as the host knows them: ids that stay put between computations, and what
// each one holds. Plain TS.

/** A node with no community (a removed slot). */
export const NO_COMMUNITY = 0xffffffff;

/** One array per level, the finest first: the community id of each node id. */
export interface Assignment {
  levels: Uint32Array[];
}

export interface Community {
  id: number;
  /** 0 is the finest level. */
  level: number;
  size: number;
  /** The most central nodes: those with most weight to the rest of the community. */
  topNodes: number[];
  parent: number | null;
  children: number[];
  /** Other communities of the same level that it links to, the strongest first. */
  neighbors: { id: number; weight: number }[];
}

const TOP_NODES = 5;
const NEIGHBORS = 10;

/**
 * Gives each new community the id of the old one it shares most nodes with, one to one,
 * largest overlaps first; the others get new ids. Ids are unique across levels.
 */
export function keepIds(previous: Assignment | null, next: Uint32Array[], nextId: number): { assignment: Assignment; nextId: number } {
  let fresh = nextId;
  for (const level of previous?.levels ?? []) {
    for (const id of level) if (id !== NO_COMMUNITY && id >= fresh) fresh = id + 1;
  }
  const taken = new Set<number>();
  const levels = next.map((labels, depth) => {
    // The same depth first: a level matches the level it was.
    const old = previous?.levels[Math.min(depth, previous.levels.length - 1)];
    const overlaps = new Map<string, number>();
    for (let node = 0; node < labels.length; node++) {
      const was = old?.[node];
      if (labels[node] === NO_COMMUNITY || was === undefined || was === NO_COMMUNITY) continue;
      const pair = `${labels[node]} ${was}`;
      overlaps.set(pair, (overlaps.get(pair) ?? 0) + 1);
    }
    const names = new Map<number, number>();
    for (const [pair] of [...overlaps].sort((a, b) => b[1] - a[1])) {
      const [label, was] = pair.split(' ').map(Number) as [number, number];
      if (names.has(label) || taken.has(was)) continue;
      names.set(label, was);
      taken.add(was);
    }
    return labels.map((label) => {
      if (label === NO_COMMUNITY) return NO_COMMUNITY;
      let id = names.get(label);
      if (id === undefined) {
        id = fresh++;
        names.set(label, id);
        taken.add(id);
      }
      return id;
    });
  });
  return { assignment: { levels }, nextId: fresh };
}

/** Everything about the community `id`, or `null`. `edges` and `weights` as drawn. */
export function describeCommunity(
  { levels }: Assignment,
  id: number,
  edges: Uint32Array,
  weights: Float32Array,
  edgeCount: number,
): Community | null {
  const level = levels.findIndex((ids) => ids.includes(id));
  if (level === -1) return null;
  const ids = levels[level]!;
  const above = levels[level + 1];
  const below = levels[level - 1];
  const members: number[] = [];
  const children = new Set<number>();
  for (let node = 0; node < ids.length; node++) {
    if (ids[node] !== id) continue;
    members.push(node);
    const child = below?.[node];
    if (child !== undefined && child !== NO_COMMUNITY) children.add(child);
  }
  const inside = new Map<number, number>(members.map((node) => [node, 0]));
  const outside = new Map<number, number>();
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[e * 2]!;
    const b = edges[e * 2 + 1]!;
    const first = ids[a] ?? NO_COMMUNITY;
    const second = ids[b] ?? NO_COMMUNITY;
    if ((first !== id && second !== id) || a === b) continue;
    const weight = weights[e]!;
    if (!(weight > 0 && weight < Infinity)) continue;
    if (first === second) {
      inside.set(a, inside.get(a)! + weight);
      inside.set(b, inside.get(b)! + weight);
    } else {
      const other = first === id ? second : first;
      if (other !== NO_COMMUNITY) outside.set(other, (outside.get(other) ?? 0) + weight);
    }
  }
  const parent = above?.[members[0]!];
  return {
    id,
    level,
    size: members.length,
    topNodes: [...inside].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, TOP_NODES).map(([node]) => node),
    parent: parent === undefined || parent === NO_COMMUNITY ? null : parent,
    children: [...children],
    neighbors: [...outside]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, NEIGHBORS)
      .map(([other, weight]) => ({ id: other, weight })),
  };
}
