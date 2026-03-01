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
          'List all active Janus agents (cumulus chat tabs). Returns each agent\'s name and status (idle or streaming). Use this to discover which agents are available to communicate with.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'send_to_agent',
        description:
          'Send a message to another Janus agent by name. The message is delivered as an interjection — the target agent\'s current work is interrupted and it sees your message as a new user turn. Returns immediately (non-blocking). The target agent will process your message independently. If the target agent doesn\'t have an open tab, one will be created automatically.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'The name of the target agent (its thread name)',
            },
            message: {
              type: 'string',
              description: 'The message to send. Can include code, diffs, file paths, or any rich text.',
            },
          },
          required: ['target', 'message'],
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

      if (target === AGENT_NAME) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: 'Cannot send message to self' }) }],
          isError: true,
        };
      }

      // Try to send the message
      let result = await apiRequest('POST', `/api/agents/${encodeURIComponent(target)}/message`, {
        message,
        sender: AGENT_NAME,
      });

      // If agent not found, auto-open a chat tab for it and retry
      if (result.error && result.error.includes('not found')) {
        const createResult = await apiRequest('POST', '/api/agents', { threadName: target });
        if (createResult.error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: `Failed to auto-create agent tab: ${createResult.error}` }) }],
            isError: true,
          };
        }

        // Wait briefly for the tab to initialize (React mount + thread creation)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Retry the message
        result = await apiRequest('POST', `/api/agents/${encodeURIComponent(target)}/message`, {
          message,
          sender: AGENT_NAME,
        });
      }

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
