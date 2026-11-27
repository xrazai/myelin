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

    // `[[` completion. The prefixes match the specificity of CodeMirror's own theme.
    '.cm-tooltip.cm-tooltip-autocomplete': {
      overflow: 'hidden',
      backgroundColor: 'var(--bg-panel)',
      border: '1px solid var(--divider)',
      borderRadius: '6px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--font-size-ui)',
      minWidth: '240px',
      maxHeight: '18em',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px', color: 'var(--text)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)',
      color: 'var(--accent)',
    },
    '.cm-completionDetail': {
      marginLeft: '1em',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.85em',
      fontStyle: 'normal',
      color: 'var(--text-muted)',
    },

    // `[[link]]` hover preview.
    '.cm-tooltip:has(> .cm-hover-preview)': {
      backgroundColor: 'var(--bg-panel)',
      border: '1px solid var(--divider)',
      borderRadius: '6px',
      padding: '8px 12px',
      maxWidth: '360px',
    },
    '.cm-hover-preview-title': {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--font-size-ui)',
      fontWeight: '600',
      color: 'var(--text)',
      marginBottom: '4px',
    },
    '.cm-hover-preview-excerpt': {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--font-size-ui)',
      lineHeight: '1.45',
      color: 'var(--text-muted)',
      whiteSpace: 'pre-wrap',
      overflow: 'hidden',
      display: '-webkit-box',
      WebkitLineClamp: '6',
      WebkitBoxOrient: 'vertical',
    },
  },
  { dark: true },
);
