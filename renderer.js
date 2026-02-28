// ===== STATE =====
const tabs = new Map();        // tabId -> Tab
const ptyToTabId = new Map();  // ptyId -> tabId

let activeTabId = null;
let nextTabId = 1;

// Terminal zoom state (global across all terminals)
let terminalFontSize = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

// Map to track element UUIDs and their terminal tabs (for feedback mode)
// key: elementKey string -> { tabId, uuid }
const elementTerminals = new Map();

// Batched terminal writes: ptyId -> accumulated string
const pendingWrites = new Map();
let writeFlushRAF = null;

// Per-terminal follow-bottom: ptyId -> bool
const terminalFollowBottom = new Map();

// Resize handle drag state
let resizeDragState = null;

// Tab drag-to-reorder state
let draggedTabId = null;

// Feedback state
let feedbackMode = false;
let selectedElementData = null;


// ===== DOM REFERENCES =====
const tabBar = document.getElementById('tab-bar');
const newTabBtn = document.getElementById('new-tab-btn');
const tabTypePicker = document.getElementById('tab-type-picker');
const panelsContainer = document.getElementById('panels-container');
const dropOverlay = document.getElementById('drop-overlay');
const feedbackPopup = document.getElementById('feedback-popup');
const feedbackText = document.getElementById('feedback-text');
const feedbackSubmit = document.getElementById('feedback-submit');
const titleBar = document.getElementById('title-bar');
const titleBarText = document.getElementById('title-bar-text');


// ===== TITLE BAR =====
function updateTitleBar(color, title) {
  if (titleBar && color) {
    titleBar.style.background = color;
  }
  if (titleBarText && title) {
    titleBarText.textContent = title;
  }
}

window.electronAPI.getTitleBarInfo().then(info => {
  if (info) {
    updateTitleBar(info.color, info.title);
  }
});

window.electronAPI.onTitleBarUpdate((data) => {
  updateTitleBar(data.color, data.title);
});


// ===== TAB ELEMENT BUILDER =====
function buildTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.tabId = tab.id;
  el.draggable = true;

  const dot = document.createElement('span');
  dot.className = `tab-type-dot ${tab.type}`;

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = tab.label;

  const closeSpan = document.createElement('span');
  closeSpan.className = 'tab-close';
  closeSpan.textContent = '×';

  el.appendChild(dot);
  el.appendChild(titleSpan);
  el.appendChild(closeSpan);

  el.addEventListener('click', (e) => {
    if (e.target === closeSpan) {
      closeTab(tab.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleTabVisibility(tab.id);
    } else {
      soloSelectTab(tab.id);
    }
  });

  // Drag-to-reorder
  el.addEventListener('dragstart', (e) => {
    draggedTabId = tab.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(tab.id));
    el.classList.add('tab-dragging');
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('tab-dragging');
    draggedTabId = null;
    tabBar.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
    });
  });

  el.addEventListener('dragover', (e) => {
    if (draggedTabId === null || draggedTabId === tab.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Show drop indicator on left or right side
    const rect = el.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    el.classList.toggle('tab-drag-over-left', e.clientX < midX);
    el.classList.toggle('tab-drag-over-right', e.clientX >= midX);
  });

  el.addEventListener('dragleave', () => {
    el.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('tab-drag-over-left', 'tab-drag-over-right');
    if (draggedTabId === null || draggedTabId === tab.id) return;

    const draggedTab = tabs.get(draggedTabId);
    if (!draggedTab) return;

    // Determine position: before or after this tab
    const rect = el.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midX;

    // Move DOM element in tab bar
    if (insertBefore) {
      tabBar.insertBefore(draggedTab.tabEl, el);
    } else {
      const next = el.nextSibling;
      tabBar.insertBefore(draggedTab.tabEl, next);
    }

    // Rebuild Map order to match DOM order
    rebuildTabOrder();
    rebuildPanelLayout();
  });

  return el;
}


// ===== REBUILD TAB MAP ORDER (from DOM) =====
function rebuildTabOrder() {
  const tabEls = tabBar.querySelectorAll('.tab[data-tab-id]');
  const ordered = [];
  tabEls.forEach(el => {
    const id = parseInt(el.dataset.tabId, 10);
    const tab = tabs.get(id);
    if (tab) ordered.push([id, tab]);
  });
  tabs.clear();
  for (const [id, tab] of ordered) {
    tabs.set(id, tab);
  }
}


