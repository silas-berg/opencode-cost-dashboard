#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SCRIPT = path.join(__dirname, 'server.mjs');
const DEFAULT_URL = 'http://127.0.0.1:4795';

let dashboardProcess;
let dashboardUrl = DEFAULT_URL;

async function checkDashboardStatus() {
  try {
    const response = await fetch(`${dashboardUrl}/api/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDashboard(timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await checkDashboardStatus()) return dashboardUrl;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The dashboard did not become ready in time.');
}

async function startDashboard() {
  if (dashboardProcess && dashboardProcess.exitCode === null) {
    if (await checkDashboardStatus()) return dashboardUrl;
  }
  if (await checkDashboardStatus()) return dashboardUrl;

  dashboardProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  dashboardProcess.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  dashboardProcess.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  dashboardProcess.once('exit', () => {
    if (dashboardProcess && dashboardProcess.exitCode !== null) dashboardProcess = undefined;
  });

  return waitForDashboard();
}

async function stopDashboard() {
  if (dashboardProcess && dashboardProcess.exitCode === null) {
    try {
      await fetch(`${dashboardUrl}/api/stop`, { method: 'POST', signal: AbortSignal.timeout(1000) });
    } catch {
      // ignore
    }
    dashboardProcess.kill('SIGTERM');
  }
  dashboardProcess = undefined;
}

const server = new Server(
  {
    name: 'opencode-cost-dashboard',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'opencode_cost_dashboard',
      description: 'Start, stop, or check the local OpenCode cost dashboard',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status'],
            description: 'Whether to start, stop, or report the status of the dashboard',
          },
        },
        required: ['action'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== 'opencode_cost_dashboard') {
    throw new Error(`Unknown tool: ${name}`);
  }

  const action = args?.action ?? 'status';
  if (action === 'stop') {
    await stopDashboard();
    return {
      content: [{ type: 'text', text: 'OpenCode cost dashboard stopped.' }],
    };
  }

  if (action === 'start') {
    const url = await startDashboard();
    return {
      content: [{ type: 'text', text: `OpenCode cost dashboard is running at ${url}` }],
    };
  }

  const running = await checkDashboardStatus();
  return {
    content: [{ type: 'text', text: running ? `OpenCode cost dashboard is running at ${dashboardUrl}` : 'OpenCode cost dashboard is not running.' }],
  };
});

async function main() {
  // Auto-start the dashboard as soon as the MCP server boots, so it's ready
  // without requiring an explicit `start` tool call. Non-fatal on failure —
  // the `status`/`start` tool actions remain available to retry/inspect.
  startDashboard()
    .then((url) => console.error(`[opencode-cost-dashboard] auto-started at ${url}`))
    .catch((err) => console.error(`[opencode-cost-dashboard] auto-start failed: ${err.message}`));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
