/**
 * Cumulus Bridge - Main process module.
 *
 * Dynamically imports Cumulus ESM library into Janus's CJS main process.
 * Manages threads, spawns Claude subprocesses, and streams responses via IPC.
 *
 * As of cumulus v0.10.0, most pipeline helpers (prompt generation, stream parsing,
 * MCP config, binary resolution) are imported from the library. Janus retains
 * subprocess lifecycle management for pool gating, kill support, and message queuing.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CUMULUS_DIR = path.join(os.homedir(), '.cumulus');
const THREADS_DIR = path.join(CUMULUS_DIR, 'threads');

// Lazy-loaded Cumulus modules (ESM)
let cumulus = null;

async function loadCumulus() {
  if (cumulus) return cumulus;
  cumulus = await import('@luckydraw/cumulus');
  return cumulus;
}

function ensureDirectories() {
  if (!fs.existsSync(THREADS_DIR)) {
    fs.mkdirSync(THREADS_DIR, { recursive: true });
  }
}

function getThreadPath(threadName) {
  return path.join(THREADS_DIR, `${threadName}.jsonl`);
}

/**
 * Map cumulus Attachment shape (storedPath) to Janus renderer shape (path).
 */
function mapMessageForRenderer(msg) {
  if (!msg || !msg.attachments?.length) return msg;
  return {
    ...msg,
    attachments: msg.attachments.map(att => ({
      id: att.name,
      name: att.name,
      path: att.storedPath,
      type: att.type,
      mimeType: att.mimeType,
    })),
  };
}

class CumulusBridge {
  constructor(projectPath, windowId = null, pool = null, sharedMcpPort = null) {
    this.projectPath = projectPath;
    this.windowId = windowId;
    this.pool = pool;            // SubprocessPool (shared across bridges)
    this.sharedMcpPort = sharedMcpPort; // Shared cumulus-history MCP server port (null = use per-agent full server)
    this._destroyed = false;     // Safety flag for queued-then-destroyed
    this.threads = new Map(); // threadName -> { history, content, session, mcpConfigPath, threadPath, adaptive }
    this.activeProcesses = new Map(); // threadName -> ChildProcess
    this.messageQueues = new Map(); // threadName -> QueuedMessage[]
    this.debugContexts = new Map(); // threadName -> last debug context snapshot
  }

  async initialize() {
    ensureDirectories();
    await loadCumulus();
  }

  async getOrCreateThread(threadName) {
    if (this.threads.has(threadName)) {
      return this.threads.get(threadName);
    }

    const lib = await loadCumulus();

    // Use cumulus's cached thread state (history, content, session, adaptive)
    const threadState = await lib.getOrCreateThread(threadName);

    // Generate MCP config with janus-agents as extra server
    const agentsMcpPath = path.resolve(__dirname, 'janus-agents-mcp.js');
    const nodePath = lib.resolveNode();
    const mcpConfigPath = lib.generateMcpConfig(
      threadState.threadPath,
      threadState.session.getSessionId(),
      threadName,
      this.sharedMcpPort,
      {
        'janus-agents': {
          command: nodePath,
          args: [agentsMcpPath],
          env: {
            JANUS_API_URL: 'http://localhost:9223',
            JANUS_AGENT_NAME: threadName,
          },
        },
      }
    );

    const thread = { ...threadState, mcpConfigPath };
    this.threads.set(threadName, thread);
    return thread;
  }

  /**
   * Resolve the working directory for a thread.
   * Fallback chain: threadConfig.projectDir → sibling folder match → this.projectPath → homedir
   */
  async resolveThreadCwd(threadName) {
    const lib = await loadCumulus();

    // 1. Check thread config for explicit projectDir
    const globalConfig = await lib.loadGlobalConfig();
    const threadConfig = await lib.loadThreadConfig(threadName);
    const mergedConfig = lib.mergeConfigs(globalConfig, threadConfig);
    if (mergedConfig.projectDir && fs.existsSync(mergedConfig.projectDir)) {
      return mergedConfig.projectDir;
    }

    // 2. Convention: sibling folder with same name as thread
    if (this.projectPath) {
      const parentDir = path.dirname(this.projectPath);
      const siblingDir = path.join(parentDir, threadName);
      if (siblingDir !== this.projectPath && fs.existsSync(siblingDir)) {
        try {
          const stat = fs.statSync(siblingDir);
          if (stat.isDirectory()) return siblingDir;
        } catch { /* ignore */ }
      }
    }

    // 3. Window-level project path (default)
    return this.projectPath || os.homedir();
  }

