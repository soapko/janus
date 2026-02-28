# Task 015: Slash Commands & Command Palette

## Overview

Port cumulus's slash command system to Janus's React chat UI. Cumulus has three slash commands (`/include`, `/revert`, `/exit`) and a keyboard-navigable command palette. Currently Janus has zero command interception — typing `/include` sends it as a literal chat message to Claude.

## Current State

- `ChatInput.tsx` handles all keyboard input, sends raw text via `onSend(text, attachments)`
- `ChatPanel.tsx` passes everything to `api.sendMessage()` — no command routing
- No command detection, no palette, no overlays
- Cumulus has the backend APIs already: `listAlwaysIncludeFiles`, `addAlwaysIncludeFile`, `removeAlwaysIncludeFile`, `executeRevert`, `captureSnapshot`, `restoreSnapshot`

## Target State

### 1. Command Palette (inline autocomplete)

When the user types `/` as the first character in an empty input:

```
┌─────────────────────────────────────┐
│  Chat messages...                   │
│                                     │
│  ┌───────────────────────────────┐  │
│  │ > /include  Manage always-    │  │
│  │             include files     │  │
│  │   /revert   Revert to earlier │  │
│  │             turn              │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ /in█                          │  │
│  │                        [Send] │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

- Floating dropdown anchored above the textarea
- Filters by prefix as user types (e.g. `/in` shows only `/include`)
- Arrow keys navigate, Enter selects, Escape dismisses
- Click to select
- Styled as a dark popover with subtle border, matching chat theme

### 2. `/include` — Always-Include File Manager

Opens an **inline overlay** that replaces the message list area (input stays at bottom):

**List mode (default):**
```
┌─────────────────────────────────────┐
│  Always-Include Files               │
│  ─────────────────────────────────  │
│  📄 src/config.ts         [global]  │
│  📄 docs/api.md           [thread]  │
│  📄 README.md             [global]  │
│                                     │
│  [+ Add file]      [Done]          │
└─────────────────────────────────────┘
```

- Lists all always-include files with scope badges (`global` / `thread`)
- Click a file row to get a remove confirmation inline
- "Add file" button switches to add mode
- "Done" button (or Escape) closes overlay, returns to chat

**Add mode:**
```
┌─────────────────────────────────────┐
│  Add Always-Include File            │
│  ─────────────────────────────────  │
│  File path:                         │
│  ┌─────────────────────────────┐    │
│  │ src/utils/helpers.ts█       │    │
│  └─────────────────────────────┘    │
│                                     │
│  Scope: [Global] [Thread]           │
│                                     │
│  [Add]  [Cancel]                    │
└─────────────────────────────────────┘
```

- Text input for file path
- Toggle between global and thread scope
- Add button calls the cumulus API, returns to list mode
- Cancel returns to list mode

**Remove confirmation (inline):**
```
  📄 src/config.ts         [global]
  ────────────────────────────────
  Remove this file?  [Yes] [No]
