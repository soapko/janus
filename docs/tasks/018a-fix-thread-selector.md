# Task 018a: Fix Thread Selector

## Overview

The thread selector in ChatPanel shows a list of existing threads but clicking one does nothing. Fix it so clicking a thread switches the current chat panel to that thread — killing any active subprocess, swapping the threadName, and reloading history.

## Current State

- `ChatPanel.tsx:369-378` — thread picker renders `<div>` items with no `onClick` handler
- `mountCumulusReact()` in `renderer.js:609` — binds a fixed `threadName` into every API closure
- `CumulusBridge` tracks threads in `this.threads` Map and processes in `this.activeProcesses`

## Implementation

### 1. Add `switchThread` to the API surface

**File: `src/cumulus/types.ts`**

Add to `CumulusChatAPI`:
```typescript
switchThread: (newThreadName: string) => Promise<void>;
```

### 2. IPC handler in main.js

New handler `cumulus:switch-thread`:
```javascript
ipcMain.handle('cumulus:switch-thread', async (event, { threadName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const bridge = windowBridges.get(win.id);
  // Kill active process on the OLD thread (bridge tracks by threadName)
  // getOrCreateThread on the new threadName (loads/creates it)
  // Return history for the new thread
});
```

### 3. Preload exposure

**File: `preload.js`**

```javascript
cumulusSwitchThread: (threadName) => ipcRenderer.invoke('cumulus:switch-thread', { threadName }),
```

### 4. Renderer wiring

**File: `renderer.js`**

In `mountCumulusReact`, add `switchThread` to the API object:
```javascript
switchThread: async (newThreadName) => {
  // Kill current process
  await window.electronAPI.cumulusKill(threadName);
  // Update the threadName in closure and tab state
  threadName = newThreadName;
  tab.typeState.threadName = newThreadName;
  // Create/load the thread on the bridge side
  await window.electronAPI.cumulusCreateThread(newThreadName);
  // Return — the ChatPanel will reload history via getHistory()
},
```

Note: `threadName` is a `let` variable in `mountCumulusReact`, so it can be reassigned. All the other API closures (`sendMessage`, `kill`, `getHistory`, etc.) reference this same variable, so they'll automatically use the new thread after switching.

### 5. ChatPanel onClick handler

**File: `src/cumulus/ChatPanel.tsx`**

Add click handler to thread picker items:
```tsx
onClick={async () => {
  if (t === api.threadName) return;
  setIsLoading(true);
  setMessages([]);
  setShowThreadPicker(false);
  await api.switchThread(t);
  // Reload history for new thread
  const history = await api.getHistory(0);
  setMessages(history);
  setIsLoading(false);
}}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/cumulus/types.ts` | Add `switchThread` to `CumulusChatAPI` |
| `main.js` | New `cumulus:switch-thread` IPC handler |
| `preload.js` | Expose `cumulusSwitchThread` |
| `renderer.js` | Add `switchThread` to API object, use `let` for threadName |
| `src/cumulus/ChatPanel.tsx` | Add `onClick` to thread picker items |

## Testing

- Open two cumulus tabs with different threads (e.g., "janus" and "test")
- Send messages in both
- Click "Threads" button, click a different thread
- Verify: old messages disappear, new thread's history loads
- Send a message — verify it goes to the new thread
- Verify: thread name in header updates
