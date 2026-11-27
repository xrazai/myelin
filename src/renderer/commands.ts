// Central command registry and keyboard shortcuts for the workspace.
import { fold, score } from './note-search';

export type CommandId =
  | 'open-palette'
  | 'new-note'
  | 'switch-vault'
  | 'find'
  | 'delete'
  | 'next-tab'
  | 'previous-tab'
  | 'close-tab'
  | 'toggle-right-panel'
  | 'toggle-focus-mode'
  | 'toggle-left-panel'
  | 'save';

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

export interface Command {
  id: CommandId;
  label: string;
  shortcut: string;
  /**
   * `tree`: the key only works with the focus in the file tree, which matches it itself.
   * Elsewhere it edits text, so the window never takes it.
   */
  scope?: 'tree';
  match: (event: KeyEventLike) => boolean;
}

function ctrl(key: string, shift = false): (event: KeyEventLike) => boolean {
  const wanted = key.toLowerCase();
  return (event) => {
    // `altKey`: AltGr arrives as Ctrl+Alt on Windows and types characters.
    if (!event.ctrlKey || event.altKey || event.metaKey) return false;
    return event.shiftKey === shift && event.key.toLowerCase() === wanted;
  };
}

export const COMMANDS: readonly Command[] = [
  {
    id: 'open-palette',
    label: 'Open command palette',
    shortcut: 'Ctrl+P',
    match: ctrl('p'),
  },
  {
    id: 'new-note',
    label: 'New note',
    shortcut: 'Ctrl+N',
    match: ctrl('n'),
  },
  {
    id: 'delete',
    label: 'Delete the open note…',
    shortcut: 'Delete (file tree)',
    scope: 'tree',
    match: (event) => !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Delete',
  },
  {
    id: 'find',
    label: 'Find in note',
    shortcut: 'Ctrl+F',
    match: ctrl('f'),
  },
  {
    id: 'switch-vault',
    label: 'Switch vault…',
    shortcut: '',
    match: () => false,
  },
  {
    id: 'save',
    label: 'Save note',
    shortcut: 'Ctrl+S',
    match: ctrl('s'),
  },
  {
    id: 'close-tab',
    label: 'Close tab',
    shortcut: 'Ctrl+W',
    match: ctrl('w'),
  },
  {
    id: 'next-tab',
    label: 'Next tab',
    shortcut: 'Ctrl+Tab',
    match: ctrl('tab'),
  },
  {
    id: 'previous-tab',
    label: 'Previous tab',
    shortcut: 'Ctrl+Shift+Tab',
    match: ctrl('tab', true),
  },
  {
    id: 'toggle-right-panel',
    label: 'Toggle graph / Brain panel',
    shortcut: 'Ctrl+Shift+L',
    match: ctrl('l', true),
  },
  {
    id: 'toggle-focus-mode',
    label: 'Toggle focus mode',
    shortcut: 'Ctrl+\\',
    match: ctrl('\\'),
  },
  {
    id: 'toggle-left-panel',
    label: 'Toggle file tree',
    shortcut: 'Ctrl+Shift+B',
    match: ctrl('b', true),
  },
];

export function commandFor(event: KeyEventLike): CommandId | null {
  for (const command of COMMANDS) {
    if (command.scope === undefined && command.match(event)) return command.id;
  }
  return null;
}

export function searchCommands(query: string, commands: readonly Command[] = COMMANDS): Command[] {
  const wanted = fold(query.trim());
  if (wanted === '') return [...commands];
  const scored: { command: Command; score: number }[] = [];
  for (const command of commands) {
    const result = score(fold(command.label), wanted);
    if (result !== null) scored.push({ command, score: result });
  }
  scored.sort((a, b) => a.score - b.score || a.command.label.length - b.command.label.length);
  return scored.map((entry) => entry.command);
}
