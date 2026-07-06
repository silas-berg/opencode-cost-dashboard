import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * OpenCode Cost Dashboard
 *
 * A tiny local web server showing per-session cost plus day/week/month/year
 * graphs, read directly (read-only) from OpenCode's own local SQLite database.
 * Controlled through the `opencode_cost_dashboard` tool and exposed through the
 * `/opencode-cost-dashboard` command for OpenCode.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SCRIPT = path.join(__dirname, "server.mjs");
const DEFAULT_URL = "http://127.0.0.1:4795";
let dashboardProcess: ChildProcess | undefined;
let dashboardUrl = DEFAULT_URL;

type DashboardAction = "start" | "stop" | "status";

async function checkDashboardStatus(): Promise<boolean> {
  try {
    const response = await fetch(`${dashboardUrl}/api/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function openInBrowser(url: string): void {
  const browserCommand = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(browserCommand, args, { detached: true, stdio: "ignore" });
}

async function waitForDashboard(timeoutMs = 5000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await checkDashboardStatus()) return dashboardUrl;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The dashboard did not become ready in time.");
}

async function startDashboard(open = false): Promise<string> {
  if (dashboardProcess && dashboardProcess.exitCode === null) {
    if (await checkDashboardStatus()) return dashboardUrl;
  }

  if (await checkDashboardStatus()) return dashboardUrl;

  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  dashboardProcess = child;

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  child.once("exit", () => {
    if (dashboardProcess === child) dashboardProcess = undefined;
  });

  const url = await waitForDashboard();
  if (open) openInBrowser(url);
  return url;
}

async function stopDashboard(): Promise<void> {
  if (dashboardProcess && dashboardProcess.exitCode === null) {
    try {
      await fetch(`${dashboardUrl}/api/stop`, { method: "POST", signal: AbortSignal.timeout(1000) });
    } catch {
      // ignore stop errors and fall back to process termination
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 1000);
      dashboardProcess?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      dashboardProcess?.kill("SIGTERM");
    });
  }

  dashboardProcess = undefined;
}

export const OpencodeCostDashboardPlugin: Plugin = async () => {
  return {
    tool: {
      opencode_cost_dashboard: tool({
        description:
          "Control the local OpenCode cost dashboard. Use action 'start' to launch or reuse the dashboard, 'stop' to stop it, or 'status' to report whether it is running. " +
          "Set open=true to open the dashboard in the browser after start.",
        args: {
          action: z.enum(["start", "stop", "status"]).describe("What to do with the dashboard"),
          open: z.boolean().optional().describe("Open the dashboard in the browser when starting"),
        },
        async execute({ action = "start", open = false }: { action?: DashboardAction; open?: boolean }) {
          if (action === "stop") {
            await stopDashboard();
            return "OpenCode cost dashboard stopped.";
          }
          if (action === "status") {
            return (await checkDashboardStatus())
              ? `OpenCode cost dashboard is running at ${dashboardUrl}`
              : "OpenCode cost dashboard is not running.";
          }
          const url = await startDashboard(open);
          return `OpenCode cost dashboard is running at ${url}`;
        },
      }),
    },
    dispose: async () => {
      await stopDashboard();
    },
  };
};

export default OpencodeCostDashboardPlugin;
