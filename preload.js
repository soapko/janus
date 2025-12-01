const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Terminal
  createTerminal: (cwd) => ipcRenderer.invoke('terminal-create', cwd),
  killTerminal: (id) => ipcRenderer.send('terminal-kill', id),
  sendTerminalInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  onTerminalData: (callback) => ipcRenderer.on('terminal-data', (event, { id, data }) => callback(id, data)),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),

  // Project
  getProjectPath: () => ipcRenderer.invoke('get-project-path'),
  selectProjectFolder: () => ipcRenderer.invoke('select-project-folder')
});
