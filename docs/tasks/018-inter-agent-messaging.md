# Task 018: Inter-Agent Messaging

## Overview

Turn each Janus cumulus chat tab into an addressable agent that can send messages directly to other agents. Janus becomes an agent orchestration platform where Claude instances collaborate via interjection-based messaging, brokered by the main process.

## Design Decisions

- **MCP tool approach**: Each Claude instance gets tools like `send_to_agent(target, message)` via a `janus-agents` MCP server. Claude discovers and uses them naturally.
- **Non-blocking interjection**: Messages are injected as interjections, not blocking request-response. Agent A fires a message and continues; Agent B gets interrupted (if mid-stream) and incorporates the message.
- **No context window concern**: Cumulus uses RLM, so inter-agent messages don't degrade agent performance. Rich payloads (code, diffs, traces) are encouraged over terse summaries.
- **Cooldown with exponential backoff**: Prevents infinite loops between chatty agent pairs.
- **Agents name their own tabs**: Each agent can call `set_tab_name(name)` to label itself (e.g., "puppet-agent", "janus-dev").
- **Multi-project support**: Different agents can have different working directories, enabling cross-project collaboration in one Janus instance.
- **Broadcast support**: An agent can announce to all other agents simultaneously.
- **Agent self-identification**: Inter-agent messages are prefixed with `[agent-name]` so the receiving agent knows it's from another agent, not the human user. Format: `[janus-dev]: message content here`.
- **Let receiver decide on replies**: When Agent B receives a message from Agent A, B decides whether/how to respond via its own `send_to_agent` call. No auto-reply mechanism — avoids loops and gives agents agency.
- **Agent spawning**: Agents can spin up other agents they need via `spawn_agent` tool, so the user doesn't have to pre-create all required agents. Agents discover peers via `list_agents` and spawn missing ones on demand.
- **Discovery over static config**: Agent list is NOT baked into system prompts. Agents use `list_agents` to discover peers dynamically.
- **Message metadata**: Inter-agent messages carry metadata `{ type: 'inter-agent', sender: 'agent-name' }` for filtering/search in history.
- **Agent status tracking**: Registry tracks `idle` / `streaming` / `rate_limited` status based on active processes.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Janus Main Process              │
│                                                  │
│  ┌──────────────┐    ┌────────────────────────┐  │
│  │ Agent        │    │ Rate Limiter            │  │
│  │ Registry     │    │                         │  │
│  │              │    │ Per-pair cooldown:       │  │
│  │ name → {     │    │  1st msg: instant       │  │
│  │   threadName │    │  2nd <5s: 2s delay      │  │
│  │   tabId      │    │  3rd <5s: 4s delay      │  │
│  │   projectPath│    │  4th <5s: 8s delay      │  │
│  │   status     │    │  Reset after 30s quiet  │  │
│  │   lastActive │    │  Hard cap: 10/min/pair  │  │
│  │ }            │    └────────────────────────┘  │
│  └──────────────┘                                │
│                                                  │
│  ┌──────────────────────────────────────┐        │
│  │ HTTP API (port 9223)                 │        │
│  │  GET  /api/agents                    │        │
│  │  POST /api/agents/:name/messages     │        │
│  │  POST /api/agents/broadcast          │        │
│  │  PUT  /api/agents/:name              │        │
│  └──────────────────────────────────────┘        │
│                                                  │
│  ┌──────────────────────────────────────┐        │
│  │ CumulusBridge                        │        │
│  │  injectMessage(threadName, msg, sender)│      │
│  │  → kill active process (interjection) │       │
│  │  → append to history                  │       │
│  │  → notify renderer                    │       │
│  │  → spawn new Claude subprocess        │       │
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
│ broadcast     │          │ broadcast      │
│ set_tab_name  │          │ set_tab_name   │
└───────────────┘          └────────────────┘
         ▲                           ▲
         │ stdio                     │ stdio
         │                           │
┌────────┴──────┐          ┌─────────┴──────┐
│ Claude CLI    │          │ Claude CLI     │
│ (subprocess)  │          │ (subprocess)   │
└───────────────┘          └────────────────┘
```

## MCP Tools

### `send_to_agent`
```
Input:  { target: string, message: string }
Output: { delivered: true, target: "puppet-dev" }
       | { delivered: false, error: "Agent not found", available: ["janus-dev", "abra-dev"] }
       | { delivered: false, error: "Rate limited", retry_after_ms: 4000 }
