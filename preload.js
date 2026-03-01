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
  selectProjectFolder: () => ipcRenderer.invoke('select-project-folder'),

  // Title bar
  getTitleBarInfo: () => ipcRenderer.invoke('get-title-bar-info'),
  onTitleBarUpdate: (callback) => ipcRenderer.on('title-bar-update', (event, data) => callback(data)),

  // Tab management
  onCloseTab: (callback) => ipcRenderer.on('close-tab', () => callback()),
  onNewTab: (callback) => ipcRenderer.on('new-tab', () => callback()),

  // Paste image signal (Cmd+V with image on clipboard)
  onPasteImage: (callback) => ipcRenderer.on('paste-image', () => callback()),

  // Attachments
  saveClipboardImage: () => ipcRenderer.invoke('clipboard:save-image'),
  pickFiles: () => ipcRenderer.invoke('dialog:pick-files'),

  // Cumulus chat
  cumulusCreateThread: (name) => ipcRenderer.invoke('cumulus:create-thread', name),
  cumulusSendMessage: (thread, message, attachments) => ipcRenderer.invoke('cumulus:send-message', thread, message, attachments),
  cumulusKill: (thread) => ipcRenderer.send('cumulus:kill', thread),
  cumulusGetHistory: (thread, count) => ipcRenderer.invoke('cumulus:get-history', thread, count),
  cumulusListThreads: () => ipcRenderer.invoke('cumulus:list-threads'),
  onCumulusMessage: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('cumulus:message', handler);
    return () => ipcRenderer.removeListener('cumulus:message', handler);
  },
  onCumulusStreamChunk: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('cumulus:stream-chunk', handler);
    return () => ipcRenderer.removeListener('cumulus:stream-chunk', handler);
  },
  onCumulusStreamSegment: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('cumulus:stream-segment', handler);
    return () => ipcRenderer.removeListener('cumulus:stream-segment', handler);
  },
  onCumulusStreamEnd: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('cumulus:stream-end', handler);
    return () => ipcRenderer.removeListener('cumulus:stream-end', handler);
  },
  onCumulusError: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('cumulus:error', handler);
    return () => ipcRenderer.removeListener('cumulus:error', handler);
  },

  // Web tab control (for external automation tools)
  openWebTab: (url) => ipcRenderer.invoke('janus:open-web-tab', url),
  listWebTabs: () => ipcRenderer.invoke('janus:list-web-tabs'),
  navigateWebTab: (tabId, url) => ipcRenderer.invoke('janus:navigate-web-tab', tabId, url),
  onOpenWebTab: (callback) => ipcRenderer.on('janus:open-web-tab', (_, data) => callback(data)),
  onListWebTabs: (callback) => ipcRenderer.on('janus:list-web-tabs', (_, data) => callback(data)),
  onNavigateWebTab: (callback) => ipcRenderer.on('janus:navigate-web-tab', (_, data) => callback(data)),
  closeWebTab: (tabId) => ipcRenderer.invoke('janus:close-web-tab', tabId),
  onCloseWebTab: (callback) => ipcRenderer.on('janus:close-web-tab', (_, data) => callback(data)),
  sendWebTabResult: (requestId, result) => ipcRenderer.send('janus:web-tab-result', { requestId, result }),

  // Slash command APIs
  cumulusListIncludeFiles: (thread) => ipcRenderer.invoke('cumulus:list-include-files', thread),
  cumulusAddIncludeFile: (thread, filePath, scope) => ipcRenderer.invoke('cumulus:add-include-file', thread, filePath, scope),
  cumulusRemoveIncludeFile: (thread, filePath, scope) => ipcRenderer.invoke('cumulus:remove-include-file', thread, filePath, scope),
  cumulusGetTurns: (thread) => ipcRenderer.invoke('cumulus:get-turns', thread),
  cumulusRevert: (thread, messageId, restoreGit) => ipcRenderer.invoke('cumulus:revert', thread, messageId, restoreGit),

  // Cumulus tab creation (reverse IPC from main process)
  onCreateCumulusTab: (callback) => ipcRenderer.on('janus:create-cumulus-tab', (_, data) => callback(data)),

  // Active tab tracking
  setActiveCumulusTab: (threadName) => ipcRenderer.send('janus:active-cumulus-tab', threadName),
  clearActiveCumulusTab: () => ipcRenderer.send('janus:active-cumulus-tab', null),
  onTabUnread: (callback) => ipcRenderer.on('janus:tab-unread', (_, data) => callback(data)),
});
