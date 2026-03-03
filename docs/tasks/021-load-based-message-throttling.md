# Task 021: Load-Based Message Throttling

## Problem

Inter-agent messaging uses `injectMessage`, which **kills the active Claude subprocess** and spawns a new one with the incoming message. When multiple agents are chatting, this creates echo loops:

1. Janus broadcasts to Alice, Bob, Charlie
2. All three respond with "Acknowledged" → each triggers `injectMessage` on janus
3. Each `injectMessage` kills janus's active process, spawns a new one
4. Janus processes each ack separately, potentially re-broadcasting
5. Loop repeats — 15+ interjections observed in the brainstorm experiment

**Root cause:** The kill is what causes loops. Every message, no matter how trivial, forces a full Claude response cycle. There's no concept of "wait your turn."

## Solution: Queue Messages to Busy Agents

A transport-level constraint — no AI gating, no content filtering, no sender-declared intent.

```
Agent A calls send_to_agent("B", msg)
  → Janus checks: is B currently streaming?
  → IDLE:  deliver immediately (interjection as today)
  → BUSY:  queue it, return { status: "queued", position: 2 }
  → When B finishes current turn → deliver all queued messages as one batch
```

### Why This Breaks Echo Loops Naturally

Trace the brainstorm failure under this model:

1. Janus broadcasts "The Long Cartography wins" → delivered to idle Alice, Bob, Charlie
2. All three start streaming responses → now BUSY
3. Alice responds "Acknowledged" → `send_to_agent("janus")` → janus is BUSY → **queued**
4. Bob responds "Acknowledged" → janus still BUSY → **queued**
5. Charlie responds "Acknowledged" → **queued**
6. Janus finishes processing → receives all 3 acks as a **single batch**
7. Janus responds once to the batch → done

Instead of 15 interjections, you get **1 delivery per agent**. The queue acts as a natural damper.

## Architecture

### Message Queue (cumulus-bridge.js)

```
CumulusBridge:
  this.messageQueues = new Map<threadName, QueuedMessage[]>

  QueuedMessage = {
    text: string,        // the formatted message
    sender: string,
    type: 'direct' | 'broadcast' | 'cc',
    targets: string[],
    timestamp: number
  }
```

### Modified `injectMessage` Flow

```javascript
async injectMessage(threadName, messageText, senderName, win, opts) {
  await this.getOrCreateThread(threadName);

  const isStreaming = this.activeProcesses.has(threadName);

  if (isStreaming) {
    // BUSY — queue it, don't kill
    if (!this.messageQueues.has(threadName)) {
      this.messageQueues.set(threadName, []);
    }
    const queue = this.messageQueues.get(threadName);
    queue.push({
      text: messageText,
      sender: senderName,
      type: opts.type || 'direct',
      targets: opts.targets || [threadName],
      timestamp: Date.now()
    });
    return { status: 'queued', position: queue.length };
  }

  // IDLE — deliver immediately (existing behavior)
  // ... format prefix/replyHint as today ...
  return this.sendMessage(threadName, formatted, win);
}
```

### Drain Queue on Subprocess Exit

The key hook: when a Claude subprocess exits (finishes its turn), check the queue and deliver any pending messages as a single batch.

In `sendMessage`, the subprocess `exit` handler already exists. Add queue drain logic there:

```javascript
claude.on('exit', () => {
  this.activeProcesses.delete(threadName);
  // ... existing exit handling ...

  // Drain message queue
  this.drainQueue(threadName, win);
});
```

### Batch Delivery Format

When draining, combine all queued messages into one:

```
[While you were busy, 3 messages arrived]

[From agent "alice"] (2:34:05 PM):
Great result!

[From agent "bob"] (2:34:06 PM):
Acknowledged.

[From agent "charlie"] (2:34:08 PM):
Agreed, good choice.

(Review the above messages. Reply only if actionable work is needed.
Use send_to_agent("name", response) to respond to a specific agent.)
```

This triggers **one** Claude subprocess, one response. The reply hint is softened — "reply only if actionable" instead of the current "reply using send_to_agent."

