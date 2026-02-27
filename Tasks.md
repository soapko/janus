# Janus Tasks

## 001.features
- [x] New Window & Terminal Zoom -> [001.features.01-new-window-and-terminal-zoom.md](docs/tasks/archive/001.features.01-new-window-and-terminal-zoom.md)
- [x] Close Tab Shortcut with Pane Selection -> [001.features.02-close-tab-shortcut.md](docs/tasks/archive/001.features.02-close-tab-shortcut.md)

## 010 - Janus + Cumulus Integration

- [◒] 011: Universal tab model refactor -> [011-universal-tab-model.md](docs/tasks/011-universal-tab-model.md)
  - Replace browsers/terminals Maps with single unified tabs Map
  - Single tab bar with type icons, click/cmd+click selection
  - Dynamic panel layout with N resize handles
  - Type-specific lifecycle handlers (web/terminal/cumulus stub)
  - + button with type picker dropdown

- [◒] 012: Cumulus library integration -> [012-cumulus-lib-integration.md](docs/tasks/012-cumulus-lib-integration.md)
  - Add Cumulus lib as dependency in main process
  - IPC bridge for Claude subprocess spawning + streaming
  - Thread management (create, list, persist)

- [◒] 013: React chat UI -> [013-react-chat-ui.md](docs/tasks/013-react-chat-ui.md)
  - esbuild pipeline for React components
  - ChatPanel, ChatInput, StreamingResponse, MarkdownRenderer
  - IPC wiring: input -> main process -> Claude -> stream -> UI

- [◒] 014: Cross-panel integration -> [014-cross-panel-integration.md](docs/tasks/014-cross-panel-integration.md)
  - Terminal output -> chat context
  - Browser screenshot -> chat context
  - Feedback mode upgrade to persistent chat
  - Project-scoped thread management
