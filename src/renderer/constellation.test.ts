import type { Community } from '@myelin/graph';
import { describe, expect, test } from 'vitest';
import { describeConstellation, type ConstellationSource } from './constellation';

const community = (id: number, members: number[], neighbors: number[] = []): Community => ({
  id,
  level: 0,
  size: members.length,
  members,
  topNodes: members.slice(0, 5),
  parent: null,
  children: [],
  neighbors: neighbors.map((other) => ({ id: other, weight: 1 })),
});

describe('describeConstellation', () => {
  const all = new Map([
    [1, community(1, [0, 1, 2, 3, 4, 5, 6], [2, 3, 9])],
    [2, community(2, [7, 8])],
    [3, community(3, [9])],
  ]);
  const paths = Array.from({ length: 10 }, (_, i) => `n/Note ${i}.md`);
  const source: ConstellationSource = {
    community: (id) => all.get(id) ?? null,
    path: (id) => paths[id],
    title: (path) => path.slice(2, -3),
    edited: (path) => (path.endsWith('0.md') ? 0 : Number(path.slice(-4, -3))),
  };

  test('names it by its top note, lists related subjects and what was edited last', () => {
    const info = describeConstellation(source, 1)!;
    expect([info.name, info.size]).toEqual(['Note 0', 7]);
    expect(info.main.map((note) => note.title)).toEqual(['Note 0', 'Note 1', 'Note 2', 'Note 3', 'Note 4']);
    // A single note and a community that is gone are not subjects.
    expect(info.related).toEqual([{ id: 2, name: 'Note 7', size: 2 }]);
    expect(info.recent.map((note) => note.title)).toEqual(['Note 6', 'Note 5', 'Note 4', 'Note 3', 'Note 2']);
    expect(describeConstellation(source, 5)).toBeNull();
  });
});
