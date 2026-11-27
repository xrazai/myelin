import { describe, expect, it } from 'vitest';
import { createLinkResolver, linkKey, noteLinks, parseLinks, rewriteLinksForRename } from './links';

const targets = (text: string) => parseLinks(text).map((l) => l.target);

describe('parseLinks: forms', () => {
  it.each([
    ['[[Note]]', 'Note', '', null],
    ['[[folder/Note]]', 'folder/Note', '', null],
    ['[[a/b/Note|alias]]', 'a/b/Note', '', 'alias'],
    ['[[Note|alias]]', 'Note', '', 'alias'],
    ['[[Note#Heading]]', 'Note', '#Heading', null],
    ['[[Note#^block-1]]', 'Note', '#^block-1', null],
    ['[[Note#A#B|alias # | more]]', 'Note', '#A#B', 'alias # | more'],
    ['[[#Heading]]', '', '#Heading', null],
    ['[[ Note |  ]]', 'Note', '', null],
    ['[[Note\\|alias]]', 'Note', '', 'alias'],
    ['[[Reflexão sobre ótica|ção]]', 'Reflexão sobre ótica', '', 'ção'],
    ['[[v1.2 notes]]', 'v1.2 notes', '', null],
  ])('%s', (text, target, subpath, alias) => {
    expect(parseLinks(text)).toMatchObject([{ target, subpath, alias }]);
  });

  it('gives the ranges of the link and of the target alone', () => {
    const text = 'Ação 🌱 [[ pasta/Índice #Seção|apelido]] e ![[Outra]], [[#Fim]].';
    const links = parseLinks(text);
    expect(links.map((l) => text.slice(l.from, l.to))).toEqual([
      '[[ pasta/Índice #Seção|apelido]]',
      '[[Outra]]',
      '[[#Fim]]',
    ]);
    expect(links.map((l) => text.slice(l.targetFrom, l.targetTo))).toEqual(['pasta/Índice', 'Outra', '']);
  });

  it('keeps offsets across lines with CRLF', () => {
    const text = '# [[A]]\r\n\r\ntext\r\n[[B]]\r\n```\r\n[[C]]\r\n```\r\n[[D]]';
    expect(parseLinks(text).map((l) => text.slice(l.from, l.to))).toEqual(['[[A]]', '[[B]]', '[[D]]']);
  });

  it.each(['[[]]', '[[  ]]', '[[|alias]]', '[Note]', '[[Note]', '[[No\nte]]', '\\[[Note]]', '[a](b.md)'])(
    'is not a link: %j',
    (text) => {
      expect(parseLinks(text)).toEqual([]);
    },
  );

  it('finds the inner link among stray brackets', () => {
    expect(targets('[[[A]]] [[broken [[B]] [ [[C]]')).toEqual(['A', 'B', 'C']);
  });
});

