const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = process.env.REACTION_TEST_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Run browser checks against a local disposable test server.');
(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { Math.random = () => 0; });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.locator('#connState[data-state=online]').waitFor();
    await page.clock.install({ time: new Date('2026-10-25T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
    const stage = page.locator('#stage'), next = page.locator('#nextRoundBtn');
    const state = () => stage.getAttribute('data-state');
    await stage.click({ force: true }); assert.equal(await state(), 'waiting');
    await stage.click({ force: true }); assert.equal(await state(), 'early');
    await page.clock.runFor(10000); assert.equal(await state(), 'early');
    assert.match(await next.textContent(), /重试本轮/);
    await next.click({ force: true }); await page.clock.runFor(1600);
    assert.equal(await state(), 'ready');
    assert.equal(await stage.evaluate(e => getComputedStyle(e).transitionDuration), '0s');
    await page.clock.runFor(200); await stage.click({ force: true });
    assert.equal(await state(), 'result'); await page.clock.runFor(15000); assert.equal(await state(), 'result');
    await stage.dblclick({ force: true }); assert.equal(await state(), 'result');
    for (let round = 2; round <= 5; round++) {
      assert.match(await next.textContent(), new RegExp(String(round)));
      await next.click({ force: true }); await page.clock.runFor(1600); assert.equal(await state(), 'ready');
      await page.clock.runFor(200); await stage.click({ force: true });
      assert.equal(await state(), round === 5 ? 'complete' : 'result');
    }
    assert.equal(await next.isVisible(), false);
    assert.equal(await page.locator('#resultSheet').isVisible(), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('yuzi-rt.history.v1')).length), 1);
    await page.locator('#nickname').fill('BrowserCheck');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/scores') && r.status() === 201), page.locator('#submitBtn').click({ force: true })]);
    await page.locator('#submitSuccess').waitFor();
    await page.getByRole('button', { name: '切换浅色模式' }).click({ force: true });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at ' + width);
    }
    if (process.env.OUTPUT_DIR) {
      fs.mkdirSync(process.env.OUTPUT_DIR, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => scrollTo(0, 0)); await page.clock.runFor(32);
      await page.screenshot({ path: path.join(process.env.OUTPUT_DIR, '反应测试-独立浅色.png'), fullPage: true });
    }
    await page.locator('#retryBtn').click({ force: true });
    await page.evaluate(() => dispatchEvent(new Event('blur'))); assert.equal(await state(), 'paused');
    await page.clock.runFor(10000); assert.equal(await state(), 'paused');
    await next.click({ force: true }); assert.equal(await state(), 'waiting');
    await page.locator('#resetBtn').click({ force: true }); await page.clock.runFor(10000); assert.equal(await state(), 'idle');
    await stage.focus(); await page.clock.runFor(32);
    await page.keyboard.down('Space'); assert.equal(await state(), 'waiting');
    await page.keyboard.down('Space'); assert.equal(await state(), 'waiting');
    await page.keyboard.up('Space'); await page.clock.runFor(1600); assert.equal(await state(), 'ready');
    await page.clock.runFor(200); await page.keyboard.press('Space'); assert.equal(await state(), 'result');
    await page.clock.runFor(10000); assert.equal(await state(), 'result');
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    await mobile.addInitScript(() => { Math.random = () => 0; });
    const touch = await mobile.newPage(); await touch.goto(url);
    await touch.locator('#connState[data-state=online]').waitFor();
    await touch.clock.install({ time: new Date('2026-10-25T00:00:00Z') }); await touch.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
    await touch.locator('#stage').tap(); await touch.locator('#stage').tap();
    assert.equal(await touch.locator('#stage').getAttribute('data-state'), 'early');
    await touch.clock.runFor(10000); assert.equal(await touch.locator('#stage').getAttribute('data-state'), 'early');
    await touch.locator('#nextRoundBtn').tap(); await touch.clock.runFor(1600); await touch.clock.runFor(200); await touch.locator('#stage').tap();
    assert.equal(await touch.locator('#stage').getAttribute('data-state'), 'result');
    await touch.clock.runFor(10000); assert.equal(await touch.locator('#stage').getAttribute('data-state'), 'result');
    await mobile.close();
    assert.deepEqual(errors, []);
    console.log('PASS manual five rounds, early retry, no auto advance/double-click restart, local history, real leaderboard submission, pause/reset cleanup, keyboard, light theme and four viewports');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
