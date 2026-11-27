// The real watcher on a real folder. Events are followed through the renderer's own tree
// logic, so each test also checks that the reported tree matches a fresh scan.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TreeEntry, VaultEvent } from '../shared/ipc';
import { applyEvents } from '../renderer/tree-model';
import { writeFileAtomic } from './atomic-write';
import { contentHash, deleteIndex, openIndex, syncIndex } from './vault-index';
import { damageLinks } from './vault-index.fixtures';
import { scanVault } from './vault-scan';
import { watchVault, type VaultWatch, type VaultWatchOptions } from './vault-watcher';

vi.setConfig({ testTimeout: 30_000 });

let base: string;
let root: string;
let outside: string;
let db: Database.Database;
let watching: VaultWatch;
/** Every event emitted, in order. */
let seen: VaultEvent[];
/** The tree a renderer would show. */
let tree: TreeEntry[];

const at = (path: string) => join(root, path);
const write = (path: string, text: string) => writeFile(at(path), text, 'utf8');

function start(options: Partial<VaultWatchOptions> = {}): VaultWatch {
  return watchVault(root, {
    async openDb() {
      // A second connection, to read the index while the watcher owns its own.
      const file = join(base, 'userData', 'index.db');
      const own = openIndex(file);
      db = openIndex(file);
      return own;
    },
    emit(events) {
      seen.push(...events);
      tree = applyEvents(tree, events);
    },
    ...options,
  });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'myelin-watch-'));
  root = join(base, 'vault');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  seen = [];
  tree = [];
});

afterEach(async () => {
  await watching.close();
  db?.close();
  await rm(base, { recursive: true, force: true });
});

const notes = () => db.prepare('SELECT path FROM notes ORDER BY path').pluck().all() as string[];
const hashOf = (path: string) => db.prepare('SELECT hash FROM notes WHERE path = ?').pluck().get(path);
const linkTargets = () =>
  db.prepare('SELECT source, target_path AS path, name FROM links ORDER BY source, from_pos').all();
const indexedPaths = () => db.prepare('SELECT path FROM notes ORDER BY path').pluck().all();
const search = (query: string) =>
  db
    .prepare(
      `SELECT notes.path FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY notes.path`,
    )
    .pluck()
    .all(query);

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 15_000, interval: 25 });
const event = (type: VaultEvent['type'], path: string, kind: 'note' | 'folder' = 'note'): VaultEvent =>
  type === 'changed' ? { type, path } : { type, kind, path };

let sentinels = 0;
/**
 * Waits until everything done before it was handled, using a change that must be reported.
 * Returns the other events since `from`.
 */
async function settled(from = 0): Promise<VaultEvent[]> {
  const name = `zz-sentinel-${++sentinels}.md`;
  await write(name, 'x');
  await until(() => expect(seen.slice(from)).toContainEqual(event('created', name)));
  await until(() => expect(hashOf(name)).toBe(contentHash('x')));
  const events = seen.slice(from).filter((e) => !e.path.startsWith('zz-sentinel-'));
  await rm(at(name));
  await until(() => expect(seen).toContainEqual(event('deleted', name)));
  await until(() => expect(notes()).not.toContain(name));
  return events;
}

async function expectTreeMatchesDisk(): Promise<void> {
  const fresh = await scanVault(root);
  await until(() => expect(tree).toEqual(fresh));
}

