const { app, BrowserWindow, ipcMain, dialog, session, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const pty = require('node-pty');
const { COLOR_PALETTE, getProjectColor, getProjectColorId, setProjectColor, getColorHex } = require('./projectColors');
const { CumulusBridge } = require('./cumulus-bridge');

const windows = new Set();
// Map PTY processes by window ID and terminal ID: windowId -> Map(terminalId -> ptyProcess)
const windowPtyProcesses = new Map();
// Map window ID -> CumulusBridge instance
const windowBridges = new Map();
// Map window ID -> active cumulus thread name (reported by renderer)
const windowActiveCumulusTab = new Map();
let nextTerminalId = 1;

function updateWindowTitle(win) {
  if (win.projectPath) {
    const folderName = path.basename(win.projectPath);
    win.setTitle(`Janus – ${folderName}`);
  } else {
    win.setTitle('Janus');
  }
}

function createWindow(projectPath = null) {
  const titleBarColor = getProjectColor(projectPath);

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Janus',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: titleBarColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      webSecurity: false  // Allow file:// URLs in webviews
    }
  });

  // Store projectPath on the window object and update title
  win.projectPath = projectPath;
  updateWindowTitle(win);
  windows.add(win);

  // Initialize PTY map for this window
  windowPtyProcesses.set(win.id, new Map());

  // Initialize Cumulus bridge for this window
  const bridge = new CumulusBridge(projectPath);
  bridge.initialize().catch(err => console.error('[Cumulus] Init error:', err));
  windowBridges.set(win.id, bridge);

  win.loadFile('index.html');

  win.on('closed', () => {
    // Kill all PTY processes for this window
    const ptyMap = windowPtyProcesses.get(win.id);
    if (ptyMap) {
      for (const [id, ptyProcess] of ptyMap) {
        ptyProcess.kill();
      }
      windowPtyProcesses.delete(win.id);
    }
    // Destroy Cumulus bridge for this window
    const bridge = windowBridges.get(win.id);
    if (bridge) {
      bridge.destroy();
      windowBridges.delete(win.id);
    }
    windows.delete(win);
  });

  return win;
}

function createTerminal(win, cwd = null) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
  const id = nextTerminalId++;

  // Spawn as login shell (-l) to source user's profile and get proper PATH
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || win.projectPath || process.env.HOME,
    env: process.env
  });

  // Batch PTY output to reduce IPC frequency during rapid streaming
  // (e.g., LLM token-by-token output). Flushes every 16ms (~60fps).
  let pendingData = '';
  let flushTimer = null;

  ptyProcess.onData((data) => {
    pendingData += data;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('terminal-data', { id, data: pendingData });
        }
        pendingData = '';
      }, 16);
    }
  });

  // Store PTY process in the window's map
  const ptyMap = windowPtyProcesses.get(win.id);
  if (ptyMap) {
    ptyMap.set(id, ptyProcess);
  }

  return id;
}

// Helper to get PTY process for a window
function getPtyProcess(win, terminalId) {
  const ptyMap = windowPtyProcesses.get(win.id);
  return ptyMap ? ptyMap.get(terminalId) : null;
}

// Create new terminal
ipcMain.handle('terminal-create', (event, cwd) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return createTerminal(win, cwd);
});

// Get project path
ipcMain.handle('get-project-path', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.projectPath : null;
});

// Get title bar info (color and title)
ipcMain.handle('get-title-bar-info', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;

  const color = getProjectColor(win.projectPath);
  const title = win.projectPath ? `Janus – ${path.basename(win.projectPath)}` : 'Janus';
  return { color, title };
});

// Select project folder
ipcMain.handle('select-project-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;

  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    win.projectPath = result.filePaths[0];
    // Update the Cumulus bridge so chat tabs use the correct project path
    const bridge = windowBridges.get(win.id);
    if (bridge) bridge.projectPath = win.projectPath;
    updateWindowTitle(win);
    // Notify renderer of title bar update
    const newColor = getProjectColor(win.projectPath);
    const title = `Janus – ${path.basename(win.projectPath)}`;
    win.webContents.send('title-bar-update', { color: newColor, title });
    return win.projectPath;
  }
  return null;
});