// ===== WEB TAB =====
function createWebTab(url = 'http://localhost:3000') {
  const id = nextTabId++;

  // Build panel
  const panelEl = document.createElement('div');
  panelEl.className = 'tab-panel';
  panelEl.dataset.tabId = id;

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'web-toolbar';

  const backBtn = document.createElement('button');
  backBtn.className = 'nav-btn';
  backBtn.textContent = '←';
  backBtn.title = 'Back';

  const forwardBtn = document.createElement('button');
  forwardBtn.className = 'nav-btn';
  forwardBtn.textContent = '→';
  forwardBtn.title = 'Forward';

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'nav-btn';
  reloadBtn.textContent = '↻';
  reloadBtn.title = 'Reload';

  const feedbackBtn = document.createElement('button');
  feedbackBtn.className = 'nav-btn';
  feedbackBtn.textContent = '⊙';
  feedbackBtn.title = 'Feedback';

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'url-input';
  urlInput.placeholder = 'Enter URL...';
  urlInput.value = url;

  const goBtn = document.createElement('button');
  goBtn.className = 'nav-btn';
  goBtn.textContent = 'Go';

  toolbar.appendChild(backBtn);
  toolbar.appendChild(forwardBtn);
  toolbar.appendChild(reloadBtn);
  toolbar.appendChild(feedbackBtn);
  toolbar.appendChild(urlInput);
  toolbar.appendChild(goBtn);

  // Web container (holds the webview)
  const webContainer = document.createElement('div');
  webContainer.className = 'web-container';

  // Webview — NEVER moved in DOM after creation
  const webview = document.createElement('webview');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, javascript=yes, webgl=yes');
  webview.setAttribute('partition', 'persist:browser');
  webview.setAttribute('useragent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  webview.src = url;

  webContainer.appendChild(webview);

  panelEl.appendChild(toolbar);
  panelEl.appendChild(webContainer);

  // Insert panel BEFORE drop overlay
  panelsContainer.insertBefore(panelEl, dropOverlay);

  // Webview navigation helpers
  function navigateToUrl() {
    let target = urlInput.value.trim();
    if (!target.startsWith('http://') && !target.startsWith('https://') && !target.startsWith('file://')) {
      target = 'https://' + target;
    }
    webview.src = target;
  }

  backBtn.addEventListener('click', () => {
    if (webview.canGoBack()) webview.goBack();
  });

  forwardBtn.addEventListener('click', () => {
    if (webview.canGoForward()) webview.goForward();
  });

  reloadBtn.addEventListener('click', () => {
    webview.reload();
  });

  feedbackBtn.addEventListener('click', () => {
    if (activeTabId === id) {
      toggleFeedbackMode();
    } else {
      soloSelectTab(id);
      toggleFeedbackMode();
    }
  });

  goBtn.addEventListener('click', navigateToUrl);

  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') navigateToUrl();
  });

  // Webview events
  webview.addEventListener('page-title-updated', (e) => {
    const title = e.title || 'Web';
    const tab = tabs.get(id);
    if (tab) {
      tab.label = title.length > 25 ? title.substring(0, 25) + '...' : title;
      tab.tabEl.querySelector('.tab-title').textContent = tab.label;
    }
  });

  webview.addEventListener('did-navigate', (e) => {
    if (activeTabId === id) {
      urlInput.value = e.url;
    }
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    if (activeTabId === id) {
      urlInput.value = e.url;
    }
  });

  webview.addEventListener('did-fail-load', (e) => {
    console.error('Webview load failure:', e.validatedURL, e.errorCode, e.errorDescription);
  });

  webview.addEventListener('will-navigate', (e) => {
    if (activeTabId === id) {
      urlInput.value = e.url;
    }
    console.log('Will navigate to:', e.url);
  });

  webview.addEventListener('dom-ready', () => {
    console.log('DOM ready for:', webview.getURL());
    if (feedbackMode && activeTabId === id) {
      webview.executeJavaScript(feedbackScript);
    }
  });

  webview.addEventListener('crashed', () => {
    console.error('Webview crashed');
  });

  webview.addEventListener('render-process-gone', (e) => {
    console.error('Render process gone:', e.reason);
  });

  webview.addEventListener('destroyed', () => {
    console.error('Webview destroyed');
  });

  webview.addEventListener('unresponsive', () => {
    console.error('Webview unresponsive');
  });

  webview.addEventListener('did-finish-load', () => {
    console.log('Webview finished loading:', webview.getURL());
  });

  // Console message listener for feedback mode
  webview.addEventListener('console-message', (e) => {
    if (e.message && e.message.startsWith('__JANUS_ELEMENT_SELECTED__:')) {
      const jsonStr = e.message.replace('__JANUS_ELEMENT_SELECTED__:', '');
      try {
        selectedElementData = JSON.parse(jsonStr);
        const x = selectedElementData.screenX - window.screenX;
        const y = selectedElementData.screenY - window.screenY;
        showFeedbackPopup(x, y);
      } catch (err) {
        console.error('Failed to parse element data:', err);
        disableFeedbackMode();
      }
    }
  });

  // Click in panel activates this tab
  panelEl.addEventListener('mousedown', () => {
    if (activeTabId !== id) {
      activateTab(id);
    }
  });

  // Build tab object
  const tab = {
    id,
    type: 'web',
    label: 'Web',
    visible: false,
    tabEl: null,
    panelEl,
    typeState: { webview, urlInput, feedbackBtn, webContainer }
  };

  const tabEl = buildTabEl(tab);
  tab.tabEl = tabEl;
  tabBar.insertBefore(tabEl, newTabBtn);

  tabs.set(id, tab);

  // Solo select this new tab
  soloSelectTab(id);

  return id;
}