describe('after the first sync', () => {
  beforeEach(async () => {
    await write('Home.md', 'start [[Later]]');
    watching = start();
    await watching.indexed;
    tree = await watching.getTree();
  });

  test('an external create, edit, rename and delete reach the tree and the index', async () => {
    await write('Later.md', 'alpha [[Home]]');
    await until(() => expect(search('alpha')).toEqual(['Later.md']));
    expect(seen).toEqual([event('created', 'Later.md')]);
    expect(linkTargets()).toContainEqual({ source: 'Home.md', path: 'Later.md', name: null });

    await write('Later.md', 'bravo');
    await until(() => expect(search('bravo')).toEqual(['Later.md']));
    await until(() => expect(seen).toContainEqual(event('changed', 'Later.md')));
    expect(search('alpha')).toEqual([]);

    await rename(at('Later.md'), at('Renamed.md'));
    await until(() => expect(notes()).toEqual(['Home.md', 'Renamed.md']));
    expect(await settled()).toContainEqual(event('deleted', 'Later.md'));
    expect(search('bravo')).toEqual(['Renamed.md']);
    expect(linkTargets()).toEqual([{ source: 'Home.md', path: null, name: 'Later' }]);

    const from = seen.length;
    await rm(at('Renamed.md'));
    await until(() => expect(notes()).toEqual(['Home.md']));
    expect(await settled(from)).toEqual([event('deleted', 'Renamed.md')]);
    await expectTreeMatchesDisk();
  });

  test('rewriting the same bytes or touching a note reports nothing', async () => {
    await write('Home.md', 'start [[Later]]');
    await utimes(at('Home.md'), new Date(), new Date());
    expect(await settled()).toEqual([]);
  });

  test('*.tmp files, dot entries and other files report nothing', async () => {
    await write('Home.md.tmp', 'half written');
    await write('image.png', 'x');
    await mkdir(at('.obsidian'));
    await write('.obsidian/note.md', 'hidden');
    expect(await settled()).toEqual([]);
    expect(notes()).toEqual(['Home.md']);
  });

  test('an editor that saves through a temp file reports one change', async () => {
    await writeFile(at('Home.md.tmp'), 'saved elsewhere', 'utf8');
    await rename(at('Home.md.tmp'), at('Home.md'));
    await until(() => expect(search('elsewhere')).toEqual(['Home.md']));
    expect(await settled()).toEqual([event('changed', 'Home.md')]);
  });

  test('case-only renames, repeated, of notes and folders', async () => {
    await mkdir(at('Dir'));
    await write('Dir/in.md', 'inside');
    await write('k.md', 'kay');
    await until(() => expect(notes()).toEqual(['Dir/in.md', 'Home.md', 'k.md']));
    // chokidar's own events stop after the first of these.
    for (const [from, to] of [['k.md', 'K.md'], ['K.md', 'k.md'], ['k.md', 'K.md']] as const) {
      await rename(at(from), at(to));
      await until(() => expect(notes()).toEqual(['Dir/in.md', 'Home.md', to].sort()));
      await expectTreeMatchesDisk();
    }
    for (const [from, to] of [['Dir', 'DIR'], ['DIR', 'Dir'], ['Dir', 'DIR']] as const) {
      await rename(at(from), at(to));
      await until(() => expect(notes()).toEqual([`${to}/in.md`, 'Home.md', 'K.md'].sort()));
      await expectTreeMatchesDisk();
    }
    await appendFile(at('DIR/in.md'), ' more', 'utf8');
    await until(() => expect(search('more')).toEqual(['DIR/in.md']));
  });

  test('a folder moved in, renamed, moved out: every entry is reported', async () => {
    await mkdir(join(outside, 'pack', 'sub'), { recursive: true });
    await mkdir(join(outside, 'pack', 'empty'));
    await writeFile(join(outside, 'pack', 'sub', 'deep.md'), 'treasure', 'utf8');

    await rename(join(outside, 'pack'), at('pack'));
    await until(() => expect(search('treasure')).toEqual(['pack/sub/deep.md']));
    expect([...(await settled())].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      event('created', 'pack', 'folder'),
      event('created', 'pack/empty', 'folder'),
      event('created', 'pack/sub', 'folder'),
      event('created', 'pack/sub/deep.md'),
    ]);

    await rename(at('pack'), at('box'));
    await until(() => expect(search('treasure')).toEqual(['box/sub/deep.md']));
    await expectTreeMatchesDisk();

    const from = seen.length;
    await rename(at('box'), join(outside, 'box'));
    await until(() => expect(notes()).toEqual(['Home.md']));
    expect(await settled(from)).toContainEqual(event('deleted', 'box/sub/deep.md'));
    await expectTreeMatchesDisk();
  });

  test('many changes at once end in the right tree and index', async () => {
    await mkdir(at('many'));
    const names = Array.from({ length: 400 }, (_, i) => `many/n${i}.md`);
    await Promise.all(names.map((name) => write(name, `text ${name}`)));
    await until(() => expect(notes()).toHaveLength(401));
    await expectTreeMatchesDisk();
    await rm(at('many'), { recursive: true });
    await until(() => expect(notes()).toEqual(['Home.md']));
    await expectTreeMatchesDisk();
  });

  describe('loop guard', () => {
    test("the app's own writes are indexed and report nothing", async () => {
      await watching.write('Home.md', 'mine [[New]]', 'start [[Later]]');
      await watching.write('Home.md', 'mine again [[New]]', 'mine [[New]]');
      await watching.write('New.md', 'brand new', null);
      await until(() => expect(search('again')).toEqual(['Home.md']));
      await until(() => expect(search('brand')).toEqual(['New.md']));
      expect(linkTargets()).toEqual([{ source: 'Home.md', path: 'New.md', name: null }]);
      // Only the note new to the tree is reported, and never as `changed`.
      expect(await settled()).toEqual([event('created', 'New.md')]);
      await expectTreeMatchesDisk();
    });

    test('a write never replaces what it did not expect', async () => {
      // Before the watcher reports it: the race between an external edit and auto-save.
      await write('Home.md', 'theirs');
      expect(await watching.write('Home.md', 'mine', 'start [[Later]]')).toEqual({ status: 'conflict', disk: 'theirs' });
      expect(await readFile(at('Home.md'), 'utf8')).toBe('theirs');
      await until(() => expect(seen).toContainEqual(event('changed', 'Home.md')));

      // Creating over an existing note, and saving a note that was deleted.
      expect(await watching.write('Home.md', 'mine', null)).toEqual({ status: 'conflict', disk: 'theirs' });
      await rm(at('Home.md'));
      expect(await watching.write('Home.md', 'mine', 'theirs')).toEqual({ status: 'conflict', disk: null });
      expect(await readdir(root)).toEqual([]);
    });

    test('a write of what is already on disk does nothing, whatever it expected', async () => {
      const before = (await stat(at('Home.md'))).mtimeMs;
      expect(await watching.write('Home.md', 'start [[Later]]', 'old')).toEqual({ status: 'saved' });
      expect((await stat(at('Home.md'))).mtimeMs).toBe(before);
      expect(await settled()).toEqual([]);
    });

    test('a file that is not UTF-8 is never overwritten', async () => {
      const latin1 = Buffer.from('a\u00e7\u00e3o', 'latin1');
      await writeFile(at('Home.md'), latin1);
      // What the editor was given cannot be turned back into these bytes.
      await expect(watching.write('Home.md', 'edited', latin1.toString('utf8'))).rejects.toThrow('not UTF-8');
      expect(await readFile(at('Home.md'))).toEqual(latin1);
    });

    test('an app write that creates folders reports them with the note', async () => {
      await mkdir(at('deep/er'), { recursive: true });
      expect(await watching.write('deep/er/A.md', 'a', null)).toEqual({ status: 'saved' });
      await expectTreeMatchesDisk();
      const events = await settled();
      expect(events.filter((e) => e.type === 'changed')).toEqual([]);
    });

    test('a failed write leaves the note and no temp file', async () => {
      // A folder where the temp file goes.
      await mkdir(at('Home.md.tmp'));
      await expect(watching.write('Home.md', 'mine', 'start [[Later]]')).rejects.toThrow();
      expect(await readFile(at('Home.md'), 'utf8')).toBe('start [[Later]]');
    });

    test('an external write right after an own write is reported', async () => {
      await watching.write('Home.md', 'mine', 'start [[Later]]');
      await until(() => expect(hashOf('Home.md')).toBe(contentHash('mine')));
      await writeFileAtomic(at('Home.md'), 'theirs');
      await until(() => expect(seen).toEqual([event('changed', 'Home.md')]));
      // Going back to what the app wrote earlier is still an external change.
      await writeFileAtomic(at('Home.md'), 'mine');
      await until(() => expect(hashOf('Home.md')).toBe(contentHash('mine')));
      expect(await settled()).toEqual([event('changed', 'Home.md'), event('changed', 'Home.md')]);
    });

    test('a rename updates the index at once and reports each rewritten note', async () => {
      await write('Target.md', '[[Home]] [[#Self]]');
      await until(() => expect(notes()).toContain('Target.md'));
      await settled();
      const from = seen.length;
      expect(await watching.rename('Home.md', 'Renamed.md')).toEqual({ notUpdated: [] });
      // No waiting: the index is up to date once the rename resolves.
      expect(indexedPaths()).toContain('Renamed.md');
      expect(indexedPaths()).not.toContain('Home.md');
      expect(linkTargets()).toContainEqual({ source: 'Target.md', path: 'Renamed.md', name: null });
      expect(await readFile(at('Target.md'), 'utf8')).toBe('[[Renamed]] [[#Self]]');
      expect(await readFile(at('Renamed.md'), 'utf8')).toBe('start [[Later]]');
      expect((await settled(from)).filter((e) => e.type === 'changed')).toEqual([event('changed', 'Target.md')]);
      await expectTreeMatchesDisk();
    });

    test('a rename rewrites a link another program wrote moments before', async () => {
      await write('Late.md', 'now links [[Home]]');
      await watching.rename('Home.md', 'Renamed.md');
      expect(await readFile(at('Late.md'), 'utf8')).toBe('now links [[Renamed]]');
    });

    test('a rename may change only the case of the name', async () => {
      await write('lower.md', 'x');
      await until(() => expect(notes()).toContain('lower.md'));
      await watching.rename('lower.md', 'Lower.md');
      expect(notes()).toContain('Lower.md');
      expect(notes()).not.toContain('lower.md');
      await expectTreeMatchesDisk();
    });

    test('a refused rename leaves the vault untouched', async () => {
      await write('Target.md', '[[Home]]');
      await mkdir(at('Dir'));
      await write('Dir/In.md', 'in');
      await until(() => expect(notes()).toContain('Dir/In.md'));
      await expect(watching.rename('Home.md', 'Target.md')).rejects.toThrow('already exists');
      await expect(watching.rename('Home.md', 'target.md')).rejects.toThrow('already exists');
      await expect(watching.rename('Home.md', 'C# notes.md')).rejects.toThrow('cannot contain');
      await expect(watching.rename('Home.md', 'dir/Home.md')).rejects.toThrow('the folder is named Dir');
      expect(await readFile(at('Target.md'), 'utf8')).toBe('[[Home]]');
      expect(await readFile(at('Home.md'), 'utf8')).toBe('start [[Later]]');
    });

    test('a failed own write leaves no expected hash behind', async () => {
      await expect(watching.write('missing/A.md', 'lost', null)).rejects.toThrow('ENOENT');
      await mkdir(at('missing'));
      await write('missing/A.md', 'lost');
      await until(() => expect(seen).toContainEqual(event('created', 'missing/A.md')));
    });
  });

  test('getTree reports what changed before any report arrived', async () => {
    await write('Now.md', 'now');
    const fresh = await watching.getTree();
    expect(fresh.map((entry) => entry.path)).toEqual(['Home.md', 'Now.md']);
    await until(() => expect(notes()).toEqual(['Home.md', 'Now.md']));
    expect((await settled()).filter((e) => e.type === 'created')).toEqual([event('created', 'Now.md')]);
  });

  test('nothing is reported or indexed after close', async () => {
    await write('Late.md', 'late');
    await watching.close();
    await write('Later.md', 'later');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(seen).toEqual([]);
    expect(notes()).toEqual(['Home.md']);
  });
});

