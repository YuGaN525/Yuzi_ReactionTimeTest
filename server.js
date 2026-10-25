import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { openDatabase } from './src/db.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const parsedPort = Number.parseInt(process.env.PORT ?? '3000', 10);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
const dataDir = path.resolve(ROOT, process.env.DATA_DIR ?? 'data');
const adminToken = (process.env.ADMIN_TOKEN ?? '').trim();
const trustProxy = ['1', 'true', 'yes'].includes((process.env.TRUST_PROXY ?? '').toLowerCase());
const rateLimitMax = Number.parseInt(process.env.RATE_LIMIT_MAX ?? '8', 10);
const rateLimitWindowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '600000', 10);
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
const extraConnectSrc = (process.env.CSP_CONNECT_SRC ?? '')
  .split(/\s+/)
  .map((value) => value.trim())
  .filter(Boolean);

const db = openDatabase(dataDir);
const app = createApp({
  db,
  publicDir: path.join(ROOT, 'public'),
  adminToken,
  trustProxy,
  corsOrigins,
  extraConnectSrc,
  rateLimit: {
    max: Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 8,
    windowMs:
      Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0 ? rateLimitWindowMs : 10 * 60 * 1000,
  },
});

const server = app.listen(port, () => {
  console.log(`Yuzi Reaction Time Test running at http://localhost:${port}`);
  console.log(`SQLite data directory: ${dataDir}`);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
