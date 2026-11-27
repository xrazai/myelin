// The real watcher on a real folder. Events are followed through the renderer's own tree
// logic, so each test also checks that the reported tree matches a fresh scan.
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

    test('a rename rewrites links once, without reporting link-only changes', async () => {
      await write('Target.md', '[[Home]] [[#Self]]');
      await until(() => expect(notes()).toContain('Target.md'));
      const from = seen.length;
      await watching.rename('Home.md', 'Renamed.md');
      await until(() => expect(notes()).toEqual(['Renamed.md', 'Target.md']));
      expect(await readFile(at('Target.md'), 'utf8')).toBe('[[Renamed]] [[#Self]]');
      expect(await readFile(at('Renamed.md'), 'utf8')).toBe('start [[Later]]');
      expect(linkTargets()).toContainEqual({ source: 'Target.md', path: 'Renamed.md', name: null });
      expect(await settled(from)).not.toContainEqual(event('changed', 'Target.md'));
      await expectTreeMatchesDisk();
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

describe('during the first sync', () => {
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
