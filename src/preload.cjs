const { contextBridge, ipcRenderer } = require('electron');

// Expose only this small API, not Electron or unrestricted IPC, to the sandboxed UI.
contextBridge.exposeInMainWorld('audioLab', {
  info: () => ipcRenderer.invoke('audio:info'),
  open: () => ipcRenderer.invoke('audio:open'),
  loadNative: (id) => ipcRenderer.invoke('audio:load-native', id),
  command: (message) => ipcRenderer.invoke('audio:command', message),
  onEvent: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('audio:event', listener);
    // Return an unsubscribe function for callers that tear down their UI.
    return () => ipcRenderer.removeListener('audio:event', listener);
  },
});
