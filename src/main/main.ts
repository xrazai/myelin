// Manages windows and routes IPC. No file I/O here (AGENTS.md, rule 1).
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import { EVENT_CHANNELS, type VaultInfo } from '../shared/ipc';
import { pendingHandlers, registerIpc, sendEvent } from './ipc';
import { createVaultClient, type VaultClient } from './vault-client';
import type { VaultWorkerData } from './vault-protocol';
import vaultWorkerPath from './vault-worker?modulePath';

// The renderer never sends paths: the folder comes from this dialog.
async function pickAndOpenVault(
  vault: VaultClient,
  title: string,
  buttonLabel: string,
): Promise<VaultInfo | null> {
  const options: OpenDialogOptions = { title, buttonLabel, properties: ['openDirectory', 'createDirectory'] };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const { canceled, filePaths } = await (parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options));
  const [root] = filePaths;
  if (canceled || !root) return null;
  const info = await vault.call('open', root);
  // A failure is logged by the worker.
  void vault.call('whenIndexed').then(
    (report) => console.log('[main] vault indexed', report),
    () => {},
  );
  return info;
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    console.log('[main] window shown');
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  // The dev server URL only exists under `electron-vite dev`; the packaged app loads from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  const workerData: VaultWorkerData = { userData: app.getPath('userData') };
  const vault = createVaultClient(new Worker(vaultWorkerPath, { workerData }), (events) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendEvent(window.webContents, EVENT_CHANNELS.vaultEvents, events);
    }
  });
  registerIpc({
    ...pendingHandlers,
    // The same operation: a folder without vault.json gets one, an existing vault is left as is.
    createVault: () => pickAndOpenVault(vault, 'Create a new vault', 'Create vault here'),
    openVault: () => pickAndOpenVault(vault, 'Open a vault', 'Open vault'),
    getTree: () => vault.call('getTree'),
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
