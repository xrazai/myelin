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
  getTree: call('getTree'),
  readNote: call('readNote'),
  writeNote: call('writeNote'),
  search: call('search'),
  onVaultEvents: subscribe(EVENT_CHANNELS.vaultEvents),
  onIndexing: subscribe(EVENT_CHANNELS.indexing),
};

contextBridge.exposeInMainWorld('myelin', api);