// ===== TERMINAL TAB =====
async function createTerminalTab(cwd) {
  const id = nextTabId++;

  // Spawn PTY
  const ptyId = await window.electronAPI.createTerminal(cwd);
  ptyToTabId.set(ptyId, id);

  // Build panel
  const panelEl = document.createElement('div');
  panelEl.className = 'tab-panel';
  panelEl.dataset.tabId = id;

  // Terminal container (position relative for the scroll button)
  const terminalContainer = document.createElement('div');
  terminalContainer.className = 'terminal-container';

  // Terminal element (xterm renders here)
  const termEl = document.createElement('div');
  termEl.className = 'terminal-el';
  terminalContainer.appendChild(termEl);

  // Per-terminal scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-to-bottom-btn';
  scrollBtn.title = 'Scroll to bottom';
  scrollBtn.textContent = '↓';
  terminalContainer.appendChild(scrollBtn);

  panelEl.appendChild(terminalContainer);

  // Insert panel BEFORE drop overlay
  panelsContainer.insertBefore(panelEl, dropOverlay);

  // Create xterm instance
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
  term.open(termEl);

  // Auto-follow bottom enabled by default
  terminalFollowBottom.set(ptyId, true);

  // Terminal data input: re-enable auto-follow on any keystroke
  term.onData((data) => {
    window.electronAPI.sendTerminalInput(ptyId, data);
    terminalFollowBottom.set(ptyId, true);
  });

  // Scroll debounce state for this terminal's scroll button
  let scrollUpdateTimer = null;
  let lastScrollUpdateTime = 0;
  const SCROLL_UPDATE_DEBOUNCE = 50;

  function updateScrollBtnVisibility() {
    if (scrollUpdateTimer) clearTimeout(scrollUpdateTimer);
    const now = Date.now();
    const elapsed = now - lastScrollUpdateTime;
    if (elapsed < SCROLL_UPDATE_DEBOUNCE) {
      scrollUpdateTimer = setTimeout(doScrollBtnUpdate, SCROLL_UPDATE_DEBOUNCE - elapsed);
      return;
    }
    doScrollBtnUpdate();
  }

  function doScrollBtnUpdate() {
    scrollUpdateTimer = null;
    lastScrollUpdateTime = Date.now();
    const buffer = term.buffer.active;
    const isAtBottom = buffer.viewportY >= buffer.baseY;
    if (isAtBottom) {
      scrollBtn.classList.remove('visible');
    } else {
      scrollBtn.classList.add('visible');
    }
  }

  // Wheel events disable follow mode when user scrolls up
  terminalContainer.addEventListener('wheel', () => {
    requestAnimationFrame(() => {
      const buffer = term.buffer.active;
      terminalFollowBottom.set(ptyId, buffer.viewportY >= buffer.baseY);
      updateScrollBtnVisibility();
    });
  }, { passive: true });

  term.onScroll(() => {
    updateScrollBtnVisibility();
  });

  scrollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    terminalFollowBottom.set(ptyId, true);
    term.scrollToBottom();
    scrollBtn.classList.remove('visible');
  });

  // Per-terminal ResizeObserver
  const resizeObserver = new ResizeObserver(() => {
    const tab = tabs.get(id);
    if (tab && tab.visible) {
      debouncedFitTerminal(id);
    }
  });
  resizeObserver.observe(terminalContainer);

  // Click in panel activates this tab
  panelEl.addEventListener('mousedown', () => {
    if (activeTabId !== id) {
      activateTab(id);
      setTimeout(() => term.focus(), 10);
    }
  });

  // Build tab object
  const tab = {
    id,
    type: 'terminal',
    label: `Terminal ${id}`,
    visible: false,
    tabEl: null,
    panelEl,
    typeState: { ptyId, term, fitAddon, terminalContainer, termEl, scrollBtn }
  };

  const tabEl = buildTabEl(tab);
  tab.tabEl = tabEl;
  tabBar.insertBefore(tabEl, newTabBtn);

  tabs.set(id, tab);

  // Solo select this new tab
  soloSelectTab(id);

  // Fit after layout is established
  setTimeout(() => {
    fitTerminal(id);
    term.focus();
  }, 100);

  return id;
}