// Kill terminal
ipcMain.on('terminal-kill', (event, id) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const ptyProcess = getPtyProcess(win, id);
  if (ptyProcess) {
    ptyProcess.kill();
    const ptyMap = windowPtyProcesses.get(win.id);
    if (ptyMap) ptyMap.delete(id);
  }
});

// Handle terminal input
ipcMain.on('terminal-input', (event, { id, data }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const ptyProcess = getPtyProcess(win, id);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

// Handle terminal resize
ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const ptyProcess = getPtyProcess(win, id);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

// ===== CUMULUS IPC HANDLERS =====

// Helper to get bridge for a window
function getBridge(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return windowBridges.get(win.id) || null;
}

// Create/open a thread
ipcMain.handle('cumulus:create-thread', async (event, threadName) => {
  const bridge = getBridge(event);
  if (!bridge) return null;
  await bridge.getOrCreateThread(threadName);
  return { threadName };
});

// Send message and stream response
ipcMain.handle('cumulus:send-message', async (event, threadName, message, attachments) => {
  const bridge = getBridge(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!bridge || !win) return null;
  return bridge.sendMessage(threadName, message, win, attachments);
});

// Kill running Claude process for a thread
ipcMain.on('cumulus:kill', (event, threadName) => {
  const bridge = getBridge(event);
  if (bridge) bridge.killProcess(threadName);
});

// Get message history
ipcMain.handle('cumulus:get-history', async (event, threadName, count) => {
  const bridge = getBridge(event);
  if (!bridge) return [];
  return bridge.getHistory(threadName, count);
});

// List available threads
ipcMain.handle('cumulus:list-threads', async (event) => {
  const bridge = getBridge(event);
  if (!bridge) return [];
  return bridge.listThreads();
});

// ===== SLASH COMMAND IPC HANDLERS =====

ipcMain.handle('cumulus:list-include-files', async (event, threadName) => {
  const bridge = getBridge(event);
  if (!bridge) return [];
  return bridge.listIncludeFiles(threadName);
});

ipcMain.handle('cumulus:add-include-file', async (event, threadName, filePath, scope) => {
  const bridge = getBridge(event);
  if (!bridge) return;
  return bridge.addIncludeFile(threadName, filePath, scope);
});

ipcMain.handle('cumulus:remove-include-file', async (event, threadName, filePath, scope) => {
  const bridge = getBridge(event);
  if (!bridge) return;
  return bridge.removeIncludeFile(threadName, filePath, scope);
});

ipcMain.handle('cumulus:get-turns', async (event, threadName) => {
  const bridge = getBridge(event);
  if (!bridge) return [];
  return bridge.getTurns(threadName);
});

ipcMain.handle('cumulus:revert', async (event, threadName, messageId, restoreGit) => {
  const bridge = getBridge(event);
  if (!bridge) return { success: false, removedCount: 0, error: 'No bridge' };
  return bridge.revert(threadName, messageId, restoreGit);
});

// Track which cumulus tab is active in the renderer
ipcMain.on('janus:active-cumulus-tab', (event, threadName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (threadName) {
      windowActiveCumulusTab.set(win.id, threadName);
    } else {
      windowActiveCumulusTab.delete(win.id);
    }
  }
});

// ===== WEB TAB CONTROL IPC HANDLERS =====

// Request ID counter for renderer round-trips
let nextWebTabRequestId = 1;
const pendingWebTabRequests = new Map();

ipcMain.handle('janus:open-web-tab', (event, url) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const requestId = nextWebTabRequestId++;
  return new Promise((resolve) => {
    pendingWebTabRequests.set(requestId, resolve);
    win.webContents.send('janus:open-web-tab', { requestId, url });
    // Timeout after 5s
    setTimeout(() => {
      if (pendingWebTabRequests.has(requestId)) {
        pendingWebTabRequests.delete(requestId);
        resolve(null);
      }
    }, 5000);
  });
});

