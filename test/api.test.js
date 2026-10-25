import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

async function startApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzi-rt-test-'));
  const db = openDatabase(dataDir);
  const app = createApp({
    db,
    publicDir: PUBLIC_DIR,
    adminToken: overrides.adminToken ?? 'test-secret',
    rateLimit: overrides.rateLimit ?? { max: 1000, windowMs: 60_000 },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function submit(url, payload) {
  return fetch(`${url}/api/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function json(response) {
  return response.json();
}

test('serves the app, health endpoint and a 404 page', async (t) => {
  const fixture = await startApp();
  t.after(() => fixture.close());

  const health = await fetch(`${fixture.url}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await json(health);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.total, 0);
  assert.equal(typeof healthBody.uptime, 'number');

  const home = await fetch(fixture.url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const html = await home.text();
  assert.match(html, /Yuzi 反应力测试/);
  assert.match(html, /id="stage"/);

  const missing = await fetch(`${fixture.url}/not-here`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /信号丢失了/);

  const missingApi = await fetch(`${fixture.url}/api/not-here`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await json(missingApi), { error: '接口不存在。' });
});

test('rejects invalid submissions', async (t) => {
  const fixture = await startApp();
  t.after(() => fixture.close());

  const invalidPayloads = [
    { name: '', rounds: [200, 210, 220, 230, 240] },
    { name: 'a'.repeat(17), rounds: [200, 210, 220, 230, 240] },
    { name: '玩家', rounds: [200, 210, 220, 230] },
    { name: '玩家', rounds: [200, 210, 220, 230, 10] },
    { name: '玩家', rounds: [200, 210, 220, 230, '240'] },
    { name: '玩家', rounds: [200, 210, 220, 230, 9999] },
    { name: '玩家' },
  ];

  for (const payload of invalidPayloads) {
    const response = await submit(fixture.url, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(typeof (await json(response)).error, 'string');
  }

  const board = await fetch(`${fixture.url}/api/leaderboard`);
  assert.equal((await json(board)).total, 0);
});

test('stores scores, computes rankings and supports both sort orders', async (t) => {
  const fixture = await startApp();
  t.after(() => fixture.close());

  const first = await submit(fixture.url, {
    name: '阿柚',
    rounds: [246, 231, 258, 244, 239],
    avgMs: 1,
    bestMs: 1,
  });
  assert.equal(first.status, 201);
  const firstBody = await json(first);
  assert.equal(firstBody.score.name, '阿柚');
  assert.equal(firstBody.score.avgMs, 244);
  assert.equal(firstBody.score.bestMs, 231);
  assert.equal(firstBody.rank, 1);
  assert.equal(firstBody.percentile, 0);
  assert.equal(firstBody.total, 1);

  const second = await submit(fixture.url, {
    name: 'Yuzi Fan',
    rounds: [188, 202, 219, 196, 205],
  });
  assert.equal(second.status, 201);
  const secondBody = await json(second);
  assert.equal(secondBody.rank, 1);
  assert.equal(secondBody.percentile, 100);
  assert.equal(secondBody.total, 2);

  const avgBoardResponse = await fetch(`${fixture.url}/api/leaderboard?sort=avg&limit=50`);
  const avgBoard = await json(avgBoardResponse);
  assert.equal(avgBoard.sort, 'avg');
  assert.equal(avgBoard.total, 2);
  assert.deepEqual(
    avgBoard.entries.map((entry) => [entry.rank, entry.name, entry.avgMs, entry.bestMs]),
    [
      [1, 'Yuzi Fan', 202, 188],
      [2, '阿柚', 244, 231],
    ],
  );
  assert.equal('rounds' in avgBoard.entries[0], false);

  const bestBoard = await json(await fetch(`${fixture.url}/api/leaderboard?sort=best`));
  assert.equal(bestBoard.sort, 'best');
  assert.deepEqual(
    bestBoard.entries.map((entry) => [entry.rank, entry.name, entry.bestMs]),
    [
      [1, 'Yuzi Fan', 188],
      [2, '阿柚', 231],
    ],
  );

  const clamped = await json(await fetch(`${fixture.url}/api/leaderboard?limit=9999`));
  assert.equal(clamped.limit, 100);
});

test('protects leaderboard removal with an admin token', async (t) => {
  const fixture = await startApp();
  t.after(() => fixture.close());

  const created = await json(
    await submit(fixture.url, { name: '测试选手', rounds: [210, 220, 230, 240, 250] }),
  );
  const endpoint = `${fixture.url}/api/scores/${created.score.id}`;

  const noToken = await fetch(endpoint, { method: 'DELETE' });
  assert.equal(noToken.status, 403);

  const wrongToken = await fetch(endpoint, {
    method: 'DELETE',
    headers: { 'X-Admin-Token': 'wrong' },
  });
  assert.equal(wrongToken.status, 403);

  const deleted = await fetch(endpoint, {
    method: 'DELETE',
    headers: { 'X-Admin-Token': 'test-secret' },
  });
  assert.equal(deleted.status, 204);

  const board = await json(await fetch(`${fixture.url}/api/leaderboard`));
  assert.equal(board.total, 0);
});

test('rate limits repeated submissions', async (t) => {
  const fixture = await startApp({ rateLimit: { max: 1, windowMs: 60_000 } });
  t.after(() => fixture.close());

  const payload = { name: '限流测试', rounds: [210, 220, 230, 240, 250] };
  const first = await submit(fixture.url, payload);
  assert.equal(first.status, 201);

  const second = await submit(fixture.url, payload);
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
  assert.match((await json(second)).error, /提交过于频繁/);
});
