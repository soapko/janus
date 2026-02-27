# Task 012: Cumulus Library Integration

## Overview

Bring Cumulus's core library into Janus's Electron main process. Set up the IPC bridge for Claude subprocess management and response streaming. This enables the chat tab type to function.

## Dependencies

- Task 011 (universal tab model) must be complete
- Cumulus project at `~/Documents/_Projects/cumulus`

## Cumulus Modules to Integrate

### Core (required for chat):
- `src/lib/history.ts` - JSONL conversation persistence (deps: nanoid)
- `src/lib/content-store.ts` - External content storage + search (deps: nanoid, crypto; internal: content-detector, context-budget, embeddings)
- `src/lib/content-detector.ts` - Content analysis + summary generation (deps: child_process)
- `src/lib/context-budget.ts` - Token budgeting (no deps)
- `src/lib/embeddings.ts` - Local embeddings via HuggingFace transformers (deps: @huggingface/transformers)
- `src/lib/retriever.ts` - RAG hybrid search (internal: content-store, context-budget, embeddings, history, session)
- `src/lib/session.ts` - Session documents (deps: nanoid; internal: context-budget, embeddings)
- `src/lib/stream-processor.ts` - Stream interception + content externalization (internal: content-detector, content-store, context-budget)
- `src/lib/config.ts` - Always-include file config (internal: context-budget)
- `src/lib/image-utils.ts` - Image processing (deps: nanoid, child_process)
- `src/lib/summarizer.ts` - Conversation summarization (internal: history type)

### MCP Server:
- `src/mcp/server.ts` - Exposes lib layer as MCP tools to Claude (deps: @modelcontextprotocol/sdk; internal: all lib modules)

### Optional (can defer):
- `src/lib/snapshots.ts` - Git state capture/restore
- `src/lib/revert.ts` - Conversation revert orchestrator
- `src/lib/migrate.ts` - Migration for pre-RAG threads

## Implementation Steps

### 1. Add Cumulus as Local Dependency

In Janus `package.json`, add cumulus as a file dependency pointing to the built output:

```json
{
  "dependencies": {
    "cumulus": "file:../cumulus"
  }
}
```

Or alternatively, copy/symlink the compiled `dist/` output. The Cumulus project compiles to `dist/` via `tsc`.

Need to ensure Cumulus is built first: `cd ~/Documents/_Projects/cumulus && npm run build`

### 2. Add Required npm Dependencies to Janus

```json
{
  "dependencies": {
    "@huggingface/transformers": "^3.8.1",
    "@modelcontextprotocol/sdk": "^1.25.3",
    "nanoid": "^5.1.6"
  }
}
```

Note: `nanoid` v5 is ESM-only. Janus main process uses CommonJS (`require`). Options:
- Use dynamic `import()` for nanoid
- Or use nanoid v3 which supports CJS
- Or switch Janus main process to ESM (more invasive)

Recommended: Use dynamic `import()` for all Cumulus modules since they're ESM.

### 3. Create Cumulus Bridge Module (`cumulus-bridge.js`)

New file in Janus root. Runs in the main process. Responsibilities:

```javascript
// cumulus-bridge.js - Main process module

class CumulusBridge {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.threads = new Map(); // threadName -> { historyStore, contentStore, sessionManager }
  }

  async initialize() {
    // Dynamically import Cumulus ESM modules
    // Initialize stores for default thread
  }

  async createThread(threadName) {
    // Create HistoryStore, ContentStore, SessionManager
    // Generate MCP config file
    // Return thread info
  }

  async sendMessage(threadName, message) {
    // 1. Process images in message
    // 2. Create ContextBudget
    // 3. Load always-include files
    // 4. Run RAG retrieval
    // 5. Build system prompt
    // 6. Spawn claude subprocess
    // 7. Stream response chunks via callback
    // 8. On completion, save to history, update session
  }

  async listThreads() { ... }
  async searchHistory(threadName, query) { ... }

  destroy() {
    // Kill any running Claude subprocesses
    // Clean up MCP server processes
  }
}
```

### 4. Add IPC Channels

New channels in `main.js` and `preload.js`:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `cumulus:create-thread` | invoke | Create/open a thread |
| `cumulus:send-message` | invoke | Send user message, returns when Claude finishes |
| `cumulus:stream-chunk` | main→renderer | Stream partial response text |
| `cumulus:stream-end` | main→renderer | Signal response complete |
| `cumulus:list-threads` | invoke | List available threads |
| `cumulus:get-history` | invoke | Get recent messages for a thread |
| `cumulus:search` | invoke | Search history/content |

### 5. Update Preload

Add to `window.electronAPI`:
```javascript
cumulusCreateThread: (name) => ipcRenderer.invoke('cumulus:create-thread', name),
cumulusSendMessage: (thread, message) => ipcRenderer.invoke('cumulus:send-message', thread, message),
onCumulusStreamChunk: (callback) => ipcRenderer.on('cumulus:stream-chunk', (_, data) => callback(data)),
onCumulusStreamEnd: (callback) => ipcRenderer.on('cumulus:stream-end', (_, data) => callback(data)),
cumulusListThreads: () => ipcRenderer.invoke('cumulus:list-threads'),
cumulusGetHistory: (thread, count) => ipcRenderer.invoke('cumulus:get-history', thread, count),
cumulusSearch: (thread, query) => ipcRenderer.invoke('cumulus:search', thread, query),
```

### 6. Thread Management

- Each Cumulus tab maps to one thread
- Thread name derived from project folder name + optional suffix
- Threads stored in `~/.cumulus/threads/` (same as standalone Cumulus)
- MCP config file generated per-thread at `~/.cumulus/mcp-config-{threadName}.json`

### 7. Claude Subprocess Management

Port the logic from `useClaudeProcess.ts` to the main process:
- Spawn `claude --print --verbose --output-format stream-json --permission-mode bypassPermissions --mcp-config <path> --append-system-prompt <prompt>`
- Parse stream-json lines through StreamProcessor
- Send chunks to renderer via IPC
- Handle kill/interrupt
- Strip CLAUDE env vars from subprocess

## Testing

- Verify Cumulus modules import successfully in Electron main process
- Create a thread, verify stores initialize
- Send a message, verify Claude spawns and streams response
- Response appears in IPC stream chunks
- Thread persists across app restart
- MCP server spawns and provides tools to Claude
- Multiple windows can have independent threads

## Risk Notes

- ESM/CJS interop: Cumulus is ESM, Janus main is CJS. Dynamic `import()` required.
- `@huggingface/transformers` may need special handling in Electron (native module loading)
- `onnxruntime-node` (transitive dep via transformers) needs ASAR unpacking like node-pty
- Claude CLI must be available in PATH