// ===== CUMULUS TAB =====
let cumulusTabCounter = 0;

function createCumulusTab(threadName) {
  const id = nextTabId++;
  cumulusTabCounter++;

  // Default thread name based on counter; will be overridden with project name
  if (!threadName) {
    threadName = `chat-${cumulusTabCounter}`;
  }

  const panelEl = document.createElement('div');
  panelEl.className = 'tab-panel';
  panelEl.dataset.tabId = id;

  const container = document.createElement('div');
  container.className = 'cumulus-container';
  panelEl.appendChild(container);
  panelsContainer.insertBefore(panelEl, dropOverlay);

  panelEl.addEventListener('mousedown', () => {
    if (activeTabId !== id) {
      activateTab(id);
    }
  });

  const tab = {
    id,
    type: 'cumulus',
    label: 'Chat',
    visible: false,
    tabEl: null,
    panelEl,
    typeState: { container, threadName, reactRoot: null }
  };

  const tabEl = buildTabEl(tab);
  tab.tabEl = tabEl;
  tabBar.insertBefore(tabEl, newTabBtn);

  tabs.set(id, tab);

  // Use project folder name as thread name for the first chat tab
  if (cumulusTabCounter === 1) {
    window.electronAPI.getProjectPath().then(projectPath => {
      if (projectPath) {
        const folderName = projectPath.split('/').pop() || 'default';
        tab.typeState.threadName = folderName;
        threadName = folderName;
      }
      mountCumulusReact(tab, container, threadName);
    });
  } else {
    mountCumulusReact(tab, container, threadName);
  }

  soloSelectTab(id);

  return id;
}

function mountCumulusReact(tab, container, threadName) {
  if (typeof window.mountCumulusChat !== 'function') {
    container.textContent = 'Chat bundle not loaded';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.color = 'rgba(255, 255, 255, 0.4)';
    container.style.fontSize = '18px';
    return;
  }

  window.electronAPI.cumulusCreateThread(threadName).then(() => {
    const api = {
      sendMessage: (msg, attachments) => window.electronAPI.cumulusSendMessage(threadName, msg, attachments),
      kill: () => window.electronAPI.cumulusKill(threadName),
      getHistory: (count) => window.electronAPI.cumulusGetHistory(threadName, count),
      listThreads: () => window.electronAPI.cumulusListThreads(),
      threadName,
      saveClipboardImage: () => window.electronAPI.saveClipboardImage(),
      pickFiles: () => window.electronAPI.pickFiles(),
      onMessage: (cb) => window.electronAPI.onCumulusMessage(cb),
      onStreamChunk: (cb) => window.electronAPI.onCumulusStreamChunk(cb),
      onStreamEnd: (cb) => window.electronAPI.onCumulusStreamEnd(cb),
      onError: (cb) => window.electronAPI.onCumulusError(cb),
      // Slash command APIs
      listIncludeFiles: () => window.electronAPI.cumulusListIncludeFiles(threadName),
      addIncludeFile: (filePath, scope) => window.electronAPI.cumulusAddIncludeFile(threadName, filePath, scope),
      removeIncludeFile: (filePath, scope) => window.electronAPI.cumulusRemoveIncludeFile(threadName, filePath, scope),
      getTurns: () => window.electronAPI.cumulusGetTurns(threadName),
      revert: (messageId, restoreGit) => window.electronAPI.cumulusRevert(threadName, messageId, restoreGit),
      closeTab: () => {
        // Close the cumulus tab — find tab by threadName and remove it
        for (const [tid, t] of tabs) {
          if (t.type === 'cumulus' && t.typeState.threadName === threadName) {
            closeTab(tid);
            break;
          }
        }
      },
    };
    tab.typeState.reactRoot = window.mountCumulusChat(container, api);
  });
}


// ===== TAB ACTIVATION (active highlight only, no visibility change) =====
function activateTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;

  for (const [tid, tab] of tabs) {
    if (tab.visible) {
      tab.tabEl.classList.add('tab-visible');
    } else {
      tab.tabEl.classList.remove('tab-visible');
    }
    if (tid === id) {
      tab.tabEl.classList.add('active');
    } else {
      tab.tabEl.classList.remove('active');
    }
  }

  // Sync URL input if active tab is web
  const tab = tabs.get(id);
  if (tab && tab.type === 'web') {
    const { webview, urlInput } = tab.typeState;
    try {
      urlInput.value = webview.getURL() || urlInput.value;
    } catch (e) {
      // webview not ready yet
    }
  }
}


// ===== SOLO SELECT (click: show only this tab) =====
function soloSelectTab(id) {
  if (!tabs.has(id)) return;

  for (const [tid, tab] of tabs) {
    tab.visible = tid === id;
  }

  // Reset all panels to equal flex
  for (const [, tab] of tabs) {
    tab.panelEl.style.flex = '';
  }

  activateTab(id);
  rebuildPanelLayout();

  // Focus terminal if applicable
  const tab = tabs.get(id);
  if (tab && tab.type === 'terminal') {
    setTimeout(() => {
      fitTerminal(id);
      tab.typeState.term.focus();
    }, 50);
  }
}


