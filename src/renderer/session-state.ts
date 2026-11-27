// What a vault looked like when it was left: open tabs and expanded folders. Renderer-only
// state, remembered per vault in `localStorage`. Paths only, never text.

export interface SessionState {
  /** Open tabs, in strip order. */
  tabs: string[];
  active: string | null;
  /** Expanded folders of the file tree. */
  expanded: string[];
}

export const EMPTY_SESSION: Readonly<SessionState> = { tabs: [], active: null, expanded: [] };

const sessionKey = (vaultId: string) => `myelin.session.${vaultId}`;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];

/** Anything unreadable is an empty session. */
export function loadSession(storage: Pick<Storage, 'getItem'>, vaultId: string): SessionState {
  try {
    const stored = JSON.parse(storage.getItem(sessionKey(vaultId)) ?? 'null') as Partial<SessionState> | null;
    return {
      tabs: strings(stored?.tabs),
      active: typeof stored?.active === 'string' ? stored.active : null,
      expanded: strings(stored?.expanded),
    };
  } catch {
    return { ...EMPTY_SESSION };
  }
}

export function saveSession(storage: Pick<Storage, 'setItem'>, vaultId: string, state: SessionState): void {
  try {
    storage.setItem(sessionKey(vaultId), JSON.stringify(state));
  } catch {
    // A full or blocked storage only loses the session.
  }
}

/** The tabs that can still be opened: what no longer is a note is skipped. */
export function restorableTabs(
  state: SessionState,
  isNote: (path: string) => boolean,
): { tabs: string[]; active: string | null } {
  const tabs = state.tabs.filter(isNote);
  if (tabs.length === 0) return { tabs, active: null };
  if (state.active !== null && tabs.includes(state.active)) return { tabs, active: state.active };
  // The nearest tab after where the missing one was, else the one before.
  const at = state.active === null ? 0 : Math.max(0, state.tabs.indexOf(state.active));
  const after = state.tabs.slice(at).find(isNote);
  return { tabs, active: after ?? tabs.at(-1)! };
}
