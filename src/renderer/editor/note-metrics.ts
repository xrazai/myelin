// Quiet reading & research metrics for the active note (computed debounced off the typing hot path).
import { parseLinks } from '../../shared/links';

export interface NoteMetrics {
  words: number;
  readMinutes: number;
  links: number;
}

const WORDS_PER_MINUTE = 220;
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Counts words, estimated reading time, and `[[wiki-links]]` in a Markdown note. */
export function computeNoteMetrics(text: string): NoteMetrics {
  const matches = text.match(WORD_RE);
  const words = matches ? matches.length : 0;
  const readMinutes = words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  const links = text.includes('[[') ? parseLinks(text).length : 0;
  return { words, readMinutes, links };
}

export function formatWordSummary(metrics: NoteMetrics): string {
  const words = `${metrics.words} ${metrics.words === 1 ? 'word' : 'words'}`;
  if (metrics.readMinutes === 0) return words;
  return `${words} · ${metrics.readMinutes} min read`;
}

export function formatLinkSummary(links: number): string {
  return `${links} ${links === 1 ? 'link' : 'links'}`;
}
