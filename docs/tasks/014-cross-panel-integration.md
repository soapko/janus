# Task 014: Cross-Panel Integration

## Overview

Connect the panels for a cohesive developer experience. Terminal output can be piped to chat, browser state can be shared with chat, and the feedback mode uses persistent chat threads instead of throwaway terminal commands.

## Dependencies

- Task 011 (universal tab model)
- Task 012 (cumulus lib integration)
- Task 013 (React chat UI)

## Features

### 1. Terminal -> Chat

**Use case:** Error in terminal, want to ask Claude about it.

**Mechanic:**
- Keyboard shortcut `Cmd+Shift+C` when a terminal tab is active
- Captures last N lines of terminal output (configurable, default 50)
- Opens/focuses a cumulus tab
- Prepends the terminal output as context in the chat input

**Implementation:**
- Read terminal buffer: `term.buffer.active` provides line-by-line access
- Extract text: iterate `buffer.getLine(i).translateToString(true)` for the last N lines
- Route to cumulus tab: find or create a cumulus tab, set the input text

### 2. Browser -> Chat

**Use case:** Want to discuss what's on screen with Claude.

**Mechanic:**
- Keyboard shortcut `Cmd+Shift+S` when a web tab is active
- Captures screenshot of current webview via `webview.capturePage()`
- Opens/focuses a cumulus tab
- Attaches screenshot as context

**Implementation:**
- `capturePage()` returns a NativeImage
- Convert to PNG buffer, save to content store's images dir
- Include image path in the chat message context

### 3. Feedback Mode Upgrade

**Current:** Element selection -> popup -> submit to `claude -p` in a throwaway terminal tab.

**New:** Element selection -> popup -> submit to cumulus chat tab with the element HTML as context.

**Implementation:**
- Modify `submitFeedback()` to route to a cumulus tab instead of creating a terminal
- Format the message: include the element's HTML, CSS selector, and user's feedback text
- The cumulus tab has persistent history, so follow-up questions work naturally
- Remove `elementTerminals` Map (no longer needed)

### 4. Project-Scoped Threads

- Default thread name: project folder name (e.g., `my-project`)
- Thread persists across app sessions
- Each Janus window has one default thread
- Can create additional threads via the cumulus tab header

### 5. Thread Management UI

In the cumulus tab header area:
- Current thread name displayed
- Dropdown to switch threads
- "New Thread" button
- Thread search (optional, defer if complex)

## Keyboard Shortcuts (additions)

| Shortcut | Action |
|----------|--------|
| Cmd+Shift+C | Send terminal output to chat |
| Cmd+Shift+S | Send browser screenshot to chat |

## Testing

- Terminal: run a command that errors, Cmd+Shift+C, verify error appears in chat
- Browser: load a page, Cmd+Shift+S, verify screenshot is captured
- Feedback mode: select element, write feedback, verify it goes to cumulus chat
- Thread persists after closing and reopening app
- Multiple threads can be created and switched
