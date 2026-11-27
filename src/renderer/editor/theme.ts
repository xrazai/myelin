// Editor look. Colors and fonts come from the tokens in `styles.css` (docs/identity.md).
import { EditorView } from '@codemirror/view';

export const theme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg-editor)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--font-size-body)',
      fontFeatureSettings: 'normal',
      lineHeight: '1.65',
    },
    // A readable measure, centered; the side padding never goes away.
    '.cm-content': {
      maxWidth: 'calc(46em + 64px)',
      margin: '0 auto',
      padding: '32px 0 40vh',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0 32px' },

    '.cm-md-heading': { fontWeight: '600', lineHeight: '1.35' },
    '.cm-md-h1': { fontSize: '1.65em' },
    '.cm-md-h2': { fontSize: '1.4em' },
    '.cm-md-h3': { fontSize: '1.2em' },
    '.cm-md-h4': { fontSize: '1.05em' },
    '.cm-md-h6': { color: 'var(--text-muted)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strong': { fontWeight: '700' },
    '.cm-md-strike': { textDecoration: 'line-through' },
    // Links read as text: body font, only the color tells them apart.
    '.cm-md-link, .cm-md-wikilink': { color: 'var(--accent)' },
    '.cm-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
    // `em` would shrink twice inside code.
    '.cm-md-code .cm-md-syntax': { fontSize: '1em' },
    '.cm-md-syntax': {
      fontFamily: 'var(--font-mono)',
      fontSize: '0.85em',
      fontStyle: 'normal',
      fontWeight: '400',
    },
    '.cm-md-syntax, .cm-md-syntax *': { color: 'var(--text-muted)' },
  },
  { dark: true },
);
