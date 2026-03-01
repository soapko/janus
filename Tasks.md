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

- [◒] 015: Slash commands & command palette -> [015-slash-commands.md](docs/tasks/015-slash-commands.md)
  - Command palette: `/` prefix detection, filtered dropdown, keyboard nav
  - `/include`: Always-include file manager overlay (list/add/remove)
  - `/revert`: Turn picker with git restore toggle
  - `/exit`: Close cumulus tab
  - IPC bridge extensions for include/revert APIs

- [◒] 016: Voice-to-text input -> [016-voice-to-text.md](docs/tasks/016-voice-to-text.md)
  - Moonshine JS (local, MIT, free) for on-device speech recognition
  - Mic button in chat input with recording state indicator
  - Streaming transcription with VAD (auto-detects speech pauses)
  - Microphone permission handling in Electron

- [◒] 017: Web panel CDP/Playwright integration -> [017-web-panel-cdp-integration.md](docs/tasks/017-web-panel-cdp-integration.md)
  - IPC commands: `openWebTab`, `listWebTabs`, `navigateWebTab`
  - CDP already exposed on port 9222, webview targets discoverable
  - Enables Playwright/Puppet/Abra to automate web panel content

- [◒] 018a: Fix thread selector -> [018a-fix-thread-selector.md](docs/tasks/018a-fix-thread-selector.md)
  - Thread picker dropdown exists but clicking does nothing
  - Add switchThread: kill subprocess, swap threadName, remount React
  - Prerequisite for 018b (need to switch between agent threads)

- [◒] 018b: Inter-agent messaging PoC -> [018b-inter-agent-messaging-poc.md](docs/tasks/018b-inter-agent-messaging-poc.md)
  - Each cumulus tab is addressable agent (identity = thread name)
  - HTTP API: `GET /api/agents`, `POST /api/agents/:name/message`
  - `janus-agents` MCP server with `list_agents` + `send_to_agent`
  - Message injection via interjection (kill + resend)

- [ ] 018: Inter-agent messaging (full) -> [018-inter-agent-messaging.md](docs/tasks/018-inter-agent-messaging.md)
  - Broadcast, set_tab_name, rate limiting, agent status tracking
  - Agent message visual styling (colored borders, badges)
  - Multi-project support, agent spawning