```

- Appears directly below the file row
- Yes removes via API, refreshes list
- No collapses back to normal row

### 3. `/revert` — Conversation Revert

Opens an **inline overlay** replacing the message list:

**Turn picker:**
```
┌─────────────────────────────────────┐
│  Revert Conversation                │
│  ─────────────────────────────────  │
│  Keep everything after this turn:   │
│                                     │
│  #12  "Can you fix the login..."    │
│       2:45 PM                       │
│  #11  "What about the auth..."      │
│       2:32 PM  🔀                   │
│  #10  "Show me the database..."     │
│       2:15 PM  🔀                   │
│  ...                                │
│                                     │
│  [Cancel]                           │
└─────────────────────────────────────┘
```

- Scrollable list of turns (user message + assistant response pairs)
- Most recent first
- 🔀 icon indicates git snapshot available for code restoration
- Click a turn to proceed to confirmation

**Confirm:**
```
┌─────────────────────────────────────┐
│  Revert to after turn #10?          │
│  ─────────────────────────────────  │
│  This will remove 4 messages.       │
│                                     │
│  ☐ Also restore code to that point  │
│    (git snapshot available)         │
│                                     │
│  [Revert]  [Cancel]                 │
└─────────────────────────────────────┘
```

- Shows how many messages will be removed
- Checkbox for git restore (only if snapshot exists)
- Revert executes, shows brief result toast, returns to chat with truncated history
- Cancel returns to turn picker

### 4. `/exit`

In Janus context: close the current cumulus chat tab. No overlay needed — immediate action, same as clicking the tab's close button.

## Implementation Plan

### Phase 1: Command Palette + Routing

**Files:** `ChatInput.tsx`, `ChatPanel.tsx`, `chat.css`

1. Add command detection in `ChatInput.tsx`:
   - Track `isCommandMode` when input starts with `/` and cursor is at the command text
   - Filter commands by prefix
   - Render floating dropdown above textarea
   - Arrow key navigation + Enter selection + click selection
   - Escape dismissal

2. Add command routing in `ChatPanel.tsx`:
   - `handleSend` checks if text starts with `/`
   - Route to handler: set overlay state (`'include' | 'revert' | null`)
   - `/exit` → close tab via `api` or window event

3. CSS for command palette dropdown

### Phase 2: IPC Bridge Extensions

**Files:** `cumulus-bridge.js`, `preload.js`, `renderer.js`

New IPC methods needed:

```javascript
// Always-include file management
cumulusListIncludeFiles(thread)    → { global: string[], thread: string[] }
cumulusAddIncludeFile(thread, path, scope)    → void
cumulusRemoveIncludeFile(thread, path, scope) → void

// Revert
cumulusGetTurns(thread)            → Turn[]
cumulusRevert(thread, messageId, restoreGit) → RevertResult
```

Bridge calls cumulus lib APIs directly (already available in `dist/`).

### Phase 3: `/include` Overlay

**Files:** New `IncludeOverlay.tsx`, `ChatPanel.tsx`, `chat.css`

- React component with list/add/remove modes
- Receives thread name from ChatPanel
- Calls IPC methods for CRUD operations
- Renders in place of message list when active

### Phase 4: `/revert` Overlay

**Files:** New `RevertOverlay.tsx`, `ChatPanel.tsx`, `chat.css`

- React component with turn picker and confirmation
- Groups messages into turns (user + assistant pairs)
- Shows git snapshot availability from message metadata
- Calls IPC revert method, refreshes message list on success

## Data Dependencies

| Command | Cumulus API | Import path |
|---------|-----------|-------------|
| `/include` list | `listAlwaysIncludeFiles(threadName)` | `cumulus/dist/lib/config.js` |
| `/include` add | `addAlwaysIncludeFile(path, threadName?)` | `cumulus/dist/lib/config.js` |
| `/include` remove | `removeAlwaysIncludeFile(path, threadName?)` | `cumulus/dist/lib/config.js` |
| `/revert` turns | `HistoryStore.getAll()` + grouping | `cumulus/dist/lib/history.js` |
| `/revert` execute | `executeRevert(store, msgId, opts)` | `cumulus/dist/lib/revert.js` |
| `/revert` git | `restoreSnapshot(snapshot)` | `cumulus/dist/lib/snapshots.js` |

## Edge Cases

- Command palette should not activate if Claude is currently streaming
- `/revert` with zero messages should show "Nothing to revert" inline
- `/include` add with invalid/nonexistent path — show validation error
- After revert, refresh messages from history store (authoritative source)
- Git restore failures should show error but still complete history truncation
- Overlay escape should always return to chat without side effects

## Testing

- Type `/` → palette appears with all commands
- Type `/in` → palette filters to `/include` only
- Arrow down + Enter → selects command
- Escape → dismisses palette, clears input
- `/include` → overlay shows, can add/remove files, Done returns to chat
- `/revert` → shows turns, can revert, messages update correctly
- `/exit` → closes the cumulus tab
