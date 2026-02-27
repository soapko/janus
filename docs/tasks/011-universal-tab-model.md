# Task 011: Universal Tab Model

## Overview

Refactor Janus's renderer from two fixed panel types (browser + terminal) to a universal tab model where any tab can be web, terminal, or cumulus type. Multiple tabs can be selected simultaneously and displayed side-by-side as panels.

## Current State

- `renderer.js` (~1194 LOC) has two separate Maps: `browsers` (id -> {webview, tab}) and `terminals` (id -> {term, fitAddon, container, tab})
- Two separate tab bars: `#browser-tab-bar` and `#tab-bar` (terminal)
- Two fixed panels: `#browser-panel` (left, collapsible) and `#terminal-panel` (right)
- Single resize handle between the two panels
- `selectedPane` tracks which panel is focused ('browser' | 'terminal')
- Browser panel starts collapsed; toggle with Cmd+\

## Target State

### Data Model

```javascript
const tabs = new Map(); // id -> Tab
let nextTabId = 1;

// Tab object:
{
  id: number,
  type: 'web' | 'terminal' | 'cumulus',
  label: string,
  visible: boolean,        // currently displayed in a panel
  panelEl: HTMLElement,     // the panel container div
  tabEl: HTMLElement,       // the tab bar element
  typeState: {
    // web: { webview }
    // terminal: { term, fitAddon, container }
    // cumulus: { reactRoot, threadId }
  }
}
```

### DOM Structure

```html
<body>
  <div class="title-bar" id="title-bar">...</div>
  <div class="tab-bar" id="tab-bar">
    <!-- All tabs in one bar, with type icons -->
    <div class="tab active" data-tab-id="1">
      <span class="tab-type-icon">&#x1F310;</span>  <!-- or text icon -->
      <span class="tab-title">localhost:3000</span>
      <span class="tab-close">&times;</span>
    </div>
    <div class="tab" data-tab-id="2">...</div>
    <button id="new-tab-btn">+</button>
    <div id="tab-type-picker" class="tab-type-picker hidden">
      <button data-type="web">Web</button>
      <button data-type="terminal">Terminal</button>
      <button data-type="cumulus">Chat</button>
    </div>
  </div>
  <div class="panels-container" id="panels-container">
    <!-- Dynamic: one panel per visible tab -->
    <div class="panel" data-tab-id="1">
      <!-- web toolbar + webview, OR terminal container, OR cumulus mount -->
    </div>
    <div class="resize-handle"></div>
    <div class="panel" data-tab-id="2">...</div>
  </div>
</body>
```

### Selection Mechanics

- **Click** on a tab: solo-select (this tab visible, all others hidden), shown full-width
- **Cmd+Click** on a tab: toggle visibility (add/remove from visible set)
- If cmd+click makes the last visible tab hidden, it stays visible (at least 1 must be visible)
- Visible tabs display left-to-right in tab bar order
- The "active" tab (last clicked, blue highlight) receives keyboard focus and keyboard shortcuts

### Panel Layout

- N visible tabs = N panels in a flex row
- Each panel starts at `flex: 1` (equal width)
- N-1 resize handles between panels
- Resize handles adjust `flex` of adjacent panels via mousedrag
- When visibility changes, panels are rebuilt (or shown/hidden) and resize handles regenerated

### Tab Type Lifecycle

Each type has create/show/hide/destroy functions:

**Web:**
- create: create webview element, set URL, attach navigation event listeners
- show: set webview display to flex, add to panel
- hide: set webview display to none
- destroy: remove webview from DOM

**Terminal:**
- create: IPC createTerminal, create xterm + FitAddon, open into container
- show: set container display to block, fit terminal
- hide: set container display to none
- destroy: IPC killTerminal, term.dispose(), remove container

**Cumulus** (stub for now):
- create: create placeholder div "Chat coming soon"
- show/hide/destroy: standard display toggle

### Web Tab Toolbar

The browser toolbar (back/forward/reload/URL bar) needs to move inside each web-type panel (not be a global toolbar). When a web tab is visible, its panel includes the toolbar above the webview.

### Keyboard Shortcuts (updated)

| Shortcut | Action |
|----------|--------|
| Cmd+T | New terminal tab |
| Cmd+Shift+T | Open type picker |
| Cmd+W | Close active tab |
| Cmd+1..9 | Switch to tab N (solo select) |
| Cmd+\ | Toggle between showing just the active tab vs all visible tabs |
| Cmd+R | Reload active web tab (if active tab is web type) |
| Cmd+=/- | Zoom terminal font (if active tab is terminal) |

### Preserved Functionality

Everything that works today must still work:
- File drag-and-drop (to terminal: paste path, to browser: navigate)
- Feedback mode (element selection, popup, submit to terminal)
- Browser webview events (navigation, title updates, URL bar sync)
- Terminal PTY lifecycle (create, input, output, resize, kill)
- Terminal scroll-to-bottom button
- Terminal font zoom
- Image paste to terminal
- Project folder selection on startup
- Title bar with project colors
- Multi-window support

## Implementation Steps

1. Update `index.html`:
   - Remove the two-panel DOM structure
   - Add single unified tab bar
   - Add panels container (dynamic children)
   - Add type picker dropdown
   - Move browser toolbar into a template/fragment for per-panel use
   - Update all CSS for new layout

2. Rewrite tab management in `renderer.js`:
   - Create `tabs` Map replacing `browsers` + `terminals`
   - Implement `createTab(type, options)` dispatching to type-specific creators
   - Implement `showTab(id)` / `hideTab(id)` dispatching to type-specific show/hide
   - Implement `closeTab(id)` dispatching to type-specific destroy
   - Implement `selectTab(id)` (solo) and `toggleTabVisibility(id)` (multi)

3. Implement panel layout system:
   - `rebuildPanels()` - reads visible tabs, creates/updates panel divs and resize handles
   - Resize handle drag logic generalized for N panels
   - Panel flex distribution on visibility changes

4. Port web tab functionality:
   - `createWebTab(url)` - creates webview + toolbar, returns tab object
   - `showWebTab(tab)` / `hideWebTab(tab)` / `destroyWebTab(tab)`
   - URL bar, navigation, webview events all scoped per-tab

5. Port terminal tab functionality:
   - `createTerminalTab()` - creates xterm + PTY, returns tab object
   - `showTerminalTab(tab)` / `hideTerminalTab(tab)` / `destroyTerminalTab(tab)`
   - Terminal data routing, fit, scroll, zoom all scoped per-tab

6. Port feedback mode:
   - Adapt to work with web-type tabs from unified Map
   - `getActiveWebTab()` helper

7. Port drag-and-drop:
   - Adapt drop target detection to use panels-container and tab types

8. Port keyboard shortcuts:
   - Dispatch based on active tab type

9. Stub cumulus tab type:
   - Placeholder panel with "Chat" label

10. Test all existing functionality works through the new model

## Testing

- Launch app, verify single tab bar appears
- Create terminal tab (Cmd+T), verify it works
- Create web tab (+ button > Web), verify webview loads
- Click tabs to solo-select, verify full-width display
- Cmd+click to show multiple tabs side-by-side
- Resize handle between panels works
- Close tabs (Cmd+W and x button)
- Cmd+1..9 tab switching
- Terminal: type commands, scroll, zoom font, scroll-to-bottom button
- Browser: navigate, back/forward, reload, URL bar
- Drag file to terminal, drag file to browser
- Feedback mode: toggle, select element, submit feedback
- Image paste to terminal
- Multi-window: new window gets its own tabs
- Project folder picker on first launch
