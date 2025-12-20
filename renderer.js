// ===== PANE SELECTION STATE =====
let selectedPane = 'terminal'; // 'browser' or 'terminal'

function selectPane(pane) {
  selectedPane = pane;
  // Update visual indicator
  document.getElementById('browser-panel').classList.toggle('selected', pane === 'browser');
  document.getElementById('terminal-panel').classList.toggle('selected', pane === 'terminal');
}

// ===== BROWSER PANEL TOGGLE =====
let browserPanelCollapsed = false;

function toggleBrowserPanel() {
  browserPanelCollapsed = !browserPanelCollapsed;

  const browserPanel = document.getElementById('browser-panel');
  const divider = document.getElementById('divider');
  const toggleBtn = document.getElementById('toggle-browser-btn');

  if (browserPanelCollapsed) {
    browserPanel.classList.add('collapsed');
    divider.classList.add('collapsed');
    toggleBtn.textContent = '▶';
    toggleBtn.title = 'Show Browser (Cmd+\\)';
    // Select terminal pane when browser is hidden
    selectPane('terminal');
  } else {
    browserPanel.classList.remove('collapsed');
    divider.classList.remove('collapsed');
    toggleBtn.textContent = '◀';
    toggleBtn.title = 'Hide Browser (Cmd+\\)';
  }

  // Resize terminal after panel toggle
  setTimeout(resizeActiveTerminal, 50);
}

// ===== TITLE BAR MANAGEMENT =====
const titleBar = document.getElementById('title-bar');
const titleBarText = document.getElementById('title-bar-text');

function updateTitleBar(color, title) {
  if (titleBar && color) {
    titleBar.style.background = color;
  }
  if (titleBarText && title) {
    titleBarText.textContent = title;
  }
}

// Initialize title bar on load
window.electronAPI.getTitleBarInfo().then(info => {
  if (info) {
    updateTitleBar(info.color, info.title);
  }
});

// Listen for title bar updates from main process
window.electronAPI.onTitleBarUpdate((data) => {
  updateTitleBar(data.color, data.title);
});

// ===== BROWSER TAB MANAGEMENT =====
const browsers = new Map();
let activeBrowserId = null;
let nextBrowserId = 1;

const browserTabBar = document.getElementById('browser-tab-bar');
const browsersContainer = document.getElementById('browsers-container');
const newBrowserTabBtn = document.getElementById('new-browser-tab-btn');
const urlInput = document.getElementById('url-input');