```javascript
drainQueue(threadName, win) {
  const queue = this.messageQueues.get(threadName);
  if (!queue || queue.length === 0) return;

  // Clear queue before sending (prevents re-entrance)
  this.messageQueues.delete(threadName);

  if (queue.length === 1) {
    // Single message — deliver normally (no batch wrapper)
    const msg = queue[0];
    const prefix = this.formatPrefix(msg);
    const replyHint = this.formatReplyHint(msg);
    const formatted = `${prefix}\n${msg.text}\n\n${replyHint}`;
    this.sendMessage(threadName, formatted, win);
    return;
  }

  // Multiple messages — batch format
  const lines = [`[While you were busy, ${queue.length} messages arrived]\n`];
  for (const msg of queue) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    lines.push(`[From agent "${msg.sender}"] (${time}):`);
    lines.push(msg.text);
    lines.push('');
  }
  lines.push('(Review the above messages. Reply only if actionable work is needed.');
  lines.push('Use send_to_agent("name", response) to respond to a specific agent.)');

  this.sendMessage(threadName, lines.join('\n'), win);
}
```

### Updated `getActiveAgents`

Expose queue depth so agents can self-regulate:

```javascript
getActiveAgents() {
  const agents = [];
  for (const [threadName] of this.threads) {
    const queue = this.messageQueues.get(threadName) || [];
    agents.push({
      name: threadName,
      status: this.activeProcesses.has(threadName) ? 'streaming' : 'idle',
      queueDepth: queue.length,
    });
  }
  return agents;
}
```

### Updated MCP Tool Responses (janus-agents-mcp.js)

`send_to_agent` returns delivery status:

```json
{ "status": "delivered", "target": "puppet" }
{ "status": "queued", "target": "puppet", "position": 3 }
```

`list_agents` includes queue depth:

```json
{
  "agents": [
    { "name": "puppet", "status": "streaming", "queueDepth": 2 },
    { "name": "abra", "status": "idle", "queueDepth": 0 }
  ]
}
```

### Updated MCP Tool Descriptions

`send_to_agent` description should mention:
- Non-blocking: returns immediately with delivery status
- If target is busy (streaming), message is queued for delivery when they finish
- Queued messages are batched — the target sees all pending messages at once
- The target decides whether to reply (no forced response)

`list_agents` description should mention:
- `status`: "idle" (ready for messages) or "streaming" (busy, messages will be queued)
- `queueDepth`: number of messages waiting for delivery

## Files to Change

| File | Change |
|------|--------|
| `cumulus-bridge.js` | Add `messageQueues` Map, modify `injectMessage` to queue when busy, add `drainQueue` method, hook drain into subprocess exit, update `getActiveAgents` to include `queueDepth` |
| `main.js` | HTTP API responses include queue status from bridge |
| `janus-agents-mcp.js` | Update tool descriptions, return `status`/`position` from `send_to_agent`, include `queueDepth` in `list_agents` |

## Edge Cases

### Agent receives message while idle, starts streaming, then more arrive
- First message: delivered immediately (idle path)
- Agent starts streaming in response
- Subsequent messages: queued (busy path)
- Agent finishes: queue drains as batch
- This is the expected happy path.

### Agent is idle with no subprocess and receives a batch
- Queue drains, `sendMessage` spawns a subprocess
- Normal flow from there.

### Queue grows very large (runaway sender)
- Natural backpressure: the sender sees `position: 50` and can decide to stop
- Optional hard cap: drop messages beyond N (e.g., 20) with an error response
- Start with no cap — the batch format itself is a deterrent (Claude sees 50 messages and naturally prioritizes)

### Multiple senders queued
- All get batched together in arrival order
- The batch format attributes each message to its sender
- Claude sees the full picture and responds holistically

### Agent exits/crashes with messages in queue
- Queue is in-memory — lost on crash (acceptable)
- No persistence needed — these are ephemeral coordination messages

## What This Does NOT Change

- Message format (prefix, sender attribution) — same as today
- HTTP API endpoints — same paths, just richer responses
- MCP tool names and required parameters — same
- Single-message to idle agent — identical behavior to today
- Thread history persistence — unchanged

## Testing

1. Open two cumulus tabs (A and B)
2. Send a message to A to start it streaming
3. While A is streaming, send 3 messages to A from B
4. Verify: messages are queued, not delivered immediately
5. When A finishes, verify: all 3 messages arrive as a single batch
6. Verify: `list_agents` shows `queueDepth` correctly
7. Verify: `send_to_agent` returns `{ status: "queued", position: N }`
8. Verify: idle agent still receives messages immediately
