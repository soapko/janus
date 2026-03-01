/**
 * Cumulus Bridge - Main process module.
 *
 * Dynamically imports Cumulus ESM library into Janus's CJS main process.
 * Manages threads, spawns Claude subprocesses, and streams responses via IPC.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CUMULUS_DIR = path.join(os.homedir(), '.cumulus');
const THREADS_DIR = path.join(CUMULUS_DIR, 'threads');

const RECENT_CONTEXT_COUNT = 10;
const RECENT_MSG_MAX_TOKENS = 500;
const TOTAL_CONTEXT_BUDGET = 120_000;
const RECENT_CONTEXT_BUDGET = 6_000;

const SYSTEM_PROMPT_TEMPLATE = `You have NO memory of this conversation. There are {count} prior messages (~{tokens} tokens) in the history.

CURRENT SESSION: {sessionId}
{alwaysIncludeContext}{recentContext}
{retrievedContext}
CONTEXT MANAGEMENT:
- RECENT CONVERSATION: The last few messages, always included for continuity.
- RETRIEVED CONTEXT: Automatically retrieved based on the user's current message using semantic + keyword search.
- Large content may be stored externally as [STORED:xxx] references.

FALLBACK TOOLS (use only if retrieved context is insufficient):
- search_history: Search past messages by keyword or meaning
- peek_recent: Get the last few messages
- read_messages: Read messages by index range
- retrieve_content: Get full stored content by [STORED:xxx] ID
- search_content: Search across all stored content

WORKFLOW:
1. FIRST use the RETRIEVED CONTEXT above — it was automatically selected for relevance to this query
2. Check RECENT CONVERSATION for immediate context
3. Only use tools if the retrieved context doesn't contain what you need
4. For [STORED:xxx] references, use retrieve_content to get full content

NEVER guess. Use the context provided or retrieve more if needed.
IMPORTANT: Never mention the retrieval system or tools to the user. Present information naturally.`;

/**
 * Resolve the full path to the `claude` CLI binary.
 * When launched from Finder, the PATH is minimal and won't include ~/.local/bin.
 */
function resolveClaudeCli() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'claude'; // fallback to PATH lookup
}

/**
 * Resolve the full path to `node`.
 * When launched from Finder, the PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin).
 */
function resolveNode() {
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    path.join(os.homedir(), '.nvm/versions/node', 'current', 'bin/node'),
    '/usr/bin/node',
  ];
  // Also check NVM versions directory for any installed node
  const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
  try {
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      candidates.push(path.join(nvmDir, v, 'bin/node'));
    }
  } catch {
    // No NVM installed
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node'; // fallback to PATH lookup
}

// Lazy-loaded Cumulus modules (ESM)
let cumulus = null;

