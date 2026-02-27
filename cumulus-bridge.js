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

function generateMcpConfig(threadPath, sessionId) {
  // Point to the cumulus MCP server in node_modules
  const mcpServerPath = path.resolve(__dirname, 'node_modules/cumulus/dist/mcp/index.js');
  const contentStorePath = getContentStorePath(threadPath);
  const sessionsPath = getSessionsPath(threadPath);

  const config = {
    mcpServers: {
      'cumulus-history': {
        command: 'node',
        args: [mcpServerPath],
        env: {
          CUMULUS_THREAD_PATH: threadPath,
          CUMULUS_CONTENT_PATH: contentStorePath,
          CUMULUS_SESSIONS_PATH: sessionsPath,
          ...(sessionId && { CUMULUS_SESSION_ID: sessionId }),
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

    const mcpConfigPath = generateMcpConfig(threadPath, session.getSessionId());

    const thread = { history, content, session, mcpConfigPath, threadPath };
    this.threads.set(threadName, thread);
    return thread;
  }

  async sendMessage(threadName, messageText, win) {
    const lib = await loadCumulus();
    const thread = await this.getOrCreateThread(threadName);

    // Create fresh budget
    const budget = new lib.ContextBudget();

    // Check if user input should be externalized
    let messageForClaude = messageText;
    if (lib.shouldExternalizeUserInput && lib.shouldExternalizeUserInput(messageText, budget)) {
      const { replacement } = await lib.externalizeUserInput(messageText, thread.content);
      messageForClaude = replacement;
    } else {
      budget.consume(lib.estimateTokens(messageText));
    }

    // Save user message to history
    const userMessage = await thread.history.append({
      role: 'user',
      content: messageText,
      metadata: {
        sessionId: thread.session.getSessionId(),
      },
    });

    // Send user message back to renderer
    win.webContents.send('cumulus:message', {
      threadName,
      message: userMessage,
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
      messageForClaude,
    ];

    // Filter out Claude env vars
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('CLAUDE') && key !== 'CLAUDECODE'
      )
    );

    const claudePath = resolveClaudeCli();
    const cwd = this.projectPath || os.homedir();
    const claude = spawn(claudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd,
    });

    this.activeProcesses.set(threadName, claude);

    let fullResponse = '';
    let buffer = '';
    const pendingLines = [];

    const processLine = async (line) => {
      if (!line.trim()) return;

      let processed;
      try {
        processed = await streamProcessor.processLine(line);
      } catch {
        processed = { line, modified: false, eventType: 'unknown' };
      }

      const text = extractTextFromStreamLine(processed.line);
      if (text) {
        if (fullResponse && !fullResponse.endsWith('\n')) {
          fullResponse += '\n\n';
          win.webContents.send('cumulus:stream-chunk', { threadName, text: '\n\n' });
        }
        fullResponse += text;
        win.webContents.send('cumulus:stream-chunk', { threadName, text });
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
            });
          } else {
            console.log('[Bridge] handleCompletion: fullResponse is empty, sending null');
            win.webContents.send('cumulus:stream-end', {
              threadName,
              message: null,
              fallbackText: null,
            });
          }
        } catch (err) {
          console.error('[Bridge] handleCompletion error:', err);
          win.webContents.send('cumulus:stream-end', {
            threadName,
            message: null,
            fallbackText: fullResponse || null,
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
    if (count <= 0) {
      return thread.history.getAll();
    }
    return thread.history.getRecent(count);
  }

  async listThreads() {
    ensureDirectories();
    const files = fs.readdirSync(THREADS_DIR).filter(f => f.endsWith('.jsonl'));
    return files.map(f => f.replace(/\.jsonl$/, ''));
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
