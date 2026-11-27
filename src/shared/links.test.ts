import { describe, expect, it } from 'vitest';
import { createLinkResolver, linkKey, noteLinks, parseLinks } from './links';

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
      expect(r('plano', 'Home.md')).toEqual({ path: 'Estudos/Plano.md' }); // fewer folders, then shorter
      expect(r('Curta', 'Home.md')).toEqual({ path: 'ab/Curta.md' });
      expect(r('Empate', 'Home.md')).toEqual({ path: 'a/Empate.md' });
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
      { source: 'Estudos/Plano.md', path: 'Estudos/Plano.md', subpath: '#Topo' },
      { source: 'Estudos/Plano.md', path: 'Home.md' },
    ]);
  });

  it('builds the same key for a path and the targets that name it', () => {
    expect(linkKey('Referências/Configuração.md')).toBe(linkKey('REFERÊNCIAS/configuração'.normalize('NFD')));
  });
});