// ===== TOGGLE VISIBILITY (cmd+click) =====
function toggleTabVisibility(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  const visibleTabs = [...tabs.values()].filter(t => t.visible);

  if (tab.visible) {
    // Cannot hide the last visible tab
    if (visibleTabs.length <= 1) return;

    tab.visible = false;

    // If we hid the active tab, activate another visible one
    if (activeTabId === id) {
      const nextVisible = [...tabs.values()].find(t => t.visible);
      if (nextVisible) {
        activateTab(nextVisible.id);
      }
    }
  } else {
    tab.visible = true;
    activateTab(id);
  }

  rebuildPanelLayout();

  // Fit any newly visible terminals
  for (const [tid, t] of tabs) {
    if (t.visible && t.type === 'terminal') {
      setTimeout(() => fitTerminal(tid), 50);
    }
  }
}


// ===== PANEL LAYOUT =====
function rebuildPanelLayout() {
  // Remove all existing resize handles
  const handles = panelsContainer.querySelectorAll('.resize-handle');
  handles.forEach(h => h.remove());

  const visibleTabs = [...tabs.values()].filter(t => t.visible);
  const hiddenTabs = [...tabs.values()].filter(t => !t.visible);

  // Hide non-visible panels
  for (const tab of hiddenTabs) {
    tab.panelEl.classList.add('panel-hidden');
    tab.panelEl.style.order = '9999';
  }

  // Assign order and insert resize handles for visible panels
  visibleTabs.forEach((tab, idx) => {
    tab.panelEl.classList.remove('panel-hidden');
    tab.panelEl.style.order = String(idx * 2);

    if (idx < visibleTabs.length - 1) {
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.style.order = String(idx * 2 + 1);
      panelsContainer.appendChild(handle);

      // Store which panels this handle separates
      const leftTab = tab;
      const rightTab = visibleTabs[idx + 1];

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        disableWebviewPointerEvents();
        document.body.style.cursor = 'col-resize';

        resizeDragState = {
          leftPanelEl: leftTab.panelEl,
          rightPanelEl: rightTab.panelEl,
          startX: e.clientX,
          startLeftWidth: leftTab.panelEl.getBoundingClientRect().width,
          startRightWidth: rightTab.panelEl.getBoundingClientRect().width
        };
      });
    }
  });

  // Update tab bar visible indicator
  for (const [, tab] of tabs) {
    if (tab.visible) {
      tab.tabEl.classList.add('tab-visible');
    } else {
      tab.tabEl.classList.remove('tab-visible');
    }
  }
}


// ===== RESIZE HANDLE MOUSE EVENTS =====
document.addEventListener('mousemove', (e) => {
  if (!resizeDragState) return;

  const { leftPanelEl, rightPanelEl, startX, startLeftWidth, startRightWidth } = resizeDragState;
  const delta = e.clientX - startX;
  const newLeftWidth = Math.max(200, startLeftWidth + delta);
  const newRightWidth = Math.max(200, startRightWidth - delta);

  leftPanelEl.style.flex = `0 0 ${newLeftWidth}px`;
  rightPanelEl.style.flex = `0 0 ${newRightWidth}px`;

  // Fit all visible terminals during resize
  for (const [id, tab] of tabs) {
    if (tab.visible && tab.type === 'terminal') {
      fitTerminal(id);
    }
  }
});

document.addEventListener('mouseup', () => {
  if (resizeDragState) {
    // Convert pixel-based flex to proportional flex-grow so panels
    // maintain their ratio but still resize with the window
    const visibleTabs = [...tabs.values()].filter(t => t.visible);
    const widths = visibleTabs.map(t => t.panelEl.getBoundingClientRect().width);
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    if (totalWidth > 0) {
      visibleTabs.forEach((tab, i) => {
        tab.panelEl.style.flex = `${widths[i] / totalWidth} 1 0%`;
      });
    }

    resizeDragState = null;
    document.body.style.cursor = '';
    enableWebviewPointerEvents();
  }
});


// ===== WEBVIEW POINTER EVENTS (disable during resize/drag) =====
function disableWebviewPointerEvents() {
  for (const [, tab] of tabs) {
    if (tab.type === 'web') {
      tab.typeState.webview.style.pointerEvents = 'none';
    }
  }
}

function enableWebviewPointerEvents() {
  for (const [, tab] of tabs) {
    if (tab.type === 'web') {
      tab.typeState.webview.style.pointerEvents = '';
    }
  }
}


