// Glue between the vault and `@myelin/graph` (AGENTS.md, rule 4): feeds it the notes and
// links of the index, keeps it current, saves its positions by note path and wires its
// events. Plain TS, outside Svelte's reactivity.
import { MyelinGraph, type MyelinGraphOptions } from '@myelin/graph';
import type { GraphDelta, GraphSnapshot, MyelinApi } from '../shared/ipc';
import { describeConstellation, type ConstellationInfo } from './constellation';
import type { LinkPulse } from './editor/link-pulse';
import { GraphModel, SavedCommunities } from './graph-model';

/** The graph is read again once the index has been quiet this long. */
const REFRESH_MS = 800;
/** Positions are saved this long after the layout stops, and at least this often while it runs. */
const SAVE_MS = 1000;
const SAVE_EVERY_MS = 15000;
/** A pulse waits this long at most for its link to reach the graph. */
const PULSE_WAIT_MS = 15000;
/** Nodes that were just linked stay active this long. */
const ACTIVE_MS = 6000;

export type GraphApi = Pick<
  MyelinApi,
  'getGraph' | 'getGraphChanges' | 'saveGraphPositions' | 'saveGraphCommunities' | 'onGraphChange' | 'onIndexing'
>;

/** What the view uses of `MyelinGraph`. */
export type Graph = Pick<
  MyelinGraph,
  | 'setGraph'
  | 'addNodes'
  | 'removeNodes'
  | 'addEdges'
  | 'removeEdges'
  | 'updateStates'
  | 'pulseEdge'
  | 'highlightNode'
  | 'focusNode'
  | 'focusCommunity'
  | 'getCommunity'
  | 'on'
  | 'destroy'
>;

export interface GraphViewOptions {
  canvas: HTMLCanvasElement;
  labelCanvas: HTMLCanvasElement;
  api: GraphApi;
  colors: NonNullable<MyelinGraphOptions['colors']>;
  labelStyle: NonNullable<MyelinGraphOptions['labelStyle']>;
  /** A node was clicked. */
  onopen: (path: string) => void;
  /** The constellation under the pointer, or `null`. */
  onhover?: (constellation: ConstellationInfo | null) => void;
  /** A constellation was clicked. */
  onselect?: (constellation: ConstellationInfo) => void;
  /** The constellations or the notes changed: what was described may be out of date. */
  onchange?: () => void;
  /** The graph cannot be drawn. */
  onerror: (message: string) => void;
  /** For tests. */
  createGraph?: (canvas: HTMLCanvasElement, options: MyelinGraphOptions) => Graph;
}

export interface GraphView {
  /** Notes about to show up under other paths keep their nodes. */
  renamed(moves: Iterable<readonly [string, string]>): void;
  /** Shows a note as if its node were hovered; `null` ends it. */
  highlight(path: string | null): void;
  /** Light from a note along each new link, once the graph has it. */
  pulse(pulse: LinkPulse): void;
  /** Glides to a note, if the graph has it. */
  focus(path: string): void;
  focusConstellation(id: number): void;
  /** What a constellation holds now, or `null` once it is gone. */
  constellation(id: number): ConstellationInfo | null;
  destroy(): void;
}

const title = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.md'.length);