async function loadCumulus() {
  if (cumulus) return cumulus;
  cumulus = await import('cumulus');
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

function getContentStorePath(threadPath) {
  return threadPath.replace(/\.jsonl$/, '.content');
}

function getSessionsPath(threadPath) {
  return threadPath.replace(/\.jsonl$/, '.sessions');
}

function truncateToTokens(content, maxTokens, estimateTokensFn) {
  const tokens = estimateTokensFn(content);
  if (tokens <= maxTokens) return content;
  const targetChars = maxTokens * 3;
  return content.slice(0, targetChars) + '... [truncated]';
}

function formatRecentContext(recentMessages, budgetTokens, estimateTokensFn) {
  if (recentMessages.length === 0 || budgetTokens <= 0) return '';

  const header = '\nRECENT CONVERSATION (last few messages):\n---\n';
  const footer = '---\n';
  const overhead = estimateTokensFn(header + footer);
  let remaining = budgetTokens - overhead;
  if (remaining <= 0) return '';

  const formatted = [];
  for (let i = recentMessages.length - 1; i >= 0 && remaining > 0; i--) {
    const msg = recentMessages[i];
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const truncated = truncateToTokens(msg.content, RECENT_MSG_MAX_TOKENS, estimateTokensFn);
    const line = `[${label}]: ${truncated}\n`;
    const lineTokens = estimateTokensFn(line);

    if (lineTokens > remaining) break;

    formatted.unshift(line);
    remaining -= lineTokens;
  }

  if (formatted.length === 0) return '';
  return header + formatted.join('') + footer;
}

function generateSystemPrompt(count, tokens, sessionId, recentMessages, retrievedContext, alwaysIncludeContext, estimateTokensFn) {
  const recentContext = formatRecentContext(recentMessages, RECENT_CONTEXT_BUDGET, estimateTokensFn);
  return SYSTEM_PROMPT_TEMPLATE
    .replace('{count}', count.toString())
    .replace('{tokens}', tokens.toString())
    .replace('{sessionId}', sessionId)
    .replace('{alwaysIncludeContext}', alwaysIncludeContext)
    .replace('{recentContext}', recentContext)
    .replace('{retrievedContext}', retrievedContext);
}

function generateMcpConfig(threadPath, sessionId, agentName) {
  // Point to the cumulus MCP server in node_modules
  const mcpServerPath = path.resolve(__dirname, 'node_modules/cumulus/dist/mcp/index.js');
  const agentsMcpPath = path.resolve(__dirname, 'janus-agents-mcp.js');
  const contentStorePath = getContentStorePath(threadPath);
  const sessionsPath = getSessionsPath(threadPath);
  const nodePath = resolveNode();

  const config = {
    mcpServers: {
      'cumulus-history': {
        command: nodePath,
        args: [mcpServerPath],
        env: {
          CUMULUS_THREAD_PATH: threadPath,
          CUMULUS_CONTENT_PATH: contentStorePath,
          CUMULUS_SESSIONS_PATH: sessionsPath,
          ...(sessionId && { CUMULUS_SESSION_ID: sessionId }),
        },
      },
      'janus-agents': {
        command: nodePath,
        args: [agentsMcpPath],
        env: {
          JANUS_API_URL: 'http://localhost:9223',
          JANUS_AGENT_NAME: agentName || '',
        },
      },
    },
  };

  const configPath = path.join(CUMULUS_DIR, `mcp-config-${Date.now()}.json`);
  ensureDirectories();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function cleanupMcpConfig(configPath) {
  try {
    if (configPath && fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Parse a stream-json line into typed StreamSegment objects.
 * Returns an array of segments (may be empty if the line isn't relevant).
 */
function parseStreamSegments(line) {
  if (!line.trim()) return [];
  try {
    const parsed = JSON.parse(line);

    // Assistant message — may contain text, thinking, tool_use blocks
    if (parsed.type === 'assistant' && parsed.message?.content) {
      const segments = [];
      for (const block of parsed.message.content) {
        if (block.type === 'text' && block.text) {
          segments.push({ type: 'text', content: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          segments.push({ type: 'thinking', content: block.thinking });
        } else if (block.type === 'tool_use') {
          segments.push({ type: 'tool_use', tool: block.name, input: block.input || {} });
        } else if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          segments.push({ type: 'tool_result', content, isError: !!block.is_error });
        }
      }
      return segments;
    }

    // User message — contains tool_result blocks (Claude CLI stream-json format)
    if (parsed.type === 'user' && parsed.message?.content) {
      const segments = [];
      for (const block of parsed.message.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          segments.push({ type: 'tool_result', content, isError: !!block.is_error });
        }
      }
      return segments;
    }

    // Standalone tool_result event (type field)
    if (parsed.type === 'tool_result') {
      const content = typeof parsed.content === 'string'
        ? parsed.content
        : (parsed.content ? JSON.stringify(parsed.content) : '');
      return [{ type: 'tool_result', content, isError: !!parsed.is_error }];
    }

    // Standalone tool_result event (output field, no type)
    if (parsed.output !== undefined) {
      return [{ type: 'tool_result', content: String(parsed.output), isError: false }];
    }

    // System event
    if (parsed.type === 'system') {
      const content = parsed.subtype
        ? `${parsed.subtype}: ${parsed.message || ''}`
        : (parsed.message || JSON.stringify(parsed));
      return [{ type: 'system', content }];
    }

    // Result / completion event
    if (parsed.type === 'result') {
      return [{ type: 'result', duration_ms: parsed.duration_ms, usage: parsed.usage }];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Extract text content from a stream-json line.
 */
function extractTextFromStreamLine(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed.type === 'assistant' && parsed.message?.content) {
      const texts = [];
      for (const block of parsed.message.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        }
      }
      return texts.length > 0 ? texts.join('\n\n') : null;
    }
    return null;
  } catch {
    return null;
  }
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
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.threads = new Map(); // threadName -> { history, content, session, mcpConfigPath }
    this.activeProcesses = new Map(); // threadName -> ChildProcess
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
    const threadPath = getThreadPath(threadName);
    const contentStorePath = getContentStorePath(threadPath);
    const sessionsPath = getSessionsPath(threadPath);

    const history = new lib.HistoryStore(threadPath);
    const content = new lib.ContentStore(contentStorePath);
    const session = new lib.SessionManager(sessionsPath, threadName);
    await session.initialize();

    const mcpConfigPath = generateMcpConfig(threadPath, session.getSessionId(), threadName);

    const thread = { history, content, session, mcpConfigPath, threadPath };
    this.threads.set(threadName, thread);
    return thread;
  }

  async sendMessage(threadName, messageText, win, attachments = []) {
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
    const recentMessages = await thread.history.getRecent(RECENT_CONTEXT_COUNT);
    const recentConversation = recentMessages
      .filter(m => m.role !== 'session')
      .map(m => ({ role: m.role, content: m.content }));

    // Load always-include files
    const globalConfig = await lib.loadGlobalConfig();
    const threadConfig = await lib.loadThreadConfig(threadName);
    const mergedConfig = lib.mergeConfigs(globalConfig, threadConfig);
    const alwaysInclude = await lib.readAlwaysIncludeFiles(mergedConfig, this.projectPath || process.cwd());

    // Calculate RAG budget
    const userQueryTokens = lib.estimateTokens(messageText);
    const ragBudget = Math.max(
      0,
      TOTAL_CONTEXT_BUDGET - userQueryTokens - alwaysInclude.totalTokens - RECENT_CONTEXT_BUDGET
    );

    // Run RAG retrieval
    let retrievalResult = null;
    try {
      const threadPath = getThreadPath(threadName);
      const sessionsPath = getSessionsPath(threadPath);
      retrievalResult = await lib.retrieve(messageText, thread.history, thread.content, {
        budgetTokens: ragBudget,
        currentSessionId: thread.session.getSessionId(),
        sessionsPath,
        recentMessages: recentConversation,
      });
    } catch (err) {
      console.error('[CumulusBridge] Retrieval error:', err);
    }

    const retrievedContext = retrievalResult?.context ?? '';

    // Generate system prompt
    const systemPrompt = generateSystemPrompt(
      stats.count,
      stats.totalTokens,
      thread.session.getSessionId(),
      recentConversation,
      retrievedContext,
      alwaysInclude.formattedContext,
      lib.estimateTokens
    );

    // Create stream processor for content externalization
    const streamProcessor = new lib.StreamProcessor({
      budget,
      contentStore: thread.content,
    });

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

    // Filter out Claude env vars
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('CLAUDE') && key !== 'CLAUDECODE'
      )
    );

    const claudePath = resolveClaudeCli();
    const cwd = this.projectPath || os.homedir();
    const claude = spawn(claudePath, args, {
      stdio: [hasImages ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd,
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

    const processLine = async (line) => {
      if (!line.trim()) return;

      let processed;
      try {
        processed = await streamProcessor.processLine(line);
      } catch {
        processed = { line, modified: false, eventType: 'unknown' };
      }

      // Existing text-only flow (backward compat)
      const text = extractTextFromStreamLine(processed.line);
      if (text) {
        if (fullResponse && !fullResponse.endsWith('\n')) {
          fullResponse += '\n\n';
          win.webContents.send('cumulus:stream-chunk', { threadName, text: '\n\n' });
        }
        fullResponse += text;
        win.webContents.send('cumulus:stream-chunk', { threadName, text });
      }

      // Structured segments for verbose display
      const segments = parseStreamSegments(processed.line);
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
      // verbose debug output from --verbose and should be ignored.  Previous
      // patterns like /^Error:/m were too aggressive and matched non-fatal
      // MCP warnings, causing the UI to clear the stream buffer mid-response.
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
   * Inject an inter-agent message into a thread as an interjection.
   * Kills any active Claude process (interrupting it), then sends
   * the formatted message through the normal sendMessage flow.
   */
  async injectMessage(threadName, messageText, senderName, win) {
    // Ensure the thread exists
    await this.getOrCreateThread(threadName);

    // Kill active subprocess (interjection)
    if (this.activeProcesses.has(threadName)) {
      this.killProcess(threadName);
      // Brief delay to let process clean up
      await new Promise(r => setTimeout(r, 100));
    }

    const formatted = `[From agent "${senderName}"]:\n${messageText}\n\n(Reply using send_to_agent("${senderName}", your_response) to respond directly. Be concise and task-focused — no pleasantries or sign-offs.)`;
    return this.sendMessage(threadName, formatted, win);
  }

  /**
   * Returns list of active agent threads with their status.
   */
  getActiveAgents() {
    const agents = [];
    for (const [threadName] of this.threads) {
      agents.push({
        name: threadName,
        status: this.activeProcesses.has(threadName) ? 'streaming' : 'idle',
      });
    }
    return agents;
  }

  destroy() {
    // Kill all running processes
    for (const [threadName, proc] of this.activeProcesses) {
      proc.kill('SIGTERM');
    }
    this.activeProcesses.clear();

    // Clean up MCP configs
    for (const [, thread] of this.threads) {
      cleanupMcpConfig(thread.mcpConfigPath);
    }
    this.threads.clear();
  }
}

module.exports = { CumulusBridge };
