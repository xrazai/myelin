// Workspace keyboard shortcuts (AGENTS.md, "Shortcuts"; `Ctrl+P` comes with the palette).

export type Shortcut =
  | 'next-tab'
  | 'previous-tab'
  | 'close-tab'
  | 'toggle-right-panel'
  | 'toggle-focus-mode'
  | 'toggle-left-panel'
  | 'save';

type Keys = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

export function shortcutFor(event: Keys): Shortcut | null {
  // `altKey`: AltGr arrives as Ctrl+Alt on Windows and types characters.
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key.toLowerCase()) {
    case 'tab':
      return event.shiftKey ? 'previous-tab' : 'next-tab';
    case 's':
      return event.shiftKey ? null : 'save';
    case 'w':
      return event.shiftKey ? null : 'close-tab';
    case 'l':
      return event.shiftKey ? 'toggle-right-panel' : null;
    case '\\':
      return event.shiftKey ? null : 'toggle-focus-mode';
    case 'b':
      return event.shiftKey ? 'toggle-left-panel' : null;
    default:
      return null;
  }
}
