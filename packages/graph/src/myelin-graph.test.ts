// MyelinGraph against a fake canvas, backend and layout worker: what it uploads, when it
// draws, and what moves the camera. The shaders are proven by `bench --graph` and the demo.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Backend, Frame, Scene } from './backend/backend.ts';
import type { ToWorker } from './layout/protocol.ts';
import type { LayoutWorker } from './layout/graph-layout.ts';
import { MyelinGraph } from './myelin-graph.ts';

let frames: (() => void)[] = [];
let observers: ((entries: unknown[]) => void)[] = [];
const disconnect = vi.fn();

beforeEach(() => {
  frames = [];
  observers = [];
  vi.stubGlobal('devicePixelRatio', 2);
  vi.stubGlobal('requestAnimationFrame', (task: () => void) => frames.push(task));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (id) frames[id - 1] = () => {};
  });
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(report: (entries: unknown[]) => void) {
        observers.push(report);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const nextFrame = () => frames.splice(0).forEach((task) => task());
const resize = (width: number, height: number) =>
  observers.at(-1)!([{ contentRect: { width, height } }]);

class FakeBackend implements Backend {
  scene: Scene | null = null;
  positions: number[] | null = null;
  rendered: Frame[] = [];
  destroyed = false;
  updates: { nodes: [number, number] | null; edges: [number, number] | null }[] = [];
  loads = 0;
  setGraph(scene: Scene) {
    this.scene = scene;
    this.positions = null;
    this.loads++;
  }
  updateGraph(scene: Scene, nodes: [number, number] | null, edges: [number, number] | null) {
    this.scene = scene;
    this.updates.push({ nodes, edges });
  }
  colors: [number[], number[]] | null = null;
  setColors(coarse: Float32Array, fine: Float32Array) {
    this.colors = [[...coarse], [...fine]];
  }
  setPositions(positions: Float32Array) {
    this.positions = [...positions];
  }
  render(frame: Frame) {
    this.rendered.push({ ...frame, camera: { ...frame.camera } });
  }
  destroy() {
    this.destroyed = true;
  }
}

function setup() {
  const target = new EventTarget();
  const canvas = Object.assign(target, {
    width: 300,
    height: 150,
    clientLeft: 0,
    clientTop: 0,
    style: { touchAction: 'auto' },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  }) as unknown as HTMLCanvasElement;

  const sent: ToWorker[] = [];
  const worker: LayoutWorker = {
    onmessage: null,
    postMessage: (message) => void sent.push(message),
    terminate: vi.fn(),
  };
  const backends: FakeBackend[] = [];
  const graph = new MyelinGraph(canvas, {
    createWorker: () => worker,
    createBackend: () => {
      backends.push(new FakeBackend());
      return backends.at(-1)!;
    },
  });
  /** A layout update, as the worker sends it. */
  const layout = (...values: number[]) => {
    const start = sent.findLast((message) => message.type === 'start')!;
    const buffer = Float32Array.from(values).buffer;
    worker.onmessage!({
      data: { type: 'positions', run: start.run, buffer, iteration: 1, done: false, converged: false },
    });
  };
  const event = (type: string, fields: object = {}) =>
    canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
  return { graph, canvas, sent, worker, layout, event, backends, backend: () => backends.at(-1)! };
}

const data = (positions?: number[]) => ({
  nodeCount: 2,
  edges: Uint32Array.of(0, 1),
  positions: positions && Float32Array.from(positions),
});

describe('MyelinGraph', () => {
  test('sizes the backing store to device pixels and draws the new size at once', () => {
    const { canvas, backend } = setup();
    resize(400, 300);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(backend().rendered.at(-1)).toMatchObject({ width: 800, height: 600, pixelRatio: 2 });
  });

  test('draws saved positions at once and fits the camera to them', () => {
    const { graph, backend } = setup();
    resize(400, 300);
    graph.setGraph(data([0, 0, 3600, 0]));
    expect(backend().positions).toEqual([0, 0, 3600, 0]);
    nextFrame();
    expect(backend().rendered.at(-1)!.camera).toEqual({ x: 1800, y: 0, zoom: 0.1 });
  });

  test('without positions, nothing is placed until the layout reports; the host hears it after the graph', () => {
    const { graph, layout, backend } = setup();
    resize(400, 300);
    graph.setGraph(data());
    expect(backend().positions).toBeNull();
    const seen: unknown[] = [];
    graph.on('layoutChange', () => seen.push(backend().positions));
    layout(1, 2, 3, 4);
    expect(seen).toEqual([[1, 2, 3, 4]]);
  });

  test('draws once per frame however many changes came', () => {
    const { graph, layout, backend } = setup();
    resize(400, 300);
    graph.setGraph(data());
    const drawn = backend().rendered.length;
    layout(0, 0, 1, 1);
    layout(0, 0, 2, 2);
    nextFrame();
    expect(backend().rendered.length).toBe(drawn + 1);
  });

  test('the camera follows the layout until the user moves it, and again after fit', () => {
    const { graph, layout, event } = setup();
    resize(400, 300);
    graph.setGraph(data([0, 0, 360, 0]));
    layout(0, 0, 3600, 0);
    expect(graph.camera.x).toBe(1800);

    event('wheel', { deltaX: 10, deltaY: 0, deltaMode: 0, ctrlKey: false, clientX: 0, clientY: 0 });
    const moved = graph.camera;
    expect(moved.x).toBeCloseTo(1900);
    layout(0, 0, 360, 0);
    resize(500, 300);
    expect(graph.camera).toEqual(moved);

    graph.fit();
    expect(graph.camera.x).toBe(180);
  });

  test('a drag pans', () => {
    const { graph, event } = setup();
    resize(400, 300);
    graph.camera = { x: 0, y: 0, zoom: 2 };
    event('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    event('pointermove', { pointerId: 1, clientX: 30, clientY: 4 });
    event('pointerup', { pointerId: 1 });
    event('pointermove', { pointerId: 1, clientX: 99, clientY: 99 });
    expect(graph.camera).toEqual({ x: -10, y: 3, zoom: 2 });
  });

  test('two pointers pinch around their middle', () => {
    const { graph, event } = setup();
    resize(400, 300);
    graph.camera = { x: 0, y: 0, zoom: 1 };
    event('pointerdown', { button: 0, pointerId: 1, clientX: 150, clientY: 150 });
    event('pointerdown', { button: 0, pointerId: 2, clientX: 250, clientY: 150 });
    event('pointermove', { pointerId: 1, clientX: 100, clientY: 150 });
    expect(graph.camera.zoom).toBeCloseTo(1.5);
  });

  test('a restored context gets the graph again', () => {
    const { graph, layout, event, backends } = setup();
    resize(400, 300);
    graph.setGraph(data());
    layout(1, 2, 3, 4);
    expect(event('webglcontextlost')).toBe(false);
    const drawn = backends[0]!.rendered.length;
    resize(401, 300);
    expect(backends[0]!.rendered.length).toBe(drawn);
    event('webglcontextrestored');
    nextFrame();
    expect(backends).toHaveLength(2);
    expect(backends[1]!.scene!.nodeCount).toBe(2);
    expect(backends[1]!.positions).toEqual([1, 2, 3, 4]);
    expect(backends[1]!.rendered).toHaveLength(1);
  });

  test('a graph that does not check out changes nothing', () => {
    const { graph, sent, backend } = setup();
    resize(400, 300);
    graph.setGraph(data([0, 0, 1, 1]));
    const scene = backend().scene;
    expect(() => graph.setGraph({ ...data(), states: new Float32Array(1) })).toThrow(/states/);
    expect(() => graph.setGraph({ nodeCount: 1, edges: Uint32Array.of(0, 5) })).toThrow(RangeError);
    expect(backend().scene).toBe(scene);
    expect(sent.filter((message) => message.type === 'start')).toHaveLength(1);
  });

  test('destroy stops the layout, the observers and the listeners', () => {
    const { graph, canvas, worker, event, backend } = setup();
    resize(400, 300);
    graph.setGraph(data([0, 0, 1, 1]));
    const camera = graph.camera;
    disconnect.mockClear();
    graph.destroy();
    graph.destroy();
    nextFrame();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(backend().destroyed).toBe(true);
    expect(disconnect).toHaveBeenCalled();
    expect(canvas.style.touchAction).toBe('auto');
    event('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    event('pointermove', { pointerId: 1, clientX: 50, clientY: 50 });
    expect(graph.camera).toEqual(camera);
    expect(() => graph.setGraph(data())).toThrow(/destroyed/);
  });
});

describe('incremental changes', () => {
  /** A settled graph of three nodes in a row: 0 - 1, and 2 alone. */
  function settled() {
    const t = setup();
    resize(400, 300);
    t.graph.setGraph({ nodeCount: 3, edges: Uint32Array.of(0, 1), positions: Float32Array.of(0, 0, 100, 0, 500, 0) });
    t.layout(0, 0, 100, 0, 500, 0);
    const start = t.sent.findLast((message) => message.type === 'start')!;
    t.worker.onmessage!({
      data: { type: 'positions', run: start.run, buffer: Float32Array.of(0, 0, 100, 0, 500, 0).buffer, iteration: 2, done: true, converged: true },
    });
    return t;
  }
  const relaxes = (sent: ToWorker[]) => sent.flatMap((message) => (message.type === 'relax' ? [message] : []));

  test('one local pass for the changes of a task: the new node and its neighbor may move', async () => {
    const { graph, sent, backend } = settled();
    const loads = backend().loads;
    const [id] = graph.addNodes(1);
    graph.addEdges(Uint32Array.of(id!, 2));
    await Promise.resolve();
    expect(id).toBe(3);
    expect(relaxes(sent)).toHaveLength(1);
    const { graph: asked } = relaxes(sent)[0]!;
    expect([...asked.movable].sort()).toEqual([2, 3]);
    expect(backend().loads).toBe(loads);
    expect(backend().updates).toHaveLength(1);
  });

  test('removed slots are reused, ids stay stable and the host hears positions by id', async () => {
    const { graph, sent, worker } = settled();
    graph.removeNodes([1]);
    await Promise.resolve();
    expect(relaxes(sent)).toHaveLength(0);
    expect([...graph.addNodes(2)]).toEqual([1, 3]);
    await Promise.resolve();
    const seen: number[][] = [];
    graph.on('layoutChange', (positions) => seen.push([...positions]));
    const message = relaxes(sent)[0]!;
    worker.onmessage!({
      data: { type: 'positions', run: message.run, buffer: Float32Array.of(0, 0, 1, 1, 500, 0, 3, 3).buffer, iteration: 0, done: true, converged: true },
    });
    expect(seen).toEqual([[0, 0, 1, 1, 500, 0, 3, 3]]);
    expect(() => graph.removeNodes([9])).toThrow(/no node 9/);
  });

  test('changes need a graph first', () => {
    const { graph } = setup();
    expect(() => graph.addNodes(1)).toThrow(/setGraph/);
  });
});

describe('pointing and focus', () => {
  function ready() {
    const t = setup();
    resize(400, 300);
    t.graph.setGraph({ nodeCount: 2, edges: Uint32Array.of(0, 1), positions: Float32Array.of(0, 0, 100, 0) });
    t.graph.camera = { x: 0, y: 0, zoom: 1 };
    return t;
  }
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 0 });

  test('tells what the pointer is over and what is clicked, not what a drag passes', () => {
    const { graph, event } = ready();
    const hovered: (number | null)[] = [];
    const clicked: number[] = [];
    graph.on('nodeHover', (id) => hovered.push(id));
    graph.on('nodeClick', (id) => clicked.push(id));
    event('pointermove', at(200, 150));
    event('pointermove', at(201, 150));
    event('pointermove', at(200, 40));
    event('pointermove', at(300, 150));
    event('pointerleave');
    expect(hovered).toEqual([0, null, 1, null]);
    event('pointerdown', at(300, 150));
    event('pointerup', at(301, 150));
    event('pointerdown', at(200, 150));
    event('pointermove', { ...at(230, 150), buttons: 1 });
    event('pointerup', at(230, 150));
    expect(clicked).toEqual([1]);
  });

  test('glides to a node and ends exactly on it; the user takes the camera back', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { graph, event } = ready();
    graph.camera = { x: 0, y: 0, zoom: 0.25 };
    graph.focusNode(1, { duration: 600 });
    now.mockReturnValue(1300);
    nextFrame();
    expect(graph.camera.x).toBeCloseTo(50);
    expect(graph.camera.zoom).toBeCloseTo(0.5);
    now.mockReturnValue(1700);
    nextFrame();
    expect(graph.camera).toEqual({ x: 100, y: 0, zoom: 1 });
    graph.focusNode(0, { duration: 600 });
    event('pointerdown', at(10, 10));
    now.mockReturnValue(2500);
    nextFrame();
    expect(graph.camera.x).toBe(100);
    expect(() => graph.focusNode(7)).toThrow(/no node 7/);
    now.mockRestore();
  });
});

