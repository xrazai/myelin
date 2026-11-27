// Following a `[[link]]`: `Ctrl+Click` or `Ctrl+Enter` opens its note, with `Shift` in a
// new tab. A link to a note that does not exist creates it.
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { MyelinApi } from '../../shared/ipc';
import type { ParsedLink } from '../../shared/links';
import type { NoteList } from '../note-list';
import { linkAt } from './link-syntax';
import { notePath } from './note-path';

/**
 * Characters Windows refuses in a name, hidden (dot) names, and a trailing dot or space,
 * which Windows drops: the note would be created somewhere else.
 */
const UNUSABLE = /[<>:"\\|?*\u0000-\u001f]|[. ]$|^\./;

/** Where the note for an unresolved link goes: as written, from the vault root. */
export function newNotePath(name: string): string {
  if (name.split('/').some((part) => part === '' || UNUSABLE.test(part))) {
    throw new Error(`"${name}" cannot be a note name`);
  }
  return `${name}.md`;
}

/**
 * The path of the note a link of `source` leads to, creating the note if there is none.
 * Creating never replaces anything: `writeNote` with a `null` base only writes where there
 * is no file, and it refuses paths outside the vault.
 */
export async function linkDestination(
  notes: Pick<NoteList, 'ready' | 'resolve'>,
  disk: Pick<MyelinApi, 'writeNote'>,
  target: string,
  source: string,
): Promise<string> {
  // Without the list, a note in a folder would look missing and get a twin at the root.
  await notes.ready;
  const found = notes.resolve(target, source);
  if (found.path !== null) return found.path;
  const path = newNotePath(found.name);
  // On a conflict the file is there already: it is opened as it is.
  await disk.writeNote(path, '', null);
  return path;
}

export type FollowLink = (link: ParsedLink, source: string, newTab: boolean) => void;

export function linkFollowing(follow: FollowLink): Extension {
  function run(view: EditorView, pos: number, newTab: boolean, edges: boolean): boolean {
    const link = linkAt(view.state, pos, edges);
    if (link) follow(link, view.state.facet(notePath), newTab);
    return link !== null;
  }
  const onKey = (newTab: boolean) => (view: EditorView) => run(view, view.state.selection.main.head, newTab, true);

  // Ahead of the default keymap, where `Mod-Enter` adds a line: that still happens off links.
  return Prec.high([
    keymap.of([
      { key: 'Mod-Enter', run: onKey(false) },
      { key: 'Mod-Shift-Enter', run: onKey(true) },
    ]),
    EditorView.domEventHandlers({
      // On `mousedown`, before the editor takes `Ctrl+Click` as a second cursor.
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        // Not the edges: a click past the end of a line lands there.
        if (pos === null || !run(view, pos, event.shiftKey, false)) return false;
        event.preventDefault();
        return true;
      },
    }),
  ]);
}
