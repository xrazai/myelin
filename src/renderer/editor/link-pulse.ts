// A saved note that links somewhere it did not before: the cue for the graph's synaptic
// pulse (docs/features.md, pillar B). Nothing listens yet.
import { parseLinks, type LinkResolver } from '../../shared/links';

/** The `window` event the graph listens for; `detail` is a `LinkPulse`. */
export const LINK_PULSE_EVENT = 'myelin:link-pulse';

export interface LinkPulse {
  /** The saved note. */
  source: string;
  /** Notes it links to now and did not before. Never empty. */
  targets: string[];
}

/** The notes `text` links to. Links to missing notes and to itself make no edge. */
function destinations(source: string, text: string, resolve: LinkResolver): Set<string> {
  const found = new Set<string>();
  for (const { target } of parseLinks(text)) {
    const { path } = resolve(target, source);
    if (path !== null && path !== source) found.add(path);
  }
  return found;
}

/** `null` if the save added no edge. */
export function linkPulse(source: string, before: string, after: string, resolve: LinkResolver): LinkPulse | null {
  // Most saves have no link at all.
  if (!after.includes('[[')) return null;
  const had = destinations(source, before, resolve);
  const targets = [...destinations(source, after, resolve)].filter((path) => !had.has(path));
  return targets.length === 0 ? null : { source, targets };
}
