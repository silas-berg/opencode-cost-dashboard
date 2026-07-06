import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PROVIDERS, importsDbPath, ensureImportsDb, runProviderImport, discoverAccounts, getScanPaths, addScanPath, removeScanPath } from './imports.mjs';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4795);
const assetsDir = path.join(process.cwd(), 'opencode-cost-dashboard-assets');
const dbPath = (() => {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'opencode.db');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode', 'opencode.db');
  }
  const xdgData = process.env.XDG_DATA_HOME;
  const base = xdgData && xdgData.length > 0 ? xdgData : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function parseModel(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  try {
    const parsed = JSON.parse(raw);
    const provider = parsed.providerID || '';
    const id = parsed.id || parsed.modelID || '';
    return provider && id ? `${provider}/${id}` : id || provider || 'unknown';
  } catch {
    return raw;
  }
}

function bigintSafe(_key, value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function openDb() {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  const importDbPathValue = importsDbPath().replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${importDbPathValue}' AS imp`);
  return db;
}

// Columns shared by the OpenCode `session` table and the imported_session table,
// UNIONed so imported provider sessions appear alongside native ones in every query.
const SESSION_COLS =
  'id, project_id, title, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, model, agent, directory, time_created, time_updated, time_archived';
const SESSION_SOURCE = `(SELECT ${SESSION_COLS}, NULL AS provider FROM session UNION ALL SELECT ${SESSION_COLS}, provider FROM imp.imported_session)`;

function parseTimeWindowValue(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null) {
    if (month === null) return null;
    const maxDay = new Date(year, month, 0).getDate();
    if (day < 1 || day > maxDay) return null;
  }
  return { raw: value, precision: day ? 'day' : month ? 'month' : 'year' };
}

function getTimeWindowClauses(params) {
  const clauses = [];
  const values = [];
  const day = typeof params.day === 'string' ? params.day.trim() : '';
  const month = typeof params.month === 'string' ? params.month.trim() : '';
  const year = typeof params.year === 'string' ? params.year.trim() : '';
  const start = typeof params.start === 'string' ? params.start.trim() : '';
  const end = typeof params.end === 'string' ? params.end.trim() : '';

  if (start || end) {
    const startValue = start || end;
    const endValue = end || start;
    const startParsed = parseTimeWindowValue(startValue);
    const endParsed = parseTimeWindowValue(endValue);
    if (startParsed && endParsed && startParsed.precision === endParsed.precision) {
      if (startParsed.precision === 'day') {
        clauses.push("strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') >= ? AND strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') <= ?");
        values.push(startValue, endValue);
      } else if (startParsed.precision === 'month') {
        clauses.push("strftime('%Y-%m', time_created/1000, 'unixepoch', 'localtime') >= ? AND strftime('%Y-%m', time_created/1000, 'unixepoch', 'localtime') <= ?");
        values.push(startValue, endValue);
      } else {
        clauses.push("strftime('%Y', time_created/1000, 'unixepoch', 'localtime') >= ? AND strftime('%Y', time_created/1000, 'unixepoch', 'localtime') <= ?");
        values.push(startValue, endValue);
      }
    } else {
      clauses.push('1 = 0');
    }
  } else if (day) {
    const parts = day.split(/\s+to\s+/i);
    if (parts.length > 1) {
      const startDay = parseTimeWindowValue(parts[0].trim());
      const endDay = parseTimeWindowValue(parts[1] ? parts[1].trim() : parts[0].trim());
      if (startDay && endDay && startDay.precision === 'day' && endDay.precision === 'day') {
        clauses.push("strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') >= ? AND strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') <= ?");
        values.push(parts[0].trim(), parts[1] ? parts[1].trim() : parts[0].trim());
      } else {
        clauses.push('1 = 0');
      }
    } else {
      const parsedDay = parseTimeWindowValue(day);
      if (parsedDay && parsedDay.precision === 'day') {
        clauses.push("strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') = ?");
        values.push(day);
      } else {
        clauses.push('1 = 0');
      }
    }
  } else if (month) {
    const parts = month.split(/\s+to\s+/i);
    if (parts.length > 1) {
      const startMonth = parseTimeWindowValue(parts[0].trim());
      const endMonth = parseTimeWindowValue(parts[1] ? parts[1].trim() : parts[0].trim());
      if (startMonth && endMonth && startMonth.precision === 'month' && endMonth.precision === 'month') {
        clauses.push("strftime('%Y-%m', time_created/1000, 'unixepoch', 'localtime') >= ? AND strftime('%Y-%m', time_created/1000, 'unixepoch', 'localtime') <= ?");
        values.push(parts[0].trim(), parts[1] ? parts[1].trim() : parts[0].trim());
      } else {
        clauses.push('1 = 0');
      }
    } else {
      const parsedMonth = parseTimeWindowValue(month);
      if (parsedMonth && parsedMonth.precision === 'month') {
        clauses.push("strftime('%Y-%m', time_created/1000, 'unixepoch', 'localtime') = ?");
        values.push(month);
      } else {
        clauses.push('1 = 0');
      }
    }
  } else if (year) {
    const parts = year.split(/\s+to\s+/i);
    if (parts.length > 1) {
      const startYear = parseTimeWindowValue(parts[0].trim());
      const endYear = parseTimeWindowValue(parts[1] ? parts[1].trim() : parts[0].trim());
      if (startYear && endYear && startYear.precision === 'year' && endYear.precision === 'year') {
        clauses.push("strftime('%Y', time_created/1000, 'unixepoch', 'localtime') >= ? AND strftime('%Y', time_created/1000, 'unixepoch', 'localtime') <= ?");
        values.push(parts[0].trim(), parts[1] ? parts[1].trim() : parts[0].trim());
      } else {
        clauses.push('1 = 0');
      }
    } else {
      const parsedYear = parseTimeWindowValue(year);
      if (parsedYear && parsedYear.precision === 'year') {
        clauses.push("strftime('%Y', time_created/1000, 'unixepoch', 'localtime') = ?");
        values.push(year);
      } else {
        clauses.push('1 = 0');
      }
    }
  }

  return { clauses, values };
}

