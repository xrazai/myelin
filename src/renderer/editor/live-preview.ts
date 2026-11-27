// Live preview (docs/features.md, pillar A): Markdown syntax is hidden on the lines without
// a cursor or selection. Only the visible ranges are walked, which keeps huge notes fast.
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

const mark = (name: string) => Decoration.mark({ class: name });

/** Styles of whole nodes, on every line. */
const STYLES: Record<string, Decoration> = {
  Emphasis: mark('cm-md-em'),
  StrongEmphasis: mark('cm-md-strong'),
  Strikethrough: mark('cm-md-strike'),
  InlineCode: mark('cm-md-code'),
  FencedCode: mark('cm-md-code'),
  CodeBlock: mark('cm-md-code'),
  Link: mark('cm-md-link'),
  WikiLink: mark('cm-md-wikilink'),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6].flatMap((level) => {
      const heading = mark(`cm-md-heading cm-md-h${level}`);
      return [
        [`ATXHeading${level}`, heading],
        [`SetextHeading${level}`, heading],
      ];
    }),
  ),
};

/** Raw syntax, whenever it shows. */
const syntax = mark('cm-md-syntax');
const hidden = Decoration.replace({});

/** Syntax that always shows: hiding it would lose the shape of the text. */
const ALWAYS_SHOWN = new Set([
  'ListMark', 'QuoteMark', 'TaskMarker', 'HorizontalRule', 'TableDelimiter', 'CodeInfo', 'LinkLabel',
]);

/** Marks hidden only under these parents; under any other they always show. */
const HIDDEN_UNDER: Record<string, readonly string[]> = {
  EmphasisMark: ['Emphasis', 'StrongEmphasis'],
  StrikethroughMark: ['Strikethrough'],
  CodeMark: ['InlineCode'],
  WikiLinkMark: ['WikiLink'],
};

const SPACE = /[ \t]/;

/** The `[from, to)` of a hideable piece of syntax, or `null` if this node always shows. */
function hideable(state: EditorState, node: SyntaxNode): [number, number] | null {
  const parent = node.parent!;
  if (node.name === 'HeaderMark') {
    // The `===` of a setext heading is a line of its own: hiding it would leave a hole.
    if (!parent.name.startsWith('ATXHeading')) return null;
    const line = state.doc.lineAt(node.from);
    let from = node.from - line.from;
    let to = node.to - line.from;
    // The spaces go with their `#`: after the opening one, before a closing one.
    if (node.from === parent.from) while (SPACE.test(line.text.charAt(to))) to++;
    else while (SPACE.test(line.text.charAt(from - 1))) from--;
    return [line.from + from, line.from + to];
  }
  return HIDDEN_UNDER[node.name]?.includes(parent.name) ? [node.from, node.to] : null;
}

/**
 * What hides in `[text](url "title")`: the `[` and everything from the `]` on. `null` for
 * the other link forms, which show as written.
 */
function linkSyntax(node: SyntaxNode): [number, number][] | null {
  if (!node.getChild('URL')) return null;
  const [open, close] = node.getChildren('LinkMark');
  // Hiding a link without text would leave nothing to see.
  if (!open || !close || close.from === open.to) return null;
  return [
    [open.from, open.to],
    [close.from, node.to],
  ];
}

/** The decorations of `ranges`, which must be sorted and not overlap. */
export function livePreviewDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const { doc } = state;
  const found: Range<Decoration>[] = [];
  /** Lines with a cursor or selection, as `[start, end]` offsets. */
  const revealed = state.selection.ranges.map(
    ({ from, to }) => [doc.lineAt(from).from, doc.lineAt(to).to] as const,
  );
  const isRevealed = (from: number, to: number) => revealed.some(([start, end]) => from <= end && to >= start);

  const add = (decoration: Decoration, from: number, to: number) => {
    if (to > from) found.push(decoration.range(from, to));
  };
  const conceal = (from: number, to: number) => {
    if (isRevealed(from, to)) add(syntax, from, to);
    // A view plugin may not replace a line break.
    else if (to <= doc.lineAt(from).to) add(hidden, from, to);
  };

  let done = -1;
  for (const range of ranges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        // A node that spans two ranges is entered twice, and decorated once.
        if (cursor.from <= done) return;
        const { name, from, to } = cursor;
        const style = STYLES[name];
        if (style) add(style, from, to);

        if (name === 'Link') {
          const parts = linkSyntax(cursor.node);
          if (parts) for (const [start, end] of parts) conceal(start, end);
        } else if (name === 'LinkMark' || name === 'URL' || name === 'LinkTitle') {
          // Inside an inline link they are covered above.
          const parent = cursor.node.parent!;
          if (!(parent.name === 'Link' && linkSyntax(parent))) add(syntax, from, to);
        } else if (ALWAYS_SHOWN.has(name)) {
          add(syntax, from, to);
        } else if (name === 'HeaderMark' || name in HIDDEN_UNDER) {
          const part = hideable(state, cursor.node);
          if (part) conceal(...part);
          else add(syntax, from, to);
        }
      },
    });
    done = range.to;
  }
  return Decoration.set(found, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = livePreviewDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        // The parser works in the background: a long note gets its tree bit by bit.
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = livePreviewDecorations(update.view.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
