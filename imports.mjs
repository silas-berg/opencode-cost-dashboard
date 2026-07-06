import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

// Providers offered in the import modal. `source` is the ccusage source name;
// entries with source=null are shown but disabled (no local cost data exists).
export const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', source: 'claude', available: true },
  { id: 'copilot', label: 'GitHub Copilot (CLI)', source: 'copilot', available: true },
  { id: 'copilot-vscode', label: 'GitHub Copilot (VS Code)', source: 'copilot-vscode', available: true },
  { id: 'codex', label: 'Codex', source: 'codex', available: true },
  { id: 'gemini', label: 'Gemini CLI', source: 'gemini', available: true },
  {
    id: 'cursor',
    label: 'Cursor local history',
    source: 'cursor',
    available: true,
    note: 'Reads Cursor local SQLite history, estimates missing token counts from local message text when needed, and derives a GitHub-style token-cost estimate from the detected model family.',
  },
];

const MAX_CURSOR_PREFIX_ROWS = 1500;
const MAX_CURSOR_COMPOSERS = 120;
const MAX_CURSOR_BUBBLES_PER_COMPOSER = 80;
const MAX_CURSOR_CONTEXTS_PER_COMPOSER = 40;

export function getImportDateBucket(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return '';
  const dayMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dayMatch) return `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}`;
  const monthMatch = text.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) return `${monthMatch[1]}-${monthMatch[2]}`;
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) {
    const dt = new Date(ms);
    return dt.toISOString().slice(0, 10);
  }
  return '';
}

export function shouldSkipImportForDate(dateBucket, existingDateBuckets, force) {
  if (force || !dateBucket) return false;
  return Boolean(existingDateBuckets && existingDateBuckets.has(dateBucket));
}

function getExistingImportDateBuckets(db, provider) {
  const rows = db.prepare('SELECT time_created FROM imported_session WHERE provider = ?').all(provider);
  return new Set(rows.map((row) => getImportDateBucket(row.time_created)).filter(Boolean));
}

export function resetImportedRowsForProvider(db, provider) {
  if (!db || typeof db.prepare !== 'function') return;
  db.prepare('DELETE FROM imported_session WHERE provider = ?').run(provider);
  if (provider === 'cursor') {
    db.prepare('DELETE FROM cursor_local_session').run();
  }
}

export function withImportTimeout(promise, label, timeoutMs = 120000) {
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))}s`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function createCopilotVscodeSeenState() {
  return { importIds: new Set(), sessionIds: new Set() };
}

export function isCopilotVscodeDuplicate(seen, importId, sessionId) {
  if (!seen || typeof seen !== 'object') return false;
  const importIds = seen.importIds || (seen.importIds = new Set());
  const sessionIds = seen.sessionIds || (seen.sessionIds = new Set());
  const normalizedImportId = String(importId || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();

  if (normalizedImportId && importIds.has(normalizedImportId)) return true;
  if (normalizedSessionId && sessionIds.has(normalizedSessionId)) return true;

  if (normalizedImportId) importIds.add(normalizedImportId);
  if (normalizedSessionId) sessionIds.add(normalizedSessionId);
  return false;
}

export function discoverAccounts() {
  let gitEmail = '';
  let gitName = '';
  let githubUser = '';
  
  try {
    gitEmail = execSync('git config --get user.email', { encoding: 'utf8' }).trim();
  } catch (e) {}
  
  try {
    gitName = execSync('git config --get user.name', { encoding: 'utf8' }).trim();
  } catch (e) {}

  try {
    const hostsPath = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GitHub CLI', 'hosts.yml')
      : path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
    if (fs.existsSync(hostsPath)) {
      const content = fs.readFileSync(hostsPath, 'utf8');
      const match = content.match(/user:\s*(\S+)/);
      if (match) {
        githubUser = match[1];
      }
    }
  } catch (e) {}

  const normalizeIdentity = (value) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '';
  };

  const githubDisplay = githubUser
    ? `${githubUser}${normalizeIdentity(gitEmail) ? ` (${normalizeIdentity(gitEmail)})` : ''}`
    : normalizeIdentity(gitEmail) || 'unknown';

  const claudeDisplay = normalizeIdentity(gitEmail) || 'unknown';

  return {
    copilot: githubDisplay,
    'copilot-vscode': githubDisplay,
    codex: githubDisplay,
    claude: claudeDisplay,
    gemini: normalizeIdentity(gitEmail) || 'unknown',
    cursor: 'Local history'
  };
}

function opencodeDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'opencode');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  const xdgData = process.env.XDG_DATA_HOME;
  const base = xdgData && xdgData.length > 0 ? xdgData : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode');
}

export function importsDbPath() {
  return path.join(opencodeDataDir(), 'cost-dashboard-imports.db');
}

// Columns are named to match the OpenCode `session` table so the two can be
// UNIONed together in a single query (see SESSION_SOURCE in server.mjs).
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS imported_session (
    import_id TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    agent TEXT,
    directory TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_archived INTEGER,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    raw TEXT
  )
`;

function getDefaultVsCodeScanPaths() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
    candidates.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Code', 'User'));
    candidates.push(path.join(appData, 'Code - Insiders', 'User'));
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'User'));
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code - Insiders', 'User'));
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Visual Studio Code', 'User'));
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Visual Studio Code - Insiders', 'User'));
  } else {
    candidates.push(path.join(home, '.vscode-server', 'data', 'User'));
    candidates.push(path.join(home, '.vscode-server-insiders', 'data', 'User'));
    candidates.push(path.join(home, '.config', 'Code', 'User'));
    candidates.push(path.join(home, '.config', 'Code - Insiders', 'User'));
    candidates.push(path.join(home, '.config', 'Code - OSS', 'User'));
    candidates.push(path.join(home, '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User'));
    candidates.push(path.join(home, '.var', 'app', 'com.visualstudio.code.insiders', 'config', 'Code - Insiders', 'User'));
    candidates.push(path.join(home, 'snap', 'code', 'common', '.config', 'Code', 'User'));
    candidates.push(path.join(home, 'snap', 'code-insiders', 'common', '.config', 'Code - Insiders', 'User'));
    candidates.push(path.join(home, '.config', 'VSCodium', 'User'));

    const windowsUsersRoot = '/mnt/c/Users';
    try {
      const entries = fs.readdirSync(windowsUsersRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Code', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Code - Insiders', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Visual Studio Code', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Visual Studio Code - Insiders', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Microsoft VS Code - Insiders', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Visual Studio Code', 'User'));
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Visual Studio Code - Insiders', 'User'));
      }
    } catch {
      // WSL Windows users root unavailable
    }
  }

  return Array.from(new Set(
    candidates
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
  ));
}

function seedDefaultScanPaths(db) {
  const existing = new Set(db.prepare('SELECT path FROM import_scan_path').all().map((row) => row.path));
  const now = Date.now();
  for (const scanPath of getDefaultVsCodeScanPaths()) {
    if (!existing.has(scanPath)) {
      db.prepare('INSERT OR IGNORE INTO import_scan_path (path, created_at) VALUES (?, ?)').run(scanPath, now);
      existing.add(scanPath);
    }
  }
}

export function ensureImportsDb() {
  if (!DatabaseSync) throw new Error('node:sqlite is not available in this environment');
  const db = new DatabaseSync(importsDbPath());
  try {
    db.exec(CREATE_TABLE);
    db.exec(CREATE_SCAN_PATH_TABLE);
    seedDefaultScanPaths(db);
  } finally {
    db.close();
  }
}

// Extra filesystem paths the user has registered for the VS Code chat-session
// history scan (e.g. a backed-up profile or a non-default install location).
// Each is recursively scanned for chatSessions/emptyWindowChatSessions/
// transferredChatSessions directories (see discoverChatSessionSources).
const CREATE_SCAN_PATH_TABLE = `
  CREATE TABLE IF NOT EXISTS import_scan_path (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )
`;

export function getScanPaths() {
  ensureImportsDb();
  const db = new DatabaseSync(importsDbPath());
  try {
    return db.prepare('SELECT path FROM import_scan_path ORDER BY created_at ASC').all().map((r) => r.path);
  } finally {
    db.close();
  }
}

export function addScanPath(inputPath) {
  const resolved = path.resolve(String(inputPath || ''));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  ensureImportsDb();
  const db = new DatabaseSync(importsDbPath());
  try {
    db.prepare('INSERT OR IGNORE INTO import_scan_path (path, created_at) VALUES (?, ?)').run(resolved, Date.now());
  } finally {
    db.close();
  }
  return getScanPaths();
}

export function removeScanPath(inputPath) {
  const resolved = path.resolve(String(inputPath || ''));
  ensureImportsDb();
  const db = new DatabaseSync(importsDbPath());
  try {
    db.prepare('DELETE FROM import_scan_path WHERE path = ?').run(resolved);
  } finally {
    db.close();
  }
  return getScanPaths();
}

function runCcusageCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // We run without the --offline flag so ccusage can resolve online billing and pricing where supported.
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: Boolean(options.useShell),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ccusage timed out for ${command}`));
    }, 120000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const start = stdout.indexOf('{');
      if (start === -1) {
        reject(new Error(stderr.trim() || `ccusage exited with code ${code} and no output`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.slice(start));
        resolve(Array.isArray(parsed.session) ? parsed.session : []);
      } catch (err) {
        reject(new Error(`Failed to parse ccusage output: ${err.message}`));
      }
    });
  });
}

function runCcusageAll() {
  const isWindows = process.platform === 'win32';
  const npxCommand = isWindows ? 'npx.cmd' : 'npx';
  const commandLine = `${npxCommand} -y ccusage@latest session --json`;
  const attempts = [
    { command: npxCommand, args: ['-y', 'ccusage@latest', 'session', '--json'] },
    { command: 'powershell.exe', args: ['-NoProfile', '-Command', commandLine], options: { useShell: true } },
    { command: 'pwsh', args: ['-NoProfile', '-Command', commandLine], options: { useShell: true } },
    { command: 'cmd.exe', args: ['/d', '/c', commandLine], options: { useShell: true } },
  ];

  return (async () => {
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        return await runCcusageCommand(attempt.command, attempt.args, attempt.options);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('ccusage unavailable');
  })();
}

// ccusage's per-source `<agent> session` subcommand is unreliable, but the
// combined `session` command groups every source by its `agent` field. Run it
// once and cache briefly so a multi-provider import triggers a single process.
const CACHE_TTL_MS = 120000;
let sessionCache = { at: 0, sessions: null };

async function getAllSessions() {
  if (sessionCache.sessions && Date.now() - sessionCache.at < CACHE_TTL_MS) {
    return sessionCache.sessions;
  }
  const sessions = await runCcusageAll();
  sessionCache = { at: Date.now(), sessions };
  return sessions;
}

function topModel(session) {
  const breakdowns = Array.isArray(session.modelBreakdowns) ? session.modelBreakdowns : [];
  if (breakdowns.length > 0) {
    const best = breakdowns.reduce((a, b) => ((b.cost || 0) > (a.cost || 0) ? b : a));
    if (best && best.modelName) return best.modelName;
  }
  const used = Array.isArray(session.modelsUsed) ? session.modelsUsed : [];
  return used[0] || 'unknown';
}

/**
 * Import one provider's sessions via ccusage into the imports DB.
 * Idempotent: dedup key is `<source>:<period>`; re-importing updates in place.
 * Returns { provider, label, found, imported, skipped, cost }.
 */
export async function runProviderImport(provider, options = {}) {
  const entry = PROVIDERS.find((p) => p.id === provider);
  const force = Boolean(options.force);
  if (!entry) throw new Error(`Unknown provider: ${provider}`);
  if (!entry.available || !entry.source) {
    return { provider: entry.id, label: entry.label, found: 0, imported: 0, skipped: 0, cost: 0, unavailable: true };
  }

  if (provider === 'cursor') {
    return withImportTimeout(runCursorImport({ force }), 'Cursor import');
  }

  if (provider === 'copilot-vscode') {
    return withImportTimeout(runCopilotVscodeImport({ force, phase: options.phase }), 'GitHub Copilot (VS Code) import');
  }

  return withImportTimeout((async () => {
    const allSessions = await getAllSessions();
    const sessions = allSessions.filter((s) => s.agent === entry.source);

    ensureImportsDb();
    const db = new DatabaseSync(importsDbPath());
    try {
      const existing = new Set(
        db
          .prepare('SELECT import_id FROM imported_session WHERE provider = ?')
          .all(entry.source)
          .map((r) => r.import_id)
      );
      const upsert = db.prepare(`
      INSERT INTO imported_session (
        import_id, id, project_id, title, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write, model, agent,
        directory, time_created, time_updated, time_archived, provider, session_id,
        imported_at, raw
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(import_id) DO UPDATE SET
        cost = excluded.cost,
        tokens_input = excluded.tokens_input,
        tokens_output = excluded.tokens_output,
        tokens_reasoning = excluded.tokens_reasoning,
        tokens_cache_read = excluded.tokens_cache_read,
        tokens_cache_write = excluded.tokens_cache_write,
        model = excluded.model,
        time_updated = excluded.time_updated,
        imported_at = excluded.imported_at,
        raw = excluded.raw
    `);

      let imported = 0;
      let skipped = 0;
      let cost = 0;
      const now = Date.now();
      const existingDateBuckets = getExistingImportDateBuckets(db, entry.source);

      for (const s of sessions) {
        const sessionId = String(s.period);
        const importId = `${entry.source}:${sessionId}`;
        const activity = s.metadata && s.metadata.lastActivity ? Date.parse(s.metadata.lastActivity) : NaN;
        const ts = Number.isFinite(activity) ? activity : now;
        const model = `${entry.source}/${topModel(s)}`;
        const sessionCost = Number(s.totalCost) || 0;
        cost += sessionCost;
        const dateBucket = getImportDateBucket(ts || s.startedAt || s.createdAt || s.period);
        const skipByDate = shouldSkipImportForDate(dateBucket, existingDateBuckets, force);

        if (skipByDate || existing.has(importId)) {
          skipped += 1;
          continue;
        }

        upsert.run(
          importId,
          importId,
          null,
          `${entry.label} session ${sessionId.slice(0, 8)}`,
          sessionCost,
          Number(s.inputTokens) || 0,
          Number(s.outputTokens) || 0,
          0,
          Number(s.cacheReadTokens) || 0,
          Number(s.cacheCreationTokens) || 0,
          model,
          entry.source,
          null,
          ts,
          ts,
          null,
          entry.source,
          sessionId,
          now,
          JSON.stringify(s)
        );

        imported += 1;
      }

      return { provider: entry.id, label: entry.label, found: sessions.length, imported, skipped, cost };
    } finally {
      db.close();
    }
  })(), `${entry.label} import`);
}

function ensureCursorLocalTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursor_local_session (
      id TEXT PRIMARY KEY,
      composer_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_schema TEXT NOT NULL,
      workspace_storage_id TEXT,
      workspace_path TEXT,
      title TEXT,
      model TEXT,
      agent TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0,
      exact_input_tokens INTEGER DEFAULT 0,
      exact_output_tokens INTEGER DEFAULT 0,
      quality TEXT NOT NULL,
      raw_hash TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cursor_local_composer
    ON cursor_local_session(composer_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cursor_local_time
    ON cursor_local_session(time_created)
  `);
}

function getDefaultCursorScanRoots() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Cursor', 'User'));
  } else {
    // Linux local config
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(path.join(xdgConfig, 'Cursor', 'User'));

    // Check for WSL Windows users' roaming Cursor data
    const windowsUsersRoot = '/mnt/c/Users';
    try {
      const entries = fs.readdirSync(windowsUsersRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Cursor', 'User'));
      }
    } catch {
      // WSL Windows users root unavailable
    }
  }

  return Array.from(new Set(
    candidates
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
  ));
}

function discoverCursorSources() {
  const roots = getDefaultCursorScanRoots();
  const sources = [];

  for (const root of roots) {
    const globalDbPath = path.join(root, 'globalStorage', 'state.vscdb');
    if (fs.existsSync(globalDbPath)) {
      sources.push({ kind: 'global', root, dbPath: globalDbPath });
    }

    const workspaceRoot = path.join(root, 'workspaceStorage');
    if (!fs.existsSync(workspaceRoot)) continue;
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = path.join(workspaceRoot, entry.name);
      const dbPath = path.join(entryDir, 'state.vscdb');
      const workspaceJsonPath = path.join(entryDir, 'workspace.json');
      if (fs.existsSync(dbPath)) {
        sources.push({
          kind: 'workspace',
          root,
          workspaceStorageId: entry.name,
          dbPath,
          workspaceJsonPath: fs.existsSync(workspaceJsonPath) ? workspaceJsonPath : null,
        });
      }
    }
  }

  return sources;
}

function openCursorDbReadOnly(dbPath) {
  if (!DatabaseSync) throw new Error('node:sqlite is not available in this environment');
  return new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
}

