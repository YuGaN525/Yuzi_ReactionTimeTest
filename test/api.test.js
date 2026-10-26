import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, createScoreStore } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

test('website board keeps one lowest-average session per user and the fastest from that same session', async t => {
  const fixture = await startApp({ websiteKey: WEBSITE_KEY }); t.after(() => fixture.close());
  const runs = [[80,500,500,500,500], [210,210,210,210,210], [190,200,210,200,200],
    [220,220,220,220,220], [230,230,230,230,230], [240,240,240,240,240], [250,250,250,250,250]];
  for (const rounds of runs) {
    const response = await accountSubmit(fixture.url, { account: ACCOUNT, submissionId: randomUUID(), rounds });
    assert.equal(response.status, 201);
    const body = await response.json(); assert.equal(body.total, 1); assert.equal(body.rank, 1);
  }
  const board = await json(await fetch(fixture.url + '/api/leaderboard?sort=best'));
  assert.equal(board.sort, 'avg'); assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].avgMs, 200); assert.equal(board.entries[0].bestMs, 190);
  const details = await json(await fetch(fixture.url + '/api/leaderboard/accounts/' + ACCOUNT.id));
  assert.equal(details.total, 7); assert.equal(details.sessions.length, 5);
  assert.deepEqual(details.sessions.map(s => s.avgMs), [200,210,220,230,240]);
  assert.equal(details.sessions[0].bestMs, 190); assert.equal(details.sessions[0].rounds.length, 5);
});

test('preview returns ten users, full leaderboard at most one hundred, and totals count users', async t => {
  const fixture = await startApp({ websiteKey: WEBSITE_KEY }); t.after(() => fixture.close());
  for (let i = 0; i < 103; i++) {
    const id = randomUUID();
    await accountSubmit(fixture.url, { account: { ...ACCOUNT, id, name: 'Player ' + i }, submissionId: randomUUID(), rounds: Array(5).fill(180 + i) });
  }
  const preview = await json(await fetch(fixture.url + '/api/leaderboard'));
  assert.equal(preview.entries.length, 10); assert.equal(preview.total, 103);
  const full = await json(await fetch(fixture.url + '/api/leaderboard?limit=1000'));
  assert.equal(full.entries.length, 100); assert.equal(new Set(full.entries.map(e => e.accountId)).size, 100);
  assert.equal((await fetch(fixture.url + '/api/leaderboard/accounts/not-an-account')).status, 400);
  assert.equal((await fetch(fixture.url + '/api/leaderboard/accounts/' + randomUUID())).status, 404);
});

test('administration validates rounds, protects versions, recomputes ranking, and can remove user history', async t => {
  const fixture = await startApp({ websiteKey: WEBSITE_KEY }); t.after(() => fixture.close());
  for (const ms of [200,250,300]) await accountSubmit(fixture.url, { account: ACCOUNT, submissionId: randomUUID(), rounds: Array(5).fill(ms) });
  const endpoint = fixture.url + '/api/admin/scores';
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await fetch(endpoint, { headers: { 'X-Website-Key': 'wrong-key' } })).status, 403);
  const headers = { 'X-Website-Key': WEBSITE_KEY, 'Content-Type': 'application/json' };
  const list = await json(await fetch(endpoint, { headers }));
  assert.equal(list.total, 3); assert.equal(list.items.length, 3);
  const row = list.items.find(s => s.avgMs === 200);
  const invalid = await fetch(endpoint + '/' + row.id, { method: 'PUT', headers, body: JSON.stringify({ rounds: [1], version: row.version }) });
  assert.equal(invalid.status, 400);
  const edited = await fetch(endpoint + '/' + row.id, { method: 'PUT', headers,
    body: JSON.stringify({ name: 'Corrected player', rounds: [300,310,320,330,340], avgMs: 1, version: row.version }) });
  assert.equal(edited.status, 200); assert.equal((await edited.json()).avgMs, 320);
  assert.equal((await fetch(endpoint + '/' + row.id, { method: 'PUT', headers, body: JSON.stringify({ rounds: Array(5).fill(200), version: row.version }) })).status, 409);
  assert.equal((await fetch(endpoint + '/' + row.id + '?version=0', { method: 'DELETE', headers })).status, 409);
  let board = await json(await fetch(fixture.url + '/api/leaderboard'));
  assert.equal(board.entries[0].avgMs, 250);
  assert.equal((await fetch(endpoint + '/' + row.id + '?version=1', { method: 'DELETE', headers })).status, 204);
  const removed = await json(await fetch(fixture.url + '/api/admin/accounts/' + ACCOUNT.id + '/scores', { method: 'DELETE', headers }));
  assert.equal(removed.removed, 2);
  board = await json(await fetch(fixture.url + '/api/leaderboard')); assert.equal(board.total, 0);
});

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

