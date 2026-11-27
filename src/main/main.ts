// Manages windows and routes IPC. No file I/O here (AGENTS.md, rule 1).
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow } from 'electron';
import { pendingHandlers, registerIpc } from './ipc';
import { createVaultClient } from './vault-client';
import vaultWorkerPath from './vault-worker?modulePath';

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
  const vault = createVaultClient(new Worker(vaultWorkerPath));
  registerIpc({ ...pendingHandlers, getTree: () => vault.call('getTree') });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
