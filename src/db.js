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
  return db;
}

export function createScoreStore(db) {
  const insertScore = db.prepare(`
    INSERT INTO scores (name, avg_ms, best_ms, rounds, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const countAll = db.prepare('SELECT COUNT(*) AS total FROM scores');
  const countFaster = db.prepare('SELECT COUNT(*) AS total FROM scores WHERE avg_ms < ?');
  const countSlower = db.prepare('SELECT COUNT(*) AS total FROM scores WHERE avg_ms > ?');
  const listByAvg = db.prepare(`
    SELECT id, name, avg_ms, best_ms, created_at,
           RANK() OVER (ORDER BY avg_ms ASC) AS rank
    FROM scores
    ORDER BY avg_ms ASC, created_at ASC, id ASC
    LIMIT ?
  `);
  const listByBest = db.prepare(`
    SELECT id, name, avg_ms, best_ms, created_at,
           RANK() OVER (ORDER BY best_ms ASC) AS rank
    FROM scores
    ORDER BY best_ms ASC, created_at ASC, id ASC
    LIMIT ?
  `);
  const deleteScore = db.prepare('DELETE FROM scores WHERE id = ?');

  return {
    add({ name, rounds, avgMs, bestMs, createdAt }) {
      const result = insertScore.run(name, avgMs, bestMs, JSON.stringify(rounds), createdAt);
      const id = Number(result.lastInsertRowid);
      const total = Number(countAll.get().total);
      const faster = Number(countFaster.get(avgMs).total);
      const slower = Number(countSlower.get(avgMs).total);
      const percentile = total > 1 ? Math.round((slower / (total - 1)) * 100) : 0;
      return { id, total, rank: faster + 1, percentile };
    },

    leaderboard(sort, limit) {
      const rows = sort === 'best' ? listByBest.all(limit) : listByAvg.all(limit);
      return rows.map((row) => ({
        rank: Number(row.rank),
        id: Number(row.id),
        name: row.name,
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