function createBrowserTab(url = 'http://localhost:3000') {
  const id = nextBrowserId++;

  // Create webview
  const webview = document.createElement('webview');
  webview.className = 'browser-instance';
  webview.id = `browser-${id}`;
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, javascript=yes, webgl=yes');
  webview.setAttribute('partition', 'persist:browser');
  webview.setAttribute('useragent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  webview.src = url;
  browsersContainer.appendChild(webview);

  // Create tab
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="tab-title">New Tab</span>
    <span class="tab-close">×</span>
  `;

  // Insert before the + button
  browserTabBar.insertBefore(tab, newBrowserTabBtn);

  // Tab click handler
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeBrowserTab(id);
    } else {
      switchToBrowserTab(id);
    }
  });

  // Update tab title when page loads
  webview.addEventListener('page-title-updated', (e) => {
    const title = e.title || 'New Tab';
    tab.querySelector('.tab-title').textContent = title.length > 20 ? title.substring(0, 20) + '...' : title;
  });

  // Debug: Log load failures
  webview.addEventListener('did-fail-load', (e) => {
    console.error('=== WEBVIEW LOAD FAILURE ===');
    console.error('URL:', e.validatedURL);
    console.error('Error code:', e.errorCode);
    console.error('Error description:', e.errorDescription);
    console.error('Is main frame:', e.isMainFrame);
  });

  // Debug: Track navigation
  webview.addEventListener('will-navigate', (e) => {
    console.log('Will navigate to:', e.url);
  });

  webview.addEventListener('did-start-navigation', (e) => {
    console.log('Did start navigation:', e.url, 'isMainFrame:', e.isMainFrame);
  });

  webview.addEventListener('dom-ready', () => {
    console.log('DOM ready for:', webview.getURL());
  });

  // Detect render process crashes
  webview.addEventListener('crashed', () => {
    console.error('=== WEBVIEW CRASHED ===');
  });

  webview.addEventListener('render-process-gone', (e) => {
    console.error('=== RENDER PROCESS GONE ===');
    console.error('Reason:', e.reason);

    // Auto-reload disabled for debugging
    // if (e.reason !== 'killed' && e.reason !== 'clean-exit') {
    //   console.log('Attempting to reload webview...');
    //   setTimeout(() => {
    //     try {
    //       webview.reload();
    //     } catch (err) {
    //       console.error('Failed to reload:', err);
    //     }
    //   }, 1000);
    // }
  });

  webview.addEventListener('destroyed', () => {
    console.error('=== WEBVIEW DESTROYED ===');
  });

  webview.addEventListener('unresponsive', () => {
    console.error('=== WEBVIEW UNRESPONSIVE ===');
  });

  webview.addEventListener('responsive', () => {
    console.log('Webview became responsive again');
  });

  webview.addEventListener('did-finish-load', () => {
    console.log('Webview finished loading:', webview.getURL());
  });

  webview.addEventListener('did-start-loading', () => {
    console.log('Webview started loading:', webview.src);
  });

  // Update URL bar when navigation happens (only for active tab)
  webview.addEventListener('did-navigate', (e) => {
    if (activeBrowserId === id) {
      urlInput.value = e.url;
    }
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    if (activeBrowserId === id) {
      urlInput.value = e.url;
    }
  });

  // Store browser info
  browsers.set(id, { webview, tab });

  // Switch to this tab
  switchToBrowserTab(id);

  return id;
}

function switchToBrowserTab(id) {
  // Deactivate all
  for (const [browserId, browserInfo] of browsers) {
    browserInfo.webview.classList.remove('active');
    browserInfo.tab.classList.remove('active');
  }

  // Activate selected
  const browserInfo = browsers.get(id);
  if (browserInfo) {
    browserInfo.webview.classList.add('active');
    browserInfo.tab.classList.add('active');
    activeBrowserId = id;

    // Update URL bar
    try {
      urlInput.value = browserInfo.webview.getURL() || '';
    } catch (e) {
      urlInput.value = browserInfo.webview.src || '';
    }

    // Select browser pane
    selectPane('browser');
  }
}

function closeBrowserTab(id) {
  const browserInfo = browsers.get(id);
  if (!browserInfo) return;

  // Remove DOM elements
  browserInfo.webview.remove();
  browserInfo.tab.remove();

  // Remove from map
  browsers.delete(id);

  // Switch to another tab or create new one
  if (browsers.size === 0) {
    createBrowserTab();
  } else if (activeBrowserId === id) {
    const firstId = browsers.keys().next().value;
    switchToBrowserTab(firstId);
  }
}

function getActiveBrowser() {
  if (activeBrowserId) {
    const browserInfo = browsers.get(activeBrowserId);
    return browserInfo ? browserInfo.webview : null;
  }
  return null;
}

// New browser tab button
newBrowserTabBtn.addEventListener('click', () => createBrowserTab());

// Create initial browser tab
createBrowserTab();

// Browser controls
document.getElementById('back-btn').addEventListener('click', () => {
  const browser = getActiveBrowser();
  if (browser && browser.canGoBack()) browser.goBack();
});

document.getElementById('forward-btn').addEventListener('click', () => {
  const browser = getActiveBrowser();
  if (browser && browser.canGoForward()) browser.goForward();
});

document.getElementById('reload-btn').addEventListener('click', () => {
  const browser = getActiveBrowser();
  if (browser) browser.reload();
});

document.getElementById('go-btn').addEventListener('click', navigateToUrl);

urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') navigateToUrl();
});

function navigateToUrl() {
  let url = urlInput.value.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
    url = 'https://' + url;
  }
  const browser = getActiveBrowser();
  if (browser) {
    console.log('Navigating to:', url);
    browser.src = url;
  }
}

// ===== DRAG AND DROP FILE SUPPORT =====
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;

function disableWebviewPointerEvents() {
  for (const [id, browserInfo] of browsers) {
    browserInfo.webview.style.pointerEvents = 'none';
  }
}

function enableWebviewPointerEvents() {
  for (const [id, browserInfo] of browsers) {
    browserInfo.webview.style.pointerEvents = '';
  }
}

// Detect when files are dragged into the window
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  // Only show overlay for file drags
  if (e.dataTransfer.types.includes('Files')) {
    dragCounter++;
    if (dragCounter === 1) {
      dropOverlay.classList.add('visible');
      disableWebviewPointerEvents();
    }
  }
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dropOverlay.classList.remove('visible');
    enableWebviewPointerEvents();
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

// Handle drop on the overlay
dropOverlay.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');
  enableWebviewPointerEvents();

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    // Use the file path from Electron's file object
    const filePath = file.path;
    if (filePath) {
      // Check if drop is over the terminal panel
      const terminalPanel = document.getElementById('terminal-panel');
      const terminalRect = terminalPanel.getBoundingClientRect();
      const isOverTerminal = e.clientX >= terminalRect.left &&
                             e.clientX <= terminalRect.right &&
                             e.clientY >= terminalRect.top &&
                             e.clientY <= terminalRect.bottom;

      if (isOverTerminal && activeTerminalId) {
        // Insert file path into active terminal (escape spaces and special chars)
        const escapedPath = filePath.replace(/([ "'\\$`!])/g, '\\$1');
        window.electronAPI.sendTerminalInput(activeTerminalId, escapedPath);
      } else {
        // Navigate browser to file
        const fileUrl = 'file://' + filePath;
        urlInput.value = fileUrl;
        const browser = getActiveBrowser();
        if (browser) browser.src = fileUrl;
      }
    }
  }
});

