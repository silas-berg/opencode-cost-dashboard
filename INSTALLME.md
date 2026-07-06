# Install OpenCode Cost Dashboard

This file is intended to be fetched by an LLM or automation tool and used to install the OpenCode cost dashboard into any OpenCode instance.

## One-shot install

```bash
set -e
mkdir -p ~/.config/opencode/plugins
cd ~/.config/opencode/plugins
rm -rf opencode-cost-dashboard
curl -L https://codeload.github.com/silas-berg/opencode-cost-dashboard/tar.gz/refs/heads/master \
  | tar -xz
mv opencode-cost-dashboard-master opencode-cost-dashboard
cd opencode-cost-dashboard
npm install --no-fund --no-audit
```

## Verify

```bash
cd ~/.config/opencode/plugins/opencode-cost-dashboard
npm start
```

Then open:

- http://127.0.0.1:4795/

## OpenCode MCP config

After installation, add the dashboard as an MCP server in your OpenCode config:

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

You can also copy the example from [docs/opencode-mcp-config.json](docs/opencode-mcp-config.json) and update the path.

## Notes

- The plugin entrypoint is [opencode-cost-dashboard.ts](opencode-cost-dashboard.ts).
- The MCP server entrypoint is [mcp-server.mjs](mcp-server.mjs).
- The dashboard reads the local OpenCode database in read-only mode.
- The install is intended to work on any local OpenCode instance.