describe('createFolder', () => {
  beforeEach(async () => {
    await mkdir(at('Notes'));
    await write('Notes/A.md', 'a');
    watching = start();
    await watching.indexed;
    tree = await watching.getTree();
    seen = [];
  });

  test('creates the folder and reports it before resolving', async () => {
    await watching.createFolder('Notes/New folder');
    expect(seen).toEqual([event('created', 'Notes/New folder', 'folder')]);
    expect(await readdir(at('Notes/New folder'))).toEqual([]);
    await watching.createFolder('Top');
    expect(tree.map((entry) => entry.path)).toEqual(['Notes', 'Top']);
  });

  test('never replaces a folder or a file, in any case', async () => {
    await write('plain', 'a file, not a note');
    for (const path of ['Notes', 'notes', 'plain', 'Plain']) {
      await expect(watching.createFolder(path), path).rejects.toThrow('already named');
    }
    await expect(watching.createFolder('notes/Sub')).rejects.toThrow('the folder is named Notes');
    expect(await readFile(at('plain'), 'utf8')).toBe('a file, not a note');
    expect(await readdir(at('Notes'))).toEqual(['A.md']);
    expect(seen).toEqual([]);
  });

  test('refuses names it cannot use, paths outside the vault and a missing parent', async () => {
    for (const path of ['C#', 'x.md', 'end.', 'why?']) await expect(watching.createFolder(path), path).rejects.toThrow();
    for (const path of ['../out', '.myelin/x', 'a//b', 'C:/x', 'a\\b']) {
      await expect(watching.createFolder(path), path).rejects.toThrow('not a folder path');
    }
    await expect(watching.createFolder('missing/Sub')).rejects.toThrow('ENOENT');
    await symlink(outside, at('Link'), 'junction');
    await expect(watching.createFolder('Link/Sub')).rejects.toThrow('not a folder');
    expect(await readdir(outside)).toEqual([]);
    expect((await readdir(root)).filter((name) => name !== '.myelin').sort()).toEqual(['Link', 'Notes']);
  });
});