// Prevent default drop behavior elsewhere
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');
  enableWebviewPointerEvents();
});


// ===== TERMINAL TAB MANAGEMENT =====
const terminals = new Map();
let activeTerminalId = null;

const tabBar = document.getElementById('tab-bar');
const terminalsContainer = document.getElementById('terminals-container');
const newTabBtn = document.getElementById('new-tab-btn');

// Terminal zoom state
let terminalFontSize = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

function setTerminalFontSize(size) {
  terminalFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));

  // Update all terminal instances
  for (const [id, termInfo] of terminals) {
    termInfo.term.options.fontSize = terminalFontSize;
    termInfo.fitAddon.fit();
    window.electronAPI.resizeTerminal(id, termInfo.term.cols, termInfo.term.rows);
  }
}

function zoomInTerminal() {
  setTerminalFontSize(terminalFontSize + 2);
}

function zoomOutTerminal() {
  setTerminalFontSize(terminalFontSize - 2);
}

async function createTab() {
  const id = await window.electronAPI.createTerminal();

  // Create terminal instance with current font size
  const term = new Terminal({
    cursorBlink: true,
    fontSize: terminalFontSize,
    fontFamily: 'Menlo, Monaco, monospace',
    theme: {
      background: '#000000',
      foreground: '#ffffff'
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // Create container for this terminal
  const container = document.createElement('div');
  container.className = 'terminal-instance';
  container.id = `terminal-${id}`;
  terminalsContainer.appendChild(container);

  term.open(container);

  // Create tab
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="tab-title">Terminal ${id}</span>
    <span class="tab-close">×</span>
  `;

  // Insert before the + button
  tabBar.insertBefore(tab, newTabBtn);

  // Tab click handler
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(id);
    } else {
      switchToTab(id);
    }
  });

  // Terminal input handler
  term.onData((data) => {
    window.electronAPI.sendTerminalInput(id, data);
  });

  // Store terminal info
  terminals.set(id, { term, fitAddon, container, tab });

  // Switch to this tab
  switchToTab(id);

  // Fit after a short delay
  setTimeout(() => {
    fitAddon.fit();
    window.electronAPI.resizeTerminal(id, term.cols, term.rows);
  }, 100);

  return id;
}

function switchToTab(id) {
  // Deactivate all
  for (const [termId, termInfo] of terminals) {
    termInfo.container.classList.remove('active');
    termInfo.tab.classList.remove('active');
  }

  // Activate selected
  const termInfo = terminals.get(id);
  if (termInfo) {
    termInfo.container.classList.add('active');
    termInfo.tab.classList.add('active');
    activeTerminalId = id;

    // Fit and focus
    setTimeout(() => {
      termInfo.fitAddon.fit();
      termInfo.term.focus();
      window.electronAPI.resizeTerminal(id, termInfo.term.cols, termInfo.term.rows);
    }, 50);

    // Select terminal pane
    selectPane('terminal');
  }
}

function closeTab(id) {
  const termInfo = terminals.get(id);
  if (!termInfo) return;

  // Kill the PTY
  window.electronAPI.killTerminal(id);

  // Remove DOM elements
  termInfo.container.remove();
  termInfo.tab.remove();
  termInfo.term.dispose();

  // Remove from map
  terminals.delete(id);

  // Switch to another tab or create new one
  if (terminals.size === 0) {
    createTab();
  } else if (activeTerminalId === id) {
    const firstId = terminals.keys().next().value;
    switchToTab(firstId);
  }
}

// Handle resize for active terminal
function resizeActiveTerminal() {
  if (activeTerminalId) {
    const termInfo = terminals.get(activeTerminalId);
    if (termInfo) {
      termInfo.fitAddon.fit();
      window.electronAPI.resizeTerminal(activeTerminalId, termInfo.term.cols, termInfo.term.rows);
    }
  }
}

window.addEventListener('resize', resizeActiveTerminal);
new ResizeObserver(resizeActiveTerminal).observe(terminalsContainer);

// Handle terminal data from main process
window.electronAPI.onTerminalData((id, data) => {
  const termInfo = terminals.get(id);
  if (termInfo) {
    termInfo.term.write(data);
  }
});

// New tab button
newTabBtn.addEventListener('click', createTab);

// Zoom buttons
document.getElementById('zoom-in-btn').addEventListener('click', zoomInTerminal);
document.getElementById('zoom-out-btn').addEventListener('click', zoomOutTerminal);

// Browser panel toggle button
document.getElementById('toggle-browser-btn').addEventListener('click', toggleBrowserPanel);

// Initial tab will be created after project folder selection (see initProjectFolder)


// ===== PANEL RESIZING =====
const divider = document.getElementById('divider');
const container = document.querySelector('.container');
const leftPanel = document.getElementById('browser-panel');
const rightPanel = document.getElementById('terminal-panel');

let isResizing = false;

divider.addEventListener('mousedown', (e) => {
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  // Disable pointer events on all webviews to prevent them from capturing mouse
  for (const [id, browserInfo] of browsers) {
    browserInfo.webview.style.pointerEvents = 'none';
  }
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;

  const containerRect = container.getBoundingClientRect();
  const percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;

  if (percentage > 20 && percentage < 80) {
    leftPanel.style.flex = `0 0 ${percentage}%`;
    rightPanel.style.flex = `0 0 ${100 - percentage}%`;
    resizeActiveTerminal();
  }
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = '';
    // Re-enable pointer events on all webviews
    for (const [id, browserInfo] of browsers) {
      browserInfo.webview.style.pointerEvents = '';
    }
  }
});


// ===== FEEDBACK MODE =====
let feedbackMode = false;
const feedbackBtn = document.getElementById('feedback-btn');
const feedbackPopup = document.getElementById('feedback-popup');
const feedbackText = document.getElementById('feedback-text');
const feedbackSubmit = document.getElementById('feedback-submit');

// Store selected element data
let selectedElementData = null;
let selectedElementPosition = { x: 0, y: 0 };

// Map to track element UUIDs and their terminal tabs
const elementTerminals = new Map();

// Generate UUID for elements
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Generate a unique key for an element based on its selector path
function getElementKey(elementData) {
  return elementData.selector || elementData.outerHTML.substring(0, 100);
}

const feedbackScript = `
(function() {
  if (window.__janusFeedbackActive) return;
  window.__janusFeedbackActive = true;

  let highlightedElement = null;
  const originalOutlines = new WeakMap();

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el === document.body) return 'body';

    let path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector = '#' + el.id;
        path.unshift(selector);
        break;
      } else {
        let sibling = el;
        let nth = 1;
        while (sibling = sibling.previousElementSibling) {
          if (sibling.tagName === el.tagName) nth++;
        }
        if (nth > 1) selector += ':nth-of-type(' + nth + ')';
      }
      path.unshift(selector);
      el = el.parentNode;
    }
    return path.join(' > ');
  }

  function highlight(el) {
    if (highlightedElement && highlightedElement !== el) {
      unhighlight(highlightedElement);
    }
    if (el && el !== document.body && el !== document.documentElement) {
      if (!originalOutlines.has(el)) {
        originalOutlines.set(el, el.style.outline);
      }
      el.style.outline = '2px solid #0066cc';
      highlightedElement = el;
    }
  }

  function unhighlight(el) {
    if (el && originalOutlines.has(el)) {
      el.style.outline = originalOutlines.get(el);
      originalOutlines.delete(el);
    }
    if (highlightedElement === el) {
      highlightedElement = null;
    }
  }

  window.__janusMouseOver = function(e) {
    highlight(e.target);
  };

  window.__janusMouseOut = function(e) {
    unhighlight(e.target);
  };

  window.__janusClick = function(e) {
    if (highlightedElement) {
      e.preventDefault();
      e.stopPropagation();

      const data = {
        outerHTML: highlightedElement.outerHTML,
        selector: getSelector(highlightedElement),
        tagName: highlightedElement.tagName,
        screenX: e.screenX,
        screenY: e.screenY
      };

      console.log('__JANUS_ELEMENT_SELECTED__:' + JSON.stringify(data));
    }
  };

  document.addEventListener('mouseover', window.__janusMouseOver, true);
  document.addEventListener('mouseout', window.__janusMouseOut, true);
  document.addEventListener('click', window.__janusClick, true);
})();
`;

const cleanupScript = `
(function() {
  if (!window.__janusFeedbackActive) return;
  window.__janusFeedbackActive = false;

  document.removeEventListener('mouseover', window.__janusMouseOver, true);
  document.removeEventListener('mouseout', window.__janusMouseOut, true);
  document.removeEventListener('click', window.__janusClick, true);

  // Remove any remaining highlights - check multiple possible formats
  document.querySelectorAll('*').forEach(el => {
    if (el.style.outline && (
        el.style.outline.includes('0066cc') ||
        el.style.outline.includes('rgb(0, 102, 204)') ||
        el.style.outline === '2px solid #0066cc'
    )) {
      el.style.outline = '';
    }
  });
})();
`;

function enableFeedbackMode() {
  feedbackMode = true;
  feedbackBtn.classList.add('active');

  const browser = getActiveBrowser();
  if (browser) {
    browser.executeJavaScript(feedbackScript);
  }
}

function disableFeedbackMode() {
  feedbackMode = false;
  feedbackBtn.classList.remove('active');

  const browser = getActiveBrowser();
  if (browser) {
    browser.executeJavaScript(cleanupScript);
  }
}

function toggleFeedbackMode() {
  if (feedbackMode) {
    disableFeedbackMode();
  } else {
    enableFeedbackMode();
  }
}

function showFeedbackPopup(x, y) {
  // Make visible first to get dimensions
  feedbackPopup.classList.add('visible');

  const popupWidth = feedbackPopup.offsetWidth;
  const popupHeight = feedbackPopup.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const padding = 10;

  // Adjust x to keep popup in viewport
  if (x + popupWidth + padding > viewportWidth) {
    x = viewportWidth - popupWidth - padding;
  }
  if (x < padding) {
    x = padding;
  }

  // Adjust y to keep popup in viewport
  if (y + popupHeight + padding > viewportHeight) {
    y = viewportHeight - popupHeight - padding;
  }
  if (y < padding) {
    y = padding;
  }

  feedbackPopup.style.left = x + 'px';
  feedbackPopup.style.top = y + 'px';
  feedbackText.value = '';
  feedbackText.focus();
}

function hideFeedbackPopup() {
  feedbackPopup.classList.remove('visible');
  selectedElementData = null;
}

// Create or get terminal tab for element
async function getOrCreateElementTerminal(elementKey) {
  if (elementTerminals.has(elementKey)) {
    const terminalInfo = elementTerminals.get(elementKey);
    switchToTab(terminalInfo.tabId);
    return terminalInfo;
  }

  // Generate new UUID and create terminal
  const uuid = generateUUID();
  const tabId = await createTab();

  const terminalInfo = { tabId, uuid };
  elementTerminals.set(elementKey, terminalInfo);

  return terminalInfo;
}

// Send feedback to claude CLI
async function submitFeedback() {
  const feedback = feedbackText.value.trim();

  if (!feedback || !selectedElementData) {
    hideFeedbackPopup();
    disableFeedbackMode();
    return;
  }

  const elementKey = getElementKey(selectedElementData);
  const terminalInfo = await getOrCreateElementTerminal(elementKey);

  // Format the message for claude using heredoc to avoid escaping issues
  const message = `\`\`\`html
${selectedElementData.outerHTML}
\`\`\`

User Feedback: ${feedback}`;

  // Get the terminal and send the claude command using heredoc
  const termInfo = terminals.get(terminalInfo.tabId);
  if (termInfo) {
    // Use heredoc to pass multi-line content safely
    const claudeCommand = `claude --dangerously-skip-permissions -p "$(cat <<'ENDFEEDBACK'
${message}
ENDFEEDBACK
)"
`;
    window.electronAPI.sendTerminalInput(terminalInfo.tabId, claudeCommand);
  }

  hideFeedbackPopup();
  disableFeedbackMode();
}

