// A note's file against the editor's text. The editor works on LF text without a byte
// order mark; a note keeps the BOM and the line ending it had on disk (AGENTS.md, rule 8).

export interface NoteFormat {
  bom: boolean;
  eol: '\n' | '\r\n' | '\r';
}

export function parseNote(raw: string): { text: string; format: NoteFormat } {
  const bom = raw.startsWith('﻿');
  const body = bom ? raw.slice(1) : raw;
  const counts = { '\n': 0, '\r\n': 0, '\r': 0 };
  for (const [ending] of body.matchAll(/\r\n?|\n/g)) counts[ending as NoteFormat['eol']]++;
  // Mixed endings: the most used one. LF if there is none, or on a tie.
  let eol: NoteFormat['eol'] = '\n';
  for (const ending of ['\r\n', '\r'] as const) if (counts[ending] > counts[eol]) eol = ending;
  return { text: body.replace(/\r\n?/g, '\n'), format: { bom, eol } };
}

export function serializeNote(text: string, { bom, eol }: NoteFormat): string {
  return (bom ? '﻿' : '') + (eol === '\n' ? text : text.replaceAll('\n', eol));
}