ipcMain.handle('janus:list-web-tabs', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return [];
  const requestId = nextWebTabRequestId++;
  return new Promise((resolve) => {
    pendingWebTabRequests.set(requestId, resolve);
    win.webContents.send('janus:list-web-tabs', { requestId });
    setTimeout(() => {
      if (pendingWebTabRequests.has(requestId)) {
        pendingWebTabRequests.delete(requestId);
        resolve([]);
      }
    }, 5000);
  });
});

ipcMain.handle('janus:navigate-web-tab', (event, tabId, url) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };
  const requestId = nextWebTabRequestId++;
  return new Promise((resolve) => {
    pendingWebTabRequests.set(requestId, resolve);
    win.webContents.send('janus:navigate-web-tab', { requestId, tabId, url });
    setTimeout(() => {
      if (pendingWebTabRequests.has(requestId)) {
        pendingWebTabRequests.delete(requestId);
        resolve({ success: false });
      }
    }, 5000);
  });
});

// Renderer sends results back here
ipcMain.on('janus:web-tab-result', (event, { requestId, result }) => {
  const resolve = pendingWebTabRequests.get(requestId);
  if (resolve) {
    pendingWebTabRequests.delete(requestId);
    resolve(result);
  }
});

ipcMain.handle('janus:close-web-tab', (event, tabId) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };
  const requestId = nextWebTabRequestId++;
  return new Promise((resolve) => {
    pendingWebTabRequests.set(requestId, resolve);
    win.webContents.send('janus:close-web-tab', { requestId, tabId });
    setTimeout(() => {
      if (pendingWebTabRequests.has(requestId)) {
        pendingWebTabRequests.delete(requestId);
        resolve({ success: false });
      }
    }, 5000);
  });
});

// ===== HTTP API FOR EXTERNAL TOOLS (Playwright/Puppet/Abra) =====

const HTTP_API_PORT = 9223;

