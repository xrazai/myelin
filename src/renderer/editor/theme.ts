// Editor look. Colors and fonts come from the tokens in `styles.css` (docs/identity.md).
import { EditorView } from '@codemirror/view';

export const theme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg-editor)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--font-size-body)',
      fontWeight: '390',
      fontOpticalSizing: 'auto',
      fontFeatureSettings: 'normal',
      lineHeight: '1.7',
    },
    // Ergonomic long-form reading measure (~64-68ch), centered; side padding stays intact.
    '.cm-content': {
      maxWidth: 'calc(40em + 64px)',
      margin: '0 auto',
      padding: '36px 0 40vh',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0 32px' },

    // Asymmetric heading rhythm: more breathing room above than below.
    '.cm-md-h1-line': { paddingTop: '1.05em', paddingBottom: '0.32em' },
    '.cm-md-h1-line:first-child': { paddingTop: '0' },
    '.cm-md-h2-line': { paddingTop: '1.25em', paddingBottom: '0.24em' },
    '.cm-md-h3-line': { paddingTop: '0.95em', paddingBottom: '0.16em' },
    '.cm-md-h4-line': { paddingTop: '0.7em', paddingBottom: '0.1em' },
    '.cm-md-heading': { fontWeight: '580', lineHeight: '1.3', letterSpacing: '-0.014em' },
    '.cm-md-h1': { fontSize: '1.75em', letterSpacing: '-0.022em' },
    '.cm-md-h2': { fontSize: '1.36em' },
    '.cm-md-h3': { fontSize: '1.15em' },
    '.cm-md-h4': { fontSize: '1.04em' },
    '.cm-md-h6': { color: 'var(--text-muted)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strong': { fontWeight: '680' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-muted)' },

    // Links read as prose with a restrained botanical underline and subtle hover feedback.
    '.cm-md-link, .cm-md-wikilink': {
      color: 'var(--accent)',
      textDecoration: 'underline',
      textDecorationColor: 'color-mix(in srgb, var(--accent) 36%, transparent)',
      textDecorationThickness: '1px',
      textUnderlineOffset: '3px',
      borderRadius: '3px',
      transition: 'background-color var(--t-fast) ease, text-decoration-color var(--t-fast) ease',
    },
    '.cm-md-link:hover, .cm-md-wikilink:hover': {
      backgroundColor: 'var(--surface-active)',
      textDecorationColor: 'var(--accent)',
    },

    // Research blockquote: slim sage rail over a quiet recessed surface.
    '.cm-md-quote-line': {
      margin: '0 24px',
      padding: '3px 16px 3px 18px',
      borderLeft: '2px solid color-mix(in srgb, var(--accent) 55%, var(--divider))',
      backgroundColor: 'color-mix(in srgb, var(--bg-panel) 50%, transparent)',
    },
    '.cm-md-quote': {
      fontStyle: 'italic',
      color: 'color-mix(in srgb, var(--text) 88%, var(--text-muted))',
    },

    // Inline code chip and fenced code block surface.
    '.cm-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.86em' },
    '.cm-md-inline-code': {
      backgroundColor: 'var(--surface-code)',
      borderRadius: '4px',
      padding: '0.08em 0.36em',
      boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--divider) 85%, transparent)',
      color: 'color-mix(in srgb, var(--text) 94%, var(--learning))',
    },
    '.cm-md-codeblock-line': {
      margin: '0 20px',
      padding: '0 16px',
      backgroundColor: 'var(--bg-panel)',
      borderLeft: '1px solid var(--divider)',
      borderRight: '1px solid var(--divider)',
      lineHeight: '1.58',
    },
    '.cm-md-codeblock-first': {
      marginTop: '0.55em',
      paddingTop: '10px',
      borderTop: '1px solid var(--divider)',
      borderTopLeftRadius: '8px',
      borderTopRightRadius: '8px',
    },
    '.cm-md-codeblock-last': {
      marginBottom: '0.55em',
      paddingBottom: '10px',
      borderBottom: '1px solid var(--divider)',
      borderBottomLeftRadius: '8px',
      borderBottomRightRadius: '8px',
    },

    // Horizontal rules and task markers.
    '.cm-md-hr-line': {
      paddingTop: '0.5em',
      paddingBottom: '0.5em',
    },
    '.cm-md-hr': {
      color: 'var(--divider)',
      letterSpacing: '0.14em',
    },
    '.cm-md-task': {
      fontFamily: 'var(--font-mono)',
      fontSize: '0.84em',
      color: 'var(--text-muted)',
      padding: '0 2px',
      borderRadius: '3px',
    },
    '.cm-md-task-done': {
      color: 'var(--accent)',
      backgroundColor: 'var(--surface-active)',
    },

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
