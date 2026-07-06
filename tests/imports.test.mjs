import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverAccounts, estimateCursorCost, findFilesRecursive, getImportDateBucket, isCopilotVscodeDuplicate, resetImportedRowsForProvider, shouldSkipImportForDate, withImportTimeout } from '../imports.mjs';

test('date buckets are normalized and existing dates can be skipped', () => {
  assert.equal(getImportDateBucket(1719792000000), '2024-07-01');
  assert.equal(getImportDateBucket('not-a-timestamp'), '');
  assert.equal(shouldSkipImportForDate('2024-07-02', new Set(['2024-07-02']), false), true);
  assert.equal(shouldSkipImportForDate('2024-07-02', new Set(['2024-07-02']), true), false);
  assert.equal(shouldSkipImportForDate('', new Set(['2024-07-02']), false), false);
});

test('import timeout helper rejects long-running work', async () => {
  await assert.rejects(
    withImportTimeout(new Promise((resolve) => setTimeout(() => resolve('done'), 50)), 'Test import', 10),
    /Test import timed out after 1s/
  );
});

test('cursor cost estimates scale from token counts and model pricing', () => {
  const cost = estimateCursorCost({ inputTokens: 1_000_000, outputTokens: 500_000, modelName: 'claude-sonnet-4' });
  assert.equal(cost, 10.5);
});

test('discoverAccounts avoids exposing private local identity fallbacks', () => {
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-account-'));
  try {
    process.env.HOME = tempHome;
    process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');

    const accounts = discoverAccounts();

    assert.equal(accounts.copilot, 'unknown');
    assert.equal(accounts['copilot-vscode'], 'unknown');
    assert.equal(accounts.codex, 'unknown');
    assert.equal(accounts.claude, 'unknown');
    assert.equal(accounts.gemini, 'unknown');
    assert.equal(accounts.cursor, 'Local history');
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('recursive scans can prune irrelevant directories to stay fast', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-scan-'));
  try {
    const relevantDir = path.join(tempRoot, 'User', 'workspaceStorage', 'abc123', 'chatSessions');
    const irrelevantDir = path.join(tempRoot, 'cache', 'nested');
    fs.mkdirSync(relevantDir, { recursive: true });
    fs.mkdirSync(irrelevantDir, { recursive: true });
    fs.writeFileSync(path.join(relevantDir, 'session.jsonl'), '{"kind": 0}\n');
    fs.writeFileSync(path.join(irrelevantDir, 'ignored.json'), '{}');

    const matches = findFilesRecursive(tempRoot, 0, (ent, fullPath) => ent.isFile() && ent.name.endsWith('.jsonl'), [], {
      maxDepth: 5,
      shouldRecurse: (ent, fullPath, depth) => {
        if (ent.name === 'cache') return false;
        return depth < 5;
      },
    });

    assert.equal(matches.includes(path.join(relevantDir, 'session.jsonl')), true);
    assert.equal(matches.includes(path.join(irrelevantDir, 'ignored.json')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('force reimport removes prior provider rows before re-importing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE imported_session (
        import_id TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        raw TEXT
      );
      CREATE TABLE cursor_local_session (
        id TEXT PRIMARY KEY,
        composer_id TEXT NOT NULL,
        title TEXT,
        imported_at INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO imported_session (import_id, id, provider, title, cost, tokens_input, tokens_output, time_created, time_updated, imported_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cursor:old', 'cursor:old', 'cursor', 'old', 0, 0, 0, 1, 1, 1, '{}');
    db.prepare('INSERT INTO cursor_local_session (id, composer_id, title, imported_at) VALUES (?, ?, ?, ?)')
      .run('cursor:old', 'old', 'old', 1);

    resetImportedRowsForProvider(db, 'cursor');

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM imported_session WHERE provider = ?').get('cursor').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cursor_local_session').get().count, 0);
  } finally {
    db.close();
  }
});

test('Copilot VS Code history and OTel imports share duplicate detection', () => {
  const seen = { importIds: new Set(['copilot-vscode-hist:abc123']), sessionIds: new Set(['abc123']) };

  assert.equal(isCopilotVscodeDuplicate(seen, 'copilot-vscode-hist:abc123', 'abc123'), true);
  assert.equal(isCopilotVscodeDuplicate(seen, 'copilot-vscode:abc123', 'abc123'), true);
  assert.equal(isCopilotVscodeDuplicate(seen, 'copilot-vscode:xyz789', 'xyz789'), false);
});
