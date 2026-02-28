# Janus

A multi-panel macOS developer workspace built with Electron. Terminals, a web browser, and an AI chat — each in their own tab, viewable solo or side by side.

Named after the Roman god of beginnings and transitions, Janus puts everything you need for local development in a single window.

## Features

### Unified Tab System

Every panel lives in a single tab bar. Click a tab to view it full-width, or **Cmd+Click** multiple tabs to show them side by side with resizable dividers.

- **Terminal tabs** — Full terminal emulator powered by `node-pty` and `xterm.js`, running your login shell with complete PATH support
- **Web tabs** — Embedded browser with navigation controls (back, forward, reload, URL bar) via Electron webviews
- **Chat tabs** — AI chat powered by Claude CLI with streaming responses, markdown rendering, and conversation threading
- **+ button** — Click to pick a tab type (Terminal, Web, or Chat)
- **Drag to reorder** — Drag tabs to rearrange them; panel order follows tab order

### AI Chat

The chat panel connects to Claude CLI and supports:

- Streaming responses with live markdown rendering
- Image and file attachments (paste or pick from file dialog)
- Conversation history persistence via threads
- Context from other panels (see Cross-Panel Integration below)

### Cross-Panel Integration

- **Terminal → Chat** (`Cmd+Shift+C`) — Sends the last 50 lines of terminal output to the chat for help
- **Browser → Chat** (`Cmd+Shift+S`) — Sends the current page URL to the chat for discussion
- **Feedback mode** — Click the ⊙ button in a web tab's toolbar, select a UI element, and submit feedback that routes to the chat with the element's HTML and selector

### Multi-Window & Projects

- **Cmd+N** — Open a new window tied to a different project folder
- **Project color coding** — Each project gets a unique title bar color, persisted across sessions and configurable via Window > Project Color

### Terminal

- **Zoom** — `Cmd+=` / `Cmd+-` to adjust font size (8–32px range)
- **Scroll-to-bottom** — A button appears when scrolled up; click to snap back to latest output
- **Batched rendering** — PTY writes are batched at ~60fps to eliminate scroll flickering during rapid output
- **Drag and drop** — Drop a file onto a terminal to insert its escaped path

## Architecture

```
main.js              Electron main process — windows, PTY lifecycle, IPC, menus
preload.js           Context bridge (electronAPI)
renderer.js          Renderer process — tab system, panels, keyboard shortcuts
index.html           UI shell with inline CSS

src/cumulus/          React chat UI (ChatPanel, ChatInput, MessageBubble, etc.)
dist/cumulus-chat.js  Chat bundle (built by esbuild)
cumulus-bridge.js     Claude CLI subprocess manager, stream parser, thread persistence

projectColors.js     Per-project color storage (~/.janus-colors.json)
forge.config.js      Electron Forge packaging configuration
```

## Prerequisites

- **macOS** (uses `hiddenInset` title bar and macOS menu patterns)
- **Node.js** (LTS recommended)
- **Electron 28+**
- **Claude CLI** — Required for the chat panel. Install from [claude.ai](https://claude.ai)

## Getting Started

```bash
# Install dependencies (includes native rebuild for node-pty)
npm install

# Rebuild native modules for Electron
npm run rebuild

# Start the app
npm start
```

On launch, Janus prompts you to select a project folder. A chat tab opens by default — use the **+** button to add terminals and web panels.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Build chat bundle and launch via Electron Forge |
| `npm run package` | Package the app (unsigned `.app` bundle) |
| `npm run make` | Build distributable (DMG/ZIP for macOS) |
| `npm run rebuild` | Rebuild native modules (`node-pty`) for Electron |
| `npm run build:chat` | Build the React chat bundle only |
| `npm run watch:chat` | Watch and rebuild the chat bundle on changes |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New window (select project folder) |
| `Cmd+T` | New terminal tab |
| `Cmd+W` | Close active tab |
| `Cmd+1`–`Cmd+9` | Switch to tab N |
| `Cmd+Click` tab | Toggle tab visibility (show multiple panels) |
| `Cmd+R` | Reload active web tab |
| `Cmd+=` / `Cmd+-` | Zoom terminal in/out |
| `Cmd+Shift+C` | Send terminal output to chat |
| `Cmd+Shift+S` | Send browser page to chat |

## License

MIT
