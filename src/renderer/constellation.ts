// What a constellation tells the user: its name, its main notes, the subjects it links
// to and what was edited in it lately (docs/features.md, Using constellations). Plain TS.
import type { Community } from '@myelin/graph';

const MAIN_NOTES = 5;
const RELATED = 6;
const RECENT = 5;

export interface ConstellationNote {
  path: string;
  title: string;
}

export interface ConstellationInfo {
  id: number;
  /** The title of its most central note. */
  name: string;
  size: number;
  main: ConstellationNote[];
  /** The other constellations it links to, the strongest first. */
  related: { id: number; name: string; size: number }[];
  /** The notes edited last, the latest first. */
  recent: ConstellationNote[];
}

export interface ConstellationSource {
  community(id: number): Community | null;
  /** The path of a node. */
  path(id: number): string | undefined;
  title(path: string): string;
  /** When a note last changed; 0 where unknown. */
  edited(path: string): number;
}

export function describeConstellation(source: ConstellationSource, id: number): ConstellationInfo | null {
  const community = source.community(id);
  if (!community) return null;
  const note = (path: string) => ({ path, title: source.title(path) });
  const paths = (nodes: number[]) => nodes.map((node) => source.path(node)).filter((path) => path !== undefined);
  const nameOf = (of: Community) => {
    const [top] = paths(of.topNodes);
    return top === undefined ? '' : source.title(top);
  };
  const related: ConstellationInfo['related'] = [];
  for (const neighbor of community.neighbors) {
    if (related.length === RELATED) break;
    const other = source.community(neighbor.id);
    // A note alone is not a subject.
    if (other && other.size > 1) related.push({ id: other.id, name: nameOf(other), size: other.size });
  }
  const recent = paths(community.members)
    .map((path) => ({ path, at: source.edited(path) }))
    .filter(({ at }) => at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT)
    .map(({ path }) => note(path));
  return {
    id,
    name: nameOf(community),
    size: community.size,
    main: paths(community.topNodes).slice(0, MAIN_NOTES).map(note),
    related,
    recent,
  };
}