function getMainWindow() {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

function sendToRenderer(channel, data) {
  return new Promise((resolve) => {
    const win = getMainWindow();
    if (!win) return resolve(null);
    const requestId = nextWebTabRequestId++;
    pendingWebTabRequests.set(requestId, resolve);
    win.webContents.send(channel, { requestId, ...data });
    setTimeout(() => {
      if (pendingWebTabRequests.has(requestId)) {
        pendingWebTabRequests.delete(requestId);
        resolve(null);
      }
    }, 5000);
  });
}

function startHttpApi() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${HTTP_API_PORT}`);
    const segments = url.pathname.split('/').filter(Boolean); // ['api', 'tabs', ...]

    // GET /api/tabs — list web tabs
    if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'tabs' && !segments[2]) {
      const tabs = await sendToRenderer('janus:list-web-tabs', {});
      res.writeHead(200);
      res.end(JSON.stringify(tabs || []));
      return;
    }

    // POST /api/tabs — create web tab
    if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'tabs' && !segments[2]) {
      const body = await readBody(req);
      const { url: tabUrl } = body;
      const result = await sendToRenderer('janus:open-web-tab', { url: tabUrl });
      if (result) {
        res.writeHead(201);
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to create tab' }));
      }
      return;
    }

    // POST /api/tabs/:id/navigate — navigate a tab
    if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'tabs' && segments[3] === 'navigate') {
      const tabId = parseInt(segments[2], 10);
      const body = await readBody(req);
      const result = await sendToRenderer('janus:navigate-web-tab', { tabId, url: body.url });
      res.writeHead(200);
      res.end(JSON.stringify(result || { success: false }));
      return;
    }

    // DELETE /api/tabs/:id — close a tab
    if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'tabs' && segments[2]) {
      const tabId = parseInt(segments[2], 10);
      const result = await sendToRenderer('janus:close-web-tab', { tabId });
      res.writeHead(200);
      res.end(JSON.stringify(result || { success: false }));
      return;
    }

    // ===== AGENT MESSAGING ENDPOINTS =====

    // POST /api/agents — create a new cumulus chat tab (agent)
    if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'agents' && !segments[2]) {
      const body = await readBody(req);
      const threadName = body.threadName;
      if (!threadName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing threadName' }));
        return;
      }

      // Check if agent already exists
      for (const [, bridge] of windowBridges) {
        if (bridge.threads.has(threadName)) {
          res.writeHead(200);
          res.end(JSON.stringify({ created: false, threadName, reason: 'already exists' }));
          return;
        }
      }

      // Create the tab via reverse IPC to renderer
      const result = await sendToRenderer('janus:create-cumulus-tab', { threadName });
      if (!result) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to create tab (renderer timeout or no window)' }));
        return;
      }

      res.writeHead(201);
      res.end(JSON.stringify({ created: true, threadName: result.threadName, tabId: result.tabId }));
      return;
    }

    // GET /api/agents — list all active cumulus agents across all windows
    if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'agents' && !segments[2]) {
      const agents = [];
      const activeThreads = [];
      for (const [winId, bridge] of windowBridges) {
        const bridgeAgents = bridge.getActiveAgents();
        agents.push(...bridgeAgents);
        const activeThread = windowActiveCumulusTab.get(winId);
        if (activeThread) activeThreads.push(activeThread);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ agents, activeTab: activeThreads[0] || null }));
      return;
    }

    // POST /api/agents/:name/message — deliver message to a specific agent
    if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'agents' && segments[3] === 'message') {
      const targetName = decodeURIComponent(segments[2]);
      const body = await readBody(req);
      const { message, sender } = body;

      if (!message || !sender) {
        res.writeHead(400);
        res.end(JSON.stringify({ delivered: false, error: 'Missing message or sender' }));
        return;
      }

      // Find which bridge owns this thread
      let targetBridge = null;
      let targetWin = null;
      for (const [winId, bridge] of windowBridges) {
        if (bridge.threads.has(targetName)) {
          targetBridge = bridge;
          targetWin = BrowserWindow.fromId(winId);
          break;
        }
      }

      if (!targetBridge || !targetWin) {
        // Collect available agent names for helpful error
        const available = [];
        for (const [, bridge] of windowBridges) {
          for (const [name] of bridge.threads) {
            available.push(name);
          }
        }
        res.writeHead(404);
        res.end(JSON.stringify({ delivered: false, error: `Agent "${targetName}" not found`, available }));
        return;
      }

      // Inject the message (non-blocking from the sender's perspective)
      targetBridge.injectMessage(targetName, message, sender, targetWin).catch(err => {
        console.error(`[Agent API] injectMessage error for ${targetName}:`, err);
      });

      // Notify renderer to show unread badge on target tab
      targetWin.webContents.send('janus:tab-unread', { threadName: targetName });

      res.writeHead(200);
      res.end(JSON.stringify({ delivered: true, target: targetName }));
      return;
    }

    // GET /api/targets — list CDP webview targets (convenience)
    if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'targets') {
      try {
        const resp = await fetch('http://localhost:9222/json');
        const targets = await resp.json();
        const webviews = targets.filter(t => t.type === 'webview');
        res.writeHead(200);
        res.end(JSON.stringify(webviews));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'CDP not available' }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(HTTP_API_PORT, '127.0.0.1', () => {
    console.log(`Janus HTTP API listening on http://127.0.0.1:${HTTP_API_PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${HTTP_API_PORT} in use, trying ${HTTP_API_PORT + 1}`);
      server.listen(HTTP_API_PORT + 1, '127.0.0.1');
    }
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

// ===== ATTACHMENT IPC HANDLERS =====

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const ATTACHMENT_DIR = path.join(os.tmpdir(), 'janus-attachments');