describe('communities', () => {
  const asked = (sent: ToWorker[]) => sent.flatMap((message) => (message.type === 'communities' ? [message] : []));

  test('are computed once the graph is quiet, and ids and getCommunity follow', () => {
    vi.useFakeTimers();
    const { graph, sent, worker } = setup();
    graph.setGraph({ nodeCount: 3, edges: Uint32Array.of(0, 1) });
    graph.addEdges(Uint32Array.of(1, 2));
    vi.advanceTimersByTime(999);
    expect(asked(sent)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(asked(sent)).toHaveLength(1);
    const seen: number[][] = [];
    graph.on('communitiesChange', ({ levels }) => seen.push([...levels[0]!]));
    // What the worker is given to keep ids and pick colors with.
    expect(asked(sent)[0]!.naming).toMatchObject({ previous: null, nextId: 0, alive: Uint8Array.of(1, 1, 1) });
    const levels = [Uint32Array.of(0, 0, 0).buffer];
    const colors = [new Float32Array(16).buffer, new Float32Array(16).buffer];
    worker.onmessage!({ data: { type: 'communities', run: asked(sent)[0]!.run, levels, nextId: 1, colors } });
    expect(seen).toEqual([[0, 0, 0]]);
    expect(graph.getCommunity(0)).toMatchObject({ size: 3, level: 0 });
    vi.useRealTimers();
  });

  test('a saved assignment is used at once, with nothing computed on load', () => {
    vi.useFakeTimers();
    const { graph, sent } = setup();
    graph.setGraph({ nodeCount: 2, edges: Uint32Array.of(0, 1), communities: { levels: [Uint32Array.of(7, 7)] } });
    vi.advanceTimersByTime(5000);
    expect(asked(sent).filter((message) => message.graph.nodeCount > 0)).toHaveLength(0);
    expect(graph.getCommunity(7)).toMatchObject({ size: 2 });
    expect(() => graph.setGraph({ nodeCount: 2, edges: new Uint32Array(0), communities: { levels: [Uint32Array.of(1)] } })).toThrow(/one id per node/);
    vi.useRealTimers();
  });
});

describe('adaptive quality in the graph', () => {
  /** Runs frames `gap` ms apart until none is asked for, and counts them. */
  const runFrames = (gap: number) => {
    let time = 0;
    let count = 0;
    while (frames.length > 0 && count < 500) {
      const tasks = frames.splice(0) as ((at: number) => void)[];
      time += gap;
      for (const task of tasks) task?.(time);
      count++;
    }
    return count;
  };
  const settle = (sent: ToWorker[], worker: LayoutWorker) => {
    const start = sent.findLast((message) => message.type === 'start')!;
    const buffer = Float32Array.of(0, 0, 100, 0).buffer;
    worker.onmessage!({
      data: { type: 'positions', run: start.run, buffer, iteration: 1, done: true, converged: true },
    });
  };

  test.each([
    [16, 0.5],
    [30, 0.25],
  ])('after the first layout, frames %i ms apart leave the glow at %d, and drawing stops', (gap, glow) => {
    const { graph, sent, worker, backend } = setup();
    resize(400, 300);
    graph.setGraph(data());
    settle(sent, worker);
    const drawn = runFrames(gap);
    expect(drawn).toBeGreaterThan(30);
    expect(drawn).toBeLessThan(60);
    expect(graph.glow).toBe(glow);
    expect(backend().rendered.at(-1)!.glow).toBeGreaterThan(0);
    graph.destroy();
  });
});

describe('effects in the graph', () => {
  test('a pulse draws its beam frame after frame, then drawing stops', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { graph, backend } = setup();
    resize(400, 300);
    graph.setGraph(data([0, 0, 100, 0]));
    nextFrame();
    graph.pulseEdge(0, 1);
    nextFrame();
    expect(backend().rendered.at(-1)!.beams).toMatchObject({ count: 1 });
    expect(frames.some(Boolean)).toBe(true);
    now.mockReturnValue(5000);
    nextFrame();
    expect(backend().rendered.at(-1)!.beams).toMatchObject({ count: 0 });
    nextFrame();
    const drawn = backend().rendered.length;
    nextFrame();
    expect(backend().rendered).toHaveLength(drawn);
    expect(() => graph.pulseEdge(0, 9)).toThrow(RangeError);
    graph.destroy();
    now.mockRestore();
  });

  test('saved communities color the nodes; a removed node loses its color', async () => {
    const { graph, backend } = setup();
    resize(400, 300);
    graph.setGraph({
      nodeCount: 4,
      edges: Uint32Array.of(0, 1, 1, 2, 2, 3),
      positions: Float32Array.of(0, 0, 10, 0, 20, 0, 30, 0),
      communities: { levels: [Uint32Array.of(1, 1, 1, 1)] },
    });
    nextFrame();
    const [coarse, fine] = backend().colors!;
    expect(coarse.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(fine).toEqual(coarse);
    expect(backend().rendered.at(-1)!.constellations).toBeDefined();
    graph.removeNodes([3]);
    await Promise.resolve();
    nextFrame();
    expect(backend().colors![0].slice(0, 4)).toEqual([1, 1, 1, 255]);
    graph.destroy();
  });
});

describe('pointing at constellations', () => {
  test('where no node is, a glowing one is hovered, clicked and double clicked; focus fits it', () => {
    const { graph, event } = setup();
    resize(400, 300);
    graph.setGraph({
      nodeCount: 3,
      edges: Uint32Array.of(0, 1, 1, 2),
      positions: Float32Array.of(-1000, 0, 1000, 0, 0, 900),
      communities: { levels: [Uint32Array.of(5, 5, 5)] },
    });
    nextFrame();
    const seen: unknown[] = [];
    graph.on('communityHover', (id) => seen.push(['hover', id]));
    graph.on('communityClick', (id) => seen.push(['click', id]));
    graph.on('communityDoubleClick', (id) => seen.push(['double', id]));
    // The center of the three, at the middle of the view.
    const { camera } = graph;
    const middle = { clientX: 200, clientY: 150 + (300 - camera.y) * camera.zoom, pointerId: 1, button: 0 };
    event('pointermove', { ...middle, buttons: 0 });
    event('pointerdown', middle);
    event('pointerup', middle);
    event('dblclick', middle);
    event('pointerleave');
    expect(seen).toEqual([['hover', 5], ['click', 5], ['double', 5], ['hover', null]]);

    graph.camera = { x: 5000, y: 5000, zoom: 3 };
    graph.focusCommunity(5, { duration: 0 });
    expect(graph.camera.x).toBeCloseTo(0);
    expect(graph.camera.zoom).toBeLessThan(0.2);
    graph.destroy();
  });
});