// Feedback button click handler
feedbackBtn.addEventListener('click', toggleFeedbackMode);

// Feedback popup submit
feedbackSubmit.addEventListener('click', submitFeedback);

// ESC key to exit feedback mode or close popup
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (feedbackPopup.classList.contains('visible')) {
      hideFeedbackPopup();
      disableFeedbackMode();
    } else if (feedbackMode) {
      disableFeedbackMode();
    }
  }
});

// Click outside popup to close
document.addEventListener('click', (e) => {
  if (feedbackPopup.classList.contains('visible') &&
      !feedbackPopup.contains(e.target) &&
      e.target !== feedbackBtn) {
    hideFeedbackPopup();
    disableFeedbackMode();
  }
});

// Enter key in textarea to submit
feedbackText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitFeedback();
  }
});

// Handle console messages from webview (element selected)
function setupWebviewConsoleListener(webview) {
  webview.addEventListener('console-message', (e) => {
    if (e.message && e.message.startsWith('__JANUS_ELEMENT_SELECTED__:')) {
      const jsonStr = e.message.replace('__JANUS_ELEMENT_SELECTED__:', '');
      try {
        selectedElementData = JSON.parse(jsonStr);

        // Convert screen coordinates to window coordinates
        const rect = webview.getBoundingClientRect();
        const x = selectedElementData.screenX - window.screenX;
        const y = selectedElementData.screenY - window.screenY;

        showFeedbackPopup(x, y);
      } catch (err) {
        console.error('Failed to parse element data:', err);
        disableFeedbackMode();
      }
    }
  });
}

