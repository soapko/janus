# Janus

A two-panel macOS developer tool built with Electron that combines a web browser and terminal side by side. Named after the Roman god of duality, Janus lets you view your web app and interact with your terminal in a single window — ideal for local development workflows.

## Features

- **Split-panel layout** — Resizable browser and terminal panels side by side
- **Tabbed terminals** — Multiple terminal tabs powered by `node-pty` and `xterm.js`, each running a login shell with full PATH support
- **Tabbed browser** — Multiple browser tabs using Electron webviews with navigation controls (back, forward, reload, URL bar)
- **Multi-window support** — Open multiple Janus windows, each tied to a different project folder (`Cmd+N`)
- **Project color coding** — Each project gets a randomly assigned title bar color (configurable via Window > Project Color menu) persisted across sessions
- **Browser panel toggle** — Collapse/expand the browser panel to maximize terminal space (`Cmd+\`). Starts collapsed by default
- **Terminal zoom** — Adjust terminal font size with `Cmd+`/`Cmd-` (range: 8–32px)
- **Scroll-to-bottom button** — Appears when scrolled up in a terminal; click to snap back to the latest output
- **Drag and drop** — Drop files onto the terminal to insert the escaped path, or onto the browser to open them
- **Feedback mode** — Click the feedback button (⊙) in the browser toolbar to select a UI element, then submit feedback that gets sent to Claude CLI in a dedicated terminal tab
- **Close tab shortcut** — `Cmd+W` closes the active tab in whichever panel (browser or terminal) is currently selected
- **Batched rendering** — PTY output and xterm writes are batched at ~60fps to eliminate scroll flickering during rapid streaming (e.g., LLM output)

## Architecture

```
main.js            Electron main process — window management, PTY lifecycle, IPC, menus
preload.js         Context bridge exposing electronAPI to the renderer
renderer.js        Renderer process — browser tabs, terminal tabs, UI interactions
projectColors.js   Per-project color persistence (~/.janus-colors.json)
index.html         Single-page UI with inline CSS
forge.config.js    Electron Forge packaging/signing configuration
```

## Prerequisites

- **macOS** (primary target; uses `hiddenInset` title bar and macOS-specific menu patterns)
- **Node.js** (LTS recommended)
- **Electron 28+**

## Getting Started

```bash
# Install dependencies (includes native rebuild for node-pty)
npm install

# Rebuild native modules for Electron
npm run rebuild

# Start the app
npm start
```

On launch, Janus prompts you to select a project folder. The terminal opens in that directory, and the window title updates to show the folder name.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Launch via Electron Forge |
| `npm run package` | Package the app (unsigned) |
| `npm run make` | Build distributable (DMG/ZIP for macOS) |
| `npm run rebuild` | Rebuild native modules (`node-pty`) for Electron |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New window (select project folder) |
| `Cmd+W` | Close active tab in selected panel |
| `Cmd+R` | Reload active browser tab |
| `Cmd+\` | Toggle browser panel |
| `Cmd+=` / `Cmd+-` | Zoom terminal in/out |

## License

MIT
