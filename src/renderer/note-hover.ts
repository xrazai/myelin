// A note under the pointer in the tree or in a `[[link]]`: the graph shows which node it is.

/** The `window` event the graph listens for; `detail` is a note path, or `null`. */
export const NOTE_HOVER_EVENT = 'myelin:note-hover';

export function announceNoteHover(path: string | null): void {
  window.dispatchEvent(new CustomEvent(NOTE_HOVER_EVENT, { detail: path }));
}
