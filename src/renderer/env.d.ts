import type { MyelinApi } from '../shared/ipc';

declare global {
  interface Window {
    readonly myelin: MyelinApi;
  }
}
