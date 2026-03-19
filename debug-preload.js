const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('debugAPI', {
  getDebugState: (threadName) => ipcRenderer.invoke('cumulus:get-debug-state', threadName),
  getActiveThread: () => ipcRenderer.invoke('cumulus:get-active-thread'),
  listThreads: () => ipcRenderer.invoke('cumulus:list-threads-debug'),
  onDebugUpdate: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('debug:update', handler);
    return () => ipcRenderer.removeListener('debug:update', handler);
  },
});
