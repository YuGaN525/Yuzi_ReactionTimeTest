import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'leaderboard.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      avg_ms INTEGER NOT NULL, best_ms INTEGER NOT NULL,
      rounds TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scores_avg ON scores(avg_ms);
    CREATE INDEX IF NOT EXISTS idx_scores_best ON scores(best_ms);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(scores)').all().map(row => row.name));
  for (const name of ['account_id', 'profile_path', 'avatar_url', 'submission_id']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE scores ADD COLUMN ${name} TEXT`);
  }
  if (!columns.has('version')) db.exec('ALTER TABLE scores ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_submission ON scores(account_id, submission_id)
      WHERE account_id IS NOT NULL AND submission_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_scores_account_avg ON scores(account_id, avg_ms, best_ms, id);
  `);
  return db;
}

function score(row, includeRounds = false) {
  const result = {
    id: Number(row.id), accountId: row.account_id ?? null, name: row.name,
    profilePath: row.profile_path ?? null, avatarUrl: row.avatar_url ?? null,
    avgMs: Number(row.avg_ms), bestMs: Number(row.best_ms), createdAt: row.created_at,
  };
  if (row.rank !== undefined) result.rank = Number(row.rank);
  if (includeRounds) { result.rounds = JSON.parse(row.rounds); result.version = Number(row.version); }
  return result;
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export function createScoreStore(db, accountOnly = false) {
  // Website ranking is the lowest average per account. Its displayed fastest
  // round belongs to that same session. History is preserved for the top five.
  function winners(sort = 'avg') {
    const metric = !accountOnly && sort === 'best' ? 'best_ms' : 'avg_ms';
    return { metric, sql: `WITH ordered AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(account_id, 'anonymous:' || id)
        ORDER BY ${metric}, avg_ms, best_ms, created_at, id
      ) AS account_row
      FROM scores WHERE best_ms >= 80 ${accountOnly ? 'AND account_id IS NOT NULL' : ''}
    ), winners AS (SELECT * FROM ordered WHERE account_row=1)` };
  }
  function board(sort, limit) {
    const { metric, sql } = winners(sort);
    return db.prepare(`${sql} SELECT *, RANK() OVER (ORDER BY ${metric}) AS rank
      FROM winners ORDER BY ${metric}, avg_ms, best_ms, created_at, id LIMIT ?`).all(limit).map(row => score(row));
  }
  function total() {
    const { sql } = winners();
    return Number(db.prepare(`${sql} SELECT COUNT(*) AS total FROM winners`).get().total);
  }
  function byId(id) { return db.prepare('SELECT * FROM scores WHERE id=?').get(id); }

  return {
    add({ name, rounds, avgMs, bestMs, createdAt, account = null, submissionId = null }) {
      if (!Array.isArray(rounds) || rounds.some(ms => !Number.isFinite(ms) || ms < 80) || bestMs < 80)
        fail(400, '最快反应低于80毫秒，整次成绩无效。');
      const previous = account && submissionId
        ? db.prepare('SELECT * FROM scores WHERE account_id=? AND submission_id=?').get(account.id, submissionId) : null;
      if (previous && previous.rounds !== JSON.stringify(rounds)) fail(409, '同一次测试不能重复提交不同成绩。');
      const inserted = previous ? null : db.prepare(`INSERT INTO scores
        (name, avg_ms, best_ms, rounds, created_at, account_id, profile_path, avatar_url, submission_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, avgMs, bestMs, JSON.stringify(rounds), createdAt,
        account?.id ?? null, account?.profilePath ?? null, account?.avatarUrl ?? null, submissionId);
      const id = previous ? Number(previous.id) : Number(inserted.lastInsertRowid);
      const { sql } = winners();
      const own = account ? db.prepare(`${sql} SELECT * FROM winners WHERE account_id=?`).get(account.id) : byId(id);
      const stats = db.prepare(`${sql} SELECT COUNT(*) AS total,
        COALESCE(SUM(avg_ms < ?),0) AS faster, COALESCE(SUM(avg_ms > ?),0) AS slower FROM winners`).get(own.avg_ms, own.avg_ms);
      const count = Number(stats.total);
      return { id, total: count, rank: Number(stats.faster) + 1,
        percentile: count > 1 ? Math.round(Number(stats.slower) / (count - 1) * 100) : 0,
        replayed: !!previous, createdAt: previous?.created_at ?? createdAt,
        personalBest: score(own), isPersonalBest: Number(own.id) === id };
    },
    leaderboard: board,
    total,
    accountDetails(accountId) {
      const rows = db.prepare('SELECT * FROM scores WHERE account_id=? AND best_ms>=80 ORDER BY avg_ms, best_ms, created_at, id LIMIT 5').all(accountId);
      if (!rows.length) return null;
      return { accountId, name: rows[0].name,
        total: Number(db.prepare('SELECT COUNT(*) AS total FROM scores WHERE account_id=? AND best_ms>=80').get(accountId).total),
        sessions: rows.map(row => score(row, true)) };
    },
    adminScores({ page = 1, pageSize = 20, keyword = '', accountId = null }) {
      const where = accountId ? 'WHERE account_id=?' : 'WHERE instr(lower(name), lower(?)) > 0 OR account_id=?';
      const params = accountId ? [accountId] : [keyword, keyword];
      const count = Number(db.prepare(`SELECT COUNT(*) AS total FROM scores ${where}`).get(...params).total);
      const rows = db.prepare(`SELECT * FROM scores ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize);
      return { items: rows.map(row => score(row, true)), total: count, page, pageSize };
    },
    update(id, { name, rounds, avgMs, bestMs, version }) {
      const previous = byId(id);
      if (!previous) fail(404, '成绩不存在。');
      const updated = db.prepare('UPDATE scores SET name=?,rounds=?,avg_ms=?,best_ms=?,version=version+1 WHERE id=? AND version=?')
        .run(name ?? previous.name, JSON.stringify(rounds), avgMs, bestMs, id, version);
      if (!updated.changes) fail(409, '成绩已被其他管理员修改，请刷新后重试。');
      return score(byId(id), true);
    },
    remove(id, version) {
      if (version !== undefined) {
        if (!byId(id)) return false;
        if (!db.prepare('DELETE FROM scores WHERE id=? AND version=?').run(id, version).changes)
          fail(409, '成绩已变更，请刷新后重试。');
        return true;
      }
      return Number(db.prepare('DELETE FROM scores WHERE id=?').run(id).changes) > 0;
    },
    removeAccount(accountId) { return Number(db.prepare('DELETE FROM scores WHERE account_id=?').run(accountId).changes); },
  };
}
