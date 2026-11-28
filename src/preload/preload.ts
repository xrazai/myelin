// Implements the contract in `shared/ipc.ts`. Never expose `ipcRenderer` itself.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CALL_CHANNELS, EVENT_CHANNELS, type CallName, type EventPayloads, type MyelinApi } from '../shared/ipc';

function call<K extends CallName>(name: K) {
  return (...args: Parameters<MyelinApi[K]>) =>
    ipcRenderer.invoke(CALL_CHANNELS[name], ...args) as ReturnType<MyelinApi[K]>;
}

function subscribe<C extends keyof EventPayloads>(channel: C) {
  return (listener: (payload: EventPayloads[C]) => void) => {
    // The IpcRendererEvent stays here: it gives access to ipcRenderer.
    const wrapper = (_event: IpcRendererEvent, payload: EventPayloads[C]) => listener(payload);
    ipcRenderer.on(channel, wrapper);
    return () => {
      ipcRenderer.removeListener(channel, wrapper);
    };
  };
}

const api: MyelinApi = {
  createVault: call('createVault'),
  openVault: call('openVault'),
  reopenVault: call('reopenVault'),
  getTree: call('getTree'),
  listNotes: call('listNotes'),
  readNote: call('readNote'),
  getPreviews: call('getPreviews'),
  getBacklinks: call('getBacklinks'),
  writeNote: call('writeNote'),
  renameNote: call('renameNote'),
  renameFolder: call('renameFolder'),
  createFolder: call('createFolder'),
  deleteInfo: call('deleteInfo'),
  deleteItem: call('deleteItem'),
  search: call('search'),
  getGraph: call('getGraph'),
  saveGraphPositions: call('saveGraphPositions'),
  saveGraphCommunities: call('saveGraphCommunities'),
  resumeUnload: call('resumeUnload'),
  onVaultEvents: subscribe(EVENT_CHANNELS.vaultEvents),
  onIndexing: subscribe(EVENT_CHANNELS.indexing),
  onGraphChange: subscribe(EVENT_CHANNELS.graphChange),
};

contextBridge.exposeInMainWorld('myelin', api);
