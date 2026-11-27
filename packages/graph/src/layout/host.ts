// The worker side: runs the solver in slices, so that messages get in between them, and
// publishes positions through two buffers that go back and forth (double buffering).

import { ForceAtlas2 } from './forceatlas2.ts';
import type { FromWorker, Port, ToWorker } from './protocol.ts';

export interface HostOptions {
  /** Runs `task` after pending messages. */
  schedule?: (task: () => void) => void;
  /** Iterations run for about this long before yielding; at least one runs. */
  sliceMs?: number;
  /** Shortest time between two position updates (the last one is always sent). */
  reportMs?: number;
}

interface Run {
  id: number;
  layout: ForceAtlas2;
  /** Buffers the worker owns now. */
  free: ArrayBuffer[];
  reportedAt: number;
  /** The last iteration published; -1 for none. */
  reported: number;
}

export function createLayoutHost(port: Port<FromWorker>, options: HostOptions = {}): void {
  const { schedule = (task) => setTimeout(task, 0), sliceMs = 16, reportMs = 33 } = options;
  let run: Run | null = null;

  function report(current: Run, now: number): void {
    const buffer = current.free.pop();
    // The main thread still holds both: skip this update instead of allocating.
    if (!buffer) return;
    const { layout } = current;
    new Float32Array(buffer).set(layout.positions);
    current.reportedAt = now;
    current.reported = layout.iteration;
    const { iteration, done, converged } = layout;
    port.postMessage({ type: 'positions', run: current.id, buffer, iteration, done, converged }, [buffer]);
    if (done && run === current) run = null;
  }

  function tick(current: Run): void {
    // A newer `start` or a `stop` replaced it.
    if (run !== current) return;
    const { layout } = current;
    try {
      const started = performance.now();
      let now = started;
      do {
        layout.step();
        now = performance.now();
      } while (!layout.done && now - started < sliceMs);
      if (layout.done || current.reported < 0 || now - current.reportedAt >= reportMs) report(current, now);
    } catch (error) {
      fail(current.id, error);
      return;
    }
    // A finished run that could not report waits for a buffer to come back.
    if (!layout.done) schedule(() => tick(current));
  }

  function fail(id: number, error: unknown): void {
    run = null;
    port.postMessage({ type: 'error', run: id, message: error instanceof Error ? error.message : String(error) }, []);
  }

  port.onmessage = (event: { data: ToWorker }) => {
    const message = event.data;
    if (message.type === 'stop') {
      run = null;
    } else if (message.type === 'buffer') {
      if (run?.id !== message.run) return;
      run.free.push(message.buffer);
      if (run.layout.done) report(run, performance.now());
    } else {
      try {
        const layout = new ForceAtlas2(message.graph, message.options);
        const bytes = message.graph.nodeCount * 2 * Float32Array.BYTES_PER_ELEMENT;
        const current: Run = {
          id: message.run,
          layout,
          free: [new ArrayBuffer(bytes), new ArrayBuffer(bytes)],
          reportedAt: 0,
          reported: -1,
        };
        run = current;
        schedule(() => tick(current));
      } catch (error) {
        fail(message.run, error);
      }
    }
  };
}