async function startApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzi-rt-test-'));
  const db = openDatabase(dataDir);
  const app = createApp({
    db,
    publicDir: PUBLIC_DIR,
    adminToken: overrides.adminToken ?? 'test-secret',
    websiteKey: overrides.websiteKey ?? '',
    requireAccount: overrides.requireAccount ?? false,
    trustProxy: overrides.trustProxy ?? false,
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

test('a full IP registry does not reset active submission limits', async (t) => {
  const fixture = await startApp({ trustProxy: 1, rateLimit: { max: 1, windowMs: 60_000, maxEntries: 2 } });
  t.after(() => fixture.close());
  const post = (ip) => fetch(`${fixture.url}/api/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ name: '容量测试', rounds: [210, 220, 230, 240, 250] }),
  });
  assert.equal((await post('192.0.2.1')).status, 201);
  assert.equal((await post('192.0.2.2')).status, 201);
  const overflow = await post('192.0.2.3');
  assert.equal(overflow.status, 503);
  assert.equal(overflow.headers.get('retry-after'), '60');
  assert.equal((await post('192.0.2.1')).status, 429);
  assert.equal((await json(await fetch(`${fixture.url}/api/leaderboard`))).total, 2);
});

const WEBSITE_KEY = 'trusted-website-key-' + 'x'.repeat(32);
const ACCOUNT = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '登录玩家', profilePath: '/players/101', avatarUrl: '/uploads/avatars/test.webp' };
const RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function accountSubmit(url, body, key = WEBSITE_KEY) {
  return fetch(url + '/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Website-Key': key }, body: JSON.stringify(body) });
}
test('website mode refuses unauthenticated or malformed account submissions', async t => {
  const f = await startApp({ websiteKey: WEBSITE_KEY, requireAccount: true }); t.after(() => f.close());
  const valid = { account: ACCOUNT, submissionId: RUN, rounds: [200, 210, 220, 230, 240] };
  assert.equal((await accountSubmit(f.url, valid, '')).status, 403);
  assert.equal((await accountSubmit(f.url, valid, 'wrong')).status, 403);
  assert.equal((await accountSubmit(f.url, { name: '伪造', rounds: valid.rounds })).status, 400);
  assert.equal((await accountSubmit(f.url, { ...valid, account: { ...ACCOUNT, profilePath: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await json(await fetch(f.url + '/api/leaderboard'))).total, 0);
});
test('identified submissions retain profile links, recompute data and deduplicate retries', async t => {
  const f = await startApp({ websiteKey: WEBSITE_KEY }); t.after(() => f.close());
  const payload = { account: ACCOUNT, submissionId: RUN, rounds: [200, 210, 220, 230, 240], avgMs: 1 };
  const first = await accountSubmit(f.url, payload); assert.equal(first.status, 201);
  const saved = await first.json(); assert.equal(saved.score.avgMs, 220); assert.equal(saved.score.profilePath, '/players/101');
  const replay = await accountSubmit(f.url, payload); assert.equal(replay.status, 200); assert.equal((await replay.json()).score.id, saved.score.id);
  assert.equal((await accountSubmit(f.url, { ...payload, rounds: [250, 250, 250, 250, 250] })).status, 409);
  const board = await json(await fetch(f.url + '/api/leaderboard'));
  assert.equal(board.total, 1); assert.equal(board.entries[0].avatarUrl, ACCOUNT.avatarUrl); assert.equal(board.entries[0].profilePath, ACCOUNT.profilePath);
});
test('migrates old anonymous databases without deleting or misattributing historical scores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzi-migration-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'leaderboard.db'));
    old.exec("CREATE TABLE scores(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,avg_ms INTEGER NOT NULL,best_ms INTEGER NOT NULL,rounds TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO scores VALUES(1,'legacy',100,100,'[100,100,100,100,100]','2026-01-01T00:00:00.000Z');"); old.close();
    let db = openDatabase(dir); assert.equal(createScoreStore(db, true).total(), 0); assert.equal(createScoreStore(db).total(), 1);
    createScoreStore(db, true).add({ name: ACCOUNT.name, account: ACCOUNT, submissionId: RUN, rounds: [200,200,200,200,200], avgMs: 200, bestMs: 200, createdAt: new Date().toISOString() }); db.close();
    db = openDatabase(dir); assert.equal(createScoreStore(db).total(), 2); assert.equal(createScoreStore(db, true).total(), 1); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