describe('deleting', () => {
  /** Where the fake Recycle Bin puts things. */
  let bin: string;
  const trash = async (file: string) => void (await rename(file, join(bin, basename(file))));

  beforeEach(async () => {
    bin = join(base, 'bin');
    await mkdir(bin);
    await mkdir(at('Plans/deep'), { recursive: true });
    await mkdir(at('Plans/.hidden'));
    await mkdir(at('Other'));
    await write('Plans/A.md', '[[B]] [[Plans/A]]');
    await write('Plans/deep/B.md', 'b');
    await write('Plans/image.png', 'x');
    await write('Plans/.hidden/note.md', 'x');
    await write('Home.md', '[[Plans/A]] [[A]] and [[B|bee]]');
    await write('Links.md', '[[Plans/deep/B]]');
    // Same prefix as the folder, and not inside it.
    await write('Plans_2.md', '[[Links]]');
    watching = start();
    await watching.indexed;
    tree = await watching.getTree();
    seen = [];
  });

  test('tells what would go and how many other notes link to it', async () => {
    expect(await watching.deleteInfo('Plans/deep/B.md', 'note')).toEqual({ notes: 1, otherFiles: 0, linkedFrom: 3 });
    // A, in the folder, links into it too and is not counted.
    expect(await watching.deleteInfo('Plans', 'folder')).toEqual({ notes: 2, otherFiles: 2, linkedFrom: 2 });
    expect(await watching.deleteInfo('Plans_2.md', 'note')).toEqual({ notes: 1, otherFiles: 0, linkedFrom: 0 });
    expect(await watching.deleteInfo('Other', 'folder')).toEqual({ notes: 0, otherFiles: 0, linkedFrom: 0 });
  });

  test('moves a note, reports it before settling and leaves its links unresolved, text untouched', async () => {
    await watching.remove('Plans/deep/B.md', 'note', trash);
    expect(seen).toEqual([event('deleted', 'Plans/deep/B.md')]);
    expect(await readdir(bin)).toEqual(['B.md']);
    await until(() => expect(notes()).not.toContain('Plans/deep/B.md'));
    expect(linkTargets()).toContainEqual({ source: 'Links.md', path: null, name: 'Plans/deep/B' });
    expect(await readFile(at('Links.md'), 'utf8')).toBe('[[Plans/deep/B]]');
  });

  test('a link moves to another note of the same name', async () => {
    await write('Other/B.md', 'other b');
    await until(() => expect(notes()).toContain('Other/B.md'));
    await watching.remove('Plans/deep/B.md', 'note', trash);
    await until(() => expect(linkTargets()).toContainEqual({ source: 'Home.md', path: 'Other/B.md', name: null }));
  });

  test('moves a folder with everything in it', async () => {
    await watching.remove('Plans', 'folder', trash);
    expect(seen).toContainEqual(event('deleted', 'Plans', 'folder'));
    expect(seen).toContainEqual(event('deleted', 'Plans/deep/B.md'));
    expect((await readdir(join(bin, 'Plans'))).sort()).toEqual(['.hidden', 'A.md', 'deep', 'image.png']);
    await until(() => expect(notes()).toEqual(['Home.md', 'Links.md', 'Plans_2.md']));
  });

  test('if the bin refuses, nothing is deleted and the reason is given', async () => {
    const refuse = () => Promise.reject(new Error('no Recycle Bin on this drive'));
    await expect(watching.remove('Home.md', 'note', refuse)).rejects.toThrow('no Recycle Bin on this drive');
    expect(await readFile(at('Home.md'), 'utf8')).toContain('bee');
    expect(seen).toEqual([]);
  });

  test('a folder that moved only in part is reported as it is left', async () => {
    const partly = async (file: string) => {
      await rename(join(file, 'A.md'), join(bin, 'A.md'));
      throw new Error('a file is held');
    };
    await expect(watching.remove('Plans', 'folder', partly)).rejects.toThrow('Part of it may be there already');
    expect(seen).toEqual([event('deleted', 'Plans/A.md')]);
    await until(() => expect(notes()).not.toContain('Plans/A.md'));
    expect(notes()).toContain('Plans/deep/B.md');
  });

  test('deletes nothing outside the vault, through a link, under another spelling or of another kind', async () => {
    await writeFile(join(outside, 'Secret.md'), 'secret', 'utf8');
    await symlink(outside, at('Link'), 'junction');
    const asked: string[] = [];
    const record = async (file: string) => void asked.push(file);
    const refused: [string, 'note' | 'folder'][] = [
      ['', 'folder'], ['.', 'folder'], ['..', 'folder'], ['.myelin', 'folder'], ['../outside', 'folder'],
      ['Link', 'folder'], ['Link/Secret.md', 'note'], ['home.md', 'note'], ['plans', 'folder'],
      ['Plans/Deep', 'folder'], ['Home.md', 'folder'], ['Plans', 'note'], ['Missing.md', 'note'], ['Plans/image.png', 'note'],
    ];
    for (const [path, kind] of refused) {
      await expect(watching.remove(path, kind, record), `${kind} ${path}`).rejects.toThrow();
      await expect(watching.deleteInfo(path, kind), `${kind} ${path}`).rejects.toThrow();
    }
    expect(asked).toEqual([]);
  });

  // The Windows shell reads `Plans.` as `Plans`, and would move that one. Refused by the
  // name alone, before the disk is looked at.
  test('refuses names the shell would read as another item', async () => {
    const asked: string[] = [];
    const refused: [string, 'note' | 'folder'][] = [
      ['Plans.', 'folder'], ['Trail ', 'folder'], ['A./B.md', 'note'], ['aux', 'folder'], ['Plans/CON.md', 'note'],
    ];
    for (const [path, kind] of refused) {
      await expect(watching.remove(path, kind, async (file) => void asked.push(file)), path).rejects.toThrow('safely');
    }
    expect(asked).toEqual([]);
  });

  test('says which notes went to the bin', async () => {
    expect((await watching.remove('Plans', 'folder', trash)).sort()).toEqual(['Plans/A.md', 'Plans/deep/B.md']);
    expect(await watching.remove('Home.md', 'note', trash)).toEqual(['Home.md']);
  });

  test('a save waiting behind a deletion does not recreate the note', async () => {
    const removed = watching.remove('Plans/A.md', 'note', trash);
    const saved = watching.write('Plans/A.md', 'newer', '[[B]] [[Plans/A]]');
    await removed;
    expect(await saved).toEqual({ status: 'conflict', disk: null });
    expect(await readdir(at('Plans'))).not.toContain('A.md');
  });
});

