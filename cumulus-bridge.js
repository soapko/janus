/**
 * Cumulus Bridge - Main process module.
 *
 * Dynamically imports Cumulus ESM library into Janus's CJS main process.
 * Manages threads, spawns Claude subprocesses, and streams responses via IPC.
 *
 * As of cumulus v0.10.1, the full message pipeline (externalize → persist →
 * RAG → prompt → spawn → stream → persist response → adaptive recording)
 * is delegated to lib.sendMessage(). Janus retains subprocess pool gating,
 * IPC streaming, kill support, and message queuing.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const CUMULUS_DIR = path.join(os.homedir(), '.cumulus');
const THREADS_DIR = path.join(CUMULUS_DIR, 'threads');
const GATEWAY_CONFIG_PATH = path.join(CUMULUS_DIR, 'gateway.json');

// Cached gateway config (reloaded on each sendMessage to pick up changes)
let _gatewayConfig = null;
let _gatewayConfigMtime = 0;

function loadGatewayConfig() {
  try {
    if (!fs.existsSync(GATEWAY_CONFIG_PATH)) {
      _gatewayConfig = { enabled: false };
      return _gatewayConfig;
    }
    const stat = fs.statSync(GATEWAY_CONFIG_PATH);
    if (stat.mtimeMs !== _gatewayConfigMtime) {
      _gatewayConfigMtime = stat.mtimeMs;
      const raw = fs.readFileSync(GATEWAY_CONFIG_PATH, 'utf-8');
      _gatewayConfig = JSON.parse(raw);
    }
    return _gatewayConfig;
  } catch (err) {
    console.error('[Bridge] Failed to load gateway config:', err.message);
    return { enabled: false };
  }
}

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
    this.threads = new Map(); // threadName -> ThreadState
    this.activeProcesses = new Map(); // threadName -> ChildProcess
    this.messageQueues = new Map(); // threadName -> QueuedMessage[]
    this.debugContexts = new Map(); // threadName -> last debug context snapshot
    this.summaryTimers = new Map(); // threadName -> setTimeout handle
    this._syncRetryTimers = new Map(); // threadName -> retry setTimeout handle
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
    const threadState = await lib.getOrCreateThread(threadName);
    this.threads.set(threadName, threadState);
    return threadState;
  }

  /**
   * Resolve the working directory for a thread.
   * Fallback chain: project.path → threadConfig.projectDir → sibling folder match → this.projectPath → homedir
   */
  async resolveThreadCwd(threadName) {
    const lib = await loadCumulus();

    // 1. Check thread config for project binding or explicit projectDir
    const globalConfig = await lib.loadGlobalConfig();
    const threadConfig = await lib.loadThreadConfig(threadName);
    const mergedConfig = lib.mergeConfigs(globalConfig, threadConfig);

    // 1a. Project binding (from "Start Project" feature)
    if (mergedConfig.project?.path && fs.existsSync(mergedConfig.project.path)) {
      return mergedConfig.project.path;
    }

    // 1b. Explicit projectDir
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

  /**
   * Get the effective mode for a thread: 'local' or 'remote'.
   * Priority: per-thread override → gateway defaultMode → 'local'.
   */
  getThreadMode(threadName) {
    const gw = loadGatewayConfig();
    if (!gw.enabled || !gw.url) return 'local';
    const threadModes = gw.threadModes || {};
    if (threadModes[threadName]) return threadModes[threadName];
    return gw.defaultMode || 'local';
  }

  /**
   * Set the mode for a specific thread. Persists to gateway.json.
   * When switching Local → Remote, syncs full local history first.
   */
  async setThreadMode(threadName, mode) {
    const currentMode = this.getThreadMode(threadName);
    const gw = loadGatewayConfig();

    // Sync full local history to gateway before switching to remote
    if (currentMode === 'local' && mode === 'remote' && gw.enabled && gw.url) {
      await this.syncFullHistory(threadName, gw);
    }

    if (!gw.threadModes) gw.threadModes = {};
    if (mode === (gw.defaultMode || 'local')) {
      delete gw.threadModes[threadName];
    } else {
      gw.threadModes[threadName] = mode;
    }
    fs.writeFileSync(GATEWAY_CONFIG_PATH, JSON.stringify(gw, null, 2));
    _gatewayConfigMtime = fs.statSync(GATEWAY_CONFIG_PATH).mtimeMs;
    _gatewayConfig = gw;
  }

  /**
   * Sync full local history for a thread to the gateway.
   * Gateway deduplicates by message ID — safe to call repeatedly.
   */
  async syncFullHistory(threadName, gw) {
    const thread = await this.getOrCreateThread(threadName);
    if (!thread.history) {
      console.warn(`[Bridge] No local history for "${threadName}" — skipping sync`);
      return { synced: 0, skipped: 0 };
    }

    const allMessages = await thread.history.getAll();
    if (allMessages.length === 0) {
      console.log(`[Bridge] No messages to sync for "${threadName}"`);
      return { synced: 0, skipped: 0 };
    }

    const messages = allMessages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
    }));

    console.log(`[Bridge] Syncing ${messages.length} messages for "${threadName}" to gateway...`);

    return new Promise((resolve, reject) => {
      const url = new URL(`/api/thread/${encodeURIComponent(threadName)}/sync`, gw.url);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const body = JSON.stringify({ messages });

      const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          ...(gw.apiKey ? { 'X-API-Key': gw.apiKey } : {}),
        },
        rejectUnauthorized: false,
      };

      const req = transport.request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const result = JSON.parse(responseBody);
              console.log(`[Bridge] Sync complete for "${threadName}": synced=${result.synced}, skipped=${result.skipped}`);
              resolve(result);
            } catch {
              resolve({ synced: messages.length, skipped: 0 });
            }
          } else {
            console.error(`[Bridge] Sync failed for "${threadName}": ${res.statusCode} ${responseBody}`);
            reject(new Error(`Sync failed: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[Bridge] Sync error for "${threadName}":`, err.message);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Route messages to local or remote based on per-thread mode.
   */
  async sendMessage(threadName, messageText, win, attachments = []) {
    const gw = loadGatewayConfig();
    const mode = this.getThreadMode(threadName);
    if (mode === 'remote' && gw.enabled && gw.url) {
      return this.sendMessageRemote(threadName, messageText, win, attachments, gw);
    }
    return this.sendMessageLocal(threadName, messageText, win, attachments);
  }

  /**
   * Send message via remote cumulus gateway (SSE stream).
   * No local subprocess, pool, history, or RAG — gateway handles everything.
   */
  async sendMessageRemote(threadName, messageText, win, attachments, gw) {
    // Register thread locally for getActiveAgents tracking
    if (!this.threads.has(threadName)) {
      this.threads.set(threadName, { name: threadName, remote: true });
    }

    // Send user message to renderer immediately
    const tempUserMsg = {
      id: `msg-${Date.now()}`,
      timestamp: Date.now(),
      role: 'user',
      content: messageText,
      attachments: attachments.length > 0 ? attachments.map(att => ({
        id: att.name, name: att.name, path: att.path, type: att.type, mimeType: att.mimeType,
      })) : undefined,
    };
    win.webContents.send('cumulus:message', { threadName, message: tempUserMsg });

    // Mark as active (for queue gating — use a sentinel instead of a real process)
    const sentinel = { kill: () => {} };
    this.activeProcesses.set(threadName, sentinel);

    try {
      const response = await this._sseRequest(gw, threadName, messageText, attachments, win);
      return response;
    } catch (err) {
      console.error('[Bridge] sendMessageRemote error:', err);
      win.webContents.send('cumulus:error', {
        threadName,
        error: err.message || String(err),
      });
      return null;
    } finally {
      this.activeProcesses.delete(threadName);
      this.drainQueue(threadName, win);
    }
  }

  /**
   * Make an SSE request to the gateway and wire events to IPC.
   */
  _sseRequest(gw, threadName, message, attachments, win) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/api/thread/${encodeURIComponent(threadName)}/message`, gw.url);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const body = JSON.stringify({
        message,
        images: attachments.filter(a => a.type === 'image').map(a => a.path),
      });

      const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(gw.apiKey ? { 'X-API-Key': gw.apiKey } : {}),
        },
        // Accept self-signed certs for local dev (thundercat)
        rejectUnauthorized: false,
      };

      const req = transport.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', chunk => errorBody += chunk);
          res.on('end', () => {
            reject(new Error(`Gateway returned ${res.statusCode}: ${errorBody}`));
          });
          return;
        }

        let responseText = null;
        let buffer = '';

        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          buffer += chunk;
          // Parse SSE frames
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          let eventType = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              try {
                const data = JSON.parse(dataStr);
                this._handleSSEEvent(eventType || 'token', data, threadName, win);
                if (eventType === 'done') {
                  responseText = data.response || '';
                  // Store gateway stats as debug context
                  this.debugContexts.set(threadName, {
                    remote: true,
                    ttft: data.ttft,
                    tokensIn: data.tokensIn,
                    tokensOut: data.tokensOut,
                    gatewayUrl: gw.url,
                  });
                }
              } catch { /* ignore malformed JSON */ }
              eventType = null;
            }
          }
        });

        res.on('end', () => {
          // Process any remaining buffer
          if (buffer.trim()) {
            const remaining = buffer.split('\n');
            let eventType = null;
            for (const line of remaining) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  this._handleSSEEvent(eventType || 'token', data, threadName, win);
                  if (eventType === 'done') {
                    responseText = data.response || '';
                    this.debugContexts.set(threadName, {
                      remote: true,
                      ttft: data.ttft,
                      tokensIn: data.tokensIn,
                      tokensOut: data.tokensOut,
                      gatewayUrl: gw.url,
                    });
                  }
                } catch { /* ignore */ }
                eventType = null;
              }
            }
          }
          resolve(responseText);
        });

        res.on('error', reject);
      });

      req.on('error', (err) => {
        // Network error — gateway unreachable
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
          reject(new Error(`Gateway at ${gw.url} is unreachable (${err.code}). Check gateway status or switch to local mode.`));
        } else {
          reject(err);
        }
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Handle a single SSE event from the gateway.
   */
  _handleSSEEvent(eventType, data, threadName, win) {
    switch (eventType) {
      case 'token':
        win.webContents.send('cumulus:stream-chunk', { threadName, text: data.text });
        break;
      case 'segment':
        win.webContents.send('cumulus:stream-segment', { threadName, segment: data });
        break;
      case 'tool':
        // Show tool usage as a segment
        win.webContents.send('cumulus:stream-segment', {
          threadName,
          segment: { type: 'tool', name: data.name, input: data.input },
        });
        break;
      case 'done':
        win.webContents.send('cumulus:stream-end', {
          threadName,
          fallbackText: data.response,
          segments: [],
        });
        break;
      case 'error':
        win.webContents.send('cumulus:error', {
          threadName,
          error: data.error || 'Unknown gateway error',
        });
        break;
    }
  }

  /**
   * Sync messages to the gateway (fire-and-forget with exponential backoff retry).
   * Used in local mode to keep gateway history in sync.
   */
  _syncToGateway(gw, threadName, messages, attempt = 0) {
    const url = new URL(`/api/thread/${encodeURIComponent(threadName)}/sync`, gw.url);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const body = JSON.stringify({ messages });

    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        ...(gw.apiKey ? { 'X-API-Key': gw.apiKey } : {}),
      },
      rejectUnauthorized: false,
    };

    const req = transport.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[Bridge] Synced ${messages.length} messages for "${threadName}" to gateway`);
        } else if (attempt < 3) {
          const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
          console.warn(`[Bridge] Sync failed (${res.statusCode}), retrying in ${delay}ms...`);
          const timer = setTimeout(() => this._syncToGateway(gw, threadName, messages, attempt + 1), delay);
          this._syncRetryTimers.set(`${threadName}-${Date.now()}`, timer);
        } else {
          console.error(`[Bridge] Sync failed after ${attempt + 1} attempts for "${threadName}": ${responseBody}`);
        }
      });
    });

    req.on('error', (err) => {
      if (attempt < 3) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[Bridge] Sync error (${err.code}), retrying in ${delay}ms...`);
        const timer = setTimeout(() => this._syncToGateway(gw, threadName, messages, attempt + 1), delay);
        this._syncRetryTimers.set(`${threadName}-${Date.now()}`, timer);
      } else {
        console.error(`[Bridge] Sync failed after ${attempt + 1} attempts for "${threadName}":`, err.message);
      }
    });

    req.write(body);
    req.end();
  }

  /**
   * Send message locally via Claude subprocess (original path).
   */
  async sendMessageLocal(threadName, messageText, win, attachments = []) {
    // Gate through subprocess pool (Layer 2 throttling)
    if (this.pool) {
      await this.pool.acquire(threadName);
      if (this._destroyed) {
        this.pool.release(threadName);
        return null;
      }
    }

    const lib = await loadCumulus();

    // Register thread in local map (for getActiveAgents, etc.)
    await this.getOrCreateThread(threadName);

    // Send user message to renderer immediately for display
    const tempUserMsg = {
      id: `msg-${Date.now()}`,
      timestamp: Date.now(),
      role: 'user',
      content: messageText,
      attachments: attachments.length > 0 ? attachments.map(att => ({
        id: att.name,
        name: att.name,
        path: att.path,
        type: att.type,
        mimeType: att.mimeType,
      })) : undefined,
    };
    win.webContents.send('cumulus:message', { threadName, message: tempUserMsg });

    // Resolve per-thread working directory
    const threadCwd = await this.resolveThreadCwd(threadName);

    // Build extra MCP servers config (janus-agents)
    const agentsMcpPath = path.resolve(__dirname, 'janus-agents-mcp.js');
    const nodePath = lib.resolveNode();

    try {
      const result = await lib.sendMessage({
        threadName,
        message: messageText,
        attachments: attachments.map(att => ({
          name: att.name,
          type: att.type,
          mimeType: att.mimeType,
          path: att.path,
        })),
        sharedMcpPort: this.sharedMcpPort,
        projectDir: threadCwd,
        extraMcpServers: {
          'janus-agents': {
            command: nodePath,
            args: [agentsMcpPath],
            env: {
              JANUS_API_URL: 'http://localhost:9223',
              JANUS_AGENT_NAME: threadName,
            },
          },
        },
        onSpawn: (proc) => this.activeProcesses.set(threadName, proc),
        onToken: (text) => {
          win.webContents.send('cumulus:stream-chunk', { threadName, text });
        },
        onSegment: (seg) => {
          win.webContents.send('cumulus:stream-segment', { threadName, segment: seg });
        },
        onError: (err) => {
          win.webContents.send('cumulus:error', { threadName, error: err });
        },
      });

      // Store debug snapshot for Context Inspector
      this.debugContexts.set(threadName, result.debug);

      // Send completion to renderer
      win.webContents.send('cumulus:stream-end', {
        threadName,
        message: result.assistantMessage,
        fallbackText: result.response,
        segments: result.segments,
      });

      // Schedule segment summary generation (fire-and-forget, 5s idle delay)
      clearTimeout(this.summaryTimers.get(threadName));
      this.summaryTimers.set(threadName, setTimeout(async () => {
        try {
          const thread = this.threads.get(threadName);
          if (thread && lib.generatePendingSummaries) {
            const count = await lib.generatePendingSummaries(thread.threadPath, thread.history);
            if (count > 0) {
              console.log(`[cumulus] Generated ${count} segment summaries for ${threadName}`);
            }
          }
        } catch (err) {
          console.error(`[cumulus] Summary generation failed for ${threadName}:`, err.message);
        }
      }, 5000));

      // Sync user+assistant messages to gateway (fire-and-forget, with IDs for dedup)
      const gw = loadGatewayConfig();
      if (gw.enabled && gw.url) {
        const userMsg = result.userMessage || { role: 'user', content: messageText };
        const asstMsg = result.assistantMessage || { role: 'assistant', content: result.response };
        this._syncToGateway(gw, threadName, [
          { id: userMsg.id, role: userMsg.role || 'user', content: userMsg.content || messageText },
          { id: asstMsg.id, role: asstMsg.role || 'assistant', content: asstMsg.content || result.response },
        ]);
      }

      return result.response;
    } catch (err) {
      console.error('[Bridge] sendMessage error:', err);
      win.webContents.send('cumulus:error', {
        threadName,
        error: err.message || String(err),
      });
      return null;
    } finally {
      this.activeProcesses.delete(threadName);
      if (this.pool) {
        this.pool.release(threadName);
      }
      // Drain any messages that arrived while this agent was busy
      this.drainQueue(threadName, win);
    }
  }

  killProcess(threadName) {
    const proc = this.activeProcesses.get(threadName);
    if (proc) {
      proc.kill('SIGTERM');
      this.activeProcesses.delete(threadName);
    }
  }

  async getHistory(threadName, count = 50) {
    const gw = loadGatewayConfig();
    if (gw.enabled && gw.url) {
      return this._fetchJson(gw, `/api/thread/${encodeURIComponent(threadName)}/history?limit=${count}`);
    }
    const thread = await this.getOrCreateThread(threadName);
    const messages = count <= 0
      ? await thread.history.getAll()
      : await thread.history.getRecent(count);
    return messages.map(mapMessageForRenderer);
  }

  async listThreads() {
    const gw = loadGatewayConfig();
    if (gw.enabled && gw.url) {
      return this._fetchJson(gw, '/api/threads');
    }
    ensureDirectories();
    const files = fs.readdirSync(THREADS_DIR).filter(f => f.endsWith('.jsonl'));
    return files.map(f => f.replace(/\.jsonl$/, ''));
  }

  /**
   * Fetch JSON from the gateway API.
   */
  _fetchJson(gw, apiPath) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiPath, gw.url);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options = {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Accept': 'application/json',
          ...(gw.apiKey ? { 'X-API-Key': gw.apiKey } : {}),
        },
        rejectUnauthorized: false,
      };

      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve([]);
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[Bridge] Gateway fetch error (${apiPath}):`, err.message);
        resolve([]);
      });

      req.end();
    });
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

  /**
   * Get the project bound to a thread (if any).
   * Returns { name, path } or null.
   */
  async getThreadProject(threadName) {
    const lib = await loadCumulus();
    const threadConfig = await lib.loadThreadConfig(threadName);
    if (threadConfig.project) {
      return threadConfig.project;
    }
    return null;
  }

  /**
   * List available project templates.
   * Remote: GET /api/templates. Local: hardcoded defaults.
   */
  async listTemplates(threadName) {
    const mode = this.getThreadMode(threadName);
    const gw = loadGatewayConfig();

    if (mode === 'remote' && gw.enabled && gw.url) {
      try {
        const data = await this._fetchJson(gw, '/api/templates');
        return data.templates || data || [{ name: 'default' }, { name: 'web-app' }];
      } catch {
        return [{ name: 'default' }, { name: 'web-app' }];
      }
    }

    return [{ name: 'default' }, { name: 'web-app' }];
  }

  /**
   * Create a project and bind it to a thread.
   * Remote: POST /api/projects. Local: create folder + scaffold + update thread config.
   */
  async createProject(threadName, projectName, template = 'default', gitCloneUrl = null) {
    const mode = this.getThreadMode(threadName);
    const gw = loadGatewayConfig();

    if (mode === 'remote' && gw.enabled && gw.url) {
      return new Promise((resolve, reject) => {
        const url = new URL('/api/projects', gw.url);
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;
        const payload = JSON.stringify({
          name: projectName,
          template,
          ...(gitCloneUrl ? { gitCloneUrl } : {}),
          thread: threadName,
        });

        const req = transport.request({
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            ...(gw.apiKey ? { 'X-API-Key': gw.apiKey } : {}),
          },
          rejectUnauthorized: false,
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (res.statusCode >= 400) {
                reject(new Error(data.error || `HTTP ${res.statusCode}`));
              } else {
                resolve({ name: data.name || projectName, path: data.path });
              }
            } catch {
              reject(new Error('Invalid response from gateway'));
            }
          });
        });
        req.on('error', (err) => reject(err));
        req.write(payload);
        req.end();
      });
    }

    // Local mode: create folder, scaffold, update thread config
    const lib = await loadCumulus();
    const projectDir = path.join(os.homedir(), 'Documents', '_Projects', projectName);

    if (gitCloneUrl) {
      const { execSync } = require('child_process');
      execSync(`git clone "${gitCloneUrl}" "${projectDir}"`, { stdio: 'pipe' });
    } else {
      fs.mkdirSync(projectDir, { recursive: true });
      if (template === 'web-app') {
        fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'public'), { recursive: true });
      }
      fs.mkdirSync(path.join(projectDir, 'docs', 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'docs', 'decisions'), { recursive: true });
      if (!fs.existsSync(path.join(projectDir, 'Tasks.md'))) {
        fs.writeFileSync(path.join(projectDir, 'Tasks.md'), `# ${projectName} Tasks\n`);
      }
    }

    // Update thread config with project binding
    const threadConfig = await lib.loadThreadConfig(threadName);
    threadConfig.project = { name: projectName, path: projectDir };
    threadConfig.projectDir = projectDir;
    await lib.saveThreadConfig(threadName, threadConfig);

    return { name: projectName, path: projectDir };
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
    for (const timer of this.summaryTimers.values()) {
      clearTimeout(timer);
    }
    this.summaryTimers.clear();
    for (const timer of this._syncRetryTimers.values()) {
      clearTimeout(timer);
    }
    this._syncRetryTimers.clear();
    this.threads.clear();
  }
}

module.exports = { CumulusBridge, loadGatewayConfig };
