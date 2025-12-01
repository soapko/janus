const { app, BrowserWindow, BrowserView, ipcMain, dialog, session } = require('electron');
const path = require('path');
const pty = require('node-pty');


let mainWindow;
const ptyProcesses = new Map();
let nextTerminalId = 1;
let projectPath = null;

// BrowserView management
const browserViews = new Map();
let nextBrowserViewId = 1;
let activeBrowserViewId = null;
let browserBounds = { x: 0, y: 0, width: 700, height: 800 };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      webSecurity: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Kill all PTY processes
    for (const [id, ptyProcess] of ptyProcesses) {
      ptyProcess.kill();
    }
    ptyProcesses.clear();
    // Clean up browser views
    browserViews.clear();
  });

  mainWindow.on('resize', () => {
    updateActiveBrowserViewBounds();
  });
}

function createBrowserView(url = 'http://localhost:3000') {
  const id = nextBrowserViewId++;

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      partition: 'persist:browser'
    }
  });

  view.webContents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  view.webContents.on('page-title-updated', (event, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-title-updated', { id, title });
    }
  });

  view.webContents.on('did-navigate', (event, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-url-updated', { id, url });
    }
  });

  view.webContents.on('did-navigate-in-page', (event, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-url-updated', { id, url });
    }
  });

  view.webContents.loadURL(url);
  browserViews.set(id, view);

  // Switch to this view
  switchToBrowserView(id);

  return id;
}

function switchToBrowserView(id) {
  const view = browserViews.get(id);
  if (!view || !mainWindow) return;

  // Remove current view
  if (activeBrowserViewId !== null) {
    const currentView = browserViews.get(activeBrowserViewId);
    if (currentView) {
      mainWindow.removeBrowserView(currentView);
    }
  }

  // Add and set bounds for new view
  mainWindow.addBrowserView(view);
  view.setBounds(browserBounds);
  view.setAutoResize({ width: true, height: true });
  activeBrowserViewId = id;
}

function updateActiveBrowserViewBounds() {
  if (activeBrowserViewId !== null) {
    const view = browserViews.get(activeBrowserViewId);
    if (view) {
      view.setBounds(browserBounds);
    }
  }
}

function closeBrowserView(id) {
  const view = browserViews.get(id);
  if (!view) return;

  if (activeBrowserViewId === id) {
    mainWindow.removeBrowserView(view);
    activeBrowserViewId = null;
  }

  // Destroy the view's web contents
  view.webContents.close();
  browserViews.delete(id);

  // Switch to another view if available
  if (browserViews.size > 0) {
    const nextId = browserViews.keys().next().value;
    switchToBrowserView(nextId);
    return nextId;
  }
  return null;
}

// BrowserView IPC handlers
ipcMain.handle('browser-create', (event, url) => {
  return createBrowserView(url);
});

ipcMain.handle('browser-switch', (event, id) => {
  switchToBrowserView(id);
});

ipcMain.handle('browser-close', (event, id) => {
  return closeBrowserView(id);
});

ipcMain.handle('browser-navigate', (event, { id, url }) => {
  const view = browserViews.get(id);
  if (view) {
    view.webContents.loadURL(url);
  }
});

ipcMain.handle('browser-back', (event, id) => {
  const view = browserViews.get(id);
  if (view && view.webContents.canGoBack()) {
    view.webContents.goBack();
  }
});

ipcMain.handle('browser-forward', (event, id) => {
  const view = browserViews.get(id);
  if (view && view.webContents.canGoForward()) {
    view.webContents.goForward();
  }
});

ipcMain.handle('browser-reload', (event, id) => {
  const view = browserViews.get(id);
  if (view) {
    view.webContents.reload();
  }
});

ipcMain.handle('browser-get-url', (event, id) => {
  const view = browserViews.get(id);
  if (view) {
    return view.webContents.getURL();
  }
  return '';
});

ipcMain.handle('browser-set-bounds', (event, bounds) => {
  browserBounds = bounds;
  updateActiveBrowserViewBounds();
});

ipcMain.handle('browser-can-go-back', (event, id) => {
  const view = browserViews.get(id);
  return view ? view.webContents.canGoBack() : false;
});

ipcMain.handle('browser-can-go-forward', (event, id) => {
  const view = browserViews.get(id);
  return view ? view.webContents.canGoForward() : false;
});

function createTerminal(cwd = null) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
  const id = nextTerminalId++;

  // Spawn as login shell (-l) to source user's profile and get proper PATH
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || projectPath || process.env.HOME,
    env: process.env
  });

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  ptyProcesses.set(id, ptyProcess);
  return id;
}

// Create new terminal
ipcMain.handle('terminal-create', (event, cwd) => {
  return createTerminal(cwd);
});

// Get project path
ipcMain.handle('get-project-path', () => {
  return projectPath;
});

// Select project folder
ipcMain.handle('select-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    projectPath = result.filePaths[0];
    return projectPath;
  }
  return null;
});

// Kill terminal
ipcMain.on('terminal-kill', (event, id) => {
  const ptyProcess = ptyProcesses.get(id);
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcesses.delete(id);
  }
});

// Handle terminal input
ipcMain.on('terminal-input', (event, { id, data }) => {
  const ptyProcess = ptyProcesses.get(id);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

// Handle terminal resize
ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const ptyProcess = ptyProcesses.get(id);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

// Enable remote debugging for Playwright
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// Increase memory limits for renderer processes
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// Audio policy - allow autoplay without user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Disable features that may cause crashes in webviews
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');

// GPU acceleration flags for better canvas/WebGL performance
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,Metal');

app.whenReady().then(() => {
  // Configure permissions for webview partition
  const ses = session.fromPartition('persist:browser');

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