```

Non-blocking. Returns immediately after message is queued for delivery. The target agent receives the message as an interjection with sender metadata:

```
[From agent "janus-dev"]:
I just added CDP connection support to puppet. The API is `connectCDP(url)`.
You can use it in the browser factory.
```

### `list_agents`
```
Input:  {}
Output: {
  agents: [
    { name: "janus-dev", status: "idle", project: "/Users/karl/Documents/_Projects/janus" },
    { name: "puppet-dev", status: "streaming", project: "/Users/karl/Documents/_Projects/puppet" }
  ],
  self: "janus-dev"
}
```

### `broadcast`
```
Input:  { message: string }
Output: { delivered_to: ["puppet-dev", "abra-dev"], failed: [] }
```

Sends to all agents except self. Each delivery is independently rate-limited.

### `set_tab_name`
```
Input:  { name: string }
Output: { success: true, previous_name: "Chat", new_name: "puppet-dev" }
```

Updates the tab label in the UI and the agent's name in the registry. Other agents will see this name in `list_agents` and can target it with `send_to_agent`.

## Implementation Phases

### Phase 1: Agent Registry + HTTP Endpoints

**File: `main.js`**

Add agent registry and HTTP endpoints to the existing HTTP API server:

```javascript
// Agent registry: agentName -> { threadName, tabId, projectPath, status }
const agentRegistry = new Map();

// Register agent when cumulus tab is created
function registerAgent(threadName, tabId, projectPath) {
  const name = threadName; // default name = thread name
  agentRegistry.set(name, { threadName, tabId, projectPath, status: 'idle' });
  return name;
}

// HTTP endpoints (add to existing startHttpApi)
// GET  /api/agents         → list all agents
// POST /api/agents/:name/messages → send message to agent
// POST /api/agents/broadcast      → broadcast to all agents
// PUT  /api/agents/:name          → update agent (rename, set project)
```

### Phase 2: Rate Limiter

**File: `main.js` (or new `rate-limiter.js`)**

Per-pair cooldown with exponential backoff:

```javascript
class AgentRateLimiter {
  // Key: "sender->target" pair
  // Value: { count, lastMessageTime, backoffLevel }

  canSend(sender, target) → { allowed, retryAfterMs }
  recordSend(sender, target)

  // Rules:
  // - 1st message: instant
  // - 2nd within 5s: 2s delay
  // - 3rd within 5s: 4s delay (doubles each time)
  // - Max backoff: 30s
  // - Hard cap: 10 messages per minute per pair
  // - Reset backoff after 30s of silence between pair
  // - Broadcast counts as separate pair for each recipient
}
```

### Phase 3: Message Injection in CumulusBridge

**File: `cumulus-bridge.js`**

New method `injectMessage` for inter-agent communication:

```javascript
async injectMessage(threadName, messageText, senderName, win) {
  const thread = this.threads.get(threadName);
  if (!thread) throw new Error('Thread not found');

  // Format message with sender attribution
  const formattedMessage = `[From agent "${senderName}"]:\n${messageText}`;

  // If there's an active Claude process, kill it (interjection)
  if (this.activeProcesses.has(threadName)) {
    await this.killProcess(threadName);
    // Small delay to let the process clean up
    await new Promise(r => setTimeout(r, 100));
  }

  // Send as a regular message (reuses full sendMessage flow:
  // persist, build context, spawn Claude, stream response)
  return this.sendMessage(threadName, formattedMessage, win);
}
```

### Phase 4: `janus-agents` MCP Server

**New file: `janus-agents-mcp.js`**

A stdio-based MCP server that Claude spawns. Communicates with Janus main process via HTTP (localhost:9223).

```javascript
// Environment variables (set by cumulus-bridge):
// JANUS_API_URL=http://localhost:9223
// JANUS_AGENT_NAME=<this agent's name>

