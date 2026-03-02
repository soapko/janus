# Task 019: New Chat Tab Uses Project Default Thread

## Problem

When opening a new cumulus chat tab via the "+" button, it defaults to `chat-2`, `chat-3`, etc. instead of using the project's default thread name (same as the initial chat tab).

**Root cause:** `createCumulusTab()` in `renderer.js` (line ~556) generates `chat-${cumulusTabCounter}` when no `threadName` is passed. Only the first tab (counter === 1) has special logic to resolve the project folder name.

The "+" button handler (line ~1092) calls `createCumulusTab()` with no argument.

## Desired Behavior

New chat tabs created from the UI should default to the **same thread** as the initial chat tab (the project folder name, e.g., `janus`). This means the new tab shares the same conversation thread — which is useful for resuming work.

If the user wants a separate thread, they can use the Threads picker to switch.

## Implementation

### Single change in `renderer.js`

**Option A (simplest):** Cache the resolved project folder name and pass it to subsequent `createCumulusTab()` calls.

```javascript
// After the project path resolves for the first tab:
let defaultThreadName = null;

// In the first-tab resolution block (lines 591-602):
const folderName = projectPath.split('/').pop() || 'default';
defaultThreadName = folderName;  // cache it

// In the fallback (line 556), use the cached name:
if (!threadName) {
  threadName = defaultThreadName || `chat-${cumulusTabCounter}`;
}
```

**Option B (async):** Always resolve project path for every new tab. More robust but unnecessary since the first tab always runs first.

### Files to modify

| File | Change |
|------|--------|
| `renderer.js` | Cache `defaultThreadName` from first tab resolution, use it as fallback in `createCumulusTab()` |

### Edge cases

- First tab hasn't resolved project path yet when second tab is created → fall back to `chat-N` (unlikely since project path resolves nearly instantly)
- Multiple windows with different project paths → each window has its own `defaultThreadName` (already scoped to window since renderer.js is per-window)

## Testing

1. Launch Janus, verify first tab gets project folder name (e.g., "janus")
2. Click "+" → cumulus → verify new tab also gets "janus" thread name
3. Both tabs should show the same conversation history (shared thread)
4. Thread selector should still work to switch to a different thread
