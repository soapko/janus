# Task 017: Web Panel CDP/Playwright Integration

## Overview

Enable external automation tools (Playwright, Puppet, Abra) to programmatically open and interact with Janus web panel tabs via CDP (Chrome DevTools Protocol). Janus already exposes CDP on port 9222, and webview targets are already discoverable — the remaining work is IPC commands so terminal/chat sessions can control web tabs.

## Current State

- Janus exposes CDP via `app.commandLine.appendSwitch('remote-debugging-port', '9222')` (main.js:489)
- Webview tabs appear as CDP targets with `type: "webview"` at `http://localhost:9222/json`
- Each webview has its own `webSocketDebuggerUrl` — Playwright can connect directly
- No IPC commands exist for programmatic web tab creation/listing
- External tools can already connect via `connectOverCDP('http://localhost:9222')` — they just can't open new tabs

## Target State

Three new IPC commands:

### 1. `janus:open-web-tab` — Open a URL in a new web panel tab

```
Input:  { url: string }
Output: { tabId: number, url: string }
```

Creates a web tab with the given URL. Returns immediately — the webview starts loading in the background. External tools can then find it via CDP target discovery.

### 2. `janus:list-web-tabs` — List open web panel tabs with CDP info

```
Input:  (none)
Output: Array<{ tabId: number, url: string, title: string }>
```

Returns all web-type tabs with their current URL and title. External tools combine this with `http://localhost:9222/json` to find the right CDP target.

### 3. `janus:navigate-web-tab` — Navigate an existing web tab to a URL

```
Input:  { tabId: number, url: string }
Output: { success: boolean }
```

Changes the URL of an existing web tab. Useful for reusing a tab across test runs.

## Implementation

### Files to modify

**`main.js`** — 3 new IPC handlers (invoke for open/list/navigate)
**`preload.js`** — 3 new API exposures
**`renderer.js`** — 3 new IPC listener handlers that call existing createWebTab/tabs Map

### IPC flow

```
External tool                    Janus
    │                              │
    │  (terminal/chat runs:)       │
    │  electronAPI.openWebTab(url) │
    │  ──────────────────────────► │
    │                              │ main.js sends 'janus:open-web-tab' to renderer
    │                              │ renderer calls createWebTab(url)
    │                              │ returns { tabId, url }
    │  ◄────────────────────────── │
    │                              │
    │  curl localhost:9222/json    │
    │  ──────────────────────────► │ CDP returns webview targets
    │  ◄────────────────────────── │
    │                              │
    │  playwright.connectOverCDP() │
    │  ──────────────────────────► │ Full automation on webview content
```

### Key detail: IPC routing

Since `createWebTab()` runs in the renderer process, the main process IPC handler needs to:
1. Receive the request
2. Forward to the renderer via `win.webContents.send('janus:open-web-tab', ...)`
3. Renderer creates the tab and sends result back via `ipcRenderer.send('janus:open-web-tab-result', ...)`

Alternative (simpler): Use `ipcMain.handle` + `win.webContents.executeJavaScript()` to call renderer functions directly. But this is fragile with complex return values.

**Chosen approach:** Use paired send/on messages with a request ID for correlation.

## HTTP API (port 9223)

External tools control Janus web tabs via a local HTTP API — no IPC or Electron context needed.

### Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/tabs` | — | `[{ tabId, url, title }]` |
| `POST` | `/api/tabs` | `{ "url": "..." }` | `{ tabId, url }` |
| `POST` | `/api/tabs/:id/navigate` | `{ "url": "..." }` | `{ success }` |
| `DELETE` | `/api/tabs/:id` | — | `{ success }` |
| `GET` | `/api/targets` | — | CDP webview targets from `:9222/json` |

### Usage from curl

```bash
# Create a web tab
curl -X POST http://localhost:9223/api/tabs \
  -H 'Content-Type: application/json' \
  -d '{"url": "http://localhost:3000"}'

# List open web tabs
curl http://localhost:9223/api/tabs

# List CDP webview targets (for Playwright connection)
curl http://localhost:9223/api/targets

# Navigate a tab
curl -X POST http://localhost:9223/api/tabs/5/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url": "http://localhost:3000/dashboard"}'

# Close a tab
curl -X DELETE http://localhost:9223/api/tabs/5
```

### Usage from Playwright/Puppet

```js
const { chromium } = require('playwright');

// 1. Create a tab in Janus
const res = await fetch('http://localhost:9223/api/tabs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'http://localhost:3000' })
});
const { tabId } = await res.json();

// 2. Connect to Janus via CDP
const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
const pages = contexts[0].pages();

// 3. Find the webview page
const page = pages.find(p => p.url().includes('localhost:3000'));

// 4. Automate
await page.click('button[data-testid="submit"]');
await page.screenshot({ path: 'result.png' });
```

### Architecture

```
External Tool                     Janus (port 9223)          Janus (port 9222)
    │                                  │                          │
    │ POST /api/tabs {url}             │                          │
    │ ────────────────────────────────►│                          │
    │                                  │ IPC → renderer           │
    │                                  │ createWebTab(url)        │
    │ ◄────────────────────────────────│                          │
    │ { tabId, url }                   │                          │
    │                                  │                          │
    │ connectOverCDP(:9222)            │                          │
    │ ─────────────────────────────────────────────────────────► │
    │                                  │                          │ webview target
    │ ◄─────────────────────────────────────────────────────────│
    │ page.click(), screenshot(), ...  │                          │
```

## Testing

1. Start Janus with a project
2. Create a tab: `curl -X POST http://localhost:9223/api/tabs -H 'Content-Type: application/json' -d '{"url":"http://example.com"}'`
3. Verify the web tab appears in Janus UI
4. List tabs: `curl http://localhost:9223/api/tabs`
5. List targets: `curl http://localhost:9223/api/targets` — verify webview appears
6. Connect with Playwright: `chromium.connectOverCDP('http://localhost:9222')` — verify page access
7. Close the tab: `curl -X DELETE http://localhost:9223/api/tabs/<tabId>`

## Edge Cases

- Multiple web tabs: each gets its own CDP target, identifiable by URL
- Tab closed while automation running: CDP connection drops gracefully
- URL normalization: prepend `https://` if no protocol specified (matches existing createWebTab behavior)
- Port conflict: if 9223 is taken, falls back to 9224