// Setup listener for existing initial browser tab
setTimeout(() => {
  for (const [id, browserInfo] of browsers) {
    setupWebviewConsoleListener(browserInfo.webview);
  }
}, 100);

// Override createBrowserTab to add listener to new tabs
const originalCreateBrowserTab = createBrowserTab;
createBrowserTab = function(url) {
  const id = originalCreateBrowserTab(url);
  const browserInfo = browsers.get(id);
  if (browserInfo) {
    setupWebviewConsoleListener(browserInfo.webview);
  }
  return id;
};


// ===== STARTUP: PROJECT FOLDER SELECTION =====
async function initProjectFolder() {
  const existingPath = await window.electronAPI.getProjectPath();
  if (!existingPath) {
    await window.electronAPI.selectProjectFolder();
  }
  // Create initial terminal after project folder is set
  createTab();
}

// Initialize on load
initProjectFolder();


// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  // Cmd+R (Mac) or Ctrl+R (Windows/Linux) - Reload active browser tab only
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    const browser = getActiveBrowser();
    if (browser) {
      browser.reload();
    }
  }

  // Terminal zoom shortcuts (Cmd/Ctrl + and Cmd/Ctrl -)
  if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomInTerminal();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '-') {
    e.preventDefault();
    zoomOutTerminal();
  }

  // Toggle browser panel (Cmd/Ctrl + \)
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    toggleBrowserPanel();
  }
});


// ===== PANE SELECTION CLICK HANDLERS =====
document.getElementById('browser-panel').addEventListener('click', (e) => {
  // Don't select browser pane if clicking on divider resize handle
  if (!e.target.closest('#divider')) {
    selectPane('browser');
  }
});

document.getElementById('terminal-panel').addEventListener('click', () => {
  selectPane('terminal');
});

// Also select terminal pane when terminal receives focus (keyboard navigation)
terminalsContainer.addEventListener('focusin', () => {
  selectPane('terminal');
});


// ===== CLOSE TAB HANDLER =====
window.electronAPI.onCloseTab(() => {
  if (selectedPane === 'browser') {
    if (activeBrowserId) {
      closeBrowserTab(activeBrowserId);
    }
  } else {
    if (activeTerminalId) {
      closeTab(activeTerminalId);
    }
  }
});
