# OpenCode Cost Dashboard

A lightweight, local dashboard for inspecting OpenCode session cost data directly from your local OpenCode SQLite database.

It is stateless, read-only, and designed to run in any OpenCode instance without sending data anywhere.

![OpenCode Cost Dashboard](docs/img/dashboard-screenshot.png)

## What it shows

- Total cost, session count, and token usage
- Cost over time by hour/day/week/month/year
- Model-level cost breakdowns
- Session-level cost spikes and duration details
- Project-level aggregation

## Why this is useful

The dashboard helps you answer questions like:

- Which sessions cost the most?
- Which models are driving spend?
- How quickly did costs increase over time?
- Which project or worktree is the main source of spend?

## Installation

The easiest install path is to use the automation steps in [INSTALLME.md](INSTALLME.md).

Just tell your agent

```
Fetch curl https://raw.githubusercontent.com/silas-berg/opencode-cost-dashboard/master/INSTALLME.md 
and install the OpenCode cost dashboard into your OpenCode instance.
```

Then start the dashboard from the plugin tool or run:

### Manual install

```bash
mkdir -p ~/.config/opencode/plugins
cd ~/.config/opencode/plugins
curl -L https://codeload.github.com/silas-berg/opencode-cost-dashboard/tar.gz/refs/heads/master \
  | tar -xz
mv opencode-cost-dashboard-master opencode-cost-dashboard
cd opencode-cost-dashboard
npm install --no-fund --no-audit
```

Then start the dashboard from the plugin tool or run:

```bash
npm start
```

The dashboard is available at http://127.0.0.1:4795/.

## OpenCode integration

This repo now includes an MCP server entrypoint in [mcp-server.mjs](mcp-server.mjs) so it can be added to OpenCode as an MCP server instead of relying on a command wrapper.

Example OpenCode MCP config:

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

The dashboard auto-starts as soon as OpenCode launches the MCP server — no need to call the tool
first just to bring it up.

The MCP server exposes a tool named `opencode_cost_dashboard` with:

- start
- stop
- status

A ready-to-copy example is also available in [docs/opencode-mcp-config.json](docs/opencode-mcp-config.json).

## Importing cost from other providers

Use the **Import cost data from local providers** button (top bar) to pull in usage from
other coding-agent CLIs and merge it into the dashboard. A modal iterates through each provider
and shows how many sessions were found, imported, and skipped as duplicates.

- Supported today: **Claude Code**, **GitHub Copilot (CLI)**, **Codex**, **Gemini CLI**, and **Cursor local history**.
- **GitHub Copilot (VS Code)** is estimated from local OpenTelemetry token counts (dollar amounts are
  approximate, priced per model — see `COPILOT_PRICING` in [imports.mjs](imports.mjs)).
- **Cursor** imports local composer/session history from Cursor's SQLite state database. When Cursor has persisted token fields locally, those are used; otherwise the importer estimates tokens from the recovered text and marks the session as estimated.
- Extraction is delegated to [ccusage](https://github.com/ccusage/ccusage) via `npx` (offline pricing),
  so `node`/`npx` must be available. Cost is derived from token usage.
- Works on Windows too: Copilot (VS Code) trace/settings discovery and the `ccusage` invocation both
  handle Windows paths (`%APPDATA%`) and the `npx.cmd` shell requirement.
- Imports are **idempotent**: each session is keyed by `<provider>:<sessionId>`, so re-running never
  creates duplicates. Imported sessions are stored in a separate `cost-dashboard-imports.db` — your
  OpenCode database is never modified (it stays read-only).

## Notes

- The dashboard reads from the local OpenCode database in read-only mode.
- No telemetry or remote syncing is required.
- It is intended to work on Linux, macOS, and Windows.