// ===== CLOSE TAB =====
function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  const wasVisible = tab.visible;
  const wasActive = activeTabId === id;

  // Terminal cleanup
  if (tab.type === 'terminal') {
    const { ptyId, term } = tab.typeState;
    window.electronAPI.killTerminal(ptyId);
    ptyToTabId.delete(ptyId);
    terminalFollowBottom.delete(ptyId);
    pendingWrites.delete(ptyId);
    term.dispose();
  }

  // Cumulus cleanup
  if (tab.type === 'cumulus') {
    if (tab.typeState.reactRoot && typeof window.unmountCumulusChat === 'function') {
      window.unmountCumulusChat(tab.typeState.reactRoot);
    }
    window.electronAPI.cumulusKill(tab.typeState.threadName);
  }

  // Remove DOM elements
  tab.tabEl.remove();
  tab.panelEl.remove();

  tabs.delete(id);

  // If no tabs left, create a new terminal tab
  if (tabs.size === 0) {
    createTerminalTab();
    return;
  }

  // If the closed tab was visible, reassign visibility
  if (wasVisible) {
    const visibleRemaining = [...tabs.values()].filter(t => t.visible);

    if (visibleRemaining.length === 0) {
      // Make the first available tab visible
      const first = tabs.values().next().value;
      if (first) {
        first.visible = true;
        activateTab(first.id);
      }
    } else if (wasActive) {
      // Activate the first visible remaining tab
      activateTab(visibleRemaining[0].id);
    }

    rebuildPanelLayout();

    // Fit newly active terminal if applicable
    if (activeTabId) {
      const activeTab = tabs.get(activeTabId);
      if (activeTab && activeTab.type === 'terminal') {
        setTimeout(() => {
          fitTerminal(activeTabId);
          activeTab.typeState.term.focus();
        }, 50);
      }
    }
  }
}


// ===== TERMINAL FIT =====
function fitTerminal(id) {
  const tab = tabs.get(id);
  if (!tab || tab.type !== 'terminal') return;
  if (!tab.visible) return;

  const { ptyId, term, fitAddon } = tab.typeState;
  const buffer = term.buffer.active;
  const wasAtBottom = buffer.viewportY >= buffer.baseY;

  try {
    fitAddon.fit();
  } catch (e) {
    // Can fail if element has no dimensions yet
    return;
  }

  if (wasAtBottom) {
    term.scrollToBottom();
  }

  window.electronAPI.resizeTerminal(ptyId, term.cols, term.rows);
}

// Debounced per-terminal fit
const fitRAFs = new Map(); // tabId -> raf id

function debouncedFitTerminal(id) {
  if (fitRAFs.has(id)) cancelAnimationFrame(fitRAFs.get(id));
  const raf = requestAnimationFrame(() => {
    fitRAFs.delete(id);
    fitTerminal(id);
  });
  fitRAFs.set(id, raf);
}

window.addEventListener('resize', () => {
  for (const [id, tab] of tabs) {
    if (tab.visible && tab.type === 'terminal') {
      debouncedFitTerminal(id);
    }
  }
});


// ===== TERMINAL DATA ROUTING =====
// Batch rapid writes into a single term.write() per animation frame to prevent
// scroll flickering during streaming LLM output.
function flushTerminalWrites() {
  writeFlushRAF = null;
  for (const [ptyId, data] of pendingWrites) {
    const tabId = ptyToTabId.get(ptyId);
    if (tabId === undefined) continue;
    const tab = tabs.get(tabId);
    if (!tab || tab.type !== 'terminal') continue;

    const { term } = tab.typeState;
    term.write(data, () => {
      if (terminalFollowBottom.get(ptyId)) {
        term.scrollToBottom();
      }
    });
  }
  pendingWrites.clear();
}

window.electronAPI.onTerminalData((ptyId, data) => {
  if (!ptyToTabId.has(ptyId)) return;

  const existing = pendingWrites.get(ptyId) || '';
  pendingWrites.set(ptyId, existing + data);

  if (!writeFlushRAF) {
    writeFlushRAF = requestAnimationFrame(flushTerminalWrites);
  }
});


// ===== TERMINAL ZOOM =====
function setTerminalFontSize(size) {
  terminalFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));

  for (const [id, tab] of tabs) {
    if (tab.type === 'terminal') {
      tab.typeState.term.options.fontSize = terminalFontSize;
      fitTerminal(id);
    }
  }
}

function zoomInTerminal() {
  setTerminalFontSize(terminalFontSize + 2);
}

function zoomOutTerminal() {
  setTerminalFontSize(terminalFontSize - 2);
}


