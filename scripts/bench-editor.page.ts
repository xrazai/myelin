// The page of `bench-editor.ts`: the app's editor and theme, plus the timing probes. It
// runs in Chromium, so it is typechecked with the renderer (tsconfig.web.json).
import { EditorView } from '@codemirror/view';
import { createNoteEditor } from '../src/renderer/editor/cm-editor';
import '../src/renderer/styles.css';

/** A note with the constructs live preview works on, 20 lines per section. */
function sampleNote(lines: number): string {
  const section = (n: number) => [
    `## Section ${n}`,
    '',
    `The **myelin sheath** strengthens _frequently used_ connections, see [[Note ${n}]].`,
    `A second line with \`inline code\`, ~~old text~~ and [a link](https://example.com/${n}).`,
    '',
    `- [[folder/Note ${n}|an alias]] explains the **pattern**`,
    '- [ ] a task with *emphasis*',
    '  - nested item',
    '',
    `> A quote about [[Note ${n}#Heading]] that is long enough to wrap onto a second visual line in the editor, as prose usually does.`,
    '',
    '```ts',
    `const section = ${n}; // **not bold**`,
    '```',
    '',
    '### Detail',
    '',
    'Plain prose without any syntax, which is what most lines of a real note look like.',
    'More plain prose to finish the section.',
    '',
  ];
  const all: string[] = [];
  for (let n = 1; all.length < lines; n++) all.push(...section(n));
  return all.slice(0, lines).join('\n');
}

export interface Sample {
  /** Keydown until the DOM is updated and laid out: the main thread time of the key. */
  workMs: number;
  /** Keydown until the next frame is painted: `workMs` plus the wait for vsync. */
  frameMs: number;
}

export interface BenchPage {
  /** Opens a new note and puts the cursor at the end of line `line`. */
  open(lines: number, line: number): Promise<{ lines: number; headings: number; rawMarksAway: number }>;
  /** Starts waiting for the next key that changes the text. Call before sending it. */
  arm(): void;
  /** The timing of that key. */
  sample(): Promise<Sample>;
  length(): number;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

let view: EditorView;
let keyAt = 0;
let waiting: ((sample: Sample) => void) | null = null;
let pending: Promise<Sample>;

window.addEventListener('keydown', () => (keyAt = performance.now()), { capture: true });

const probe = EditorView.updateListener.of((update) => {
  view = update.view;
  const done = waiting;
  if (!done || !update.docChanged) return;
  waiting = null;
  const start = keyAt;
  // Reading the layout is not allowed during the update itself.
  queueMicrotask(() => {
    // Runs the editor's pending measure and forces style and layout.
    update.view.coordsAtPos(update.view.state.selection.main.head);
    const workMs = performance.now() - start;
    void frame().then(() => done({ workMs, frameMs: performance.now() - start }));
  });
});

const parent = document.getElementById('editor')!;
const editor = createNoteEditor(parent, probe);
let opened = 0;

const page: BenchPage = {
  async open(lines, line) {
    await document.fonts.ready;
    const path = `${++opened}.md`;
    editor.keep([]);
    editor.load(path, sampleNote(lines));
    editor.show(path);
    // The first update gives the probe the view.
    const current = EditorView.findFromDOM(parent)!;
    view = current;
    const at = view.state.doc.line(Math.min(line, view.state.doc.lines)).to;
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    view.focus();
    // Time for the background parser to reach the viewport and settle.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Proof that live preview is at work where the typing happens.
    const away = [...view.contentDOM.querySelectorAll('.cm-line')].filter(
      (element) => !element.querySelector('.cm-md-code') && !element.textContent!.includes('```'),
    );
    return {
      lines: view.state.doc.lines,
      headings: view.contentDOM.querySelectorAll('.cm-md-heading').length,
      rawMarksAway: away.filter((element) => /\*\*|\[\[|^#/.test(element.textContent!)).length,
    };
  },
  arm() {
    pending = new Promise((resolve) => (waiting = resolve));
  },
  sample: () => pending,
  length: () => view.state.doc.length,
};

Object.assign(window, { bench: page });
