# Task 018b: Inter-Agent Messaging PoC

## Overview

Minimal proof-of-concept for inter-agent communication. Each cumulus chat tab is an addressable agent (identified by its thread name). Agents can list peers and send messages to each other via MCP tools. Messages are delivered as interjections — the receiving agent gets interrupted and sees the message as a new user turn.

## Scope (Simplified)

### In scope
- `list_agents` and `send_to_agent` MCP tools
- HTTP API endpoints for agent listing and message delivery
- MCP server script (`janus-agents-mcp.js`)
- Wire MCP config so each cumulus tab gets the agent tools

### Out of scope (deferred)
- `spawn_agent` / `list_projects` — user manages agents manually
- `broadcast` — agent calls `send_to_agent` N times
- `set_tab_name` — thread name IS the agent name
- Rate limiting / backoff — add later if loops happen
- Visual agent colors/badges — text prefix `[From agent "X"]:` for now
- Agent status tracking

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Janus Main Process                │
│                                                  │
│  ┌──────────────────────────────────────┐        │
│  │ HTTP API (port 9223)                 │        │
│  │  GET  /api/agents                    │        │
│  │  POST /api/agents/:name/message      │        │
│  └──────────────────────────────────────┘        │
│                                                  │
│  ┌──────────────────────────────────────┐        │
│  │ CumulusBridge                        │        │
│  │  sendMessage(threadName, msg, win)   │        │
│  │  → reuses existing full flow:        │        │
│  │    persist, RAG, spawn Claude        │        │
│  └──────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
         ▲                           ▲
         │ HTTP (localhost:9223)      │ HTTP
         │                           │
┌────────┴──────┐          ┌─────────┴──────┐
│ janus-agents  │          │ janus-agents   │
│ MCP Server    │          │ MCP Server     │
│ (Agent A)     │          │ (Agent B)      │
│               │          │                │
│ Tools:        │          │ Tools:         │
│ send_to_agent │          │ send_to_agent  │
│ list_agents   │          │ list_agents    │
└───────────────┘          └────────────────┘
         ▲                           ▲
         │ stdio                     │ stdio
         │                           │
┌────────┴──────┐          ┌─────────┴──────┐
│ Claude CLI    │          │ Claude CLI     │
│ (subprocess)  │          │ (subprocess)   │
└───────────────┘          └────────────────┘
```

## Message Flow

```
Agent A calls send_to_agent("puppet", "I added CDP support")
  → MCP server POSTs to localhost:9223/api/agents/puppet/message
  → Main process finds the window + bridge that owns thread "puppet"
  → Bridge kills active process for "puppet" (interjection)
  → Bridge calls sendMessage("puppet", "[From agent janus]: ...", win)
  → Puppet's Claude sees the message as a new user turn
  → Tool returns { delivered: true } immediately to Agent A
```

## Implementation

### Phase 1: HTTP API endpoints

**File: `main.js`**

Add two endpoints to the existing `startHttpApi()`:

```javascript
// GET /api/agents — list all active cumulus threads across all windows
// Returns: [{ name: "janus", status: "idle"|"active" }]
// Scans all windowBridges, collects thread names from each bridge

// POST /api/agents/:name/message — deliver message to agent
// Body: { message: string, sender: string }
// Finds which window/bridge owns that threadName
// Kills active process (interjection), sends formatted message
// Returns: { delivered: true }
```

The agent identity IS the thread name. The endpoint scans `windowBridges` to find which bridge owns the target thread — no separate registry needed.

### Phase 2: MCP server script

**New file: `janus-agents-mcp.js`**

Stdio-based MCP server using `@modelcontextprotocol/sdk`. Two tools:

```javascript
// Environment variables (set by cumulus-bridge in MCP config):
// JANUS_API_URL=http://localhost:9223
// JANUS_AGENT_NAME=<this agent's thread name>

// Tool: list_agents
// GET http://localhost:9223/api/agents
// Returns: { agents: [...], self: JANUS_AGENT_NAME }

// Tool: send_to_agent
// Input: { target: string, message: string }
// POST http://localhost:9223/api/agents/:target/message
//   body: { message, sender: JANUS_AGENT_NAME }
// Returns: { delivered: true } or { delivered: false, error: "..." }
```

### Phase 3: Wire MCP config

**File: `cumulus-bridge.js`**

Update `generateMcpConfig` to accept `agentName` parameter and include the `janus-agents` MCP server:

```javascript
function generateMcpConfig(threadPath, sessionId, agentName) {
  const config = {
    mcpServers: {
      'cumulus-history': { /* existing */ },
      'janus-agents': {
        command: 'node',
        args: [path.resolve(__dirname, 'janus-agents-mcp.js')],
        env: {
          JANUS_API_URL: 'http://localhost:9223',
          JANUS_AGENT_NAME: agentName || '',
        },
      },
    },
  };
  // ...
}
```

Update `getOrCreateThread` to pass `threadName` as `agentName`.

### Phase 4: Message format

The sender's message is prefixed so the receiving Claude knows it's from another agent:

```
[From agent "janus"]:
I just added CDP connection support. The API is `connectCDP(url)`.
```

This is just a text prefix — no structured metadata for now. The receiving Claude's RLM will handle context naturally.

## Files to Create/Modify

| File | Change |
|------|--------|
| **New: `janus-agents-mcp.js`** | MCP server with `list_agents` + `send_to_agent`, HTTP client to localhost:9223 |
| **`main.js`** | Two new HTTP endpoints: `GET /api/agents`, `POST /api/agents/:name/message` |
| **`cumulus-bridge.js`** | `generateMcpConfig` accepts `agentName`, adds `janus-agents` MCP server |

## Dependencies

- `@modelcontextprotocol/sdk` — already used by cumulus, but `janus-agents-mcp.js` runs as its own process. Needs to be in Janus's `node_modules` or use the cumulus copy.

## Testing

1. Open Janus, create two cumulus tabs (threads "janus" and "puppet")
2. In "janus" tab, ask Claude to call `list_agents` — should show both threads
3. In "janus" tab, ask Claude to call `send_to_agent("puppet", "hello from janus")`
4. Verify: puppet tab's Claude gets interrupted and sees `[From agent "janus"]: hello from janus`
5. Verify: janus tab's tool call returns `{ delivered: true }` immediately
6. Test sending to non-existent agent — should return error with available agent names
7. Test `curl` directly: `curl http://localhost:9223/api/agents`
