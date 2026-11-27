import { expect, test } from 'vitest';
import { createLinkResolver } from '../../shared/links';
import { linkPulse } from './link-pulse';

const resolve = createLinkResolver(['Home.md', 'A.md', 'folder/B.md']);
const pulse = (before: string, after: string) => linkPulse('Home.md', before, after, resolve)?.targets ?? null;

test('reports the notes linked now and not before, once each', () => {
  expect(pulse('', '[[A]]')).toEqual(['A.md']);
  expect(pulse('[[A]]', '[[A]] [[B]] [[folder/B|again]]')).toEqual(['folder/B.md']);
  expect(linkPulse('Home.md', '', '[[A]]', resolve)).toEqual({ source: 'Home.md', targets: ['A.md'] });
});

test.each([
  ['[[A]]', '[[A]] and more text'],
  ['[[A]]', '[[a|other words]] [[A#Part]]'],
  ['[[B]]', '[[folder/B]]'],
  ['', '[[Missing]] [[Home]] [[#Part]] `[[A]]`'],
  ['[[A]]', ''],
])('stays quiet from %j to %j', (before, after) => {
  expect(pulse(before, after)).toBeNull();
});