// ===== TYPE PICKER =====
newTabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  tabTypePicker.classList.toggle('visible');

  if (tabTypePicker.classList.contains('visible')) {
    // Position picker below the + button using viewport coords (picker is position:fixed)
    const btnRect = newTabBtn.getBoundingClientRect();
    tabTypePicker.style.left = btnRect.left + 'px';
    tabTypePicker.style.top = btnRect.bottom + 2 + 'px';
  }
});

tabTypePicker.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;

  tabTypePicker.classList.remove('visible');

  const type = btn.dataset.type;
  if (type === 'terminal') {
    createTerminalTab();
  } else if (type === 'web') {
    createWebTab();
  } else if (type === 'cumulus') {
    createCumulusTab();
  }
});

// Close picker on outside click
document.addEventListener('click', (e) => {
  if (!tabTypePicker.contains(e.target) && e.target !== newTabBtn) {
    tabTypePicker.classList.remove('visible');
  }
});


// ===== FEEDBACK MODE =====
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

function getActiveWebview() {
  if (!activeTabId) return null;
  const tab = tabs.get(activeTabId);
  if (!tab || tab.type !== 'web') return null;
  return tab.typeState.webview;
}

function getActiveFeedbackBtn() {
  if (!activeTabId) return null;
  const tab = tabs.get(activeTabId);
  if (!tab || tab.type !== 'web') return null;
  return tab.typeState.feedbackBtn;
}

function enableFeedbackMode() {
  feedbackMode = true;
  const btn = getActiveFeedbackBtn();
  if (btn) btn.classList.add('active');

  const webview = getActiveWebview();
  if (webview) {
    webview.executeJavaScript(feedbackScript);
  }
}

function disableFeedbackMode() {
  feedbackMode = false;
  // Clear active class on all feedback buttons
  for (const [, tab] of tabs) {
    if (tab.type === 'web') {
      tab.typeState.feedbackBtn.classList.remove('active');
    }
  }

  const webview = getActiveWebview();
  if (webview) {
    webview.executeJavaScript(cleanupScript);
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
  feedbackPopup.classList.add('visible');

  const popupWidth = feedbackPopup.offsetWidth;
  const popupHeight = feedbackPopup.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const padding = 10;

  if (x + popupWidth + padding > viewportWidth) {
    x = viewportWidth - popupWidth - padding;
  }
  if (x < padding) x = padding;

  if (y + popupHeight + padding > viewportHeight) {
    y = viewportHeight - popupHeight - padding;
  }
  if (y < padding) y = padding;

  feedbackPopup.style.left = x + 'px';
  feedbackPopup.style.top = y + 'px';
  feedbackText.value = '';
  feedbackText.focus();
}

function hideFeedbackPopup() {
  feedbackPopup.classList.remove('visible');
  selectedElementData = null;
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getElementKey(elementData) {
  return elementData.selector || elementData.outerHTML.substring(0, 100);
}

// Create or reuse a terminal tab for a given element
async function getOrCreateElementTerminal(elementKey) {
  if (elementTerminals.has(elementKey)) {
    const terminalInfo = elementTerminals.get(elementKey);
    // Verify tab still exists
    if (tabs.has(terminalInfo.tabId)) {
      soloSelectTab(terminalInfo.tabId);
      return terminalInfo;
    }
    elementTerminals.delete(elementKey);
  }

  const uuid = generateUUID();
  const tabId = await createTerminalTab();

  const terminalInfo = { tabId, uuid };
  elementTerminals.set(elementKey, terminalInfo);

  return terminalInfo;
}

async function submitFeedback() {
  const feedback = feedbackText.value.trim();

  if (!feedback || !selectedElementData) {
    hideFeedbackPopup();
    disableFeedbackMode();
    return;
  }

  // Truncate outerHTML to avoid overwhelming the chat with huge markup
  let html = selectedElementData.outerHTML;
  if (html.length > 2000) {
    html = html.substring(0, 2000) + '\n... (truncated)';
  }

  const message = `I selected this element on the page:\n\nSelector: \`${selectedElementData.selector}\`\nTag: \`${selectedElementData.tagName}\`\n\n\`\`\`html\n${html}\n\`\`\`\n\nFeedback: ${feedback}`;

  // Route to cumulus chat instead of spawning throwaway terminal
  sendToCumulusChat(message);

  hideFeedbackPopup();
  disableFeedbackMode();
}

feedbackSubmit.addEventListener('click', submitFeedback);

feedbackText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitFeedback();
  }
});

// Click outside popup to close
document.addEventListener('click', (e) => {
  if (feedbackPopup.classList.contains('visible') &&
      !feedbackPopup.contains(e.target)) {
    hideFeedbackPopup();
    disableFeedbackMode();
  }
});


// ===== DRAG AND DROP =====
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
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
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
    enableWebviewPointerEvents();
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