export function createGraphView(options: GraphViewOptions): GraphView {
  const { api, canvas, labelCanvas, colors, labelStyle, onopen, onerror } = options;
  const model = new GraphModel();
  const create = options.createGraph ?? ((target, look) => new MyelinGraph(target, look));
  const graph = create(canvas, {
    colors,
    labelStyle,
    labelCanvas,
    getLabel: (id) => title(model.path(id) ?? ''),
  });

  let destroyed = false;
  let loaded = false;
  /** The latest positions by node id, not yet saved. */
  let unsaved: Float32Array | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveDeadline: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let again = false;
  let pulses: (LinkPulse & { until: number })[] = [];
  const saved = new SavedCommunities();
  /** When each note last changed. */
  let edited = new Map<string, number>();

  const constellation = (id: number): ConstellationInfo | null =>
    loaded
      ? describeConstellation(
          {
            community: (of) => graph.getCommunity(of),
            path: (node) => model.path(node),
            title,
            edited: (path) => edited.get(path) ?? 0,
          },
          id,
        )
      : null;
  const cooling = new Set<ReturnType<typeof setTimeout>>();

  function save(): void {
    clearTimeout(saveTimer);
    clearTimeout(saveDeadline);
    saveDeadline = undefined;
    if (!unsaved) return;
    const { paths, positions } = model.placed(unsaved);
    unsaved = null;
    if (paths.length === 0) return;
    api.saveGraphPositions(paths, positions).catch((error: unknown) => console.error('[graph] saving positions:', error));
  }

  graph.on('layoutChange', (positions, { done }) => {
    // The buffer goes back to the worker: what is kept is copied.
    unsaved = positions.slice();
    clearTimeout(saveTimer);
    if (done) saveTimer = setTimeout(save, SAVE_MS);
    else saveDeadline ??= setTimeout(save, SAVE_EVERY_MS);
  });
  graph.on('layoutError', (error) => onerror(error.message));
  graph.on('nodeClick', (id) => {
    const path = model.path(id);
    if (path !== undefined) onopen(path);
  });

  graph.on('communityHover', (id) => options.onhover?.(id === null ? null : constellation(id)));
  graph.on('communityClick', (id) => {
    const found = constellation(id);
    if (found) options.onselect?.(found);
  });
  graph.on('communityDoubleClick', (id) => graph.focusCommunity(id));
  graph.on('communitiesChange', ({ levels }) => {
    const { paths, levels: byPath } = model.grouped(levels, saved.changed(levels));
    if (paths.length > 0) {
      api.saveGraphCommunities(paths, byPath).catch((error: unknown) => {
        console.error('[graph] saving communities:', error);
        // Not saved after all: the next computation saves them all.
        saved.reset(null);
      });
    }
    options.onchange?.();
  });

  /** A node that was just linked breathes, then goes quiet. */
  function activate(paths: string[]): void {
    const ids = () => paths.map((path) => model.id(path)).filter((id) => id !== undefined);
    const lit = ids();
    graph.updateStates(lit, new Float32Array(lit.length).fill(1));
    const timer = setTimeout(() => {
      cooling.delete(timer);
      const still = ids();
      graph.updateStates(still, new Float32Array(still.length));
    }, ACTIVE_MS);
    cooling.add(timer);
  }

  function firePulses(): void {
    const now = Date.now();
    pulses = pulses.filter(({ source, targets, until }) => {
      if (now > until) return false;
      const from = model.id(source);
      const to = targets.map((target) => model.id(target));
      if (from === undefined || to.some((id) => id === undefined || !model.linked(from, id))) return true;
      for (const id of to) graph.pulseEdge(from, id!);
      activate([source, ...targets]);
      return false;
    });
  }

  function load(snapshot: GraphSnapshot): void {
    edited = new Map(snapshot.paths.map((path, i) => [path, snapshot.edited[i]!]));
    model.load(snapshot);
    saved.reset(snapshot.communities);
    graph.setGraph({
      nodeCount: snapshot.paths.length,
      edges: snapshot.edges,
      positions: snapshot.positions,
      // Saved: the constellations are there at once.
      communities: snapshot.communities ? { levels: snapshot.communities } : undefined,
    });
    loaded = true;
  }

  /** `true` if anything changed: a save that touches no link leaves the graph alone. */
  function follow(delta: GraphDelta): boolean {
    for (const path of delta.removed) edited.delete(path);
    for (const [path, time] of delta.edited) edited.set(path, time);
    const changes = model.apply(delta);
    if (changes.removeEdges.length > 0) graph.removeEdges(changes.removeEdges);
    if (changes.removeNodes.length > 0) graph.removeNodes(changes.removeNodes);
    const { paths, positions } = changes.addNodes;
    const ids = paths.length > 0 ? graph.addNodes(paths.length, { positions }) : new Uint32Array(0);
    saved.forget(ids);
    const pairs = model.assign(delta, paths, ids);
    if (pairs.length > 0) graph.addEdges(pairs);
    return delta.edited.length > 0 || delta.removed.length > 0 || delta.removedEdges.length > 0 || pairs.length > 0;
  }

  /** The whole graph the first time, then what changed. `false`: nothing to show for it. */
  async function read(): Promise<boolean> {
    if (loaded) {
      const delta = await api.getGraphChanges();
      if (destroyed) return false;
      if (delta) {
        try {
          return follow(delta);
        } catch (error) {
          // Out of step with the index: loaded again from scratch.
          console.error('[graph] following the changes:', error);
        }
      }
    }
    // `null` while the vault is first indexed: the end of that asks again.
    const snapshot = await api.getGraph();
    if (destroyed || !snapshot) return false;
    load(snapshot);
    return true;
  }

  async function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const changed = await read();
        if (destroyed) return;
        if (loaded) firePulses();
        if (changed) options.onchange?.();
      } while (again);
    } catch (error) {
      console.error('[graph] reading the graph:', error);
    } finally {
      reading = false;
    }
  }

  function later(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), REFRESH_MS);
  }

  const stops = [api.onGraphChange(later), api.onIndexing((active) => !active && void refresh())];
  void refresh();

  return {
    renamed(moves) {
      model.rename(moves);
      later();
    },
    highlight(path) {
      if (loaded) graph.highlightNode(path === null ? null : (model.id(path) ?? null));
    },
    pulse(pulse) {
      pulses.push({ ...pulse, until: Date.now() + PULSE_WAIT_MS });
      if (loaded) firePulses();
    },
    focus(path) {
      const id = loaded ? model.id(path) : undefined;
      if (id !== undefined) graph.focusNode(id);
    },
    focusConstellation(id) {
      if (loaded) graph.focusCommunity(id);
    },
    constellation,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const stop of stops) stop();
      clearTimeout(refreshTimer);
      for (const timer of cooling) clearTimeout(timer);
      save();
      graph.destroy();
    },
  };
}
