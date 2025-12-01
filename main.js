const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const pty = require('node-pty');

let mainWindow;
const ptyProcesses = new Map();
let nextTerminalId = 1;
let projectPath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      webSecurity: false  // Allow file:// URLs in webviews
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
  });
}

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
