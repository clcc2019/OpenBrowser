'use strict';

// Run with the desktop runtime: verifies the real sandboxed preload and IPC
// bridge, which cannot be exercised by a plain Node.js unit test.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  ipcMain.handle('system:info', () => ({ marker: 'preload-ok' }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '..', 'preload.js'), sandbox: true,
    contextIsolation: true, nodeIntegration: false,
  } });
  let preloadFailure;
  window.webContents.on('preload-error', (_event, _path, error) => { preloadFailure = error; });
  await window.loadURL('data:text/html,<title>preload test</title>');
  if (preloadFailure) throw preloadFailure;
  const value = await window.webContents.executeJavaScript('window.ops?.getInfo().then(v => v.marker)');
  if (value !== 'preload-ok') throw new Error('Sandboxed preload bridge did not return the IPC result');
  console.log('preload-runtime-selftest: ok');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
