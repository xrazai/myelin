import { describe, expect, test, vi } from 'vitest';
import type { GraphDelta, GraphSnapshot } from '../shared/ipc';
import { graphLook, mix } from './graph-look';
import { GraphModel, SavedCommunities } from './graph-model';
import { createGraphView, type Graph } from './graph-view';

const snapshot = (paths: string[], edges: number[], positions?: number[]): GraphSnapshot => ({
  paths,
  edited: new Float64Array(paths.length),
  communities: null,
  edges: Uint32Array.from(edges),
  positions: Float32Array.from(positions ?? paths.flatMap(() => [NaN, NaN])),
});

const delta = (changes: Partial<GraphDelta>): GraphDelta => ({
  removed: [],
  added: [],
  positions: new Float32Array(0),
  removedEdges: [],
  addedEdges: [],
  edited: [],
  ...changes,
});

describe('GraphModel', () => {
  test('a delta keeps the nodes that stay and says what else to do', () => {
    const model = new GraphModel();
    model.load(snapshot(['a.md', 'b.md', 'c.md'], [0, 1, 1, 2]));
    const next = delta({
      removed: ['b.md'],
      added: ['d.md'],
      positions: Float32Array.of(5, 6),
      removedEdges: [['a.md', 'b.md']],
      addedEdges: [['c.md', 'a.md'], ['d.md', 'a.md']],
    });
    const changes = model.apply(next);
    expect([...changes.removeEdges]).toEqual([0, 1]);
    expect(changes.removeNodes).toEqual([1]);
    expect(changes.addNodes.paths).toEqual(['d.md']);
    expect([...changes.addNodes.positions]).toEqual([5, 6]);
    // The freed slot is reused, and does not look linked to what its old note linked.
    expect([...model.assign(next, changes.addNodes.paths, [1])]).toEqual([2, 0, 1, 0]);
    expect([model.id('d.md'), model.path(1), model.id('b.md'), model.linked(1, 2)]).toEqual([1, 'd.md', undefined, false]);
    // The other direction of a pair is the same edge.
    expect(model.assign(delta({ addedEdges: [['a.md', 'c.md']] }), [], [])).toHaveLength(0);
  });

  test('renamed notes keep their node when the index reports them as new', () => {
    const model = new GraphModel();
    model.load(snapshot(['a.md', 'b.md'], [0, 1]));
    model.rename([['a.md', 'b.md'], ['b.md', 'c.md']]);
    expect([model.id('b.md'), model.id('c.md'), model.path(0)]).toEqual([0, 1, 'b.md']);
    const next = delta({
      removed: ['a.md'],
      added: ['c.md'],
      positions: Float32Array.of(NaN, NaN),
      removedEdges: [['a.md', 'b.md']],
      addedEdges: [['b.md', 'c.md']],
    });
    const changes = model.apply(next);
    expect([changes.removeEdges.length, changes.removeNodes, changes.addNodes.paths]).toEqual([0, [], []]);
    expect(model.assign(next, [], [])).toHaveLength(0);
    expect(model.placed(Float32Array.of(1, 2, NaN, NaN))).toEqual({ paths: ['b.md'], positions: Float32Array.of(1, 2) });
  });
});

describe('graph view', () => {
  test('loads, follows changes, pulses a new link once it is there and saves positions', async () => {
    vi.useFakeTimers();
    let next = delta({});
    let changed = () => {};
    let layout: (positions: Float32Array, status: { done: boolean }) => void = () => {};
    const graph = {
      setGraph: vi.fn(),
      addNodes: vi.fn(() => new Uint32Array(0)),
      removeNodes: vi.fn(),
      addEdges: vi.fn(),
      removeEdges: vi.fn(),
      updateStates: vi.fn(),
      pulseEdge: vi.fn(),
      highlightNode: vi.fn(),
      focusNode: vi.fn(),
      focusCommunity: vi.fn(),
      getCommunity: vi.fn(() => null),
      destroy: vi.fn(),
      on: vi.fn((event: string, listener: never) => {
        if (event === 'layoutChange') layout = listener;
      }),
    };
    const saveGraphPositions = vi.fn(async () => {});
    const view = createGraphView({
      canvas: {} as HTMLCanvasElement,
      labelCanvas: {} as HTMLCanvasElement,
      api: {
        getGraph: async () => snapshot(['a.md', 'b.md'], []),
        getGraphChanges: async () => next,
        saveGraphPositions,
        saveGraphCommunities: async () => {},
        onGraphChange: (listener) => ((changed = listener), () => {}),
        onIndexing: () => () => {},
      },
      colors: {},
      labelStyle: {},
      onopen: () => {},
      onerror: () => {},
      createGraph: () => graph as unknown as Graph,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(graph.setGraph).toHaveBeenCalledTimes(1);

    view.highlight('b.md');
    expect(graph.highlightNode).toHaveBeenLastCalledWith(1);

    // The save's pulse comes before the index has the link.
    view.pulse({ source: 'a.md', targets: ['b.md'] });
    expect(graph.pulseEdge).not.toHaveBeenCalled();
    next = delta({ addedEdges: [['a.md', 'b.md']] });
    changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(graph.addEdges).toHaveBeenCalledWith(Uint32Array.of(0, 1));
    expect(graph.pulseEdge).toHaveBeenCalledWith(0, 1);

    const buffer = Float32Array.of(1, 2, 3, 4);
    layout(buffer, { done: true });
    buffer.fill(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveGraphPositions).toHaveBeenCalledWith(['a.md', 'b.md'], Float32Array.of(1, 2, 3, 4));
    view.destroy();
    expect(graph.destroy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('takes its colors from the identity tokens', () => {
    const tokens: Record<string, string> = {
      '--bg-panel': ' #0b0f0e', '--accent': '#52b788', '--learning': '#f3e9d2', '--text': '#e2e8e5',
      '--text-muted': '#8a9992', '--font-ui': 'Inter',
    };
    const look = graphLook({ getPropertyValue: (name) => tokens[name] ?? '' });
    expect(look.colors.background).toBe('#0b0f0e');
    expect(look.colors.constellations).toHaveLength(6);
    expect(new Set(look.colors.constellations).size).toBe(6);
    expect(mix('#000000', '#ffffff')).toBe('#808080');
  });
});

describe('SavedCommunities', () => {
  test('after the first save, only what changed is saved, new nodes included', () => {
    const saved = new SavedCommunities();
    const levels = () => [Uint32Array.of(1, 1, 2), Uint32Array.of(3, 3, 3)];
    expect(saved.changed(levels())).toEqual([0, 1, 2]);
    expect(saved.changed(levels())).toEqual([]);
    saved.forget([1]);
    const next = levels();
    next[0]![2] = 5;
    expect(saved.changed(next)).toEqual([1, 2]);
    // Another number of levels: all of them.
    expect(saved.changed([next[0]!])).toEqual([0, 1, 2]);
    saved.reset([Uint32Array.of(1, 1)]);
    expect(saved.changed([Uint32Array.of(1, 1, 1)])).toEqual([2]);
  });
});
