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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avg_ms INTEGER NOT NULL,
      best_ms INTEGER NOT NULL,
      rounds TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scores_avg ON scores (avg_ms);
    CREATE INDEX IF NOT EXISTS idx_scores_best ON scores (best_ms);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(scores)').all().map(row => row.name));
  for (const name of ['account_id', 'profile_path', 'avatar_url', 'submission_id']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE scores ADD COLUMN ${name} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_submission ON scores(account_id, submission_id) WHERE account_id IS NOT NULL AND submission_id IS NOT NULL');
  return db;
}

export function createScoreStore(db, accountOnly = false) {
  const filter = accountOnly ? " WHERE account_id IS NOT NULL" : "";
  const insertScore = db.prepare(`
    INSERT INTO scores (name, avg_ms, best_ms, rounds, created_at, account_id, profile_path, avatar_url, submission_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countAll = db.prepare('SELECT COUNT(*) AS total FROM scores' + filter);
  const countFaster = db.prepare('SELECT COUNT(*) AS total FROM scores WHERE avg_ms < ?' + (accountOnly ? ' AND account_id IS NOT NULL' : ''));
  const countSlower = db.prepare('SELECT COUNT(*) AS total FROM scores WHERE avg_ms > ?' + (accountOnly ? ' AND account_id IS NOT NULL' : ''));
  const listByAvg = db.prepare(`
    SELECT id, name, avg_ms, best_ms, created_at, profile_path, avatar_url,
           RANK() OVER (ORDER BY avg_ms ASC) AS rank
    FROM scores ${filter}
    ORDER BY avg_ms ASC, created_at ASC, id ASC
    LIMIT ?
  `);
  const listByBest = db.prepare(`
    SELECT id, name, avg_ms, best_ms, created_at, profile_path, avatar_url,
           RANK() OVER (ORDER BY best_ms ASC) AS rank
    FROM scores ${filter}
    ORDER BY best_ms ASC, created_at ASC, id ASC
    LIMIT ?
  `);
  const deleteScore = db.prepare('DELETE FROM scores WHERE id = ?');

  return {
    add({ name, rounds, avgMs, bestMs, createdAt, account = null, submissionId = null }) {
      const previous = account && submissionId ? db.prepare('SELECT * FROM scores WHERE account_id=? AND submission_id=?').get(account.id, submissionId) : null;
      if (previous && previous.rounds !== JSON.stringify(rounds)) {
        const error = new Error('同一次测试不能重复提交不同成绩。'); error.status = 409; throw error;
      }
      const result = previous ? null : insertScore.run(name, avgMs, bestMs, JSON.stringify(rounds), createdAt, account?.id ?? null, account?.profilePath ?? null, account?.avatarUrl ?? null, submissionId);
      const id = previous ? Number(previous.id) : Number(result.lastInsertRowid);
      const total = Number(countAll.get().total);
      const faster = Number(countFaster.get(avgMs).total);
      const slower = Number(countSlower.get(avgMs).total);
      const percentile = total > 1 ? Math.round((slower / (total - 1)) * 100) : 0;
      return { id, total, rank: faster + 1, percentile, replayed: !!previous, createdAt: previous?.created_at ?? createdAt };
    },

    leaderboard(sort, limit) {
      const rows = sort === 'best' ? listByBest.all(limit) : listByAvg.all(limit);
      return rows.map((row) => ({
        rank: Number(row.rank),
        id: Number(row.id),
        name: row.name,
        profilePath: row.profile_path,
        avatarUrl: row.avatar_url,
        avgMs: Number(row.avg_ms),
        bestMs: Number(row.best_ms),
        createdAt: row.created_at,
      }));
    },

    total() {
      return Number(countAll.get().total);
    },

    remove(id) {
      return Number(deleteScore.run(id).changes) > 0;
    },
  };
}