function buildSessionWhere(projectId, params = {}, timeColumn = 'time_created', idColumn = 'id') {
  const clauses = ['time_archived IS NULL'];
  const values = [];
  const provider = typeof params.provider === 'string' ? params.provider.trim() : '';
  if (projectId) {
    if (projectId.startsWith('import:')) {
      const match = /^import:([^:]+):(.*)$/.exec(projectId);
      if (match) {
        clauses.push('provider = ?');
        values.push(match[1]);
        clauses.push('directory = ?');
        values.push(match[2] || '');
      } else {
        clauses.push('project_id = ?');
        values.push(projectId);
      }
    } else {
      clauses.push('project_id = ?');
      values.push(projectId);
    }
  }
  if (provider && !projectId?.startsWith('import:')) {
    clauses.push('provider = ?');
    values.push(provider);
  }
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (sessionId) {
    clauses.push(`${idColumn} = ?`);
    values.push(sessionId);
  }
  const timeClauses = getTimeWindowClauses(params);
  if (timeClauses.clauses.length > 0) {
    clauses.push(...timeClauses.clauses.map((clause) => clause.replaceAll('time_created', timeColumn)));
    values.push(...timeClauses.values);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function getOverview(db, projectId, params = {}) {
  const { where, values } = buildSessionWhere(projectId, params);
  const stmt = db.prepare(`
    SELECT COUNT(*) as sessionCount, COALESCE(SUM(cost),0) as totalCost,
           COALESCE(SUM(tokens_input),0) as totalInput, COALESCE(SUM(tokens_output),0) as totalOutput,
           COALESCE(SUM(tokens_cache_read),0) as totalCacheRead, COALESCE(SUM(tokens_cache_write),0) as totalCacheWrite,
           MIN(time_created) as earliest, MAX(time_created) as latest
    FROM ${SESSION_SOURCE} ${where}
  `);
  return values.length ? stmt.get(...values) : stmt.get();
}

function getTimeseries(db, bucket, projectId, params = {}) {
  const expr = {
    hour: "strftime('%Y-%m-%d %H:00', time_created/1000, 'unixepoch', 'localtime')",
    day: "date(time_created/1000, 'unixepoch', 'localtime')",
    week: "date(time_created/1000, 'unixepoch', 'localtime', 'weekday 0', '-6 days')",
    month: "strftime('%Y-%m', time_created/1000, 'unixepoch', 'localtime')",
    year: "strftime('%Y', time_created/1000, 'unixepoch', 'localtime')",
  }[bucket] || "date(time_created/1000, 'unixepoch', 'localtime')";

  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';

  // Calculate full context query ignoring sessionId filter
  const paramsFull = { ...params, sessionId: undefined };
  const { where: whereFull, values: valuesFull } = buildSessionWhere(projectId, paramsFull);

  // If a sessionId filter is active, we also query the query filtered WITH the sessionId
  let stmt;
  if (sessionId) {
    const { where: whereFiltered, values: valuesFiltered } = buildSessionWhere(projectId, params);
    stmt = db.prepare(`
      SELECT 
        all_t.period, 
        COALESCE(all_t.cost, 0) as totalCost, 
        COALESCE(fil_t.cost, 0) as filteredCost,
        COALESCE(all_t.sessionCount, 0) as totalSessionCount,
        COALESCE(fil_t.sessionCount, 0) as filteredSessionCount
      FROM (
        SELECT ${expr} as period, SUM(cost) as cost, COUNT(*) as sessionCount
        FROM ${SESSION_SOURCE} ${whereFull}
        GROUP BY period
      ) all_t
      LEFT JOIN (
        SELECT ${expr} as period, SUM(cost) as cost, COUNT(*) as sessionCount
        FROM ${SESSION_SOURCE} ${whereFiltered}
        GROUP BY period
      ) fil_t ON all_t.period = fil_t.period
      ORDER BY all_t.period ASC
    `);
    return stmt.all(...valuesFull, ...valuesFiltered);
  } else {
    stmt = db.prepare(`
      SELECT ${expr} as period, COALESCE(SUM(cost),0) as cost, COUNT(*) as sessionCount,
             COALESCE(SUM(tokens_input),0) as tokensInput, COALESCE(SUM(tokens_output),0) as tokensOutput
      FROM ${SESSION_SOURCE} ${whereFull}
      GROUP BY period ORDER BY period ASC
    `);
    const rows = valuesFull.length ? stmt.all(...valuesFull) : stmt.all();
    return rows.map(r => ({
      period: r.period,
      totalCost: r.cost,
      filteredCost: null,
      totalSessionCount: r.sessionCount,
      filteredSessionCount: null
    }));
  }
}

function getSessions(db, projectId, limit = 300, params = {}) {
  const { where, values } = buildSessionWhere(projectId, params, 's.time_created', 's.id');
  const stmt = db.prepare(`
    SELECT s.id, s.title, s.cost, s.tokens_input as tokensInput, s.tokens_output as tokensOutput,
           s.tokens_cache_read as tokensCacheRead, s.tokens_cache_write as tokensCacheWrite,
           s.model, s.agent, s.directory, s.time_created as timeCreated, s.time_updated as timeUpdated,
           s.provider as provider,
           CASE WHEN s.time_updated > s.time_created THEN s.time_updated - s.time_created ELSE 0 END as durationMs,
           p.worktree as projectWorktree, p.name as projectName
    FROM ${SESSION_SOURCE} s LEFT JOIN project p ON s.project_id = p.id
    ${where}
    ORDER BY s.time_created DESC LIMIT ?
  `);
  const args = values.length ? [...values, limit] : [limit];
  const rows = stmt.all(...args);
  return rows.map((r) => ({ ...r, model: parseModel(r.model) }));
}

function getModelBreakdown(db, projectId, params = {}) {
  const { where, values } = buildSessionWhere(projectId, params);
  const stmt = db.prepare(`
    SELECT model,
           COUNT(*) as sessionCount,
           COALESCE(SUM(cost),0) as totalCost,
           COALESCE(SUM(tokens_input),0) as tokensInput,
           COALESCE(SUM(tokens_output),0) as tokensOutput,
           COALESCE(SUM(tokens_cache_read),0) as tokensCacheRead,
           COALESCE(SUM(tokens_cache_write),0) as tokensCacheWrite,
           COALESCE(SUM(CASE WHEN time_updated > time_created THEN time_updated - time_created ELSE 0 END),0) as totalDurationMs
    FROM ${SESSION_SOURCE} ${where}
    GROUP BY model
    ORDER BY totalCost DESC
  `);
  const rows = values.length ? stmt.all(...values) : stmt.all();
  return rows.map((r) => ({ ...r, model: parseModel(r.model) }));
}

function getProjects(db, sessionId, params = {}) {
  const clauses = ['s.time_archived IS NULL'];
  const values = [];
  const provider = typeof params.provider === 'string' ? params.provider.trim() : '';
  if (sessionId) {
    clauses.push('s.session_id = ?');
    values.push(sessionId);
  }
  if (provider) {
    clauses.push('s.provider = ?');
    values.push(provider);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const stmt = db.prepare(`
    SELECT
      s.id,
      s.worktree,
      s.name,
      COUNT(s.id) as sessionCount,
      COALESCE(SUM(s.cost),0) as totalCost
    FROM (
      SELECT
        p.id as id,
        p.worktree as worktree,
        p.name as name,
        s.id as session_id,
        s.cost as cost,
        s.time_archived as time_archived,
        NULL as provider,
        s.project_id as project_id,
        s.directory as directory
      FROM project p
      JOIN session s ON s.project_id = p.id
      UNION ALL
      SELECT
        CASE
          WHEN imp.project_id IS NOT NULL THEN imp.project_id
          ELSE 'import:' || imp.provider || ':' || COALESCE(imp.directory, '')
        END as id,
        CASE
          WHEN p.id IS NOT NULL THEN p.worktree
          ELSE COALESCE(imp.directory, '')
        END as worktree,
        CASE
          WHEN p.id IS NOT NULL THEN p.name
          ELSE COALESCE(imp.directory, imp.provider || ' import')
        END as name,
        imp.id as session_id,
        imp.cost as cost,
        imp.time_archived as time_archived,
        imp.provider as provider,
        imp.project_id as project_id,
        imp.directory as directory
      FROM imp.imported_session imp
      LEFT JOIN project p ON imp.project_id = p.id
    ) s
    ${where}
    GROUP BY s.id, s.worktree, s.name
    HAVING COALESCE(SUM(s.cost),0) > 0
    ORDER BY totalCost DESC
  `);
  return values.length ? stmt.all(...values) : stmt.all();
}

function getActiveDays(db, projectId, params = {}) {
  const { where, values } = buildSessionWhere(projectId, params);
  const stmt = db.prepare(`
    SELECT strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') as day,
           COUNT(*) as sessionCount,
           COALESCE(SUM(cost),0) as totalCost
    FROM ${SESSION_SOURCE} ${where}
    GROUP BY day ORDER BY day ASC
  `);
  return values.length ? stmt.all(...values) : stmt.all();
}

function getContributionGrid(db, projectId, year, sessionId, params = {}) {
  const safeYear = String(year || new Date().getFullYear());
  const provider = typeof params.provider === 'string' ? params.provider.trim() : '';

  // Get full activity data for baseline
  const clausesFull = ['time_archived IS NULL'];
  const valuesFull = [];
  if (projectId) {
    if (projectId.startsWith('import:')) {
      const match = /^import:([^:]+):(.*)$/.exec(projectId);
      if (match) {
        clausesFull.push('provider = ?');
        valuesFull.push(match[1]);
        clausesFull.push('directory = ?');
        valuesFull.push(decodeURIComponent(match[2] || ''));
      } else {
        clausesFull.push('project_id = ?');
        valuesFull.push(projectId);
      }
    } else {
      clausesFull.push('project_id = ?');
      valuesFull.push(projectId);
    }
  }
  if (provider && !projectId?.startsWith('import:')) {
    clausesFull.push('provider = ?');
    valuesFull.push(provider);
  }
  clausesFull.push("strftime('%Y', time_created/1000, 'unixepoch', 'localtime') = ?");
  valuesFull.push(safeYear);

  const whereFull = `WHERE ${clausesFull.join(' AND ')}`;
  const stmtFull = db.prepare(`
    SELECT strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') as day,
           COALESCE(SUM(cost),0) as totalCost
    FROM ${SESSION_SOURCE} ${whereFull}
    GROUP BY day
  `);
  const rowsFull = stmtFull.all(...valuesFull);
  const totalCostByDay = new Map(rowsFull.map((row) => [row.day, Number(row.totalCost) || 0]));

  // Get filtered activity data if session ID is set
  let filteredCostByDay = new Map();
  if (sessionId) {
    const clausesFiltered = ['time_archived IS NULL', 'id = ?'];
    const valuesFiltered = [sessionId];
    if (projectId) {
      if (projectId.startsWith('import:')) {
        const match = /^import:([^:]+):(.*)$/.exec(projectId);
        if (match) {
          clausesFiltered.push('provider = ?');
          valuesFiltered.push(match[1]);
          clausesFiltered.push('directory = ?');
          valuesFiltered.push(match[2] || '');
        } else {
          clausesFiltered.push('project_id = ?');
          valuesFiltered.push(projectId);
        }
      } else {
        clausesFiltered.push('project_id = ?');
        valuesFiltered.push(projectId);
      }
    }
    if (provider && !projectId?.startsWith('import:')) {
      clausesFiltered.push('provider = ?');
      valuesFiltered.push(provider);
    }
    clausesFiltered.push("strftime('%Y', time_created/1000, 'unixepoch', 'localtime') = ?");
    valuesFiltered.push(safeYear);

    const whereFiltered = `WHERE ${clausesFiltered.join(' AND ')}`;
    const stmtFiltered = db.prepare(`
      SELECT strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') as day,
             COALESCE(SUM(cost),0) as totalCost
      FROM ${SESSION_SOURCE} ${whereFiltered}
      GROUP BY day
    `);
    const rowsFiltered = stmtFiltered.all(...valuesFiltered);
    filteredCostByDay = new Map(rowsFiltered.map((row) => [row.day, Number(row.totalCost) || 0]));
  }

  const weeks = [];
  const start = new Date(Date.UTC(Number(safeYear), 0, 1));
  const startOfGrid = new Date(start);
  const dayOfWeek = start.getUTCDay();
  startOfGrid.setUTCDate(start.getUTCDate() - dayOfWeek);

  for (let weekIndex = 0; weekIndex < 53; weekIndex += 1) {
    const week = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const cellDate = new Date(startOfGrid);
      cellDate.setUTCDate(startOfGrid.getUTCDate() + weekIndex * 7 + dayIndex);
      const dateKey = cellDate.toISOString().slice(0, 10);
      const totalCost = totalCostByDay.get(dateKey) || 0;
      const filteredCost = sessionId ? (filteredCostByDay.get(dateKey) || 0) : null;

      // Determine level based on whichever cost is active
      const costForLevel = sessionId ? filteredCost : totalCost;
      let level = 0;
      if (costForLevel > 0.25) level = 1;
      if (costForLevel > 0.75) level = 2;
      if (costForLevel > 1.5) level = 3;
      if (costForLevel > 3) level = 4;

      week.push({
        date: dateKey,
        cost: totalCost,
        filteredCost,
        month: cellDate.getUTCMonth() + 1,
        level,
        inYear: cellDate.getUTCFullYear() === Number(safeYear),
      });
    }
    weeks.push(week);
  }

  return { year: safeYear, weeks };
}

function serveStatic(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, bigintSafe));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const projectId = url.searchParams.get('project') || undefined;
  const day = url.searchParams.get('day') || undefined;
  const month = url.searchParams.get('month') || undefined;
  const year = url.searchParams.get('year') || undefined;
  const sessionId = url.searchParams.get('sessionId') || undefined;
  const start = url.searchParams.get('start') || undefined;
  const end = url.searchParams.get('end') || undefined;
  const timeFilter = { day, month, year, sessionId, start, end, provider: url.searchParams.get('provider') || undefined };

  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, { ok: true, dbPath });
    }
    if (url.pathname === '/api/overview') {
      const db = openDb();
      try { return sendJson(res, getOverview(db, projectId, timeFilter)); } finally { db.close(); }
    }
    if (url.pathname === '/api/timeseries') {
      const bucket = url.searchParams.get('bucket') || 'day';
      const db = openDb();
      try { return sendJson(res, getTimeseries(db, bucket, projectId, timeFilter)); } finally { db.close(); }
    }
    if (url.pathname === '/api/sessions') {
      const limit = Number(url.searchParams.get('limit') || '300');
      const db = openDb();
      try { return sendJson(res, getSessions(db, projectId, limit, timeFilter)); } finally { db.close(); }
    }
    if (url.pathname === '/api/model-breakdown') {
      const db = openDb();
      try { return sendJson(res, getModelBreakdown(db, projectId, timeFilter)); } finally { db.close(); }
    }
    if (url.pathname === '/api/projects') {
      const db = openDb();
      try { return sendJson(res, getProjects(db, sessionId, { provider: url.searchParams.get('provider') || '' })); } finally { db.close(); }
    }
    if (url.pathname === '/api/active-days') {
      const db = openDb();
      try { return sendJson(res, getActiveDays(db, projectId, timeFilter)); } finally { db.close(); }
    }
    if (url.pathname === '/api/contribution-grid') {
      const db = openDb();
      try { return sendJson(res, getContributionGrid(db, projectId, year, sessionId, timeFilter)); } finally { db.close(); }
    }
    if (url.pathname === '/api/import/providers') {
      const accounts = discoverAccounts();
      const mapped = PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        available: p.available,
        note: p.note || null,
        account: accounts[p.id] || null
      }));
      return sendJson(res, mapped);
    }
    if (url.pathname === '/api/import/run') {
      const provider = url.searchParams.get('provider') || '';
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      const phase = (url.searchParams.get('phase') || '').trim().toLowerCase();
      runProviderImport(provider, { force, phase })
        .then((result) => sendJson(res, result))
        .catch((err) => sendJson(res, { provider, error: err instanceof Error ? err.message : String(err) }, 500));
      return;
    }
    if (url.pathname === '/api/import/vscode-paths') {
      if (req.method === 'GET') {
        return sendJson(res, { paths: getScanPaths() });
      }
      if (req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const p = typeof body.path === 'string' ? body.path.trim() : '';
            if (!p) return sendJson(res, { error: 'path is required' }, 400);
            return sendJson(res, { paths: addScanPath(p) });
          })
          .catch((err) => sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400));
        return;
      }
      if (req.method === 'DELETE') {
        const p = url.searchParams.get('path') || '';
        return sendJson(res, { paths: removeScanPath(p) });
      }
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    if (url.pathname === '/assets/chart.umd.js') {
      return serveStatic(res, path.join(assetsDir, 'chart.umd.js'));
    }
    if (url.pathname === '/icon.png') {
      return serveStatic(res, path.join(process.cwd(), 'icon.png'));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveStatic(res, path.join(assetsDir, 'dashboard.html'));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

const server = http.createServer(handleRequest);
ensureImportsDb();
server.listen(port, host, () => {
  console.log(`OpenCode cost dashboard running at http://${host}:${port}`);
  console.log(`Using database: ${dbPath}`);
});