describe('parseLinks: code', () => {
  it.each([
    ['code span', '`[[no]]` [[yes]]'],
    ['double backticks', '`` a ` [[no]] `` [[yes]]'],
    ['span across lines', '`start\n[[no]] end` [[yes]]'],
    ['fence', '```ts\n[[no]]\n```\n[[yes]]'],
    ['tilde fence', '~~~\n[[no]]\n```\n[[no]]\n~~~~\n[[yes]]'],
    ['longer fence', '````\n```\n[[no]]\n````\n[[yes]]'],
    ['closer with text does not close', '```\n``` x\n[[no]]\n```\n[[yes]]'],
    ['unclosed fence', '[[yes]]\n```\n[[no]]\n\n[[no]]'],
    ['fence in a list item', '- ```\n  [[no]]\n  ```\n- [[yes]]'],
    ['indented fence in a list', '- item\n\n    ```\n    [[no]]\n    ```\n[[yes]]'],
    ['fence in a quote', '> ```\n> [[no]]\n> ```\n> [[yes]]'],
    ['quote end closes its fence', '> ```\n> [[no]]\n\n[[yes]]'],
    ['indented code', '    [[no]]\n\n    [[no]]\n\n\t[[no]]\n[[yes]]'],
    ['indented code after a list ended', '- a\n\ntext\n\n    [[no]]\n\n[[yes]]'],
  ])('ignores links in a %s', (_, text) => {
    expect(new Set(targets(text))).toEqual(new Set(['yes']));
  });

  it.each([
    ['unmatched backtick', 'a ` b [[yes]]'],
    ['backticks of different lengths', '`` [[yes]] `'],
    ['escaped backticks', '\\` [[yes]] \\`'],
    ['backticks in separate paragraphs', 'a `\n\n[[yes]]\n\n` b'],
    ['backticks in separate list items', '- a `\n- [[yes]] `'],
    ['backticks around a heading', 'a `\n## [[yes]]\n` b'],
    ['backticks in separate table rows', '| ` |\n| [[yes]] |\n| ` |'],
    ['indented list item', '- a\n    - [[yes]]'],
    ['indented list continuation', '1. a\n\n    [[yes]]'],
    ['indented paragraph continuation', 'text\n    [[yes]]'],
    ['inline triple backticks', '```a``` [[yes]]'],
    ['an indented fence inside a paragraph', 'text\n    ```\n[[yes]]'],
  ])('keeps links near %s', (_, text) => {
    expect(targets(text)).toEqual(['yes']);
  });

  it('lets whatever starts first win', () => {
    expect(targets('[[a`b]] [[c]] `')).toEqual(['a`b', 'c']);
    expect(targets('`[[a` [[b]]')).toEqual(['b']);
  });
});

describe('resolution', () => {
  const paths = [
    'Home.md',
    'Projetos/Myelin/Plano.md',
    'Estudos/Plano.md',
    'Arquivo/Velho/Plano.md',
    'xEstudos/Outro.md',
    'b/Empate.md',
    'a/Empate.md',
    'longa-pasta/Curta.md',
    'ab/Curta.md',
    'Referências/Configuração.md',
    'Ética.md',
    'Node.js.MD',
  ];
  const resolve = createLinkResolver(paths);
  const path = (target: string) => resolve(target, 'Home.md').path;

  it.each([
    ['Home', 'Home.md'],
    ['hOmE', 'Home.md'],
    ['Home.md', 'Home.md'],
    ['node.js', 'Node.js.MD'],
    ['configuração', 'Referências/Configuração.md'],
    ['ÉTICA', 'Ética.md'],
    ['referências/CONFIGURAÇÃO', 'Referências/Configuração.md'],
  ])('%s -> %s', (target, expected) => {
    expect(path(target)).toBe(expected);
  });

  it('ignores Unicode composition but not accents', () => {
    expect(path('Configuração'.normalize('NFD'))).toBe('Referências/Configuração.md');
    expect(createLinkResolver(['Ética.md'.normalize('NFD')])('ética', 'x.md').path).toBe('Ética.md'.normalize('NFD'));
    expect(path('Configuracao')).toBeNull();
    expect(path('Etica')).toBeNull();
  });

  it('picks the shortest path among namesakes, whatever the input order', () => {
    for (const list of [paths, [...paths].reverse()]) {
      const r = createLinkResolver(list);
      expect(r('plano', 'Home.md').path).toBe('Estudos/Plano.md'); // fewer folders, then shorter
      expect(r('Curta', 'Home.md').path).toBe('ab/Curta.md');
      expect(r('Empate', 'Home.md').path).toBe('a/Empate.md');
    }
    expect(createLinkResolver(['a-very-long-folder/N.md', 'a/b/N.md'])('N', 'x.md').path).toBe(
      'a-very-long-folder/N.md',
    );
  });

  it('does not prefer the folder of the source', () => {
    expect(resolve('Plano', 'Arquivo/Velho/Home.md').path).toBe('Estudos/Plano.md');
  });

  it('disambiguates with a folder prefix, whole folders only', () => {
    expect(path('Myelin/Plano')).toBe('Projetos/Myelin/Plano.md');
    expect(path('velho/plano')).toBe('Arquivo/Velho/Plano.md');
    expect(path('Arquivo/Velho/Plano')).toBe('Arquivo/Velho/Plano.md');
    expect(path('b/Empate')).toBe('b/Empate.md');
    expect(path('Estudos/Outro')).toBeNull();
    expect(path('Projetos/Plano')).toBeNull();
    expect(path('Nada/Home')).toBeNull();
  });

  it('keeps unresolved links, grouped by key', () => {
    const links = noteLinks('Estudos/Plano.md', '[[Ainda Não#X|y]] [[ainda não.md]] [[#Topo]] [[home]]', resolve);
    expect(links).toMatchObject([
      { source: 'Estudos/Plano.md', path: null, name: 'Ainda Não', key: 'ainda não', subpath: '#X', from: 0 },
      { source: 'Estudos/Plano.md', path: null, name: 'ainda não', key: 'ainda não' },
      { source: 'Estudos/Plano.md', path: 'Estudos/Plano.md', key: '', subpath: '#Topo' },
      { source: 'Estudos/Plano.md', path: 'Home.md', key: 'home' },
    ]);
  });

  it('builds the same key for a path and the targets that name it', () => {
    expect(linkKey('Referências/Configuração.md')).toBe(linkKey('REFERÊNCIAS/configuração'.normalize('NFD')));
  });
});

