import { describe, expect, it } from 'vitest';
import { createLinkResolver, linkKey, noteLinks, folderNameProblem, isReservedName, noteNameProblem, parseLinks, rewriteLinksForMoves, rewriteLinksForRename } from './links';

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

describe('noteNameProblem', () => {
  it.each(['New.md', 'folder/Nova nota (2).md', 'C#/Note.md', 'v1.2.md'])('accepts %s', (path) => {
    expect(noteNameProblem(path)).toBeNull();
  });

  it.each(['C# notes.md', 'a|b.md', '[x].md', 'why?.md', 'a /b.md', 'b .md', 'dir./b.md', 'b..md', 'x.md.md'])(
    'refuses %s',
    (path) => {
      expect(noteNameProblem(path)).not.toBeNull();
    },
  );
});

describe('rewriteLinksForMoves', () => {
  const all = ['Plans/A.md', 'Plans/sub/B.md', 'Other/A.md', 'Home.md'];
  const move = (text: string, source: string, from: string, to: string) => {
    const moves = new Map(all.filter((path) => path.startsWith(`${from}/`)).map((path) => [path, to + path.slice(from.length)]));
    const after = all.map((path) => moves.get(path) ?? path);
    return rewriteLinksForMoves(text, source, moves, createLinkResolver(all), createLinkResolver(after)).text;
  };

  it('rewrites links by path into a renamed folder, keeping alias, heading and block', () => {
    expect(move('[[Plans/A|a]] [[sub/B#H]] [[Plans/sub/B#^x]] [[B]] [[#Top]]', 'Home.md', 'Plans', 'Ideas')).toBe(
      '[[Ideas/A|a]] [[sub/B#H]] [[Ideas/sub/B#^x]] [[B]] [[#Top]]',
    );
  });

  it('follows a change of case only where the link writes the folder', () => {
    expect(move('[[Plans/A]] [[plans/sub/B]] [[sub/B]] [[B]] [[Other/A]]', 'Home.md', 'Plans', 'plans')).toBe(
      '[[plans/A]] [[plans/sub/B]] [[sub/B]] [[B]] [[Other/A]]',
    );
  });

  it('keeps a bare link leading to the same namesake when the new path changes which one is shortest', () => {
    // `[[A]]` led to Other/A (same depth, fewer characters than Plans/A).
    expect(move('[[A]]', 'Home.md', 'Plans', 'Z')).toBe('[[Other/A]]');
  });

  it('rewrites links between the notes that move together', () => {
    expect(move('[[Plans/sub/B]] [[Other/A]]', 'Plans/A.md', 'Plans', 'Ideas')).toBe('[[Ideas/sub/B]] [[Other/A]]');
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

  it('keeps `[[#Heading]]` and rewrites a link of the note to itself by name', () => {
    expect(rename('[[#H]] [[a/Old]]', 'a/Old.md', 'a/Old.md', 'b/New.md', ['a/Old.md', 'New.md'])).toEqual({
      text: '[[#H]] [[b/New]]',
      count: 1,
    });
  });

  it('keeps a link to a namesake from being captured by the new name', () => {
    const all = ['Old.md', 'x/y/Foo.md', 'Link.md'];
    expect(rename('[[Foo|f#H]] [[Old]]', 'Link.md', 'Old.md', 'Foo.md', all).text).toBe('[[x/y/Foo|f#H]] [[Foo]]');
  });

  it('after a folder move, keeps a bare link and rewrites a qualified one', () => {
    const all = ['a/Note.md', 'Link.md'];
    expect(rename('[[note]] [[a/Note|n]]', 'Link.md', 'a/Note.md', 'b/Note.md', all)).toEqual({
      text: '[[note]] [[b/Note|n]]',
      count: 1,
    });
  });

  it('follows a change of case only', () => {
    expect(rename('[[note]] [[Note]]', 'Link.md', 'note.md', 'Note.md', ['note.md', 'Link.md'])).toEqual({
      text: '[[Note]] [[Note]]',
      count: 1,
    });
  });

  it('refuses a rename into a folder that links cannot name', () => {
    const all = ['a/Old.md', 'Link.md'];
    expect(() => rename('[[a/Old]]', 'Link.md', 'a/Old.md', 'C#/Old.md', all)).toThrow('cannot point to');
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

describe('folderNameProblem', () => {
  it('accepts ordinary folder names, accents and spaces included', () => {
    for (const path of ['Notes', 'Anotações/2026 plans', 'a.b', 'readme.mdx']) expect(folderNameProblem(path), path).toBeNull();
  });

  it('refuses names that links, the watcher or Windows cannot hold', () => {
    const refused = ['', 'a//b', '.hidden', 'a/..', 'C#', '[x]', 'a|b', 'x.md', 'X.MD/y', 'a:b', 'why?', 'a\\b', 'end.', 'space ', ' space', 'a\0'];
    for (const path of refused) expect(folderNameProblem(path), JSON.stringify(path)).toEqual(expect.any(String));
  });
});

describe('reserved Windows names', () => {
  it('are refused for notes and folders, with or without an extension', () => {
    for (const name of ['CON', 'aux', 'Nul', 'prn', 'com1', 'LPT9', 'COM¹', 'conin$', 'CONOUT$', 'aux.notes', 'con .x']) {
      expect(isReservedName(name), name).toBe(true);
      expect(folderNameProblem(name), name).toBe('Windows reserves that name');
      expect(noteNameProblem(`${name}.md`), name).toBe('Windows reserves that name');
    }
  });

  it('leave names that only start like them', () => {
    for (const name of ['console', 'auxiliary', 'com10', 'nullable', 'my con', 'icon']) {
      expect(isReservedName(name), name).toBe(false);
    }
  });
});

describe('a resolver that follows notes', () => {
  it('resolves as one built from scratch after any additions and removals, ties included', () => {
    const names = ['a', 'A', 'bb', 'Café', 'Cafe\u0301'];
    const folders = ['', 'x/', 'y/', 'x/y/', 'long/'];
    const every = folders.flatMap((folder) => names.map((name) => `${folder}${name}.md`));
    const targets = [...every.map((path) => path.slice(0, -3)), 'a', 'y/a', 'missing', 'CAFÉ'];
    let seed = 9;
    const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    const present = new Set<string>();
    const resolver = createLinkResolver([]);
    for (let step = 0; step < 600; step++) {
      const path = every[random(every.length)]!;
      if (present.delete(path)) resolver.remove(path);
      else {
        present.add(path);
        resolver.add(path);
      }
      if (step % 20 !== 19) continue;
      const fresh = createLinkResolver(present);
      for (const target of targets) expect(resolver(target, 'x/a.md'), `${step} ${target}`).toEqual(fresh(target, 'x/a.md'));
    }
    resolver.remove('never/there.md');
  });
});
