const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('path');
const pty = require('node-pty');

const windows = new Set();
// Map PTY processes by window ID and terminal ID: windowId -> Map(terminalId -> ptyProcess)
const windowPtyProcesses = new Map();
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
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Janus',
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

  ptyProcess.onData((data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-data', { id, data });
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

// Select project folder
ipcMain.handle('select-project-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;

  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Project Folder'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    win.projectPath = result.filePaths[0];
    updateWindowTitle(win);
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
              properties: ['openDirectory'],
              title: 'Select Project Folder'
            });
            if (!result.canceled && result.filePaths.length > 0) {
              createWindow(result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit menu
    { role: 'editMenu' },
    // View menu
    { role: 'viewMenu' },
    // Window menu
    { role: 'windowMenu' }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
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

  createMenu();
  createWindow();
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
