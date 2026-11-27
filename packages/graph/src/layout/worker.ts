// Entry point of the layout worker.

import { createLayoutHost } from './host.ts';
import type { FromWorker, Port } from './protocol.ts';

// Yields through a channel: nested `setTimeout(0)` is clamped to 4 ms.
const channel = new MessageChannel();
const tasks: (() => void)[] = [];
channel.port1.onmessage = () => tasks.shift()?.();

createLayoutHost(globalThis as unknown as Port<FromWorker>, {
  schedule: (task) => {
    tasks.push(task);
    channel.port2.postMessage(null);
  },
});
