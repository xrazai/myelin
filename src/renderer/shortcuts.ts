// Workspace keyboard shortcuts, backed by the central command registry (`commands.ts`).
import { commandFor, type CommandId, type KeyEventLike } from './commands';

export type Shortcut = Exclude<CommandId, 'open-palette'>;

export function shortcutFor(event: KeyEventLike): Shortcut | null {
  const id = commandFor(event);
  return id === 'open-palette' ? null : id;
}