// MCP tool implementations:
// send_to_agent → POST /api/agents/:target/messages { message, sender }
// list_agents   → GET /api/agents
// broadcast     → POST /api/agents/broadcast { message, sender }
// set_tab_name  → PUT /api/agents/:self { name }
```

### Phase 5: Wire MCP Server into Config

**File: `cumulus-bridge.js`**

Update `generateMcpConfig` to include the `janus-agents` MCP server alongside `cumulus-history`:

```javascript
function generateMcpConfig(threadPath, sessionId, agentName) {
  const mcpServerPath = path.resolve(__dirname, 'node_modules/cumulus/dist/mcp/index.js');
  const agentsMcpPath = path.resolve(__dirname, 'janus-agents-mcp.js');

  const config = {
    mcpServers: {
      'cumulus-history': {
        command: 'node',
        args: [mcpServerPath],
        env: { /* existing env vars */ },
      },
      'janus-agents': {
        command: 'node',
        args: [agentsMcpPath],
        env: {
          JANUS_API_URL: 'http://localhost:9223',
          JANUS_AGENT_NAME: agentName,
        },
      },
    },
  };
  // ...
}
```

### Phase 6: Multi-Project Support

**File: `renderer.js`**

When creating a cumulus tab, allow specifying a custom project path:

- Default: inherit from Janus's project path (current behavior)
- New: `createCumulusTab(threadName, projectPath)` accepts optional project path
- The `[+]` type picker can include a "project folder" selector for cumulus tabs
- Agent registry stores per-agent project path
- `CumulusBridge.sendMessage` uses the agent's project path as CWD

### Phase 7: Tab Naming UI

**File: `renderer.js`**

- When `set_tab_name` is called via HTTP API, send IPC to renderer to update tab label
- Tab label update: `tab.label = newName; tab.tabEl.querySelector('.tab-label').textContent = newName`
- Visual indicator in tab bar showing it's an "agent" (e.g., the dot color changes based on agent status)

## Message Format

Inter-agent messages appear in the receiving agent's chat as user messages with sender attribution and a distinct visual style.

Rich messages encouraged — code snippets, diffs, error traces, file paths are all fine since RLM handles the context efficiently.

## Visual Design: Agent Message Bubbles

### Three Message Styles

The chat panel has three distinct bubble types:

```
User message (right-aligned, blue bubble):
                                    ┌──────────────────┐
                                    │ Set up CDP for   │
                                    │ all 3 projects   │
                                    └──────────────────┘

Assistant response (left-aligned, no background):
I'll coordinate with the other agents to set this up...

Agent message (left-aligned, 3px colored left border + name badge):
┌─────────────────────────────────────────────────┐
│ ● puppet-dev                            12:34  │
│─────────────────────────────────────────────────│
│ I just added CDP connection support.            │
│ The API is `connectCDP(url)`.                   │
│                                                 │
│ ```typescript                                   │
│ async connectCDP(url: string): Browser          │
│ ```                                             │
└─────────────────────────────────────────────────┘

Another agent (different color):
┌─────────────────────────────────────────────────┐
│ ● abra-dev                              12:35  │
│─────────────────────────────────────────────────│
│ Done. Abra now supports `--janus-auth`          │
│ flag for persona schema.                        │
└─────────────────────────────────────────────────┘
```

### Agent Color Palette

Each agent gets a deterministic color via `hash(name) % palette.length`. Six visually distinct colors:

| Index | Name   | Border/Dot | Tinted Background | Name Text  |
|-------|--------|------------|-------------------|------------|
| 0     | Purple | `#9966cc`  | `#2a2535`         | `#b08adb`  |
| 1     | Teal   | `#2aa198`  | `#1e2e2d`         | `#5ac4bc`  |
| 2     | Orange | `#e69500`  | `#2e2618`         | `#f0ad4e`  |
| 3     | Rose   | `#d33682`  | `#2e1e28`         | `#e05a9e`  |
| 4     | Lime   | `#85c025`  | `#222e18`         | `#a0d44a`  |
| 5     | Coral  | `#ff6b6b`  | `#2e1e1e`         | `#ff8a8a`  |

### Bubble Anatomy

```
┌─ 3px colored left border (agent's color)
│  ┌───────────────────────────────────────────┐
│  │ ● agent-name                      12:34  │  ← dot + name in agent color, timestamp
│  │───────────────────────────────────────────│  ← 1px separator in agent color at 20% opacity
│  │                                           │
│  │  Message content with full markdown       │  ← MarkdownRenderer (same as assistant)
│  │  support, code blocks, tables, etc.       │
│  │                                           │
│  └───────────────────────────────────────────┘
     ↑ tinted background from agent's palette row
```

### Color Assignment Function

```typescript
const AGENT_COLORS = [
  { name: 'purple', border: '#9966cc', bg: '#2a2535', text: '#b08adb' },
  { name: 'teal',   border: '#2aa198', bg: '#1e2e2d', text: '#5ac4bc' },
  { name: 'orange', border: '#e69500', bg: '#2e2618', text: '#f0ad4e' },
  { name: 'rose',   border: '#d33682', bg: '#2e1e28', text: '#e05a9e' },
  { name: 'lime',   border: '#85c025', bg: '#222e18', text: '#a0d44a' },
  { name: 'coral',  border: '#ff6b6b', bg: '#2e1e1e', text: '#ff8a8a' },
];

function getAgentColor(agentName: string) {
  let hash = 0;
  for (const ch of agentName) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}
```

