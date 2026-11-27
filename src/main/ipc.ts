// Main side of the contract in `shared/ipc.ts`. Routing only (AGENTS.md, rule 1).
import { ipcMain, type WebContents } from 'electron';
import { CALL_CHANNELS, type CallHandlers, type CallName, type EventPayloads } from '../shared/ipc';

export function registerIpc(handlers: CallHandlers): void {
  for (const name of Object.keys(CALL_CHANNELS) as CallName[]) {
    const handler = handlers[name] as (...args: unknown[]) => unknown;
    ipcMain.handle(CALL_CHANNELS[name], (_event, ...args: unknown[]) => handler(...args));
  }
}

export function sendEvent<C extends keyof EventPayloads>(
  target: WebContents,
  channel: C,
  payload: EventPayloads[C],
): void {
  target.send(channel, payload);
}

function notImplemented(name: CallName): () => never {
  return () => {
    throw new Error(`${name} is not implemented yet`);
  };
}

/** Replaced one by one by the issues that build each feature. */
export const pendingHandlers: CallHandlers = {
  createVault: notImplemented('createVault'),
  openVault: notImplemented('openVault'),
  getTree: notImplemented('getTree'),
  listNotes: notImplemented('listNotes'),
  readNote: notImplemented('readNote'),
  getPreviews: notImplemented('getPreviews'),
  writeNote: notImplemented('writeNote'),
  renameNote: notImplemented('renameNote'),
  createFolder: notImplemented('createFolder'),
  deleteInfo: notImplemented('deleteInfo'),
  deleteItem: notImplemented('deleteItem'),
  search: notImplemented('search'),
  resumeUnload: notImplemented('resumeUnload'),
};