describe('renaming a folder', () => {
  beforeEach(async () => {
    await mkdir(at('Plans/deep/.hidden'), { recursive: true });
    await mkdir(at('Other'));
    await write('Plans/A.md', '[[Plans/deep/B]] [[#Here]] [[Home]]');
    await write('Plans/deep/B.md', 'b links [[A]]');
    await write('Plans/deep/image.png', 'png');
    await write('Plans/deep/.hidden/secret.md', 'hidden');
    await write('Other/A.md', 'other a');
    await write('Home.md', '[[Plans/A|alias]] [[Plans/deep/B#H]] [[deep/B]] [[B]]');
    watching = start();
    await watching.indexed;
    tree = await watching.getTree();
    seen = [];
  });

  test('moves everything in one batch and every link leads where it did', async () => {
    const result = await watching.renameFolder('Plans', 'Ideas');
    expect(result.notUpdated).toEqual([]);
    expect(result.moved.sort()).toEqual([
      ['Plans/A.md', 'Ideas/A.md'],
      ['Plans/deep/B.md', 'Ideas/deep/B.md'],
    ]);
    expect((await readdir(at('Ideas/deep'))).sort()).toEqual(['.hidden', 'B.md', 'image.png']);
    expect(await readdir(at('Ideas/deep/.hidden'))).toEqual(['secret.md']);
    expect(await readFile(at('Home.md'), 'utf8')).toBe('[[Ideas/A|alias]] [[Ideas/deep/B#H]] [[deep/B]] [[B]]');
    expect(await readFile(at('Ideas/A.md'), 'utf8')).toBe('[[Ideas/deep/B]] [[#Here]] [[Home]]');
    // `[[A]]` meant Other/A, first of two paths as short. `Ideas/A` would now come before
    // it and capture the link, so the link is spelled out.
    expect(await readFile(at('Ideas/deep/B.md'), 'utf8')).toBe('b links [[Other/A]]');
    expect(seen).toContainEqual(event('deleted', 'Plans', 'folder'));
    expect(seen).toContainEqual(event('created', 'Ideas', 'folder'));
    expect(seen).toContainEqual(event('changed', 'Home.md'));
    expect(seen.some((e) => e.type === 'changed' && e.path.startsWith('Ideas/'))).toBe(false);
    expect(notes()).toEqual(['Home.md', 'Ideas/A.md', 'Ideas/deep/B.md', 'Other/A.md']);
    expect(linkTargets().filter((link) => (link as { path: string | null }).path === null)).toEqual([]);
  });

  test('a change of case only, then changes outside are still seen inside', async () => {
    await watching.renameFolder('Plans', 'plans');
    expect((await readdir(root)).filter((name) => name !== '.myelin').sort()).toEqual(['Home.md', 'Other', 'plans']);
    expect(await readFile(at('Home.md'), 'utf8')).toContain('[[plans/A|alias]]');
    await watching.renameFolder('plans', 'Later');
    seen = [];
    await write('Later/deep/New.md', 'from outside');
    await until(() => expect(seen).toContainEqual(event('created', 'Later/deep/New.md')));
  });

  test('refuses a taken, unusable or inner destination with the vault untouched', async () => {
    await write('file', 'x');
    const before = await readFile(at('Home.md'), 'utf8');
    const refused: [string, string][] = [
      ['Plans', 'Other'], ['Plans', 'other'], ['Plans', 'file'], ['Plans', 'Plans/inner'], ['Plans', 'plans/inner'],
      ['Plans', 'C#'], ['Plans', 'x.md'], ['Plans', 'aux'], ['Plans', 'end.'], ['Plans', '../out'], ['Plans', '.hidden'],
      ['Plans', 'Missing/Plans'], ['Plans', 'other/Sub'], ['plans', 'New'], ['', 'New'], ['Home.md', 'New'],
    ];
    for (const [from, to] of refused) await expect(watching.renameFolder(from, to), `${from} -> ${to}`).rejects.toThrow();
    expect(await readFile(at('Home.md'), 'utf8')).toBe(before);
    expect((await readdir(at('Plans'))).sort()).toEqual(['A.md', 'deep']);
    expect(await readdir(at('Other'))).toEqual(['A.md']);
    expect(seen).toEqual([]);
  });

  test('moves a folder into another and back to the root, links following', async () => {
    await watching.renameFolder('Plans/deep', 'Other/deep');
    expect(await readFile(at('Home.md'), 'utf8')).toBe('[[Plans/A|alias]] [[Other/deep/B#H]] [[deep/B]] [[B]]');
    await watching.renameFolder('Other/deep', 'deep');
    expect(await readFile(at('Home.md'), 'utf8')).toContain('[[deep/B#H]]');
    expect(await readdir(at('deep/.hidden'))).toEqual(['secret.md']);
    expect(notes()).toContain('deep/B.md');
  });

  test('a note that is not UTF-8 is left as it is', async () => {
    await writeFile(at('Latin.md'), Buffer.from([0x5b, 0x5b, 0x50, 0x6c, 0x61, 0x6e, 0x73, 0x2f, 0x41, 0x5d, 0x5d, 0xe9]));
    await until(() => expect(notes()).toContain('Latin.md'));
    expect((await watching.renameFolder('Plans', 'Ideas')).notUpdated).toEqual(['Latin.md']);
    expect((await readFile(at('Latin.md'))).at(-1)).toBe(0xe9);
  });

  test('refuses a name that only another spelling of an accent tells apart', async () => {
    await mkdir(at('Cafe\u0301'));
    await expect(watching.renameFolder('Plans', 'Caf\u00e9')).rejects.toThrow('already named');
    expect(await readdir(at('Plans'))).toContain('A.md');
    // Its own other spelling is a rename of itself.
    await watching.renameFolder('Cafe\u0301', 'Caf\u00e9');
    expect(await readdir(root)).toContain('Caf\u00e9');
  });

  test.runIf(process.platform === 'win32')('renames a folder below one whose name ends in a dot, and only it', async () => {
    const odd = (path: string) => `\\\\?\\${at(path)}`;
    await mkdir(at('v1/Plans'), { recursive: true });
    await mkdir(odd('v1.'));
    await mkdir(`${odd('v1.')}\\Plans`);
    await writeFile(`${odd('v1.')}\\Plans\\n.md`, 'n', 'utf8');
    try {
      await watching.renameFolder('v1./Plans', 'v1./Roadmap');
      expect(await readdir(`${odd('v1.')}\\Roadmap`)).toEqual(['n.md']);
      expect(await readdir(at('v1'))).toEqual(['Plans']);
    } finally {
      await rm(odd('v1.'), { recursive: true, force: true });
    }
  });

  test('a save waiting behind the rename does not recreate the old note', async () => {
    const renamed = watching.renameFolder('Plans', 'Ideas');
    // Until the rename has its turn in the queue.
    await new Promise((resolve) => setImmediate(resolve));
    const saved = watching.write('Plans/A.md', 'newer', '[[Plans/deep/B]] [[#Here]] [[Home]]');
    await renamed;
    expect(await saved).toEqual({ status: 'conflict', disk: null });
    expect(await readdir(root)).not.toContain('Plans');
  });
});

