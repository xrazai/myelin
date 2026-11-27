// GraphLayout and the worker host over a real MessageChannel, so transfers really detach.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { GraphLayout, type GraphLayoutOptions, type LayoutStatus, type LayoutWorker } from './graph-layout.ts';
import { createLayoutHost, type HostOptions } from './host.ts';
import type { FromWorker, Port } from './protocol.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const graph = () => ({ nodeCount: 4, edges: Uint32Array.of(0, 1, 1, 2, 2, 3) });

function connect(options: GraphLayoutOptions = {}, host: HostOptions = {}) {
  const sent: FromWorker[] = [];
  let workers = 0;
  const createWorker = (): LayoutWorker => {
    workers++;
    const { port1, port2 } = new MessageChannel();
    const workerSide: Port<FromWorker> = {
      onmessage: null,
      postMessage(message, transfer) {
        sent.push({ ...message });
        port2.postMessage(message, transfer);
      },
    };
    port2.onmessage = (event) => workerSide.onmessage!(event);
    // Every iteration publishes, if it has a buffer.
    createLayoutHost(workerSide, { sliceMs: 0, reportMs: 0, ...host });
    const worker: LayoutWorker = {
      onmessage: null,
      postMessage: (message, transfer) => port1.postMessage(message, transfer),
      terminate: () => {
        port1.close();
        port2.close();
      },
    };
    port1.onmessage = (event) => worker.onmessage!(event);
    return worker;
  };
  const layout = new GraphLayout({ createWorker, ...options });
  cleanups.push(() => layout.destroy());
  return { layout, sent, workers: () => workers };
}

function finished(layout: GraphLayout) {
  return new Promise<{ positions: Float32Array; status: LayoutStatus }>((resolve) => {
    layout.on('layoutChange', (positions, status) => {
      if (status.done) resolve({ positions: positions.slice(), status });
    });
  });
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('GraphLayout', () => {
  test('publishes positions until the layout settles, through two buffers', async () => {
    const { layout } = connect();
    const buffers = new Set<ArrayBuffer>();
    const arrays: Float32Array[] = [];
    layout.on('layoutChange', (positions) => {
      // The previous array is still readable while the listeners run.
      if (arrays.length > 0) expect(arrays.at(-1)!.length).toBe(8);
      arrays.push(positions);
      buffers.add(positions.buffer as ArrayBuffer);
    });
    const end = finished(layout);
    layout.setGraph(graph());
    const { positions, status } = await end;
    expect(status.converged).toBe(true);
    expect(positions).toHaveLength(8);
    expect(layout.positions).toEqual(positions);
    expect(arrays.length).toBeGreaterThan(2);
    // Every array but the latest was transferred back to the worker.
    expect(arrays.slice(0, -1).map((array) => array.length)).toEqual(new Array(arrays.length - 1).fill(0));
    // Each transfer makes a new ArrayBuffer object, but only two are ever alive.
    expect([...buffers].filter((buffer) => buffer.byteLength > 0)).toHaveLength(1);
  });

  test('transfers, and never touches, the arrays of the caller', async () => {
    const { layout } = connect();
    const input = { ...graph(), weights: Float32Array.of(1, 2, 3), positions: new Float32Array(8).fill(NaN) };
    const end = finished(layout);
    layout.setGraph(input);
    expect([input.edges.length, input.weights.length, input.positions.length]).toEqual([6, 3, 8]);
    await end;
  });

  test('waits for a buffer to send the last positions', async () => {
    const { layout, sent } = connect({ maxIterations: 5 });
    const end = finished(layout);
    layout.setGraph(graph());
    expect((await end).status).toEqual({ iteration: 5, done: true, converged: false });
    expect(sent.filter((message) => message.type === 'positions' && message.done)).toHaveLength(1);
  });

  test('drops what is left of a replaced graph', async () => {
    const { layout } = connect();
    const lengths: number[] = [];
    layout.on('layoutChange', (positions) => lengths.push(positions.length));
    layout.setGraph(graph());
    await wait();
    layout.setGraph({ nodeCount: 6, edges: Uint32Array.of(0, 5) });
    lengths.length = 0;
    await finished(layout);
    expect(new Set(lengths)).toEqual(new Set([12]));
  });

  test('stops sending after stop, and runs again after it', async () => {
    const { layout, sent, workers } = connect({ stopThreshold: 0, maxIterations: 1e6 });
    const listener = vi.fn();
    layout.on('layoutChange', listener);
    layout.setGraph(graph());
    await wait();
    layout.stop();
    await wait();
    const count = [listener.mock.calls.length, sent.length];
    await wait();
    expect([listener.mock.calls.length, sent.length]).toEqual(count);
    layout.setGraph(graph());
    await wait();
    expect(listener.mock.calls.length).toBeGreaterThan(count[0]!);
    expect(workers()).toBe(1);
  });

  test('finishes an empty graph', async () => {
    const { layout } = connect();
    const end = finished(layout);
    layout.setGraph({ nodeCount: 0, edges: new Uint32Array(0) });
    expect((await end).positions).toHaveLength(0);
  });

  test('throws on a bad graph before starting a worker', () => {
    const { layout, workers } = connect();
    expect(() => layout.setGraph({ nodeCount: 1, edges: Uint32Array.of(0, 1) })).toThrow(RangeError);
    expect(workers()).toBe(0);
  });

  test('reports a failure of the solver', async () => {
    const { layout } = connect({}, { schedule: () => { throw new Error('boom'); } });
    const error = new Promise<Error>((resolve) => layout.on('layoutError', resolve));
    layout.setGraph(graph());
    expect((await error).message).toBe('boom');
  });
});
