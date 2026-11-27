// The status bar's `learning` indicator, in plain TS: who is working, and the ivory pulse.

/** Anything shorter than this stays on screen this long, so the pulse is seen. */
export const MIN_ACTIVE_MS = 1200;

export interface Activity {
  /** Marks work in progress until the returned function is called (again is harmless). */
  begin(label: string): () => void;
  /** A one-off event: pulses once. */
  pulse(label: string): void;
  /**
   * The label of the latest activity still on, `null` when idle. Called at once and on every
   * change (the Svelte store contract). Returns the unsubscribe function.
   */
  subscribe(listener: (label: string | null) => void): () => void;
}

export function createActivity(): Activity {
  const running: { label: string }[] = [];
  const listeners = new Set<(label: string | null) => void>();
  let current: string | null = null;

  const notify = () => {
    const next = running.at(-1)?.label ?? null;
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener(current);
  };

  const begin: Activity['begin'] = (label) => {
    const entry = { label };
    const started = Date.now();
    let ended = false;
    running.push(entry);
    notify();
    return () => {
      if (ended) return;
      ended = true;
      const stop = () => {
        running.splice(running.indexOf(entry), 1);
        notify();
      };
      const left = MIN_ACTIVE_MS - (Date.now() - started);
      if (left > 0) setTimeout(stop, left);
      else stop();
    };
  };

  return {
    begin,
    pulse: (label) => begin(label)(),
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Shows the index sync on `activity`. Returns the function that stops it. */
export function trackIndexing(
  api: { onIndexing(listener: (active: boolean) => void): () => void },
  activity: Activity,
): () => void {
  let end: (() => void) | null = null;
  const unsubscribe = api.onIndexing((active) => {
    if (active) {
      end ??= activity.begin('Indexing');
    } else {
      end?.();
      end = null;
    }
  });
  return () => {
    unsubscribe();
    end?.();
    end = null;
  };
}

/** What the status bar shows. Indexing now; usage events later. */
export const learning = createActivity();