### Data Flow

1. Bridge receives `[From agent "puppet-dev"]:` prefix in interjected message
2. Bridge strips prefix, sets `metadata: { type: 'inter-agent', sender: 'puppet-dev' }` on the Message
3. Renderer receives the Message with structured metadata
4. `MessageBubble` detects `metadata.type === 'inter-agent'`, renders the agent bubble variant
5. `getAgentColor(metadata.sender)` determines the color scheme
6. CSS custom properties (`--agent-border`, `--agent-bg`, `--agent-text`) drive the styling

### CSS Implementation

```css
/* Agent message bubble — left-aligned with colored border + badge */
.message-bubble--agent {
  align-items: flex-start;
}

.message-bubble--agent .message-bubble__content {
  background: var(--agent-bg, #2a2535);
  border-left: 3px solid var(--agent-border, #9966cc);
  border-radius: 0.25em 0.55em 0.55em 0.25em;
  padding: 0;
  max-width: 100%;
  width: 100%;
  overflow: hidden;
}

.message-bubble__agent-header {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.4em 0.85em;
  border-bottom: 1px solid rgba(var(--agent-border-rgb), 0.2);
}

.message-bubble__agent-dot {
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: var(--agent-border);
  flex-shrink: 0;
}

.message-bubble__agent-name {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--agent-text);
}

.message-bubble__agent-body {
  padding: 0.5em 0.85em;
}
```

## Rate Limiting Example

```
janus-dev → puppet-dev: "Implement CDP"        ← instant
puppet-dev → janus-dev: "Done, API is..."      ← instant (different pair direction)
janus-dev → puppet-dev: "Add tests too"        ← 2s delay (2nd in 5s window)
janus-dev → puppet-dev: "Also error handling"  ← 4s delay (3rd)
janus-dev → puppet-dev: "And docs"             ← 8s delay (4th)

[30s silence]                                   ← backoff resets

janus-dev → puppet-dev: "One more thing..."    ← instant (reset)
```

## Files to Create/Modify

| File | Change |
|------|--------|
| **New: `janus-agents-mcp.js`** | MCP server with 4 tools, HTTP client to localhost:9223 |
| **`main.js`** | Agent registry, HTTP endpoints for `/api/agents/*`, tab rename IPC |
| **`cumulus-bridge.js`** | `injectMessage()` method, `generateMcpConfig` gets agent name param, strip `[From agent "..."]` prefix and set structured metadata |
| **`preload.js`** | IPC for tab rename |
| **`renderer.js`** | Tab rename handler, optional project path in `createCumulusTab`, agent color on tab dot |
| **`src/cumulus/types.ts`** | Agent color palette + `getAgentColor()` hash function |
| **`src/cumulus/MessageBubble.tsx`** | New `message-bubble--agent` variant with colored border, agent name badge, and dot. Uses CSS custom properties driven by `getAgentColor()` |
| **`src/cumulus/chat.css`** | Agent bubble styles: colored left border, header with dot + name, tinted background, separator |

## Testing

- Create two cumulus tabs, use `set_tab_name` to name them
- Agent A sends message to Agent B via `send_to_agent`
- Verify B receives message as interjection, responds naturally
- Verify A's tool call returns immediately (non-blocking)
- Send rapid messages to trigger rate limiting
- Verify backoff delays and hard cap
- Test broadcast to multiple agents
- Test `list_agents` shows correct statuses
- Test agent with different project path (CWD verification)
- Test interjection during active streaming

## Open Questions

1. **Agent status tracking**: Should we track `idle` vs `streaming` vs `waiting_for_rate_limit`? The registry could update status based on active processes.
2. **Response routing**: When Agent B responds to Agent A's message, should B automatically send its response back to A? Or should B decide via its own tool call? (Recommendation: let B decide — it's more natural and avoids auto-reply loops.)
3. **System prompt context**: Should each agent's system prompt include a list of available agents? Or let them discover via `list_agents`? (Recommendation: include agent list in system prompt so Claude knows teammates from the start.)
4. **Message persistence**: Inter-agent messages are stored in the receiving agent's history as user messages. Should they have special metadata (`{ type: 'inter-agent', sender: 'janus-dev' }`) for filtering/search?
