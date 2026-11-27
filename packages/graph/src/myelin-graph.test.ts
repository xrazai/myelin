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
  setGraph(scene: Scene) {
    this.scene = scene;
    this.positions = null;
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