describe('backlinks', () => {
  beforeEach(async () => {
    await mkdir(at('x'));
    await write('Target.md', '[[Target]] to itself');
    await write('x/Target.md', 'a namesake');
    await writeFile(at('A.md'), '\uFEFFfirst\r\nsee [[Target]] and\r\n\r\n| t |\r\n[[Target|again]]\r\n', 'utf8');
    await write('B.md', 'the other one: [[x/Target]]');
    watching = start();
    await watching.indexed;
    tree = await watching.getTree();
  });

  test('lists each linking line, not namesakes nor the note itself, through BOM and CRLF', async () => {
    expect(await watching.backlinks('Target.md')).toEqual([
      { path: 'A.md', line: 2, column: 4, text: 'see [[Target]] and' },
      { path: 'A.md', line: 5, column: 0, text: '[[Target|again]]' },
    ]);
    expect(await watching.backlinks('x/Target.md')).toEqual([
      { path: 'B.md', line: 1, column: 15, text: 'the other one: [[x/Target]]' },
    ]);
    expect(await watching.backlinks('A.md')).toEqual([]);
  });

  test('follows app writes, outside changes, renames and deletions', async () => {
    await watching.write('B.md', '[[Target]]', 'the other one: [[x/Target]]');
    expect((await watching.backlinks('Target.md'))!.map((link) => link.path)).toEqual(['A.md', 'A.md', 'B.md']);
    await watching.rename('Target.md', 'Goal.md');
    expect((await watching.backlinks('Goal.md'))!.length).toBe(3);
    await rm(at('A.md'));
    await until(() => expect(notes()).not.toContain('A.md'));
    expect((await watching.backlinks('Goal.md'))!.map((link) => link.path)).toEqual(['B.md']);
  });
});