function ensureAttachmentDir() {
  if (!fs.existsSync(ATTACHMENT_DIR)) {
    fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  }
}

// Save clipboard image to temp file
ipcMain.handle('clipboard:save-image', async () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  ensureAttachmentDir();
  const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${id}.png`;
  const filePath = path.join(ATTACHMENT_DIR, filename);
  fs.writeFileSync(filePath, image.toPNG());

  return { id, name: filename, path: filePath, type: 'image', mimeType: 'image/png' };
});

// Open file picker and return attachment objects
ipcMain.handle('dialog:pick-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return [];

  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach Files',
  });

  if (result.canceled || result.filePaths.length === 0) return [];

  return result.filePaths.map(filePath => {
    const ext = path.extname(filePath).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const mimeType = isImage
      ? `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`
      : 'application/octet-stream';
    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { id, name: path.basename(filePath), path: filePath, type: isImage ? 'image' : 'file', mimeType };
  });
});

// Build project color submenu items
function buildProjectColorSubmenu() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const currentColorId = focusedWindow && focusedWindow.projectPath
    ? getProjectColorId(focusedWindow.projectPath)
    : null;

  return COLOR_PALETTE.map(color => ({
    label: color.name,
    type: 'checkbox',
    checked: color.id === currentColorId,
    click: () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win && win.projectPath) {
        setProjectColor(win.projectPath, color.id);
        // Send update to renderer to change title bar color
        const title = `Janus – ${path.basename(win.projectPath)}`;
        win.webContents.send('title-bar-update', { color: color.hex, title });
      }
    }
  }));
}

// Create application menu
function createMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: async () => {
            const result = await dialog.showOpenDialog({
              properties: ['openDirectory', 'createDirectory'],
              title: 'Select Project Folder'
            });
            if (!result.canceled && result.filePaths.length > 0) {
              createWindow(result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('new-tab');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('close-tab');
            }
          }
        },
        ...(isMac ? [] : [{ role: 'quit' }])
      ]
    },
    // Edit menu (custom paste to support image paste in terminal apps)
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        {
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;

            // Check if clipboard has image data but no text
            // (e.g. screenshot, copied image). In that case, send raw Ctrl+V
            // to the terminal so Ink-based apps (cumulus, claude) can detect
            // it via useInput and read the clipboard image themselves.
            const image = clipboard.readImage();
            const text = clipboard.readText();
            if (!image.isEmpty() && !text.trim()) {
              win.webContents.send('paste-image');
            } else {
              win.webContents.paste();
            }
          }
        },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ]
    },
    // View menu
    { role: 'viewMenu' },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Project Color',
          submenu: buildProjectColorSubmenu()
        },
        { type: 'separator' },
        ...(isMac ? [
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Update menu when window focus changes (to refresh color checkmarks)
function setupMenuRefresh() {
  app.on('browser-window-focus', () => {
    createMenu();
  });
}

// Enable remote debugging for Playwright
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// Increase memory limits for renderer processes
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// Audio policy - allow autoplay without user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Fix webview GPU crashes - disable sandbox but keep GPU enabled for performance
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');

app.whenReady().then(() => {
  // Configure permissions for webview partition
  const ses = session.fromPartition('persist:browser');

  // Clear stale cache on startup to prevent corruption issues
  ses.clearCache();

  // Handle permission requests from webviews
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // Allow common permissions needed for web apps
    const allowedPermissions = [
      'media',
      'audioCapture',
      'display-capture',
      'mediaKeySystem',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'pointerLock',
      'fullscreen',
      'clipboard-read',
      'clipboard-sanitized-write'
    ];

    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      console.log('Permission denied:', permission);
      callback(false);
    }
  });

  // Allow microphone access for the main window (voice-to-text in chat)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (['media', 'audioCapture'].includes(permission)) {
      callback(true);
    } else {
      callback(true); // Allow all permissions for the main window
    }
  });

  createMenu();
  setupMenuRefresh();
  createWindow();
  startHttpApi();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