dropOverlay.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');
  enableWebviewPointerEvents();

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    const filePath = file.path;
    if (filePath) {
      const activeTab = activeTabId ? tabs.get(activeTabId) : null;

      if (activeTab && activeTab.type === 'terminal') {
        const escapedPath = filePath.replace(/([ "'\\$`!])/g, '\\$1');
        window.electronAPI.sendTerminalInput(activeTab.typeState.ptyId, escapedPath);
      } else {
        const fileUrl = 'file://' + filePath;
        if (activeTab && activeTab.type === 'web') {
          activeTab.typeState.urlInput.value = fileUrl;
          activeTab.typeState.webview.src = fileUrl;
        }
      }
    }
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');
  enableWebviewPointerEvents();
});


// ===== CROSS-PANEL HELPERS =====

// Find or create a cumulus tab and return its ID
function getOrCreateCumulusTab() {
  // Find existing cumulus tab
  for (const [id, tab] of tabs) {
    if (tab.type === 'cumulus') {
      return id;
    }
  }
  // Create new one
  return createCumulusTab();
}

// Extract last N lines of text from a terminal buffer
function extractTerminalText(term, lineCount = 50) {
  const buffer = term.buffer.active;
  const totalLines = buffer.length;
  const start = Math.max(0, totalLines - lineCount);
  const lines = [];
  for (let i = start; i < totalLines; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}

// Send text to a cumulus tab's input (via IPC as a message)
function sendToCumulusChat(text) {
  const cumulusId = getOrCreateCumulusTab();
  const cumulusTab = tabs.get(cumulusId);
  if (!cumulusTab) return;

  // Make the cumulus tab visible and active
  if (!cumulusTab.visible) {
    toggleTabVisibility(cumulusId);
  }
  activateTab(cumulusId);

  // Send message via IPC
  const threadName = cumulusTab.typeState.threadName;
  if (threadName) {
    window.electronAPI.cumulusSendMessage(threadName, text);
  }
}


// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  // ESC: close type picker / feedback popup / feedback mode
  if (e.key === 'Escape') {
    if (tabTypePicker.classList.contains('visible')) {
      tabTypePicker.classList.remove('visible');
      return;
    }
    if (feedbackPopup.classList.contains('visible')) {
      hideFeedbackPopup();
      disableFeedbackMode();
      return;
    }
    if (feedbackMode) {
      disableFeedbackMode();
      return;
    }
  }

  // Cmd+Shift+C: Send terminal output to chat
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'C') {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab && tab.type === 'terminal') {
        e.preventDefault();
        const terminalOutput = extractTerminalText(tab.typeState.term, 50);
        if (terminalOutput.trim()) {
          sendToCumulusChat(`Here is recent terminal output:\n\n\`\`\`\n${terminalOutput}\n\`\`\`\n\nPlease help me understand or fix any issues.`);
        }
      }
    }
  }

  // Cmd+Shift+S: Send browser screenshot to chat
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'S') {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab && tab.type === 'web') {
        e.preventDefault();
        const url = tab.typeState.webview.getURL();
        sendToCumulusChat(`I'm looking at the page: ${url}\n\nPlease help me with this page.`);
      }
    }
  }

  // Cmd+R: reload active web tab
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'r') {
    const webview = getActiveWebview();
    if (webview) {
      e.preventDefault();
      webview.reload();
    }
  }

  // Cmd+= or Cmd++: zoom in terminals
  if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomInTerminal();
  }

  // Cmd+-: zoom out terminals
  if ((e.metaKey || e.ctrlKey) && e.key === '-') {
    e.preventDefault();
    zoomOutTerminal();
  }

  // Cmd+1..9: solo select tab N
  if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
    const n = parseInt(e.key, 10);
    const tabList = [...tabs.values()];
    if (n <= tabList.length) {
      e.preventDefault();
      soloSelectTab(tabList[n - 1].id);
    }
  }
});


// ===== IMAGE PASTE HANDLER =====
window.electronAPI.onPasteImage(() => {
  if (!activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (tab && tab.type === 'terminal') {
    window.electronAPI.sendTerminalInput(tab.typeState.ptyId, '\x16');
  } else if (tab && tab.type === 'cumulus') {
    tab.typeState.container.dispatchEvent(new CustomEvent('janus-paste-image', { bubbles: true }));
  }
});


// ===== CLOSE TAB HANDLER =====
window.electronAPI.onCloseTab(() => {
  if (activeTabId) {
    closeTab(activeTabId);
  }
});


// ===== NEW TAB HANDLER (from menu Cmd+T) =====
window.electronAPI.onNewTab(() => {
  createTerminalTab();
});


// ===== STARTUP =====
async function initProjectFolder() {
  const existingPath = await window.electronAPI.getProjectPath();
  if (!existingPath) {
    await window.electronAPI.selectProjectFolder();
  }
  // Create initial chat tab after project folder is set
  createCumulusTab();
}

initProjectFolder();