describe('during the first sync', () => {
  test('the count of linking notes is unknown, never 0', async () => {
    await write('A.md', 'a');
    await write('B.md', '[[A]]');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    watching = start({ sync: async (...args) => (await held, syncIndex(...args)) });
    expect(await watching.deleteInfo('A.md', 'note')).toEqual({ notes: 1, otherFiles: 0, linkedFrom: null });
    release();
    await watching.indexed;
    expect(await watching.deleteInfo('A.md', 'note')).toEqual({ notes: 1, otherFiles: 0, linkedFrom: 1 });
  });

  /** Holds the end of the sync: everything it was going to read is already read. */
  function gate() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let synced = false;
    const sync: typeof syncIndex = async (...args) => {
      const result = await syncIndex(...args);
      synced = true;
      await held;
      return result;
    };
    return { sync, release, synced: () => synced };
  }

  test('the tree follows at once and the index catches up after it', async () => {
    await write('Edited.md', 'before');
    await write('Deleted.md', 'doomed');
    await write('Linker.md', '[[Added]]');
    await write('Own.md', 'before');
    const { sync, release, synced } = gate();
    watching = start({ sync });
    tree = await watching.getTree();
    await until(() => expect(synced()).toBe(true));
    let done = false;
    void watching.indexed.then(() => (done = true));

    await write('Edited.md', 'after');
    await write('Added.md', 'fresh');
    await rm(at('Deleted.md'));
    await watching.write('Own.md', 'mine during the sync', 'before');
    await expectTreeMatchesDisk();
    expect(done).toBe(false);
    // Nothing touched the index yet.
    expect(notes()).toEqual(['Deleted.md', 'Edited.md', 'Linker.md', 'Own.md']);

    release();
    await until(() => expect(notes()).toEqual(['Added.md', 'Edited.md', 'Linker.md', 'Own.md']));
    await until(() => expect(search('mine')).toEqual(['Own.md']));
    await until(() => expect(search('after')).toEqual(['Edited.md']));
    expect(search('doomed')).toEqual([]);
    expect(linkTargets()).toEqual([{ source: 'Linker.md', path: 'Added.md', name: null }]);
    await until(() => expect(seen).toContainEqual(event('changed', 'Edited.md')));
    expect(seen.filter((e) => e.path === 'Own.md')).toEqual([]);
  });

  test('a change the sync already read is still reported', async () => {
    // A new index: the sync reads every note, and there is no earlier hash to compare.
    await write('A.md', 'one');
    // Reported during the sync but not modified, as after Windows moves a last-access time.
    await write('Old.md', 'old');
    const lastWeek = new Date(Date.now() - 7 * 24 * 3600_000);
    await utimes(at('Old.md'), lastWeek, lastWeek);
    const first = gate();
    let edited = false;
    watching = start({
      async sync(db, vault, signal, options) {
        await writeFile(at('A.md'), 'two', 'utf8');
        await utimes(at('Old.md'), new Date(), lastWeek);
        edited = true;
        return first.sync(db, vault, signal, options);
      },
    });
    await until(() => expect(edited && first.synced()).toBe(true));
    expect(hashOf('A.md')).toBe(contentHash('two'));
    first.release();
    await until(() => expect(seen).toEqual([event('changed', 'A.md')]));
  });

  test('a change made while a large vault is being indexed', async () => {
    await mkdir(at('bulk'));
    const body = `${'word '.repeat(400)}[[n1]]`;
    await Promise.all(Array.from({ length: 4000 }, (_, i) => write(`bulk/n${i}.md`, body)));
    let done = false;
    watching = start();
    void watching.indexed.then(() => (done = true));
    tree = await watching.getTree();
    // The sync is under way once the first notes have content.
    await until(() => expect(db.prepare('SELECT 1 FROM notes_fts LIMIT 1').get()).toBeDefined());
    await write('bulk/n0.md', 'early edit');
    await write('bulk/zzz.md', 'late arrival');
    await rm(at('bulk/n3999.md'));
    expect(done).toBe(false);

    await watching.indexed;
    await until(() => expect(search('arrival')).toEqual(['bulk/zzz.md']));
    await until(() => expect(search('early')).toEqual(['bulk/n0.md']));
    await until(() => expect(notes()).toHaveLength(4000));
    expect(notes()).not.toContain('bulk/n3999.md');
    await expectTreeMatchesDisk();
  });

  test('without an index, the tree and changes still work', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await write('A.md', 'a');
    watching = start({ openDb: () => Promise.reject(new Error('no index')) });
    await expect(watching.indexed).rejects.toThrow('no index');
    tree = await watching.getTree();
    await write('A.md', 'b');
    await write('B.md', 'b');
    await until(() => expect(seen).toContainEqual(event('changed', 'A.md')));
    await expectTreeMatchesDisk();
    vi.restoreAllMocks();
  });

  test('close during the first scan settles and rejects the index', async () => {
    watching = start();
    const rejected = expect(watching.indexed).rejects.toThrow('indexing was cancelled');
    await watching.close();
    await rejected;
  });
});

