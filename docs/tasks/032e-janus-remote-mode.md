# 032e: Janus Remote Mode

## Overview
Add remote gateway support to Janus so cumulus chat tabs can delegate message handling to a remote cumulus gateway server (thundercat) instead of spawning local Claude subprocesses.

## Dependencies
- Cumulus gateway tasks 032a-032d, 032f, 032g (all complete)
- Gateway API at `POST /api/thread/:name/message` is live

## What to Build

### 1. Gateway Config
Global config at `~/.cumulus/gateway.json`:
```json
{
  "url": "https://thundercat.local:8080",
  "apiKey": "sk-cumulus-...",
  "enabled": true
}
```

### 2. `sendMessageRemote()` in cumulus-bridge.js
- POST to `${gatewayUrl}/api/thread/${threadName}/message` with `{ message, images }`
- `X-API-Key` header from config
- Parse SSE stream: token → stream-chunk, segment → stream-segment, done → stream-end, error → error
- No local history, subprocess, pool, or RAG

### 3. Route Selection in `sendMessage()`
```javascript
if (gatewayConfig.enabled) {
  return this.sendMessageRemote(threadName, message, images, win);
} else {
  return this.sendMessageLocal(threadName, message, images, win);
}
```

### 4. Remote Thread List + History
- `GET /api/threads` for thread list
- `GET /api/thread/:name/history?limit=50` for message history
- Replace local HistoryStore reads when in remote mode

### 5. Fallback Behavior
- Gateway unreachable → show error in chat, do NOT silently fall back
- Offer to switch to local mode

### 6. Context Inspector
- When remote, show gateway stats from `done` SSE event (ttft, tokensIn, tokensOut)

## Gateway SSE Format
```
event: token
data: {"text": "Hello"}

event: segment
data: {"type": "thinking", "text": "..."}

event: tool
data: {"name": "search_history", "input": {...}}

event: done
data: {"response": "full response...", "ttft": 4200, "tokensIn": 50000, "tokensOut": 350, "threadName": "puppet"}

event: error
data: {"error": "Claude process failed", "code": "CLAUDE_ERROR"}
```

## Files to Modify
- `cumulus-bridge.js` — sendMessageRemote(), route selection, remote history/threads, gateway config
- No main.js changes needed (IPC handlers already delegate to bridge)

## Testing
- Remote send with mock SSE server → verify IPC events
- Gateway unreachable → verify error shown, no silent fallback
- Mixed mode: thread A remote, thread B local → both work
