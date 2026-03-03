#!/usr/bin/env node
/**
 * Janus Agents MCP Server
 *
 * Stdio-based MCP server that gives each Claude subprocess the ability to
 * discover and communicate with other cumulus agent tabs in Janus.
 *
 * Environment variables (set by cumulus-bridge in MCP config):
 *   JANUS_API_URL   - HTTP API base URL (e.g., http://localhost:9223)
 *   JANUS_AGENT_NAME - This agent's thread name (identity)
 *
 * Tools:
 *   list_agents   - List all active agents
 *   send_to_agent - Send a message to another agent
 *   broadcast     - Send a message to all active agents
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');

const API_URL = process.env.JANUS_API_URL || 'http://localhost:9223';
const AGENT_NAME = process.env.JANUS_AGENT_NAME || 'unknown';

/**
 * Make an HTTP request to the Janus API and return the parsed JSON response.
 */
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: 'Invalid JSON response' });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: `API request failed: ${err.message}` });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  const server = new Server(
    { name: 'janus-agents', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_agents',
        description:
          'List all active Janus agents (cumulus chat tabs). Returns each agent\'s name and status (idle or streaming), and queueDepth (number of messages waiting for delivery). Use this to discover which agents are available to communicate with.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'send_to_agent',
        description:
          'Send a message to another Janus agent by name. The message is delivered as an interjection — the target agent\'s current work is interrupted and it sees your message as a new user turn. Returns immediately (non-blocking). The target agent will process your message independently. If the target agent doesn\'t have an open tab, one will be created automatically. Messages are private — only the named target(s) receive them. Use the broadcast tool to send to all agents. If the target is busy (streaming), the message is queued and will be delivered when they finish their current turn. Queued messages are batched — the target sees all pending messages at once. The response includes status ("delivered" or "queued") and position in queue if queued.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              description:
                'The name of the target agent (its thread name), or an array of agent names for multi-target messaging (e.g., ["puppet", "abra"]). Only the named targets receive the message.',
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            message: {
              type: 'string',
              description:
                'The message to send. Can include code, diffs, file paths, or any rich text.',
            },
          },
          required: ['target', 'message'],
        },
      },
      {
        name: 'broadcast',
        description:
          'Send a message to ALL active Janus agents simultaneously. The message is delivered to every agent except yourself. Returns a summary of delivery results per agent. Use this when you need to announce something to all agents (e.g., "I changed the API for X", "build is broken, hold off on commits"). Busy agents will have their messages queued for batch delivery when they finish.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to broadcast to all agents.',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'open_chat_tab',
        description:
          'Open a new cumulus chat tab with a specific thread name. If a tab with that thread name already exists, returns it without creating a duplicate. Use this to spawn a new agent before sending it messages.',
        inputSchema: {
          type: 'object',
          properties: {
            threadName: {
              type: 'string',
              description: 'The thread name for the new chat tab (becomes the agent\'s identity)',
            },
          },
          required: ['threadName'],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'list_agents') {
      const result = await apiRequest('GET', '/api/agents');
      if (result.error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              agents: result.agents || [],
              self: AGENT_NAME,
            }),
          },
        ],
      };
    }

    if (name === 'send_to_agent') {
      const { target, message } = args;
      if (!target || !message) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: 'Missing target or message' }) }],
          isError: true,
        };
      }

      // Normalize target to array
      const targets = Array.isArray(target) ? target : [target];

      // Filter out self
      const filtered = targets.filter(t => t !== AGENT_NAME);
      if (filtered.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: 'Cannot send message to self' }) }],
          isError: true,
        };
      }

      // Auto-create tabs for any targets that don't exist yet
      for (const t of filtered) {
        const check = await apiRequest('GET', '/api/agents');
        const exists = (check.agents || []).some(a => a.name === t);
        if (!exists) {
          const createResult = await apiRequest('POST', '/api/agents', { threadName: t });
          if (createResult.error) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: `Failed to auto-create agent tab "${t}": ${createResult.error}` }) }],
              isError: true,
            };
          }
          // Wait for tab to initialize
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Use multi-target endpoint (private by default)
      const result = await apiRequest('POST', '/api/agents/message', {
        targets: filtered,
        message,
        sender: AGENT_NAME,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !!result.error,
      };
    }

    if (name === 'broadcast') {
      const { message } = args;
      if (!message) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: 'Missing message' }) }],
          isError: true,
        };
      }

      const result = await apiRequest('POST', '/api/agents/broadcast', {
        message,
        sender: AGENT_NAME,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !!result.error,
      };
    }

    if (name === 'open_chat_tab') {
      const { threadName } = args;
      if (!threadName) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Missing threadName' }) }],
          isError: true,
        };
      }

      const result = await apiRequest('POST', '/api/agents', { threadName });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !!result.error,
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('janus-agents MCP server error:', err);
  process.exit(1);
});
