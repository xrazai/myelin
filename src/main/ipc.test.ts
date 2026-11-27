import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, expect, test, vi } from 'vitest';
import { CALL_CHANNELS, EVENT_CHANNELS, type MyelinApi } from '../shared/ipc';
import { pendingHandlers, registerIpc } from './ipc';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  handle: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => electron.exposed.set(key, value),
  },
  ipcMain: { handle: electron.handle },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

let api: MyelinApi;

beforeAll(async () => {
  await import('../preload/preload');
  api = electron.exposed.get('myelin') as MyelinApi;
});

test('preload exposes only window.myelin, with exactly the contract methods', () => {
  expect([...electron.exposed.keys()]).toEqual(['myelin']);
  expect(Object.keys(api).sort()).toEqual([...Object.keys(CALL_CHANNELS), 'onVaultEvents', 'onIndexing'].sort());
});

test('each call invokes its own channel with its arguments', () => {
  void api.createVault();
  void api.openVault();
  void api.getTree();
  void api.listNotes();
  void api.readNote('a.md');
  void api.getPreviews(['a.md']);
  void api.writeNote('a.md', 'text', 'before');
  void api.renameNote('a.md', 'b.md');
  void api.search('query');
  void api.resumeUnload();
  expect(electron.invoke.mock.calls).toEqual([
    [CALL_CHANNELS.createVault],
    [CALL_CHANNELS.openVault],
    [CALL_CHANNELS.getTree],
    [CALL_CHANNELS.listNotes],
    [CALL_CHANNELS.readNote, 'a.md'],
    [CALL_CHANNELS.getPreviews, ['a.md']],
    [CALL_CHANNELS.writeNote, 'a.md', 'text', 'before'],
    [CALL_CHANNELS.renameNote, 'a.md', 'b.md'],
    [CALL_CHANNELS.search, 'query'],
    [CALL_CHANNELS.resumeUnload],
  ]);
});

test('subscription passes only the payload and unsubscribes its own wrapper', () => {
  const listener = vi.fn();
  const unsubscribe = api.onVaultEvents(listener);
  const [channel, wrapper] = electron.on.mock.calls[0] as [string, (...args: unknown[]) => void];
  expect(channel).toBe(EVENT_CHANNELS.vaultEvents);
  wrapper({ sender: 'ipc event' }, [{ type: 'changed', path: 'a.md' }]);
  expect(listener.mock.calls).toEqual([[[{ type: 'changed', path: 'a.md' }]]]);
  unsubscribe();
  expect(electron.removeListener).toHaveBeenCalledWith(channel, wrapper);
});

test('each subscription listens on its own channel', () => {
  electron.on.mockClear();
  api.onVaultEvents(() => {});
  api.onIndexing(() => {});
  expect(electron.on.mock.calls.map(([channel]) => channel)).toEqual(Object.values(EVENT_CHANNELS));
});

test('main handles every call channel and drops the IPC event', () => {
  const readNote = vi.fn(() => 'text');
  registerIpc({ ...pendingHandlers, readNote });
  expect(electron.handle.mock.calls.map(([channel]) => channel)).toEqual(Object.values(CALL_CHANNELS));
  const registered = new Map(electron.handle.mock.calls as [string, (...args: unknown[]) => unknown][]);
  expect(registered.get(CALL_CHANNELS.readNote)?.({}, 'a.md')).toBe('text');
  expect(readNote).toHaveBeenCalledWith('a.md');
  expect(() => registered.get(CALL_CHANNELS.search)?.({}, 'q')).toThrow('not implemented');
});

test('only the preload and main/ipc.ts touch Electron IPC', () => {
  const src = join(import.meta.dirname, '..');
  const ipcApi =
    /\b(ipcMain|ipcRenderer|MessageChannelMain|utilityProcess)\b|\b(webContents|sender)\s*\.\s*(send|postMessage|ipc)\b|\.sendToFrame\b/;
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|js|svelte)$/.test(file) && !file.endsWith('.test.ts'))
    .map((file) => ({ file: relative(src, join(src, file)).split(sep).join('/'), text: readFileSync(join(src, file), 'utf8') }));
  expect(files.filter(({ text }) => ipcApi.test(text)).map(({ file }) => file).sort()).toEqual([
    'main/ipc.ts',
    'preload/preload.ts',
  ]);
  const rendererImports = files.filter(
    ({ file, text }) => file.startsWith('renderer/') && /['"](electron|node:[^'"]*)['"]/.test(text),
  );
  expect(rendererImports).toEqual([]);
});
