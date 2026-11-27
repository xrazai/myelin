import { contextBridge } from 'electron';
import type { MyelinApi } from '../shared/ipc';

const api: MyelinApi = {};

contextBridge.exposeInMainWorld('myelin', api);
