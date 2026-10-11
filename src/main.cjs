const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');

const { validateCommand } = require('./protocol.cjs');

let window;
let host;
// Cache startup state for a renderer that subscribes after the helper has initialized.
let ready;
let quitting = false;
const native = process.platform === 'darwin';

// Forward native events to the renderer; raw audio never crosses this bridge.
function send(message) {
  if (window && !window.isDestroyed()) window.webContents.send('audio:event', message);
}

// The Swift helper reads one JSON command per line from stdin.
function command(message) {
  if (!host || !host.stdin.writable)
    throw new Error('Native audio host is not running. Restart the app.');
  host.stdin.write(JSON.stringify(message) + '\n');
}

// Development builds and packaged apps keep the helper in different locations.
function startHost() {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'native/au-host')
    : path.join(__dirname, '../native/bin/au-host');
  host = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Process error/exit handlers below report failures, including a closed stdin pipe.
  host.stdin.on('error', () => {});
  host.on('error', (error) => {
    ready = { type: 'error', message: error.message };
    send(ready);
  });
  createInterface({ input: host.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'ready') ready = message;
      send(message);
    } catch {
      /* Non-protocol diagnostics are ignored. */
    }
  });
  host.stderr.on('data', (data) => console.error('[Audio Unit]', data.toString().trim()));
  host.on('exit', (code, signal) => {
    host = null;
    if (!quitting) {
      ready = {
        type: 'error',
        message: `Audio host stopped (${signal || code}). Restart the app.`,
      };
      send(ready);
    }
  });
}

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 1180,
    height: 850,
    minWidth: 850,
    minHeight: 720,
    backgroundColor: '#111816',
    title: 'Isolation Lab',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  ipcMain.handle('audio:info', () => ({ platform: process.platform, native, ready }));
  // Renderer commands are allowlisted; only the main-process file picker can supply paths.
  ipcMain.handle('audio:command', (_event, message) => {
    command(validateCommand(message));
  });
  ipcMain.handle('audio:open', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio clips',
          extensions: ['wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg'],
        },
      ],
    });
    if (result.canceled) return null;
    const filePath = result.filePaths[0];
    // macOS streams from disk; the browser backend receives bytes to decode locally.
    if (native) {
      command({ command: 'load', path: filePath });
      return { native: true };
    }
    if ((await stat(filePath)).size > 200 * 1024 * 1024)
      throw new Error('Choose a clip smaller than 200 MB for browser playback.');
    return { native: false, name: path.basename(filePath), bytes: await readFile(filePath) };
  });
  if (native) startHost();
  window.loadFile(path.join(__dirname, 'index.html'));
});

// Do not leave a helper process playing after the application exits.
app.on('before-quit', () => {
  quitting = true;
  host?.kill();
});
app.on('window-all-closed', () => app.quit());