describe('an index damaged where only a later read or write finds it', () => {
  let file: string;
  /** `damaged` of each `openDb` call. */
  let opens: boolean[];

  /** As the worker does it. */
  const openDb = async (damaged = false) => {
    opens.push(damaged);
    if (damaged) deleteIndex(file);
    return openIndex(file);
  };

  /** Opens the reader the helpers use. Only once the watcher is closed: it would hold the file. */
  const readIndex = () => {
    db = openIndex(file);
    return { notes: notes(), links: linkTargets() };
  };

  const rebuiltIndex = {
    notes: ['A.md', 'B.md'],
    links: [
      { source: 'A.md', path: 'B.md', name: null },
      { source: 'B.md', path: 'A.md', name: null },
    ],
  };

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    file = join(base, 'userData', 'index.db');
    opens = [];
    await write('A.md', '[[B]]');
    await write('B.md', 'b [[A]]');
    watching = start({ openDb });
    await watching.indexed;
    await watching.close();
    opens = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('during the first sync: the index is rebuilt', async () => {
    damageLinks(file);
    await write('B.md', 'edited while closed [[A]]');
    watching = start({ openDb });
    expect(await watching.indexed).toMatchObject({ notes: 2, indexed: 2, failed: 0 });
    expect(opens).toEqual([false, true]);
    await watching.close();
    expect(readIndex()).toEqual(rebuiltIndex);
    expect(search('edited')).toEqual(['B.md']);
  });

  test('during an update: the index is rebuilt and the change is still reported', async () => {
    damageLinks(file);
    watching = start({ openDb });
    // Nothing changed, so the first sync never reaches the damaged page.
    expect(await watching.indexed).toMatchObject({ indexed: 0 });
    expect(opens).toEqual([false]);
    tree = await watching.getTree();

    await write('B.md', 'edited while open [[A]]');
    await until(() => expect(seen).toContainEqual(event('changed', 'B.md')));
    expect(opens).toEqual([false, true]);

    // The new index takes the next changes.
    await write('C.md', 'later');
    await until(() => expect(seen).toContainEqual(event('created', 'C.md')));
    await rm(at('C.md'));
    await until(() => expect(seen).toContainEqual(event('deleted', 'C.md')));
    await write('A.md', 'after the rebuild [[B]]');
    await until(() => expect(seen).toContainEqual(event('changed', 'A.md')));
    await watching.close();
    expect(readIndex()).toEqual(rebuiltIndex);
    expect(search('rebuild')).toEqual(['A.md']);
    expect(opens).toEqual([false, true]);
  });

  test.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_IOERR_WRITE'])(
    '%s never deletes the file',
    async (code) => {
      const failure = Object.assign(new Error(code), { code });
      watching = start({ openDb, sync: () => Promise.reject(failure) });
      await expect(watching.indexed).rejects.toBe(failure);
      expect(opens).toEqual([false]);
      await watching.close();
      expect(readIndex()).toEqual(rebuiltIndex);
    },
  );

  test('damage that comes back is not rebuilt twice, and changes are still reported', async () => {
    const failure = Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT_VTAB' });
    watching = start({ openDb, sync: () => Promise.reject(failure) });
    await expect(watching.indexed).rejects.toBe(failure);
    expect(opens).toEqual([false, true]);
    tree = await watching.getTree();
    await write('B.md', 'still watched');
    await until(() => expect(seen).toContainEqual(event('changed', 'B.md')));
    expect(opens).toEqual([false, true]);
  });

  test('if the rebuild during an update fails, changes are still reported', async () => {
    damageLinks(file);
    watching = start({
      openDb: (damaged) => (damaged ? Promise.reject(new Error('the file is held')) : openDb()),
    });
    await watching.indexed;
    tree = await watching.getTree();
    await write('B.md', 'first');
    await until(() => expect(seen).toContainEqual(event('changed', 'B.md')));
    const from = seen.length;
    await write('A.md', 'second');
    await until(() => expect(seen.slice(from)).toContainEqual(event('changed', 'A.md')));
  });
});