  async sendMessage(threadName, messageText, win, attachments = []) {
    // Gate through subprocess pool (Layer 2 throttling)
    if (this.pool) {
      await this.pool.acquire(threadName);
      if (this._destroyed) {
        this.pool.release(threadName);
        return null;
      }
    }

    const lib = await loadCumulus();
    const thread = await this.getOrCreateThread(threadName);

    // Build image content blocks for multimodal messages
    const imageBlocks = [];
    let messageForClaude = messageText;

    if (attachments && attachments.length > 0) {
      const fileRefs = [];
      for (const att of attachments) {
        if (att.type === 'image' && att.path) {
          try {
            const data = fs.readFileSync(att.path);
            const base64 = data.toString('base64');
            const ext = path.extname(att.path).toLowerCase().replace('.', '');
            const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
            const mediaType = att.mimeType || mimeMap[ext] || 'image/png';
            imageBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            });
          } catch (err) {
            console.error('[CumulusBridge] Failed to read image:', att.path, err);
            fileRefs.push(`[Attached image (unreadable): ${att.path}]`);
          }
        } else {
          fileRefs.push(`[Attached file: ${att.path}]`);
        }
      }
      if (fileRefs.length > 0) {
        messageForClaude = messageForClaude
          ? messageForClaude + '\n\n' + fileRefs.join('\n')
          : fileRefs.join('\n');
      }
    }

    const hasImages = imageBlocks.length > 0;

    // Create fresh budget
    const budget = new lib.ContextBudget();

    // Check if user input should be externalized
    if (lib.shouldExternalizeUserInput && lib.shouldExternalizeUserInput(messageForClaude, budget)) {
      const { replacement } = await lib.externalizeUserInput(messageForClaude, thread.content);
      messageForClaude = replacement;
    } else {
      budget.consume(lib.estimateTokens(messageForClaude));
    }

    // Save user message to history (attachments get copied to persistent storage by cumulus)
    let userMessage = await thread.history.append({
      role: 'user',
      content: messageText,
      metadata: {
        sessionId: thread.session.getSessionId(),
      },
      attachments: attachments.length > 0 ? attachments.map(att => ({
        name: att.name,
        type: att.type,
        mimeType: att.mimeType,
        storedPath: att.path, // Janus uses `path`, cumulus expects `storedPath`
      })) : undefined,
    });

    // Resolve relative storedPaths to absolute (append() returns relative,
    // resolveAttachmentPaths only runs on getAll/getRecent)
    if (userMessage.attachments?.length) {
      const threadDir = path.dirname(thread.threadPath);
      userMessage = {
        ...userMessage,
        attachments: userMessage.attachments.map(att => ({
          ...att,
          storedPath: path.isAbsolute(att.storedPath) ? att.storedPath : path.join(threadDir, att.storedPath),
        })),
      };
    }

    // Send user message back to renderer (map storedPath -> path for frontend)
    win.webContents.send('cumulus:message', {
      threadName,
      message: mapMessageForRenderer(userMessage),
    });

    // Get stats
    const stats = await thread.history.getStats();

    // Get recent messages
    const recentMessages = await thread.history.getRecent(lib.RECENT_CONTEXT_COUNT);
    const recentConversation = recentMessages
      .filter(m => m.role !== 'session')
      .map(m => ({ role: m.role, content: m.content }));

    // Resolve per-thread working directory
    const threadCwd = await this.resolveThreadCwd(threadName);

    // Load always-include files (use thread cwd for relative path resolution)
    const globalConfig = await lib.loadGlobalConfig();
    const threadConfig = await lib.loadThreadConfig(threadName);
    const mergedConfig = lib.mergeConfigs(globalConfig, threadConfig);
    const alwaysInclude = await lib.readAlwaysIncludeFiles(mergedConfig, threadCwd);

    // Calculate RAG budget using adaptive limit, with optional preset override
    const adaptiveBudget = thread.adaptive.getTotalContextBudget();
    const userQueryTokens = lib.estimateTokens(messageText);
    const overhead = userQueryTokens + alwaysInclude.totalTokens + lib.RECENT_CONTEXT_BUDGET;
    const effectiveBudget = lib.resolveRagBudget
      ? lib.resolveRagBudget(mergedConfig, adaptiveBudget, overhead)
      : adaptiveBudget;
    const ragBudget = Math.max(
      0,
      effectiveBudget - userQueryTokens - alwaysInclude.totalTokens - lib.RECENT_CONTEXT_BUDGET
    );

    // Run RAG retrieval
    let retrievalResult = null;
    try {
      const threadPath = getThreadPath(threadName);
      const sessionsPath = threadPath.replace(/\.jsonl$/, '.sessions');
      const allMessages = await thread.history.getAll();
      const totalMessages = allMessages.length;
      retrievalResult = await lib.retrieve(messageText, thread.history, thread.content, {
        budgetTokens: ragBudget,
        currentSessionId: thread.session.getSessionId(),
        sessionsPath,
        recentMessages: recentConversation,
        totalMessages,
      });
    } catch (err) {
      console.error('[CumulusBridge] Retrieval error:', err);
    }

    const retrievedContext = retrievalResult?.context ?? '';

    // Capture debug context snapshot for the Context Inspector
    this.debugContexts.set(threadName, {
      timestamp: Date.now(),
      threadName,
      sessionId: thread.session.getSessionId(),
      messageCount: stats.count,
      tokenCount: stats.totalTokens,
      userMessage: messageText,
      budget: {
        total: adaptiveBudget,
        userQuery: userQueryTokens,
        alwaysInclude: alwaysInclude.totalTokens,
        recentContext: lib.RECENT_CONTEXT_BUDGET,
        ragAvailable: ragBudget,
        ragUsed: retrievalResult?.tokensUsed ?? 0,
      },
      retrieval: retrievalResult ? {
        historyCount: retrievalResult.historyCount ?? 0,
        contentCount: retrievalResult.contentCount ?? 0,
        tokensUsed: retrievalResult.tokensUsed ?? 0,
        avgRelevance: lib.computeAvgRelevance(retrievalResult.debug),
        queryType: retrievalResult.debug?.queryType ?? 'unknown',
      } : null,
      alwaysInclude: {
        files: alwaysInclude.files?.map(f => ({
          path: f.path || f.resolvedPath,
          tokens: f.tokens || 0,
          truncated: !!f.truncated,
          error: f.error || null,
        })) || [],
        totalTokens: alwaysInclude.totalTokens,
      },
      recentMessageCount: recentMessages.length,
      systemPromptLength: 0, // updated after generateSystemPrompt
    });

    // Generate system prompt (using cumulus lib helpers)
    const systemPrompt = lib.generateSystemPrompt(
      stats.count,
      stats.totalTokens,
      thread.session.getSessionId(),
      recentConversation,
      retrievedContext,
      alwaysInclude.formattedContext
    );

    // Update debug context with system prompt token estimate + breakdown
    const debugCtx = this.debugContexts.get(threadName);
    if (debugCtx) {
      const systemPromptTokens = lib.estimateTokens(systemPrompt);
      const ragTokens = retrievalResult ? lib.estimateTokens(retrievedContext) : 0;
      const recentContext = lib.formatRecentContext(recentConversation, lib.RECENT_CONTEXT_BUDGET);
      const recentContextTokens = lib.estimateTokens(recentContext);
      const alwaysIncludeTokens = alwaysInclude.totalTokens;
      const instructionTokens = systemPromptTokens - ragTokens - alwaysIncludeTokens - recentContextTokens;

      debugCtx.systemPromptLength = systemPromptTokens;
      debugCtx.systemPromptBreakdown = {
        instructionTokens,
        alwaysIncludeTokens,
        recentContextTokens,
        ragTokens,
        totalTokens: systemPromptTokens,
      };
    }

    // Create stream processor for content externalization
    const streamProcessor = new lib.StreamProcessor({
      budget,
      contentStore: thread.content,
    });

    // Prepend system reminder for file reading tools
    messageForClaude = lib.FILE_READ_REMINDER + messageForClaude;

    // Spawn Claude
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', thread.mcpConfigPath,
      '--append-system-prompt', systemPrompt,
    ];

    if (hasImages) {
      // Multimodal: pipe content blocks via stdin
      args.push('--input-format', 'stream-json');
    } else {
      // Text-only: pass as positional argument
      args.push(messageForClaude);
    }

    // Filter out Claude env vars and inject window ID
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('CLAUDE') && key !== 'CLAUDECODE'
      )
    );
    if (this.windowId != null) {
      cleanEnv.JANUS_WINDOW_ID = String(this.windowId);
    }

    const claudePath = lib.resolveClaudeCli();
    const claude = spawn(claudePath, args, {
      stdio: [hasImages ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd: threadCwd,
    });

    // For multimodal messages, write content blocks to stdin
    if (hasImages && claude.stdin) {
      const contentBlocks = [
        ...imageBlocks,
        { type: 'text', text: messageForClaude || '' },
      ];
      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: contentBlocks },
      });
      claude.stdin.write(payload + '\n');
      claude.stdin.end();
    }

    this.activeProcesses.set(threadName, claude);

    let fullResponse = '';
    let buffer = '';
    const pendingLines = [];
    const collectedSegments = [];

    // TTFT measurement: time from spawn to first text chunk
    const spawnTime = Date.now();
    let ttft = null;

    const processLine = async (line) => {
      if (!line.trim()) return;

      let processed;
      try {
        processed = await streamProcessor.processLine(line);
      } catch {
        processed = { line, modified: false, eventType: 'unknown' };
      }

      // Existing text-only flow (backward compat)
      const text = lib.extractTextFromStreamLine(processed.line);
      if (text) {
        // Capture TTFT on first text output
        if (ttft === null) {
          ttft = Date.now() - spawnTime;
        }
        if (fullResponse && !fullResponse.endsWith('\n')) {
          fullResponse += '\n\n';
          win.webContents.send('cumulus:stream-chunk', { threadName, text: '\n\n' });
        }
        fullResponse += text;
        win.webContents.send('cumulus:stream-chunk', { threadName, text });
      }

      // Structured segments for verbose display
      const segments = lib.parseStreamSegments(processed.line);
      for (const seg of segments) {
        collectedSegments.push(seg);
        win.webContents.send('cumulus:stream-segment', { threadName, segment: seg });
      }
    };

    claude.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        pendingLines.push(processLine(line).catch(() => {}));
      }
    });

    claude.stderr.on('data', (data) => {
      const text = data.toString();
      // Only treat ENOENT as a fatal error — everything else from stderr is
      // verbose debug output from --verbose and should be ignored.
      if (text.includes('ENOENT')) {
        win.webContents.send('cumulus:error', { threadName, error: text });
      }
    });

    return new Promise((resolve) => {
      let completed = false;

      const handleCompletion = async () => {
        if (completed) return;
        completed = true;
        this.activeProcesses.delete(threadName);

        // Release subprocess pool slot
        if (this.pool) {
          this.pool.release(threadName);
        }

        console.log('[Bridge] handleCompletion: fullResponse length =', fullResponse.length);

        try {
          // Save assistant message to history
          if (fullResponse) {
            const assistantMessage = await thread.history.append({
              role: 'assistant',
              content: fullResponse,
              metadata: { sessionId: thread.session.getSessionId() },
            });

            console.log('[Bridge] handleCompletion: saved to history, index =', assistantMessage?.index);

            // Update session (non-critical — don't let failures lose the message)
            try {
              const messages = await thread.history.getRecent(2);
              const userMsg = messages.find(m => m.role === 'user');
              if (userMsg) {
                await thread.session.appendExchange(userMsg.content, fullResponse);
                thread.session.generateMissingEmbeddings().catch(() => {});
              }
            } catch (sessionErr) {
              console.error('[Bridge] session update failed (non-fatal):', sessionErr);
            }

            // Record adaptive turn metrics and persist
            try {
              const tokensUsed = lib.estimateTokens(fullResponse) + userQueryTokens;
              thread.adaptive.recordTurn({
                ttft: ttft ?? (Date.now() - spawnTime), // fallback if no text was streamed
                tokensUsed,
                relevanceScore: lib.computeAvgRelevance(retrievalResult?.debug),
              });
              await thread.adaptive.save();
              console.log(`[Bridge] Adaptive turn recorded: TTFT=${ttft}ms, tokens=${tokensUsed}, limit=${thread.adaptive.getContextLimit()}`);
            } catch (adaptiveErr) {
              console.error('[Bridge] adaptive budget update failed (non-fatal):', adaptiveErr);
            }

            console.log('[Bridge] handleCompletion: sending stream-end with message');
            win.webContents.send('cumulus:stream-end', {
              threadName,
              message: assistantMessage,
              fallbackText: fullResponse,
              segments: collectedSegments,
            });
          } else {
            console.log('[Bridge] handleCompletion: fullResponse is empty, sending null');
            win.webContents.send('cumulus:stream-end', {
              threadName,
              message: null,
              fallbackText: null,
              segments: collectedSegments,
            });
          }
        } catch (err) {
          console.error('[Bridge] handleCompletion error:', err);
          win.webContents.send('cumulus:stream-end', {
            threadName,
            message: null,
            fallbackText: fullResponse || null,
            segments: collectedSegments,
          });
        }

        resolve(fullResponse);

        // Drain any messages that arrived while this agent was busy
        this.drainQueue(threadName, win);
      };

      claude.on('close', async (code) => {
        if (buffer.trim()) {
          pendingLines.push(processLine(buffer).catch(() => {}));
        }
        // Wait for ALL pending processLine promises to resolve
        // before calling handleCompletion — otherwise fullResponse
        // may be empty due to the race condition.
        await Promise.all(pendingLines);
        handleCompletion();
      });

      claude.on('error', (err) => {
        this.activeProcesses.delete(threadName);

        // Release subprocess pool slot on error
        if (this.pool) {
          this.pool.release(threadName);
        }

        const errorMsg = err.message.includes('ENOENT')
          ? 'Claude CLI not found. Please install it first.'
          : err.message;
        win.webContents.send('cumulus:error', { threadName, error: errorMsg });
        resolve(null);
      });
    });
  }

  killProcess(threadName) {
    const proc = this.activeProcesses.get(threadName);
    if (proc) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(threadName);
    }
  }

  async getHistory(threadName, count = 50) {
    const thread = await this.getOrCreateThread(threadName);
    const messages = count <= 0
      ? await thread.history.getAll()
      : await thread.history.getRecent(count);
    return messages.map(mapMessageForRenderer);
  }

  async listThreads() {
    ensureDirectories();
    const files = fs.readdirSync(THREADS_DIR).filter(f => f.endsWith('.jsonl'));
    return files.map(f => f.replace(/\.jsonl$/, ''));
  }

  async listIncludeFiles(threadName) {
    const lib = await loadCumulus();
    const result = await lib.listAlwaysIncludeFiles(threadName);
    const files = [];
    for (const p of result.global) {
      files.push({ path: p, scope: 'global' });
    }
    for (const p of result.thread) {
      files.push({ path: p, scope: 'thread' });
    }
    return files;
  }

  async addIncludeFile(threadName, filePath, scope) {
    const lib = await loadCumulus();
    const threadArg = scope === 'thread' ? threadName : undefined;
    await lib.addAlwaysIncludeFile(filePath, threadArg);
  }

  async removeIncludeFile(threadName, filePath, scope) {
    const lib = await loadCumulus();
    const threadArg = scope === 'thread' ? threadName : undefined;
    await lib.removeAlwaysIncludeFile(filePath, threadArg);
  }

  async getTurns(threadName) {
    const thread = await this.getOrCreateThread(threadName);
    const messages = await thread.history.getAll();
    const turns = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const assistant = messages[i + 1];
      turns.push({
        id: msg.id,
        userMessage: msg.content,
        assistantMessage: assistant?.role === 'assistant' ? assistant.content : undefined,
        timestamp: msg.timestamp,
        hasSnapshot: !!(msg.metadata?.gitSnapshot),
      });
    }
    // Most recent first
    return turns.reverse();
  }

  async revert(threadName, messageId, restoreGit) {
    const lib = await loadCumulus();
    const thread = await this.getOrCreateThread(threadName);
    try {
      const result = await lib.executeRevert(thread.history, messageId, { restoreGit });
      return {
        success: result.success,
        removedCount: result.removedCount,
        error: result.error || null,
      };
    } catch (err) {
      return {
        success: false,
        removedCount: 0,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Format a single message into prefixed text with reply hint.
   */
  formatMessage(messageText, senderName, { type = 'direct', targets = null } = {}) {
    const targetLabel = targets && targets.length > 0 ? targets.join(', ') : '';

    let prefix, replyHint;
    if (type === 'broadcast') {
      prefix = `[${senderName} → all]:`;
      replyHint = `(Reply using send_to_agent("${senderName}", your_response) to respond directly, or broadcast(your_message) to reply to the group. Be concise and task-focused — no pleasantries or sign-offs.)`;
    } else if (type === 'cc') {
      prefix = `[${senderName} → ${targetLabel} (CC'd)]:`;
      replyHint = `(You are CC'd on this message. Only respond if relevant to you. Use send_to_agent to reply. Be concise and task-focused — no pleasantries or sign-offs.)`;
    } else {
      prefix = `[${senderName} → ${targetLabel}]:`;
      replyHint = `(Reply using send_to_agent("${senderName}", your_response) to respond directly. Be concise and task-focused — no pleasantries or sign-offs.)`;
    }

    return `${prefix}\n${messageText}\n\n${replyHint}`;
  }

  /**
   * Inject an inter-agent message into a thread.
   * If the agent is idle, delivers immediately (interjection).
   * If the agent is busy (streaming), queues the message for batch
   * delivery when the current turn finishes.
   */
  async injectMessage(threadName, messageText, senderName, win, { type = 'direct', targets = null } = {}) {
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
        type: type,
        targets: targets || [threadName],
        timestamp: Date.now(),
      });
      console.log(`[Bridge] Message queued for busy agent "${threadName}" (position ${queue.length})`);
      return { status: 'queued', position: queue.length };
    }

    // IDLE — deliver immediately (existing interjection behavior)
    const formatted = this.formatMessage(messageText, senderName, { type, targets });
    this.sendMessage(threadName, formatted, win);
    return { status: 'delivered' };
  }

  /**
   * Drain queued messages for a thread after its subprocess exits.
   * Multiple messages are batched into a single delivery.
   */
  drainQueue(threadName, win) {
    const queue = this.messageQueues.get(threadName);
    if (!queue || queue.length === 0) return;

    // Clear queue before sending (prevents re-entrance)
    this.messageQueues.delete(threadName);

    console.log(`[Bridge] Draining ${queue.length} queued message(s) for "${threadName}"`);

    if (queue.length === 1) {
      // Single message — deliver normally
      const msg = queue[0];
      const formatted = this.formatMessage(msg.text, msg.sender, {
        type: msg.type,
        targets: msg.targets,
      });
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

  /**
   * Returns list of active agent threads with their status and queue depth.
   */
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

  /**
   * Returns the last debug context snapshot for a thread plus the adaptive budget state.
   */
  async getDebugState(threadName) {
    const debugContext = this.debugContexts.get(threadName) || null;

    // Load adaptive state from sidecar file
    let adaptiveState = null;
    try {
      const lib = await loadCumulus();
      const threadPath = getThreadPath(threadName);
      const adaptive = await lib.loadAdaptiveState(threadPath);
      adaptiveState = adaptive.getState();
    } catch {
      // No adaptive state yet for this thread — that's normal
    }

    return { debugContext, adaptiveState };
  }

  destroy() {
    this._destroyed = true;

    // Kill all running processes
    for (const [threadName, proc] of this.activeProcesses) {
      proc.kill('SIGTERM');
    }
    this.activeProcesses.clear();

    // Clean up MCP configs
    for (const [, thread] of this.threads) {
      try {
        if (thread.mcpConfigPath && fs.existsSync(thread.mcpConfigPath)) {
          fs.unlinkSync(thread.mcpConfigPath);
        }
      } catch { /* ignore */ }
    }
    this.threads.clear();
  }
}

module.exports = { CumulusBridge };
