import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { createScoreStore } from './db.js';

const ROUND_COUNT = 5;
const MIN_ROUND_MS = 50;
const MAX_ROUND_MS = 5000;
const MIN_AVG_MS = 80;
const MAX_AVG_MS = 3000;
const MAX_NAME_LENGTH = 16;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>]/g;

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value
    .normalize('NFKC')
    .replace(UNSAFE_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  const length = Array.from(name).length;
  if (length < 1 || length > MAX_NAME_LENGTH) return null;
  return name;
}

function validateRounds(value) {
  if (!Array.isArray(value) || value.length !== ROUND_COUNT) return null;
  const rounds = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    const ms = Math.round(entry);
    if (ms < MIN_ROUND_MS || ms > MAX_ROUND_MS) return null;
    rounds.push(ms);
  }
  const avgMs = Math.round(rounds.reduce((sum, ms) => sum + ms, 0) / rounds.length);
  if (avgMs < MIN_AVG_MS || avgMs > MAX_AVG_MS) return null;
  return { rounds, avgMs, bestMs: Math.min(...rounds) };
}

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || !candidate || !expected) return false;
  const left = crypto.createHash('sha256').update(candidate).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function securityHeaders(extraConnectSrc) {
  const connectSrc = ["'self'", ...extraConnectSrc].join(' ');
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connectSrc}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };
}

function corsHeaders(origins) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

function createSubmissionLimiter({ max, windowMs }) {
  const hits = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits) {
      if (record.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  sweeper.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const record = hits.get(key);

    if (!record || record.resetAt <= now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `提交过于频繁，请 ${retryAfter} 秒后再试。` });
    }
    return next();
  };
}

export function createApp({
  db,
  publicDir,
  adminToken = '',
  trustProxy = false,
  corsOrigins = [],
  extraConnectSrc = [],
  rateLimit = { max: 8, windowMs: 10 * 60 * 1000 },
}) {
  const app = express();
  const store = createScoreStore(db);
  const submissionLimiter = createSubmissionLimiter(rateLimit);

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(securityHeaders(extraConnectSrc));
  if (corsOrigins.length > 0) app.use(corsHeaders(corsOrigins));
  app.use(express.json({ limit: '8kb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      total: store.total(),
      uptime: Math.round(process.uptime()),
    });
  });

  app.get('/api/leaderboard', (req, res) => {
    const sort = req.query.sort === 'best' ? 'best' : 'avg';
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    res.json({
      sort,
      limit,
      total: store.total(),
      entries: store.leaderboard(sort, limit),
    });
  });

  app.post('/api/scores', submissionLimiter, (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: '昵称需为 1–16 个可见字符。' });
    }

    const validated = validateRounds(req.body?.rounds);
    if (!validated) {
      return res.status(400).json({ error: '请提交 5 轮有效成绩，每轮需在 50–5000 毫秒之间。' });
    }

    const createdAt = new Date().toISOString();
    const saved = store.add({
      name,
      rounds: validated.rounds,
      avgMs: validated.avgMs,
      bestMs: validated.bestMs,
      createdAt,
    });

    res.status(201).json({
      score: {
        id: saved.id,
        name,
        avgMs: validated.avgMs,
        bestMs: validated.bestMs,
        rounds: validated.rounds,
        createdAt,
      },
      rank: saved.rank,
      percentile: saved.percentile,
      total: saved.total,
    });
  });

  app.delete('/api/scores/:id', (req, res) => {
    if (!adminToken) {
      return res.status(404).json({ error: '接口不存在。' });
    }
    if (!safeTokenEqual(req.get('x-admin-token'), adminToken)) {
      return res.status(403).json({ error: '无权限执行该操作。' });
    }

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: '成绩 ID 无效。' });
    }
    if (!store.remove(id)) {
      return res.status(404).json({ error: '成绩不存在。' });
    }
    return res.status(204).end();
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: '接口不存在。' });
  });

  app.use(
    express.static(publicDir, {
      etag: true,
      maxAge: '5m',
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.use((req, res) => {
    res.status(404).sendFile(path.join(publicDir, '404.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: '提交内容过大。' });
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: '请求格式无效。' });
    }
    console.error(error);
    return res.status(500).json({ error: '服务器内部错误。' });
  });

  return app;
}
