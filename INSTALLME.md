# Install OpenCode Cost Dashboard

This file is intended to be fetched by an LLM or automation tool and used to install the project as an open-source MCP server and local dashboard for any MCP-capable client.

## One-shot install

```bash
set -e
mkdir -p ~/.local/share/opencode-cost-dashboard
cd ~/.local/share/opencode-cost-dashboard
rm -rf opencode-cost-dashboard
git clone https://github.com/silas-berg/opencode-cost-dashboard.git
cd opencode-cost-dashboard
npm install --no-fund --no-audit
```

## Verify

```bash
cd ~/.local/share/opencode-cost-dashboard/opencode-cost-dashboard
npm start
```

Then open:

- http://127.0.0.1:4795/

## MCP config

After installation, add the dashboard as an MCP server in your client configuration. The exact config file depends on your IDE, but the entry looks like this:

```json
{
  "mcpServers": {
    "opencode-cost-dashboard": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/opencode-cost-dashboard/mcp-server.mjs"]
    }
  }
}
```

You can also copy the example from [examples/opencode-mcp-config.json](examples/opencode-mcp-config.json) and update the path.

## Notes

- The MCP server entrypoint is [mcp-server.mjs](mcp-server.mjs).
- The optional OpenCode plugin entrypoint is [opencode-cost-dashboard.ts](opencode-cost-dashboard.ts).
- The dashboard reads local database data in read-only mode.
- The install is intended to work on any local machine with an MCP-capable IDE.