describe('rewriteLinksForRename', () => {
  const rename = (text: string, source: string, from: string, to: string, all: string[]) =>
    rewriteLinksForRename(text, source, from, to, createLinkResolver(all), createLinkResolver(all.map((p) => (p === from ? to : p))));

  it('rewrites a bare target, keeping alias, heading and block', () => {
    expect(rename('[[Old|alias]] [[Old#H]] [[Old#^b]]', 'Other.md', 'Old.md', 'New.md', ['Old.md', 'Other.md', 'New.md'])).toEqual({
      text: '[[New|alias]] [[New#H]] [[New#^b]]',
      count: 3,
    });
  });

  it('rewrites self links and keeps the target qualified when a namesake appears', () => {
    expect(rename('[[#H]] [[a/Old]]', 'a/Old.md', 'a/Old.md', 'b/New.md', ['a/Old.md', 'b/New.md', 'New.md'])).toEqual({
      text: '[[b/New#H]] [[b/New]]',
      count: 2,
    });
  });

  it('leaves another note\'s self link untouched', () => {
    expect(rename('[[#Self]] [[Old]]', 'Target.md', 'Old.md', 'New.md', ['Old.md', 'Target.md', 'New.md']).text).toBe(
      '[[#Self]] [[New]]',
    );
  });

  it('keeps links in code and to other notes untouched', () => {
    const text = '`[[Old]]` [[Other]] [[Old]]';
    expect(rename(text, 'Link.md', 'Old.md', 'New.md', ['Old.md', 'Other.md', 'New.md', 'Link.md']).text).toBe(
      '`[[Old]]` [[Other]] [[New]]',
    );
  });

  it('preserves BOM, CRLF and table escapes', () => {
    const text = '\uFEFF| [[Old\\|alias]] |\r\n| [[Old]] |\r\n';
    const out = rename(text, 'Link.md', 'Old.md', 'New.md', ['Old.md', 'Link.md', 'New.md']).text;
    expect(out).toBe('\uFEFF| [[New\\|alias]] |\r\n| [[New]] |\r\n');
  });

  it('uses the full path when a bare new name would be ambiguous', () => {
    expect(rename('[[Old]]', 'Link.md', 'a/Old.md', 'b/New.md', ['a/Old.md', 'b/New.md', 'New.md', 'Link.md']).text).toBe(
      '[[b/New]]',
    );
  });
});