function readKvJson(db, table, key) {
  try {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key);
    if (!row) return null;
    const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readKvPrefix(db, table, prefix, limit = MAX_CURSOR_PREFIX_ROWS) {
  try {
    const rows = db.prepare(`SELECT key, value FROM ${table} WHERE key LIKE ? ORDER BY key LIMIT ?`).all(prefix + '%', limit);
    return rows.map((row) => {
      const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
      return { key: row.key, raw, json: safeJson(raw) };
    });
  } catch {
    return [];
  }
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readWorkspaceUri(workspaceJsonPath) {
  if (!workspaceJsonPath || !fs.existsSync(workspaceJsonPath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
    return uriToFsPath(parsed.folder || parsed.workspace || parsed.rootUri || parsed.uri || '');
  } catch {
    return '';
  }
}

function readCursorDefaultModel(globalDb) {
  const preference = readKvJson(globalDb, 'ItemTable', 'cursor/lastSingleModelPreference') || readKvJson(globalDb, 'cursorDiskKV', 'cursor/lastSingleModelPreference');
  if (preference && typeof preference === 'object' && preference.composer) return preference.composer;
  return '';
}

function readGlobalComposerHeaders(globalDb) {
  const headers =
    readKvJson(globalDb, 'ItemTable', 'composer.composerHeaders') ||
    readKvJson(globalDb, 'cursorDiskKV', 'composer.composerHeaders') ||
    readKvJson(globalDb, 'ItemTable', 'composer.composerData') ||
    readKvJson(globalDb, 'cursorDiskKV', 'composer.composerData');

  const composers = [];
  if (Array.isArray(headers?.allComposers)) {
    for (const composer of headers.allComposers) {
      if (composer?.composerId) {
        composers.push({
          composerId: composer.composerId,
          name: composer.name || '',
          createdAt: Number(composer.createdAt || 0),
          lastUpdatedAt: Number(composer.lastUpdatedAt || 0),
          unifiedMode: composer.unifiedMode || '',
          forceMode: composer.forceMode || '',
          workspaceIdentifier: composer.workspaceIdentifier || null,
          source: 'global_headers',
        });
      }
    }
  }
  return composers;
}

function readWorkspaceComposers(workspaceDb, workspaceMeta) {
  const data = readKvJson(workspaceDb, 'ItemTable', 'composer.composerData') || readKvJson(workspaceDb, 'cursorDiskKV', 'composer.composerData');
  const out = [];

  if (Array.isArray(data?.allComposers)) {
    for (const composer of data.allComposers) {
      if (composer?.composerId) {
        out.push({
          composerId: composer.composerId,
          name: composer.name || '',
          createdAt: Number(composer.createdAt || 0),
          lastUpdatedAt: Number(composer.lastUpdatedAt || 0),
          unifiedMode: composer.unifiedMode || '',
          forceMode: composer.forceMode || '',
          workspaceIdentifier: {
            id: workspaceMeta.workspaceStorageId,
            uri: workspaceMeta.workspaceUri || null,
          },
          source: 'workspace_allComposers',
        });
      }
    }
  }

  for (const key of ['selectedComposerIds', 'lastFocusedComposerIds']) {
    if (Array.isArray(data?.[key])) {
      for (const composerId of data[key]) {
        out.push({
          composerId,
          name: '',
          createdAt: 0,
          lastUpdatedAt: 0,
          unifiedMode: '',
          forceMode: '',
          workspaceIdentifier: {
            id: workspaceMeta.workspaceStorageId,
            uri: workspaceMeta.workspaceUri || null,
          },
          source: `workspace_${key}`,
        });
      }
    }
  }

  return out;
}

function collectCursorComposerData(globalDb) {
  const bubbleRows = readKvPrefix(globalDb, 'cursorDiskKV', 'bubbleId:', MAX_CURSOR_PREFIX_ROWS);
  const bubblesByComposer = new Map();
  for (const row of bubbleRows) {
    const parts = String(row.key || '').split(':');
    const composerId = parts[1];
    const bubbleId = parts[2];
    if (!composerId || !bubbleId || !row.json) continue;
    const bucket = bubblesByComposer.get(composerId) || new Map();
    if (bucket.size >= MAX_CURSOR_BUBBLES_PER_COMPOSER) continue;
    bucket.set(bubbleId, row.json);
    bubblesByComposer.set(composerId, bucket);
  }

  const requestContextRows = readKvPrefix(globalDb, 'cursorDiskKV', 'messageRequestContext:', MAX_CURSOR_PREFIX_ROWS);
  const requestContextsByComposer = new Map();
  for (const row of requestContextRows) {
    const parts = String(row.key || '').split(':');
    const composerId = parts[1];
    const messageId = parts[2];
    if (!composerId || !messageId || !row.json) continue;
    const bucket = requestContextsByComposer.get(composerId) || new Map();
    if (bucket.size >= MAX_CURSOR_CONTEXTS_PER_COMPOSER) continue;
    bucket.set(messageId, row.json);
    requestContextsByComposer.set(composerId, bucket);
  }

  return { bubblesByComposer, requestContextsByComposer };
}

function readCursorComposer(globalDb, composerId, preloaded = {}) {
  const composer = readKvJson(globalDb, 'cursorDiskKV', `composerData:${composerId}`) || readKvJson(globalDb, 'ItemTable', `composerData:${composerId}`);
  if (!composer) return null;

  const bubblesById = new Map();
  const bubbleRows = preloaded.bubblesByComposer?.get(composerId);
  if (bubbleRows instanceof Map) {
    for (const [bubbleId, bubble] of bubbleRows.entries()) {
      if (bubbleId && bubble) bubblesById.set(bubbleId, bubble);
    }
  }

  const requestContextsByMessageId = preloaded.requestContextsByComposer?.get(composerId) || new Map();

  const ordered = [];
  const seenBubbleIds = new Set();
  const pushOrdered = (bubbleId, type, bubble) => {
    if (!bubbleId || seenBubbleIds.has(bubbleId)) return;
    seenBubbleIds.add(bubbleId);
    ordered.push({ bubbleId, type: Number(type || bubble?.type || 0), bubble });
  };

  if (Array.isArray(composer.conversation)) {
    for (const entry of composer.conversation) {
      if (!entry || typeof entry !== 'object') continue;
      const bubbleId = entry.bubbleId || entry.id;
      const bubble = bubblesById.get(bubbleId) || entry;
      pushOrdered(bubbleId, entry.type, bubble);
    }
  }

  if (Array.isArray(composer.fullConversationHeadersOnly)) {
    for (const header of composer.fullConversationHeadersOnly) {
      const bubbleId = header?.bubbleId;
      if (!bubbleId) continue;
      const bubble = bubblesById.get(bubbleId) || composer.conversationMap?.[bubbleId] || null;
      const inlineEntry = Array.isArray(composer.conversation)
        ? composer.conversation.find((entry) => entry?.bubbleId === bubbleId || entry?.id === bubbleId)
        : null;
      pushOrdered(bubbleId, header?.type || bubble?.type || inlineEntry?.type || 0, bubble || inlineEntry || null);
    }
  }

  if (!ordered.length && composer.conversationMap && typeof composer.conversationMap === 'object') {
    for (const [bubbleId, bubble] of Object.entries(composer.conversationMap)) {
      pushOrdered(bubbleId, bubble?.type || 0, bubble);
    }
  }

  return { composer, ordered, requestContextsByMessageId, defaultModel: readCursorDefaultModel(globalDb) };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function extractCursorBubbleText(bubble) {
  if (!bubble || typeof bubble !== 'object') return '';
  const parts = [];
  for (const key of ['text', 'content', 'markdown', 'message']) {
    if (typeof bubble[key] === 'string') parts.push(bubble[key]);
  }
  if (typeof bubble.richText === 'string') parts.push(bubble.richText);
  if (Array.isArray(bubble.codeBlocks)) {
    for (const block of bubble.codeBlocks) {
      if (typeof block?.code === 'string') parts.push(block.code);
      if (typeof block?.content === 'string') parts.push(block.content);
    }
  }
  if (Array.isArray(bubble.toolResults)) {
    for (const result of bubble.toolResults) {
      if (typeof result?.text === 'string') parts.push(result.text);
      if (typeof result?.output === 'string') parts.push(result.output);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function requestContextToText(context) {
  if (!context || typeof context !== 'object') return '';
  const parts = [];
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const lowered = key.toLowerCase();
        if (lowered.includes('content') || lowered.includes('text') || lowered.includes('prompt') || lowered.includes('diff') || lowered.includes('code')) {
          visit(child, depth + 1);
        }
      }
    }
  };
  visit(context);
  return parts.join('\n');
}

function extractCursorBubbleUsage(entry, requestContextsByMessageId) {
  const bubble = entry?.bubble || {};
  const text = extractCursorBubbleText(bubble);
  const isUser = entry?.type === 1 || bubble?.type === 1;
  const isAssistant = entry?.type === 2 || bubble?.type === 2;

  const exactOutput = firstFiniteNumber(
    bubble.tokenCount,
    bubble.tokens,
    bubble.usage?.completionTokens,
    bubble.usage?.outputTokens,
    bubble.usageData?.completionTokens,
    bubble.usageData?.outputTokens
  );
  const exactInput = firstFiniteNumber(
    bubble.promptTokens,
    bubble.inputTokens,
    bubble.usage?.promptTokens,
    bubble.usage?.inputTokens,
    bubble.usageData?.promptTokens,
    bubble.usageData?.inputTokens
  );

  const messageId = bubble.messageId || bubble.id || entry?.bubbleId;
  const requestContext = messageId ? requestContextsByMessageId.get(messageId) : null;

  let estimatedInput = 0;
  let estimatedOutput = 0;
  if (isUser && exactInput === 0) {
    estimatedInput = estimateTokensFromText(text + '\n' + requestContextToText(requestContext));
  }
  if (isAssistant && exactOutput === 0) {
    estimatedOutput = estimateTokensFromText(text);
  }

  return {
    messageId,
    text,
    inputTokens: exactInput || estimatedInput,
    outputTokens: exactOutput || estimatedOutput,
    exactInputTokens: exactInput,
    exactOutputTokens: exactOutput,
  };
}

const CURSOR_MODEL_PRICING = {
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-sonnet-4.5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4.6': { input: 3.0, output: 15.0 },
  'claude-opus-4': { input: 5.0, output: 25.0 },
  'claude-opus-4.5': { input: 5.0, output: 25.0 },
  'claude-opus-4.6': { input: 5.0, output: 25.0 },
  'claude-opus-4.7': { input: 5.0, output: 25.0 },
  'claude-opus-4.8': { input: 5.0, output: 25.0 },
  'claude-haiku-4.5': { input: 1.0, output: 5.0 },
  'gpt-5': { input: 2.5, output: 15.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gemini-2.5': { input: 1.25, output: 10.0 },
  'gemini-3': { input: 1.25, output: 10.0 },
  'o3': { input: 2.0, output: 8.0 },
  'o4': { input: 2.0, output: 8.0 },
  'cursor-default': { input: 1.5, output: 7.5 },
};

function normalizeCursorModelName(modelName) {
  const raw = String(modelName || '').trim().toLowerCase();
  if (!raw) return 'cursor-default';
  const cleaned = raw.replace(/^['"]|['"]$/g, '').replace(/[^a-z0-9._-]+/g, '-');
  if (cleaned.includes('claude-sonnet-4')) return 'claude-sonnet-4';
  if (cleaned.includes('claude-sonnet')) return 'claude-sonnet-4';
  if (cleaned.includes('claude-opus-4')) return 'claude-opus-4';
  if (cleaned.includes('claude-opus')) return 'claude-opus-4';
  if (cleaned.includes('claude-haiku')) return 'claude-haiku-4.5';
  if (cleaned.includes('gpt-5')) return 'gpt-5';
  if (cleaned.includes('gpt-4.1')) return 'gpt-4.1';
  if (cleaned.includes('gpt-4o')) return 'gpt-4o';
  if (cleaned.includes('gemini-2.5')) return 'gemini-2.5';
  if (cleaned.includes('gemini-3')) return 'gemini-3';
  if (cleaned.includes('gemini')) return 'gemini-2.5';
  if (cleaned.includes('o3')) return 'o3';
  if (cleaned.includes('o4')) return 'o4';
  return 'cursor-default';
}

export function estimateCursorCost({ inputTokens = 0, outputTokens = 0, modelName = '' } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const pricing = CURSOR_MODEL_PRICING[normalizeCursorModelName(modelName)] || CURSOR_MODEL_PRICING['cursor-default'];
  const inputCost = (input / 1_000_000) * pricing.input;
  const outputCost = (output / 1_000_000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(4));
}

function firstUserMessageTitle(ordered) {
  for (const entry of ordered) {
    const isUser = entry?.type === 1 || entry?.bubble?.type === 1;
    if (!isUser) continue;
    const text = extractCursorBubbleText(entry?.bubble).trim();
    if (text) return text.slice(0, 100);
  }
  return '';
}

function normalizeCursorSession(parsed, meta) {
  const { composer, ordered, requestContextsByMessageId } = parsed;
  let inputTokens = 0;
  let outputTokens = 0;
  let exactInput = 0;
  let exactOutput = 0;
  let sawExact = false;
  let sawEstimated = false;

  for (const entry of ordered) {
    const usage = extractCursorBubbleUsage(entry, requestContextsByMessageId);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    exactInput += usage.exactInputTokens;
    exactOutput += usage.exactOutputTokens;
    if (usage.exactInputTokens > 0 || usage.exactOutputTokens > 0) sawExact = true;
    else sawEstimated = true;
  }

  const modelName =
    composer?.modelConfig?.modelName ||
    composer?.modelConfig?.selectedModel ||
    composer?.selectedModel ||
    meta?.modelName ||
    parsed?.defaultModel ||
    'cursor-default';

  const createdAt = Number(composer?.createdAt) || Number(meta?.createdAt) || Date.now();
  const updatedAt = Number(composer?.lastUpdatedAt) || Number(meta?.lastUpdatedAt) || createdAt;
  const title = composer?.name || meta?.name || firstUserMessageTitle(ordered) || 'Cursor Session';

  let quality = 'estimated_from_local_cursor_json';
  if (exactInput > 0 || exactOutput > 0) {
    quality = sawEstimated ? 'mixed_cursor_persisted_and_estimated' : 'cursor_persisted_token_fields';
  }

  const cost = estimateCursorCost({ inputTokens, outputTokens, modelName });

  return {
    importId: `cursor:${composer?.composerId || meta?.composerId || meta?.workspaceStorageId || 'session'}`,
    title,
    cost,
    inputTokens,
    outputTokens,
    model: JSON.stringify({ providerID: 'cursor', id: modelName }),
    agent: composer?.unifiedMode || meta?.unifiedMode || 'cursor',
    directory: meta?.workspacePath || '',
    timeCreated: Math.floor(createdAt),
    timeUpdated: Math.floor(updatedAt),
    archived: null,
    quality,
    raw: JSON.stringify({ composerId: composer?.composerId || meta?.composerId, quality, modelName }),
  };
}

async function runCursorImport(options = {}) {
  const force = Boolean(options.force);
  ensureImportsDb();
  const db = new DatabaseSync(importsDbPath());
  try {
    ensureCursorLocalTables(db);

    const sources = discoverCursorSources();
    const workspaceMetaById = new Map();
    const composerMetaById = new Map();

    for (const workspaceSource of sources.filter((source) => source.kind === 'workspace')) {
      const workspaceUri = readWorkspaceUri(workspaceSource.workspaceJsonPath);
      const workspacePath = workspaceUri;
      workspaceMetaById.set(workspaceSource.workspaceStorageId, {
        workspaceStorageId: workspaceSource.workspaceStorageId,
        workspaceUri,
        workspacePath,
      });

      let workspaceDb;
      try {
        workspaceDb = openCursorDbReadOnly(workspaceSource.dbPath);
        for (const composer of readWorkspaceComposers(workspaceDb, {
          workspaceStorageId: workspaceSource.workspaceStorageId,
          workspaceUri,
        })) {
          if (!composerMetaById.has(composer.composerId)) {
            composerMetaById.set(composer.composerId, {
              ...composer,
              workspaceStorageId: workspaceSource.workspaceStorageId,
              workspaceUri,
              workspacePath,
            });
          }
        }
      } catch {
        // ignore unreadable workspace DBs
      } finally {
        try { workspaceDb?.close(); } catch {}
      }
    }

    const globalSources = sources.filter((source) => source.kind === 'global');
    const importDeadline = Date.now() + 120000;
    const checkImportDeadline = (step) => {
      if (Date.now() > importDeadline) {
        throw new Error(`Cursor import timed out after 2 minutes while ${step}`);
      }
    };
    const upsertCursorRaw = db.prepare(`
      INSERT INTO cursor_local_session (
        id, composer_id, source_path, source_schema, workspace_storage_id, workspace_path,
        title, model, agent, time_created, time_updated, tokens_input, tokens_output,
        tokens_cache_read, tokens_cache_write, exact_input_tokens, exact_output_tokens,
        quality, raw_hash, imported_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path,
        source_schema = excluded.source_schema,
        workspace_storage_id = excluded.workspace_storage_id,
        workspace_path = excluded.workspace_path,
        title = excluded.title,
        model = excluded.model,
        agent = excluded.agent,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated,
        tokens_input = excluded.tokens_input,
        tokens_output = excluded.tokens_output,
        tokens_cache_read = excluded.tokens_cache_read,
        tokens_cache_write = excluded.tokens_cache_write,
        exact_input_tokens = excluded.exact_input_tokens,
        exact_output_tokens = excluded.exact_output_tokens,
        quality = excluded.quality,
        raw_hash = excluded.raw_hash,
        imported_at = excluded.imported_at
    `);
    const upsertImported = db.prepare(`
      INSERT INTO imported_session (
        import_id, id, project_id, title, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write, model, agent,
        directory, time_created, time_updated, time_archived, provider, session_id,
        imported_at, raw
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(import_id) DO UPDATE SET
        title = excluded.title,
        cost = excluded.cost,
        tokens_input = excluded.tokens_input,
        tokens_output = excluded.tokens_output,
        tokens_cache_read = excluded.tokens_cache_read,
        tokens_cache_write = excluded.tokens_cache_write,
        model = excluded.model,
        agent = excluded.agent,
        directory = excluded.directory,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated,
        provider = excluded.provider,
        imported_at = excluded.imported_at,
        raw = excluded.raw
    `);

    let found = 0;
    let imported = 0;
    let skipped = 0;
    let totalCost = 0;
    const now = Date.now();
    const existingDateBuckets = getExistingImportDateBuckets(db, 'cursor');

    if (force) {
      resetImportedRowsForProvider(db, 'cursor');
    }

    for (const globalSource of globalSources) {
      checkImportDeadline('scanning global Cursor state');
      let globalDb;
      try {
        globalDb = openCursorDbReadOnly(globalSource.dbPath);
        const preloaded = collectCursorComposerData(globalDb);

        for (const composer of readGlobalComposerHeaders(globalDb)) {
          const workspaceId = composer.workspaceIdentifier?.id || '';
          const wsMeta = workspaceMetaById.get(workspaceId) || {};
          composerMetaById.set(composer.composerId, {
            ...composerMetaById.get(composer.composerId),
            ...composer,
            workspaceStorageId: workspaceId,
            workspacePath: wsMeta.workspacePath || '',
          });
        }

        const composerRows = readKvPrefix(globalDb, 'cursorDiskKV', 'composerData:', MAX_CURSOR_COMPOSERS);
        for (const row of composerRows) {
          const composerId = row.key.slice('composerData:'.length);
          if (!composerMetaById.has(composerId)) {
            composerMetaById.set(composerId, { composerId, source: 'orphaned_global_composer' });
          }
        }

        const composerCandidates = Array.from(composerMetaById.entries())
          .map(([composerId, meta]) => ({ composerId, meta, stamp: Number(meta.lastUpdatedAt) || Number(meta.createdAt) || 0 }))
          .sort((a, b) => b.stamp - a.stamp)
          .slice(0, MAX_CURSOR_COMPOSERS);
        composerMetaById.clear();
        for (const { composerId, meta } of composerCandidates) {
          composerMetaById.set(composerId, meta);
        }

        for (const [composerId, meta] of composerMetaById.entries()) {
          checkImportDeadline('parsing Cursor composer history');
          found += 1;
          const parsed = readCursorComposer(globalDb, composerId, preloaded);
          if (!parsed) {
            skipped += 1;
            continue;
          }

          const normalized = normalizeCursorSession(parsed, { ...meta, composerId });
          const rawHash = hashText(JSON.stringify(parsed.composer || {}).slice(0, 1_000_000));
          const importId = normalized.importId;
          const existingImport = db.prepare('SELECT 1 FROM imported_session WHERE import_id = ?').get(importId);
          const dateBucket = getImportDateBucket(normalized.timeCreated);
          const skipByDate = shouldSkipImportForDate(dateBucket, existingDateBuckets, force);

          if (skipByDate || (!force && existingImport)) {
            skipped += 1;
            continue;
          }

          upsertCursorRaw.run(
            importId,
            composerId,
            globalSource.dbPath,
            meta.source || 'cursor_local',
            normalized.directory ? meta.workspaceStorageId || 'cursor' : 'cursor',
            normalized.directory,
            normalized.title,
            normalized.model,
            normalized.agent,
            normalized.timeCreated,
            normalized.timeUpdated,
            normalized.inputTokens,
            normalized.outputTokens,
            0,
            0,
            0,
            0,
            normalized.quality,
            rawHash,
            now
          );

          totalCost += normalized.cost || 0;

          upsertImported.run(
            importId,
            importId,
            meta.workspaceStorageId || 'cursor',
            normalized.title,
            normalized.cost,
            normalized.inputTokens,
            normalized.outputTokens,
            0,
            0,
            0,
            normalized.model,
            normalized.agent,
            normalized.directory,
            normalized.timeCreated,
            normalized.timeUpdated,
            null,
            'cursor',
            composerId,
            now,
            normalized.raw
          );

          imported += 1;
        }
      } finally {
        try { globalDb?.close(); } catch {}
      }
    }

    return { provider: 'cursor', label: 'Cursor local history', found, imported, skipped, cost: Number(totalCost.toFixed(4)), note: 'Read Cursor local SQLite history. Token values are exact only when Cursor persisted them locally; otherwise they were estimated from local text. Costs use a GitHub-style token-based estimate per detected model family.' };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// GitHub Copilot (VS Code) import
//
// VS Code Copilot Chat records per-request usage only when its built-in
// OpenTelemetry SQLite span exporter is enabled. When enabled, the Copilot
// extension writes spans to `<globalStorage>/github.copilot-chat/agent-traces.db`
// (tables `spans` + `span_attributes`). This importer enables that exporter,
// discovers the trace DB(s), and aggregates spans per conversation.
//
// Pricing mirrors ypyl/vs-code-copilot-stats (USD per 1M tokens). Edit when
// GitHub changes pricing.
// ---------------------------------------------------------------------------

const COPILOT_PRICING = {
  models: {
    'gpt-5-mini': { input: 0.25, cacheInput: 0.025, output: 2.0 },
    'gpt-5.3-codex': { input: 1.75, cacheInput: 0.175, output: 14.0 },
    'gpt-5.4': {
      tiers: [
        { threshold: 272000, input: 2.5, cacheInput: 0.25, output: 15.0 },
        { threshold: 999999999, input: 5.0, cacheInput: 0.5, output: 22.5 },
      ],
    },
    'gpt-5.4-mini': { input: 0.75, cacheInput: 0.075, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, cacheInput: 0.02, output: 1.25 },
    'gpt-5.5': {
      tiers: [
        { threshold: 272000, input: 5.0, cacheInput: 0.5, output: 30.0 },
        { threshold: 999999999, input: 10.0, cacheInput: 1.0, output: 45.0 },
      ],
    },
    'claude-haiku-4.5': { input: 1.0, cacheInput: 0.1, cacheWrite: 1.25, output: 5.0 },
    'claude-sonnet-4': { input: 3.0, cacheInput: 0.3, cacheWrite: 3.75, output: 15.0 },
    'claude-sonnet-4.5': { input: 3.0, cacheInput: 0.3, cacheWrite: 3.75, output: 15.0 },
    'claude-sonnet-4.6': { input: 3.0, cacheInput: 0.3, cacheWrite: 3.75, output: 15.0 },
    'claude-opus-4.5': { input: 5.0, cacheInput: 0.5, cacheWrite: 6.25, output: 25.0 },
    'claude-opus-4.6': { input: 5.0, cacheInput: 0.5, cacheWrite: 6.25, output: 25.0 },
    'claude-opus-4.7': { input: 5.0, cacheInput: 0.5, cacheWrite: 6.25, output: 25.0 },
    'claude-opus-4.8': { input: 5.0, cacheInput: 0.5, cacheWrite: 6.25, output: 25.0 },
    'gemini-2.5-pro': { input: 1.25, cacheInput: 0.125, output: 10.0 },
    'gemini-3-flash': { input: 0.5, cacheInput: 0.05, output: 3.0 },
    'gemini-3.1-pro': { input: 2.0, cacheInput: 0.2, output: 12.0 },
    'gemini-3.5-flash': { input: 1.5, cacheInput: 0.15, output: 9.0 },
    'raptor-mini': { input: 0.25, cacheInput: 0.025, output: 2.0 },
    'mai-code-1-flash': { input: 0.75, cacheInput: 0.075, output: 4.5 },
  },
  // Maps OTel model IDs (gen_ai.request.model) to a pricing key above.
  aliases: { 'oswe-vscode-prime': 'raptor-mini' },
  // Spans from these agents/models are internal overhead, not billed to the user.
  internalAgents: ['title', 'progressMessages', 'summarizeVirtualTools'],
  internalModels: ['gpt-4o-mini-2024-07-18', 'text-embedding-3-small-512'],
};

// Resolve a pricing entry for an OTel model id, applying aliases and tiers.
// Returns null when the model is unknown or explicitly excluded.
function copilotPriceInfo(otelModelId, inputTokens) {
  let key = otelModelId;
  if (Object.prototype.hasOwnProperty.call(COPILOT_PRICING.aliases, otelModelId)) {
    const aliasVal = COPILOT_PRICING.aliases[otelModelId];
    if (!aliasVal) return null;
    key = aliasVal;
  }
  const pricing = COPILOT_PRICING.models[key];
  if (!pricing) return null;
  if (Array.isArray(pricing.tiers)) {
    const tiers = [...pricing.tiers].sort((a, b) => a.threshold - b.threshold);
    for (const tier of tiers) {
      if (inputTokens <= tier.threshold) return tier;
    }
    return tiers[tiers.length - 1];
  }
  return pricing;
}

// Estimate USD cost for a single span. Cache-read tokens are a subset of input
// tokens (not additive), so they are clamped and billed at the cache rate.
function copilotCost(priceInfo, inTokens, outTokens, cacheTok, cacheWriteTok) {
  if (!priceInfo) return null;
  const effectiveCache = Math.min(cacheTok, inTokens);
  const uncachedInput = inTokens - effectiveCache;
  let usd = (uncachedInput / 1e6) * priceInfo.input + (outTokens / 1e6) * priceInfo.output;
  if (priceInfo.cacheInput && effectiveCache > 0) usd += (effectiveCache / 1e6) * priceInfo.cacheInput;
  if (priceInfo.cacheWrite && cacheWriteTok > 0) usd += (cacheWriteTok / 1e6) * priceInfo.cacheWrite;
  return usd;
}

function copilotModelName(otelId) {
  return COPILOT_PRICING.aliases[otelId] || otelId;
}

// Candidate VS Code settings.json locations (remote/WSL server + desktop).
function vscodeSettingsCandidates() {
  const home = os.homedir();
  const paths = [
    path.join(home, '.vscode-server', 'data', 'User', 'settings.json'),
    path.join(home, '.vscode-server-insiders', 'data', 'User', 'settings.json'),
  ];
  if (process.platform === 'darwin') {
    paths.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'));
    paths.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'settings.json'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    paths.push(path.join(appData, 'Code', 'User', 'settings.json'));
    paths.push(path.join(appData, 'Code - Insiders', 'User', 'settings.json'));
  } else {
    paths.push(path.join(home, '.config', 'Code', 'User', 'settings.json'));
    paths.push(path.join(home, '.config', 'Code - Insiders', 'User', 'settings.json'));
    const windowsUsersRoot = '/mnt/c/Users';
    try {
      for (const entry of fs.readdirSync(windowsUsersRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        paths.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'));
        paths.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'settings.json'));
        paths.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'User', 'settings.json'));
        paths.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Microsoft VS Code - Insiders', 'User', 'settings.json'));
      }
    } catch {
      // ignore
    }
  }
  return Array.from(new Set(paths.map((p) => path.resolve(p))));
}

// Enable the Copilot OTel SQLite span exporter in VS Code settings so future
// Copilot Chat sessions are recorded. Edits existing settings files in place
// (with a `.bak` backup); creates one for every installed variant that is
// missing a settings.json (e.g. a remote/server install alongside a desktop
// one — each is checked independently, not gated by whether *some* variant
// already has a file). Returns a summary.
function enableCopilotOtel() {
  const targetKeys = {
    'github.copilot.chat.otel.enabled': true,
    'github.copilot.chat.otel.dbSpanExporter.enabled': true,
  };
  const staleKeys = ['github.copilot.chat.otel.exporterType', 'github.copilot.chat.otel.outfile'];
  const candidates = vscodeSettingsCandidates();
  const results = [];

  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      // No settings.json for this variant yet. Only create one if the variant
      // itself is actually installed (its data dir exists) — avoids sprinkling
      // stray settings.json files for VS Code variants that aren't present.
      const variantDataDir = path.dirname(path.dirname(file));
      if (!fs.existsSync(variantDataDir)) continue;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(targetKeys, null, 2)}\n`, 'utf8');
        results.push({ file, status: 'created' });
      } catch (e) {
        results.push({ file, status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    try {
      const raw = fs.readFileSync(file, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        let changed = false;
        for (const [k, v] of Object.entries(targetKeys)) {
          if (parsed[k] !== v) {
            parsed[k] = v;
            changed = true;
          }
        }
        for (const k of staleKeys) {
          if (k in parsed) {
            delete parsed[k];
            changed = true;
          }
        }
        if (!changed) {
          results.push({ file, status: 'already-set' });
          continue;
        }
        fs.copyFileSync(file, `${file}.bak`);
        fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        results.push({ file, status: 'updated' });
      } else {
        // JSONC with comments: minimal insert before the last closing brace so
        // existing comments/formatting are preserved.
        if (raw.includes('github.copilot.chat.otel.dbSpanExporter.enabled')) {
          results.push({ file, status: 'already-set' });
          continue;
        }
        const lastBrace = raw.lastIndexOf('}');
        if (lastBrace < 0) {
          results.push({ file, status: 'skipped-malformed' });
          continue;
        }
        const before = raw.slice(0, lastBrace).replace(/\s+$/, '');
        const after = raw.slice(lastBrace);
        const sep = before.endsWith('{') || before.endsWith(',') ? '' : ',';
        const insert =
          '  "github.copilot.chat.otel.enabled": true,\n' +
          '  "github.copilot.chat.otel.dbSpanExporter.enabled": true';
        fs.copyFileSync(file, `${file}.bak`);
        fs.writeFileSync(file, `${before}${sep}\n${insert}\n${after}`, 'utf8');
        results.push({ file, status: 'updated' });
      }
    } catch (e) {
      results.push({ file, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}

const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.hg', '.svn', '.next', '.turbo', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'out']);

// Recursively collect filesystem entries matching `matches(entry, fullPath)`
// under a folder (bounded depth, skips noise dirs). Shared by trace-db
// discovery and VS Code chat-session-directory discovery.
export function findFilesRecursive(root, depth, matches, out, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const shouldRecurse = options.shouldRecurse || ((ent, fullPath, currentDepth) => {
    if (SCAN_SKIP_DIRS.has(ent.name)) return false;
    return currentDepth < maxDepth;
  });
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (matches(ent, full)) out.push(full);
    if (ent.isDirectory()) {
      if (!shouldRecurse(ent, full, depth)) continue;
      findFilesRecursive(full, depth + 1, matches, out, options);
    }
  }
  return out;
}

// Locate Copilot OTel trace databases: the default per-variant globalStorage
// `agent-traces.db`, the tmp fallback, plus any folders in COPILOT_TRACES_DIRS
// (comma-separated, scanned recursively). Non-Copilot databases are ignored
// later when the `spans` query fails.
function copilotTraceDbCandidates() {
  const home = os.homedir();
  const globalStorageDirs = [
    path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'github.copilot-chat'),
    path.join(home, '.vscode-server-insiders', 'data', 'User', 'globalStorage', 'github.copilot-chat'),
  ];
  if (process.platform === 'darwin') {
    globalStorageDirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat'));
    globalStorageDirs.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    globalStorageDirs.push(path.join(appData, 'Code', 'User', 'globalStorage', 'github.copilot-chat'));
    globalStorageDirs.push(path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat'));
  } else {
    globalStorageDirs.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat'));
    globalStorageDirs.push(path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat'));
  }

  const found = new Set();
  for (const dir of globalStorageDirs) {
    const dbFile = path.join(dir, 'agent-traces.db');
    if (fs.existsSync(dbFile)) {
      try {
        found.add(fs.realpathSync(dbFile));
      } catch {
        found.add(dbFile);
      }
    }
  }
  const tmpDb = path.join(os.tmpdir(), 'copilot-agent-traces.db');
  if (fs.existsSync(tmpDb)) {
    try {
      found.add(fs.realpathSync(tmpDb));
    } catch {
      found.add(tmpDb);
    }
  }
  const extra = (process.env.COPILOT_TRACES_DIRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isDbFile = (ent) => ent.isFile() && ent.name.endsWith('.db');
  for (const root of extra) {
    for (const full of findFilesRecursive(root, 0, isDbFile, [], { maxDepth: 4 })) {
      try {
        found.add(fs.realpathSync(full));
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return [...found];
}

// Build a conversation_id -> title map from a trace DB, falling back to the
// first line of the earliest user request when no explicit title exists.
function loadConversationTitles(src) {
  const titles = new Map();
  try {
    const rows = src
      .prepare(
        `SELECT DISTINCT s.conversation_id AS cid, sa.value AS title
         FROM spans s JOIN span_attributes sa ON sa.span_id = s.span_id
         WHERE sa.key IN ('gen_ai.conversation.title', 'copilot_chat.conversation.title')
           AND s.conversation_id IS NOT NULL AND sa.value IS NOT NULL`
      )
      .all();
    for (const r of rows) {
      if (r.cid && !titles.has(r.cid)) titles.set(r.cid, r.title);
    }
  } catch {
    // attribute may not exist in older exports
  }
  try {
    const rows = src
      .prepare(
        `SELECT s.conversation_id AS cid, sa.value AS req
         FROM spans s JOIN span_attributes sa ON sa.span_id = s.span_id
         WHERE sa.key = 'copilot_chat.user_request'
           AND s.conversation_id IS NOT NULL AND sa.value IS NOT NULL
         ORDER BY s.start_time_ms ASC`
      )
      .all();
    for (const r of rows) {
      if (r.cid && !titles.has(r.cid) && r.req) {
        const firstLine = String(r.req).split('\n')[0].trim();
        if (firstLine) titles.set(r.cid, firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine);
      }
    }
  } catch {
    // user_request attribute optional
  }
  return titles;
}

// ---------------------------------------------------------------------------
// GitHub Copilot (VS Code) historical import — reads chat session storage
// directly from disk (chatSessions/*.jsonl mutation logs + *.json, plus
// globalStorage/emptyWindowChatSessions and transferredChatSessions). Unlike
// the OTel trace-db import above, this recovers sessions that predate
// enabling OTel tracing. Dedup key: `copilot-vscode-hist:<sessionId>`.
// ---------------------------------------------------------------------------

const CHAT_SESSION_DIR_NAMES = new Set(['chatSessions', 'emptyWindowChatSessions', 'transferredChatSessions']);

function uriToFsPath(uriLike) {
  if (!uriLike) return '';
  if (typeof uriLike === 'string') {
    if (uriLike.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(uriLike).pathname);
      } catch {
        return uriLike;
      }
    }
    return uriLike;
  }
  if (typeof uriLike === 'object' && uriLike.scheme === 'file') {
    return uriLike.path || '';
  }
  return '';
}

// Reconstructs a VS Code chat session object from a *.jsonl mutation log (an
// append-only object-mutation log) or parses a flat *.json session file.
function readChatSessionFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  if (filePath.endsWith('.json')) return JSON.parse(text);
  if (looksLikeCopilotTranscript(text)) return readCopilotTranscriptSession(text, filePath);
  return readVsCodeMutationLog(text);
}

function looksLikeCopilotTranscript(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  try {
    const first = JSON.parse(lines[0]);
    return Boolean(first && typeof first.type === 'string' && first.data && (first.data.sessionId || first.type === 'session.start'));
  } catch {
    return false;
  }
}

function readCopilotTranscriptSession(text, filePath) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId = '';
  let created = 0;
  let promptText = '';
  let responseText = '';

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.data?.sessionId) sessionId = entry.data.sessionId;
    if (entry?.timestamp) {
      const ms = Date.parse(entry.timestamp);
      if (!created && Number.isFinite(ms)) created = ms;
    }
    if (entry?.type === 'session.start' && entry?.data?.startTime) {
      const ms = Date.parse(entry.data.startTime);
      if (Number.isFinite(ms)) created = ms;
    }
    if (entry?.type === 'user.message') {
      const content = extractCopilotTranscriptText(entry.data);
      if (content) promptText = content;
    }
    if (entry?.type === 'assistant.message') {
      const content = extractCopilotTranscriptText(entry.data);
      if (content) responseText = content;
    }
  }

  return {
    customTitle: sessionId ? `Copilot transcript ${sessionId.slice(0, 8)}` : path.basename(filePath),
    creationDate: created || Date.now(),
    workingDirectory: '',
    requests: [{
      message: { text: promptText || responseText || '' },
      response: [{ text: responseText || '' }],
      timestamp: created || Date.now(),
    }],
  };
}

function extractCopilotTranscriptText(data) {
  if (!data) return '';
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.content)) {
    return data.content.map((part) => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : ''))).join('\n');
  }
  if (typeof data.message === 'string') return data.message;
  if (typeof data.text === 'string') return data.text;
  return '';
}

function readVsCodeMutationLog(text) {
  let state;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const entry = JSON.parse(line);
    switch (entry.kind) {
      case 0: // initial complete object state
        state = entry.v;
        break;
      case 1: // set
        if (state === undefined) throw new Error('VS Code chat log missing initial state before set');
        state = applyMutationSet(state, entry.k || [], entry.v);
        break;
      case 2: // push / splice
        if (state === undefined) throw new Error('VS Code chat log missing initial state before push');
        applyMutationPush(state, entry.k || [], entry.v || [], entry.i);
        break;
      case 3: // delete
        if (state === undefined) throw new Error('VS Code chat log missing initial state before delete');
        applyMutationDelete(state, entry.k || []);
        break;
      default:
        throw new Error(`Unsupported VS Code chat mutation kind: ${entry.kind}`);
    }
  }
  if (!state) throw new Error('Empty VS Code chat session log');
  return state;
}

function applyMutationSet(root, keyPath, value) {
  if (keyPath.length === 0) return value;
  const parent = getMutationParent(root, keyPath, true);
  parent[keyPath[keyPath.length - 1]] = value;
  return root;
}

function applyMutationPush(root, keyPath, values, index) {
  const parent = getMutationParent(root, keyPath, true);
  const key = keyPath[keyPath.length - 1];
  if (!Array.isArray(parent[key])) parent[key] = [];
  if (typeof index === 'number') parent[key].length = index;
  if (Array.isArray(values) && values.length > 0) parent[key].push(...values);
}

function applyMutationDelete(root, keyPath) {
  if (keyPath.length === 0) return;
  const parent = getMutationParent(root, keyPath, false);
  if (!parent) return;
  parent[keyPath[keyPath.length - 1]] = undefined;
}

function getMutationParent(root, keyPath, createMissing) {
  let cur = root;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (cur[key] === undefined || cur[key] === null) {
      if (!createMissing) return undefined;
      cur[key] = typeof keyPath[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key];
  }
  return cur;
}

// Non-recursive: *.jsonl/*.json files directly inside `dir`.
function chatSessionFilesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((ent) => ent.isFile() && (ent.name.endsWith('.jsonl') || ent.name.endsWith('.json')))
    .map((ent) => path.join(dir, ent.name));
}

// Reads workspace.json next to a workspaceStorage/<hash> folder to resolve the
// workspace's folder path. Absent for empty-window / transferred sessions.
function readWorkspaceFolderPath(workspaceStorageEntryDir) {
  try {
    const raw = fs.readFileSync(path.join(workspaceStorageEntryDir, 'workspace.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return uriToFsPath(parsed.folder || parsed.workspace || '');
  } catch {
    return '';
  }
}

// Best-effort title/archived lookup from state.vscdb's chat.ChatSessionStore.index,
// used only when a session has no customTitle of its own. Never throws.
function readSessionIndexMeta(stateDbPath, sessionId) {
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true, timeout: 2000 });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get();
    if (!row || !row.value) return null;
    const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : Object.values(parsed || {});
    for (const item of entries) {
      if (item && (item.sessionId === sessionId || item.id === sessionId)) {
        return { title: item.title || null, archived: Boolean(item.archived || item.isArchived) };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// Discovers chat session files under the standard VS Code roots (workspaceStorage
// + globalStorage) plus any user-registered extra paths, which are recursively
// scanned (bounded depth) for chatSessions/emptyWindowChatSessions/transferredChatSessions
// directories — for non-default installs, mounted backups, synced profiles, etc.
function discoverChatSessionSources(extraPaths) {
  const home = os.homedir();
  const userDataDirs = [
    path.join(home, '.vscode-server', 'data', 'User'),
    path.join(home, '.vscode-server-insiders', 'data', 'User'),
  ];
  if (process.platform === 'darwin') {
    userDataDirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
    userDataDirs.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    userDataDirs.push(path.join(appData, 'Code', 'User'));
    userDataDirs.push(path.join(appData, 'Code - Insiders', 'User'));
  } else {
    userDataDirs.push(path.join(home, '.config', 'Code', 'User'));
    userDataDirs.push(path.join(home, '.config', 'Code - Insiders', 'User'));
    const windowsUsersRoot = '/mnt/c/Users';
    try {
      const entries = fs.readdirSync(windowsUsersRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        userDataDirs.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Code', 'User'));
        userDataDirs.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Roaming', 'Code - Insiders', 'User'));
        userDataDirs.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'User'));
        userDataDirs.push(path.join(windowsUsersRoot, entry.name, 'AppData', 'Local', 'Programs', 'Microsoft VS Code - Insiders', 'User'));
      }
    } catch {
      // WSL Windows users root unavailable
    }
  }

  const sources = [];

  for (const userDataDir of userDataDirs) {
    const workspaceStorageDir = path.join(userDataDir, 'workspaceStorage');
    let workspaceHashes = [];
    try {
      workspaceHashes = fs.readdirSync(workspaceStorageDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      workspaceHashes = [];
    }
    for (const hashEntry of workspaceHashes) {
      const workspaceDir = path.join(workspaceStorageDir, hashEntry.name);
      const workspacePath = readWorkspaceFolderPath(workspaceDir);
      const stateDbPath = path.join(workspaceDir, 'state.vscdb');
      for (const file of chatSessionFilesIn(path.join(workspaceDir, 'chatSessions'))) {
        sources.push({ path: file, workspacePath, stateDbPath });
      }
      for (const file of chatSessionFilesIn(path.join(workspaceDir, 'GitHub.copilot-chat', 'transcripts'))) {
        sources.push({ path: file, workspacePath, stateDbPath });
      }
    }
    const globalStorageDir = path.join(userDataDir, 'globalStorage');
    const globalStateDbPath = path.join(globalStorageDir, 'state.vscdb');
    for (const sub of ['emptyWindowChatSessions', 'transferredChatSessions']) {
      for (const file of chatSessionFilesIn(path.join(globalStorageDir, sub))) {
        sources.push({ path: file, workspacePath: '', stateDbPath: globalStateDbPath });
      }
    }
  }

  const isHistoryDir = (ent) => ent.isDirectory() && (CHAT_SESSION_DIR_NAMES.has(ent.name) || ent.name === 'transcripts');
  for (const extraRoot of extraPaths) {
    for (const dir of findFilesRecursive(extraRoot, 0, isHistoryDir, [], { maxDepth: 4 })) {
      const parentDir = path.dirname(dir);
      const workspacePath = readWorkspaceFolderPath(parentDir);
      const stateDbPath = path.join(parentDir, 'state.vscdb');
      for (const file of chatSessionFilesIn(dir)) {
        sources.push({ path: file, workspacePath, stateDbPath });
      }
    }
  }

  return sources;
}

function extractRequestText(req) {
  if (typeof req?.message?.text === 'string') return req.message.text;
  if (Array.isArray(req?.message?.parts)) {
    return req.message.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
  }
  return '';
}

function extractResponsePartText(part) {
  if (typeof part === 'string') return part;
  if (typeof part?.value === 'string') return part.value;
  if (typeof part?.content === 'string') return part.content;
  if (typeof part?.content?.value === 'string') return part.content.value;
  if (typeof part?.text === 'string') return part.text;
  return '';
}

// ~4 chars/token, used only when a session has no persisted token counts.
function estimateTokensFromSessionText(requests) {
  let inputChars = 0;
  let outputChars = 0;
  for (const req of requests) {
    inputChars += extractRequestText(req).length;
    if (Array.isArray(req.response)) {
      outputChars += req.response.map(extractResponsePartText).join('\n').length;
    }
  }
  return { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(outputChars / 4) };
}

function maxRequestTimestamp(requests) {
  let max = 0;
  for (const req of requests) {
    max = Math.max(max, Number(req.timestamp || 0));
    max = Math.max(max, Number(req?.modelState?.completedAt || 0));
  }
  return max;
}

// Normalizes a parsed VS Code chat session into imported_session fields.
// Prefers exact persisted promptTokens/completionTokens/copilotCredits; falls
// back to estimating tokens from message text when none are present.
function extractCopilotCredits(req) {
  if (!req || typeof req !== 'object') return 0;
  const candidates = [
    req.copilotCredits,
    req.credits,
    req.credit,
    req?.usage?.copilotCredits,
    req?.usage?.credits,
    req?.credits?.copilotCredits,
  ];
  for (const candidate of candidates) {
    const val = Number(candidate);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return 0;
}

function normalizeVscodeHistorySession(session, sessionId, ctx) {
  const requests = Array.isArray(session.requests) ? session.requests : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let credits = 0;
  let hasExactUsage = false;
  let modelId = '';
  let firstPrompt = '';

  for (const req of requests) {
    const prompt = Number(req.promptTokens || 0);
    const completion = Number(req.completionTokens || 0);
    const reqCredits = extractCopilotCredits(req);
    if (prompt > 0 || completion > 0 || reqCredits > 0) hasExactUsage = true;
    inputTokens += prompt;
    outputTokens += completion;
    credits += reqCredits;
    if (!modelId && typeof req.modelId === 'string') modelId = req.modelId;
    if (!firstPrompt) firstPrompt = extractRequestText(req).trim();
  }

  let quality = 'vscode_persisted_usage';
  if (!hasExactUsage) {
    const estimated = estimateTokensFromSessionText(requests);
    inputTokens = estimated.inputTokens;
    outputTokens = estimated.outputTokens;
    quality = 'estimated_from_text';
  }

  const priceInfo = modelId ? copilotPriceInfo(modelId, inputTokens) : null;
  const cost = credits > 0 ? credits * 0.01 : copilotCost(priceInfo, inputTokens, outputTokens, 0, 0) || 0;

  const created = Number(session.creationDate) || ctx.fileBirthMs || Date.now();
  const updated = maxRequestTimestamp(requests) || ctx.fileMtimeMs || created;
  const archived = Boolean(ctx.indexMeta && ctx.indexMeta.archived);
  const title = session.customTitle || (ctx.indexMeta && ctx.indexMeta.title) || firstPrompt.slice(0, 100) || 'Copilot Chat Session';

  return {
    importId: `copilot-vscode-hist:${sessionId}`,
    title,
    cost,
    inputTokens,
    outputTokens,
    model: `copilot/${copilotModelName(modelId || 'unknown')}`,
    directory: uriToFsPath(session.workingDirectory) || ctx.workspacePath || '',
    timeCreated: Math.floor(created),
    timeUpdated: Math.floor(updated),
    archived,
    quality,
    raw: JSON.stringify({ sessionId, modelId, quality }),
  };
}

// Scans all discovered chat session files, normalizes each, and upserts into
// imported_session. Idempotent: dedup key is `copilot-vscode-hist:<sessionId>`.
// Unreadable/malformed files are skipped (counted, not thrown).
function importVscodeHistoryFiles(db, provider, options = {}, seen = createCopilotVscodeSeenState()) {
  const force = Boolean(options.force);
  db.prepare('DELETE FROM imported_session WHERE provider = ? AND cost <= 0').run(provider);
  const existing = new Set(
    db.prepare('SELECT import_id FROM imported_session WHERE provider = ?').all(provider).map((r) => r.import_id)
  );
  const upsert = db.prepare(`
    INSERT INTO imported_session (
      import_id, id, project_id, title, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, model, agent,
      directory, time_created, time_updated, time_archived, provider, session_id,
      imported_at, raw
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(import_id) DO UPDATE SET
      title = excluded.title,
      cost = excluded.cost,
      tokens_input = excluded.tokens_input,
      tokens_output = excluded.tokens_output,
      model = excluded.model,
      directory = excluded.directory,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated,
      time_archived = excluded.time_archived,
      imported_at = excluded.imported_at,
      raw = excluded.raw
  `);

  const sources = discoverChatSessionSources(getScanPaths());
  const now = Date.now();
  const existingDateBuckets = getExistingImportDateBuckets(db, provider);
  let found = 0;
  let imported = 0;
  let skipped = 0;
  let cost = 0;
  let parseErrors = 0;

  for (const source of sources) {
    found += 1;
    const sessionId = path.basename(source.path).replace(/\.(jsonl|json)$/, '');
    let stat = null;
    try {
      stat = fs.statSync(source.path);
    } catch {
      // ignore
    }
    try {
      const session = readChatSessionFile(source.path);
      const indexMeta = readSessionIndexMeta(source.stateDbPath, sessionId);
      const normalized = normalizeVscodeHistorySession(session, sessionId, {
        workspacePath: source.workspacePath,
        indexMeta,
        fileBirthMs: stat ? stat.birthtimeMs : undefined,
        fileMtimeMs: stat ? stat.mtimeMs : undefined,
      });

      const shouldPersist = normalized.cost > 0;
      if (!shouldPersist) {
        skipped += 1;
        continue;
      }

      const dateBucket = getImportDateBucket(normalized.timeCreated);
      const skipByDate = shouldSkipImportForDate(dateBucket, existingDateBuckets, force);
      if (skipByDate || existing.has(normalized.importId) || isCopilotVscodeDuplicate(seen, normalized.importId, sessionId)) {
        skipped += 1;
        continue;
      }

      cost += normalized.cost;
      upsert.run(
        normalized.importId,
        normalized.importId,
        null,
        normalized.title,
        normalized.cost,
        normalized.inputTokens,
        normalized.outputTokens,
        0,
        0,
        0,
        normalized.model,
        provider,
        normalized.directory,
        normalized.timeCreated,
        normalized.timeUpdated,
        normalized.archived ? normalized.timeUpdated : null,
        provider,
        sessionId,
        now,
        normalized.raw
      );

      imported += 1;
    } catch {
      parseErrors += 1;
    }
  }

  return { found, imported, skipped, cost, parseErrors };
}

/**
 * Import VS Code Copilot Chat sessions from the local OTel trace DB(s).
 * Enables the OTel exporter (future sessions), discovers trace databases,
 * aggregates `invoke_agent` spans per conversation, estimates cost, and upserts
 * into imported_session. Idempotent: dedup key is `copilot-vscode:<conversationId>`.
 */
async function importCopilotVscodeOtel(db, provider, options = {}, seen = createCopilotVscodeSeenState()) {
  const force = Boolean(options.force);
  const entry = PROVIDERS.find((p) => p.id === 'copilot-vscode');
  const dbFiles = copilotTraceDbCandidates();
  const existing = new Set(
    db
      .prepare('SELECT import_id FROM imported_session WHERE provider = ?')
      .all(provider)
      .map((r) => r.import_id)
  );
  const upsert = db.prepare(`
    INSERT INTO imported_session (
      import_id, id, project_id, title, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, model, agent,
      directory, time_created, time_updated, time_archived, provider, session_id,
      imported_at, raw
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(import_id) DO UPDATE SET
      title = excluded.title,
      cost = excluded.cost,
      tokens_input = excluded.tokens_input,
      tokens_output = excluded.tokens_output,
      tokens_cache_read = excluded.tokens_cache_read,
      tokens_cache_write = excluded.tokens_cache_write,
      model = excluded.model,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated,
      imported_at = excluded.imported_at,
      raw = excluded.raw
  `);

  const conversations = new Map();
  let usedDbs = 0;

  for (const dbFile of dbFiles) {
    let src;
    try {
      src = new DatabaseSync(dbFile, { readOnly: true });
      const rows = src
        .prepare(
          `SELECT
             s.span_id        AS span_id,
             s.conversation_id AS conversation_id,
             s.request_model  AS model,
             s.agent_name     AS agent,
             s.start_time_ms  AS start_ms,
             s.end_time_ms    AS end_ms,
             MAX(CASE WHEN sa.key = 'gen_ai.usage.input_tokens' THEN CAST(sa.value AS INTEGER) END) AS input_tokens,
             MAX(CASE WHEN sa.key = 'gen_ai.usage.output_tokens' THEN CAST(sa.value AS INTEGER) END) AS output_tokens,
             MAX(CASE WHEN sa.key = 'gen_ai.usage.cache_read.input_tokens' THEN CAST(sa.value AS INTEGER) END) AS cache_read,
             MAX(CASE WHEN sa.key = 'gen_ai.usage.cache_creation.input_tokens' THEN CAST(sa.value AS INTEGER) END) AS cache_write
           FROM spans s
           LEFT JOIN span_attributes sa ON sa.span_id = s.span_id
           WHERE s.name LIKE 'invoke_agent%'
           GROUP BY s.span_id`
        )
        .all();
      const titles = loadConversationTitles(src);
      usedDbs += 1;

      for (const r of rows) {
        if (r.agent && COPILOT_PRICING.internalAgents.includes(r.agent)) continue;
        if (!r.model || COPILOT_PRICING.internalModels.includes(r.model)) continue;

        const input = Number(r.input_tokens) || 0;
        const output = Number(r.output_tokens) || 0;
        const cacheRead = Number(r.cache_read) || 0;
        const cacheWrite = Number(r.cache_write) || 0;
        const cost = copilotCost(copilotPriceInfo(r.model, input), input, output, cacheRead, cacheWrite) || 0;
        const convId = r.conversation_id || r.span_id;
        const modelName = copilotModelName(r.model);

        let conv = conversations.get(convId);
        if (!conv) {
          conv = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            models: new Map(),
            tStart: Infinity,
            tEnd: 0,
            title: null,
          };
          conversations.set(convId, conv);
        }
        conv.input += input;
        conv.output += output;
        conv.cacheRead += cacheRead;
        conv.cacheWrite += cacheWrite;
        conv.cost += cost;
        conv.models.set(modelName, (conv.models.get(modelName) || 0) + cost);
        const st = Number(r.start_ms) || 0;
        const en = Number(r.end_ms) || 0;
        if (st && st < conv.tStart) conv.tStart = st;
        if (en && en > conv.tEnd) conv.tEnd = en;
        if (!conv.title && titles.has(convId)) conv.title = titles.get(convId);
      }
    } catch {
      // Not a Copilot OTel export or unreadable — skip.
    } finally {
      if (src) {
        try {
          src.close();
        } catch {
          // ignore
        }
      }
    }
  }

  let imported = 0;
  let skipped = 0;
  let cost = 0;
  const now = Date.now();
  const existingDateBuckets = getExistingImportDateBuckets(db, provider);

  for (const [convId, conv] of conversations) {
    const importId = `${provider}:${convId}`;
    let topModel = 'unknown';
    let bestCost = -1;
    for (const [m, c] of conv.models) {
      if (c > bestCost) {
        bestCost = c;
        topModel = m;
      }
    }
    const model = `copilot/${topModel}`;
    const tEnd = conv.tEnd || (Number.isFinite(conv.tStart) ? conv.tStart : now);
    const tStart = Number.isFinite(conv.tStart) ? conv.tStart : tEnd;
    const title = conv.title || `${entry.label} ${String(convId).slice(0, 8)}`;
    const dateBucket = getImportDateBucket(tStart || tEnd || now);
    const skipByDate = shouldSkipImportForDate(dateBucket, existingDateBuckets, force);
    if (skipByDate || existing.has(importId) || isCopilotVscodeDuplicate(seen, importId, String(convId))) {
      skipped += 1;
      continue;
    }
    cost += conv.cost;

    upsert.run(
      importId,
      importId,
      null,
      title,
      conv.cost,
      conv.input,
      conv.output,
      0,
      conv.cacheRead,
      conv.cacheWrite,
      model,
      provider,
      null,
      tStart,
      tEnd,
      null,
      provider,
      String(convId),
      now,
      JSON.stringify({ conversation_id: convId, models: [...conv.models.entries()] })
    );

    imported += 1;
  }

  return { found: conversations.size, imported, skipped, cost, usedDbs };
}

async function runCopilotVscodeImport(options = {}) {
  const force = Boolean(options.force);
  const phase = String(options.phase || 'all').toLowerCase();
  const entry = PROVIDERS.find((p) => p.id === 'copilot-vscode');
  const provider = 'copilot-vscode';
  enableCopilotOtel();

  ensureImportsDb();
  const db = new DatabaseSync(importsDbPath());
  try {
    const seen = createCopilotVscodeSeenState();
    if (phase === 'history') {
      const history = importVscodeHistoryFiles(db, provider, { force }, seen);
      const historyNote =
        history.found > 0
          ? `Scanned ${history.found} local chat session file(s) on disk${history.parseErrors ? ` (${history.parseErrors} unreadable)` : ''}, recovering history from before OpenTelemetry tracing was enabled.`
          : 'No local chat session files found on disk yet.';
      return {
        provider: entry.id,
        label: entry.label,
        found: history.found,
        imported: history.imported,
        skipped: history.skipped,
        cost: history.cost,
        note: historyNote,
        stage: 'history',
      };
    }

    if (phase === 'otel') {
      const otel = await importCopilotVscodeOtel(db, provider, { force }, seen);
      const otelNote =
        otel.usedDbs === 0
          ? 'Enabled VS Code OpenTelemetry tracing for exact future usage — no trace database found yet.'
          : `Read ${otel.usedDbs} Copilot trace database(s) for exact per-call usage.`;
      return {
        provider: entry.id,
        label: entry.label,
        found: otel.found,
        imported: otel.imported,
        skipped: otel.skipped,
        cost: otel.cost,
        note: otelNote,
        stage: 'otel',
      };
    }

    const history = importVscodeHistoryFiles(db, provider, { force }, seen);
    const otel = await importCopilotVscodeOtel(db, provider, { force }, seen);
    const historyNote =
      history.found > 0
        ? `Scanned ${history.found} local chat session file(s) on disk${history.parseErrors ? ` (${history.parseErrors} unreadable)` : ''}, recovering history from before OpenTelemetry tracing was enabled.`
        : 'No local chat session files found on disk yet.';
    const otelNote =
      otel.usedDbs === 0
        ? 'Enabled VS Code OpenTelemetry tracing for exact future usage — no trace database found yet.'
        : `Read ${otel.usedDbs} Copilot trace database(s) for exact per-call usage.`;

    return {
      provider: entry.id,
      label: entry.label,
      found: history.found + otel.found,
      imported: history.imported + otel.imported,
      skipped: history.skipped + otel.skipped,
      cost: Number((history.cost + otel.cost).toFixed(4)),
      note: `${historyNote} ${otelNote}`,
      stage: 'complete',
    };
  } finally {
    db.close();
  }
}
