const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFile, stat } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { validateCommand } = require('./protocol.cjs');

// A secure local origin supports ES modules, fetch, and AudioWorklet without a web server.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lab',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
let window, host, ready;
const selectedFiles = new Map();
let quitting = false;
let requestId = 0;
let fileId = 0;
const pending = new Map();
const native = process.platform === 'darwin';

function send(message) {
  if (window && !window.isDestroyed()) window.webContents.send('audio:event', message);
}
function command(message) {
  if (!host?.stdin.writable) return Promise.reject(new Error('Native audio host is not running.'));
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Native audio command timed out.'));
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    host.stdin.write(JSON.stringify({ ...message, requestId: id }) + '\n');
  });
}
function failPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
}
function startHost() {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'native/au-host')
    : path.join(__dirname, '../native/bin/au-host');
  host = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  host.stdin.on('error', (error) => failPending(error));
  host.on('error', (error) => {
    ready = { type: 'ready', available: false, parameters: [], error: error.message };
    failPending(error);
    send(ready);
  });
  createInterface({ input: host.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(message.requestId);
    if (request && ['ack', 'error'].includes(message.type)) {
      clearTimeout(request.timeout);
      pending.delete(message.requestId);
      if (message.type === 'error') request.reject(new Error(message.message));
      else request.resolve();
      return;
    }
    if (message.type === 'ready') ready = message;
    send(message);
  });
  host.stderr.on('data', (data) => console.error('[Audio Unit]', data.toString().trim()));
  host.on('exit', (code, signal) => {
    host = null;
    const message = `Native audio host stopped (${signal || code}). DeepFilterNet3 remains available.`;
    failPending(new Error(message));
    if (!quitting) {
      ready = { type: 'ready', available: false, parameters: [], error: message };
      send(ready);
    }
  });
}

app.whenReady().then(() => {
  protocol.handle('lab', (request) => {
    const url = new URL(request.url);
    // Only expose frontend files. Never turn the protocol into an arbitrary filesystem reader.
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(__dirname, relative);
    if (
      url.hostname !== 'app' ||
      !file.startsWith(__dirname + path.sep) ||
      relative.endsWith('.cjs') ||
      relative.includes('\\')
    )
      return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).href);
  });
  window = new BrowserWindow({
    width: 1180,
    height: 1000,
    minWidth: 850,
    minHeight: 750,
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
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  ipcMain.handle('audio:info', () => ({ platform: process.platform, native, ready }));
  ipcMain.handle('audio:command', (_event, message) => command(validateCommand(message)));
  ipcMain.handle('audio:load-native', (_event, id) => {
    const filePath = selectedFiles.get(id);
    if (!filePath) throw new Error('Select the audio file again.');
    return command({ command: 'load', path: filePath });
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
    if ((await stat(filePath)).size > 100 * 1024 * 1024)
      throw new Error('Choose a clip smaller than 100 MB.');
    const bytes = await readFile(filePath);
    selectedFiles.set(++fileId, filePath);
    if (selectedFiles.size > 8) selectedFiles.delete(selectedFiles.keys().next().value);
    // Give the renderer a token, not a path it could later replace with an arbitrary file.
    return { id: fileId, name: path.basename(filePath), bytes };
  });
  if (native) startHost();
  window.loadURL('lab://app/index.html');
});
app.on('before-quit', () => {
  quitting = true;
  host?.kill();
});
app.on('window-all-closed', () => app.quit());
