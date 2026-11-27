// Hover preview for `[[links]]`: prefetches visible links in one batch and renders
// warm previews synchronously from `NoteCache` (< 1 ms).
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, hoverTooltip, type Tooltip, type ViewUpdate } from '@codemirror/view';
import type { NotePreview } from '../../shared/ipc';
import { matchLink } from '../../shared/links';
import type { NoteCache } from '../note-cache';
import type { NoteList } from '../note-list';
import { linkAt, opensLink } from './link-syntax';
import { notePath } from './note-path';

export interface LinkHoverOptions {
  notes: Pick<NoteList, 'ready' | 'isLoaded' | 'resolve'>;
  cache: NoteCache;
}

/** Collects resolved note paths for `[[links]]` in `view.visibleRanges`. */
export function visibleLinkPaths(
  view: EditorView,
  notes: Pick<NoteList, 'ready' | 'isLoaded' | 'resolve'>,
): string[] {
  if (!notes.isLoaded()) return [];
  const source = view.state.facet(notePath);
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      for (let i = line.text.indexOf('[['); i !== -1; i = line.text.indexOf('[[', i + 1)) {
        const match = matchLink(line.text, i);
        if (!match?.link || !match.link.target || !opensLink(view.state, line.from + i)) continue;
        const resolved = notes.resolve(match.link.target, source);
        if (resolved.path && !seen.has(resolved.path)) {
          seen.add(resolved.path);
          paths.push(resolved.path);
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return paths;
}

function renderPreview(preview: NotePreview): { dom: HTMLElement } {
  const dom = document.createElement('div');
  dom.className = 'cm-hover-preview';

  const slash = preview.path.lastIndexOf('/');
  if (slash > 0) {
    const folder = document.createElement('div');
    folder.className = 'cm-hover-preview-path';
    folder.textContent = preview.path.slice(0, slash);
    dom.appendChild(folder);
  }

  const title = document.createElement('div');
  title.className = 'cm-hover-preview-title';
  title.textContent = preview.title;
  dom.appendChild(title);

  if (preview.excerpt) {
    const excerpt = document.createElement('div');
    excerpt.className = 'cm-hover-preview-excerpt';
    excerpt.textContent = preview.excerpt;
    dom.appendChild(excerpt);
  }

  return { dom };
}

export function linkHover({ notes, cache }: LinkHoverOptions): Extension {
  const prefetch = ViewPlugin.fromClass(
    class {
      private destroyed = false;

      constructor(view: EditorView) {
        if (notes.isLoaded()) {
          const paths = visibleLinkPaths(view, notes);
          if (paths.length > 0) void cache.prefetch(paths);
        } else {
          void notes.ready.then(() => {
            if (this.destroyed) return;
            const paths = visibleLinkPaths(view, notes);
            if (paths.length > 0) void cache.prefetch(paths);
          });
        }
      }

      update(update: ViewUpdate) {
        if (!update.viewportChanged && !update.docChanged) return;
        const paths = visibleLinkPaths(update.view, notes);
        if (paths.length > 0) void cache.prefetch(paths);
      }

      destroy() {
        this.destroyed = true;
      }
    },
  );

  const tooltip = hoverTooltip((view, pos): Tooltip | null | Promise<Tooltip | null> => {
    if (!notes.isLoaded()) return null;
    const link = linkAt(view.state, pos, true);
    if (!link?.target) return null;

    const source = view.state.facet(notePath);
    const resolved = notes.resolve(link.target, source);
    if (!resolved.path) return null;

    const targetPath = resolved.path;
    const cached = cache.peek(targetPath);
    if (cached === null) return null;
    if (cached !== undefined) {
      return {
        pos: link.from,
        end: link.to,
        above: true,
        create: () => renderPreview(cached),
      };
    }

    return cache.fetch(targetPath).then((preview) =>
      preview
        ? {
            pos: link.from,
            end: link.to,
            above: true,
            create: () => renderPreview(preview),
          }
        : null,
    );
  });

  return [prefetch, tooltip];
}
