(() => {
  'use strict';

  const API_BASE = (document.querySelector('meta[name="api-base"]')?.getAttribute('content') || '')
    .trim()
    .replace(/\/+$/, '');
  const API_PREFIX = document.querySelector('meta[name="api-prefix"]')?.content || '/api';
  const apiUrl = (path) => `${API_BASE}${API_PREFIX}${path.replace(/^\/api/, '')}`;

  const WEBSITE_MODE = API_PREFIX === '/api/tools/reaction';
  const BOARD_MODE = new URLSearchParams(location.search).get('board') === '1';
  document.body.classList.toggle('board-only', BOARD_MODE);
  const fullBoardLink = document.getElementById('fullBoardLink');
  if (fullBoardLink) {
    fullBoardLink.hidden = BOARD_MODE;
    if (WEBSITE_MODE) { fullBoardLink.href = '/tools/reaction/leaderboard'; fullBoardLink.target = '_top'; }
  }
  if (BOARD_MODE) document.getElementById('boardDescription').textContent = '前 100 位用户，按各自最佳平均反应排序。展开用户可查看其平均成绩最好的前 5 局及各局最快反应。';
  let usageSessionId = crypto.randomUUID();
  function reportUsage(action) {
    if (WEBSITE_MODE && parent !== window) parent.postMessage({ type: 'yuz1-reaction-usage', action, sessionId: usageSessionId }, location.origin);
  }
  let account = null;
  const submissions = new Map();
  function parentRequest(result) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { submissions.delete(result.submissionId); reject(new Error('上传超时，可点击重试；重复提交不会重复上榜。')); }, 20000);
      submissions.set(result.submissionId, { resolve, reject, timer });
      parent.postMessage({ type: 'yuz1-reaction-submit', submissionId: result.submissionId, rounds: result.rounds }, location.origin);
    });
  }
  window.addEventListener('message', event => {
    if (!WEBSITE_MODE || event.origin !== location.origin || event.source !== parent) return;
    if (event.data?.type === 'yuz1-reaction-account') {
      account = event.data.account || null;
      els.nickname.closest('.submit-row').previousElementSibling.hidden = true;
      els.nickname.hidden = true; els.nickname.required = false;
      updateSubmitNote();
      if (account && state.result && !state.submitted && !els.submitBtn.disabled) void handleSubmit({ preventDefault() {} });
    }
    if (event.data?.type === 'yuz1-reaction-submitted') {
      const pending = submissions.get(event.data.submissionId);
      if (!pending) return;
      submissions.delete(event.data.submissionId); clearTimeout(pending.timer);
      event.data.success ? pending.resolve(event.data.data) : pending.reject(new HttpError(event.data.message || '上传失败，请重试。', event.data.status || 503));
    }
  });
  const TOTAL_ROUNDS = 5;
  const WAIT_MIN_MS = 1400;
  const WAIT_MAX_MS = 3800;
  const REQUEST_TIMEOUT_MS = 8000;
  const BOARD_LIMIT = BOARD_MODE ? 100 : 10;
  const STORAGE_KEYS = {
    history: 'yuzi-rt.history.v1',
    nickname: 'yuzi-rt.nickname.v1',
  };

  const TIERS = [
    { max: 180, name: '超人反应', note: '快得不像普通人类。保持这个状态，你就是榜上的狠角色。' },
    { max: 210, name: '职业水准', note: '反应极快，已经摸到职业选手的门槛。' },
    { max: 240, name: '非常快', note: '明显快于平均线，手眼协调相当出色。' },
    { max: 280, name: '高于平均', note: '稳稳跑赢人类平均反应，表现可靠。' },
    { max: 320, name: '平均水准', note: '在正常范围内。放松、专注，多练几局会更稳。' },
    { max: 380, name: '稳中求快', note: '状态稍慢，但别急，专注绿色信号会有提升。' },
    { max: Infinity, name: '慢热型', note: '先热热身吧，下一局通常会更快。' },
  ];

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  const shortDate = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
  const longDate = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const numberFormat = new Intl.NumberFormat('zh-CN');

  const els = {
    stage: document.getElementById('stage'),
    stageInner: document.getElementById('stageInner'),
    roundDots: [...document.querySelectorAll('#roundDots span')],
    roundLabel: document.getElementById('roundLabel'),
    resetBtn: document.getElementById('resetBtn'),
    metricAvg: document.getElementById('metricAvg'),
    metricBest: document.getElementById('metricBest'),
    metricEarly: document.getElementById('metricEarly'),
    metricPb: document.getElementById('metricPb'),
    roundChips: [...document.querySelectorAll('#roundStrip .round-chip')],
    testSection: document.getElementById('test'),
    resultSheet: document.getElementById('resultSheet'),
    resultTier: document.getElementById('resultTier'),
    resultAvg: document.getElementById('resultAvg'),
    resultBest: document.getElementById('resultBest'),
    resultWorst: document.getElementById('resultWorst'),
    resultEarly: document.getElementById('resultEarly'),
    resultNote: document.getElementById('resultNote'),
    resultRounds: document.getElementById('resultRounds'),
    submitForm: document.getElementById('submitForm'),
    nickname: document.getElementById('nickname'),
    submitBtn: document.getElementById('submitBtn'),
    submitBtnLabel: document.getElementById('submitBtnLabel'),
    submitNote: document.getElementById('submitNote'),
    submitSuccess: document.getElementById('submitSuccess'),
    submitResultText: document.getElementById('submitResultText'),
    retryBtn: document.getElementById('retryBtn'),
    connState: document.getElementById('connState'),
    connLabel: document.getElementById('connLabel'),
    heroTotal: document.getElementById('heroTotal'),
    heroPb: document.getElementById('heroPb'),
    boardBody: document.getElementById('boardBody'),
    boardCount: document.getElementById('boardCount'),
    refreshBtn: document.getElementById('refreshBtn'),
    boardTabs: [...document.querySelectorAll('.seg-btn')],
    toast: document.getElementById('toast'),
    announcer: document.getElementById('announcer'),
    year: document.getElementById('year'),
  };

  const state = {
    signalFrame: null,
    phase: 'idle',
    rounds: [],
    falseStarts: 0,
    readyAt: 0,
    timers: new Set(),
    testVisible: false,
    boardSort: 'avg',
    boardEntries: [],
    boardTotal: 0,
    boardLoading: false,
    boardSeq: 0,
    online: null,
    lastScoreId: null,
    result: null,
    submitted: false,
  };

  class HttpError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'HttpError';
      this.status = status;
    }
  }

  function later(callback, delay) {
    const timer = window.setTimeout(() => {
      state.timers.delete(timer);
      callback();
    }, delay);
    state.timers.add(timer);
    return timer;
  }

  function clearTimers() {
    for (const timer of state.timers) window.clearTimeout(timer);
    state.timers.clear();
    if (state.signalFrame !== null) cancelAnimationFrame(state.signalFrame);
    state.signalFrame = null;
  }

  function announce(message) {
    els.announcer.textContent = message;
  }

  function formatNumber(value) {
    return numberFormat.format(Number.isFinite(Number(value)) ? Number(value) : 0);
  }

  function tierFor(avgMs) {
    return TIERS.find((tier) => avgMs < tier.max) || TIERS[TIERS.length - 1];
  }

  function quickComment(ms) {
    if (ms < 170) return '快得有点不真实。';
    if (ms < 210) return '非常快，保持专注。';
    if (ms < 250) return '漂亮，手速在线。';
    if (ms < 300) return '不错，继续稳住。';
    return '别急，下一轮会更顺。';
  }

  function readStorage(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Local storage can be unavailable in private browsing mode.
    }
  }

  function readHistory() {
    const value = readStorage(STORAGE_KEYS.history, []);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && Number.isFinite(item.avgMs) && item.avgMs >= 80
        && Array.isArray(item.rounds) && item.rounds.length === TOTAL_ROUNDS && item.rounds.every(ms => Number.isFinite(ms) && ms >= 80))
      .slice(0, 30);
  }

  function getPersonalBest() {
    const history = readHistory();
    if (history.length === 0) return null;
    return Math.min(...history.map((item) => item.avgMs));
  }

  function loadNickname() {
    const value = readStorage(STORAGE_KEYS.nickname, '');
    if (typeof value !== 'string') return '';
    return Array.from(value.trim()).slice(0, 16).join('');
  }

  function saveNickname(name) {
    writeStorage(STORAGE_KEYS.nickname, name);
  }

  function saveSession(result) {
    const history = readHistory();
    history.unshift({
      avgMs: result.avgMs,
      bestMs: result.bestMs,
      worstMs: result.worstMs,
      rounds: result.rounds,
      falseStarts: result.falseStarts,
      at: new Date().toISOString(),
    });
    writeStorage(STORAGE_KEYS.history, history.slice(0, 30));
  }

  function setMetric(element, value, unit) {
    element.replaceChildren();
    if (value === null || value === undefined) {
      const placeholder = document.createElement('span');
      placeholder.className = 'metric-empty';
      placeholder.textContent = '—';
      element.append(placeholder);
      return;
    }
    element.append(String(value));
    if (unit) {
      const suffix = document.createElement('small');
      suffix.textContent = unit;
      element.append(suffix);
    }
  }

  function updateMetrics() {
    const rounds = state.rounds;
    if (rounds.length > 0) {
      const sum = rounds.reduce((total, value) => total + value, 0);
      setMetric(els.metricAvg, Math.round(sum / rounds.length), 'ms');
      setMetric(els.metricBest, Math.min(...rounds), 'ms');
    } else {
      setMetric(els.metricAvg, null);
      setMetric(els.metricBest, null);
    }
    setMetric(els.metricEarly, state.falseStarts, '次');
    setMetric(els.metricPb, getPersonalBest(), 'ms');
  }

  function updateHeroPb() {
    const best = getPersonalBest();
    els.heroPb.replaceChildren();
    if (best === null) {
      els.heroPb.textContent = '—';
      return;
    }
    els.heroPb.append(String(best));
    const suffix = document.createElement('small');
    suffix.textContent = 'ms';
    els.heroPb.append(suffix);
  }

  function updateRoundUI() {
    const isActiveRound = ['waiting', 'ready', 'early', 'paused'].includes(state.phase);
    const activeIndex = isActiveRound ? state.rounds.length : -1;

    els.roundDots.forEach((dot, index) => {
      dot.classList.toggle('is-done', index < state.rounds.length);
      dot.classList.toggle('is-active', index === activeIndex);
    });

    els.roundChips.forEach((chip, index) => {
      const value = state.rounds[index];
      chip.classList.toggle('is-done', Number.isFinite(value));
      chip.classList.toggle('is-current', value === undefined && index === activeIndex);
      chip.querySelector('.round-chip-value').textContent =
        value === undefined ? '—' : `${value} ms`;
    });

    let label = '等待开始';
    if (state.phase === 'complete') {
      label = `${TOTAL_ROUNDS} / ${TOTAL_ROUNDS} 已完成`;
    } else if (state.phase === 'result') {
      label = `第 ${state.rounds.length} / ${TOTAL_ROUNDS} 轮`;
    } else if (state.phase === 'paused') {
      label = '已暂停';
    } else if (isActiveRound) {
      label = `第 ${Math.min(state.rounds.length + 1, TOTAL_ROUNDS)} / ${TOTAL_ROUNDS} 轮`;
    }
    els.roundLabel.textContent = label;

    const sessionInProgress = !['idle', 'complete', 'cancelled'].includes(state.phase);
    els.resetBtn.hidden = !sessionInProgress;
  }

  function setStage(phase, html, ariaLabel) {
    state.phase = phase;
    els.stage.dataset.state = phase;
    els.stage.setAttribute('aria-label', ariaLabel);
    els.stageInner.innerHTML = html;
    updateRoundUI();
  }

  function renderIdle() {
    setStage(
      'idle',
      `
        <div class="stage-face stage-face--idle">
          <span class="start-orb"><svg class="icon" aria-hidden="true"><use href="#i-bolt"/></svg></span>
          <p class="stage-kicker">REACTION TEST · 5 ROUNDS</p>
          <h3>准备好了吗？</h3>
          <p class="stage-sub">点击任意位置开始，看到绿色立即反应</p>
        </div>
      `,
      '开始反应力测试',
    );
  }

  function renderWaiting() {
    setStage(
      'waiting',
      `
        <div class="stage-face stage-face--waiting">
          <div class="wait-dots" aria-hidden="true"><span></span><span></span><span></span></div>
          <p class="stage-kicker">HOLD · WAIT FOR GREEN</p>
          <h3>等待绿色…</h3>
          <p class="stage-sub">不要提前点击，抢跑会让本轮作废</p>
        </div>
      `,
      '等待绿色信号，看到绿色后立即点击',
    );
  }

  function renderReady() {
    setStage(
      'ready',
      `
        <div class="stage-face stage-face--ready">
          <p class="stage-kicker">SIGNAL · GO</p>
          <h3>点击</h3>
          <p class="stage-sub">立即响应</p>
        </div>
      `,
      '绿色出现，立即点击',
    );
  }

  function renderRoundResult(ms) {
    const roundNumber = state.rounds.length;
    setStage(
      'result',
      `
        <div class="stage-face stage-face--result">
          <p class="stage-kicker">ROUND ${roundNumber} / ${TOTAL_ROUNDS}</p>
          <p class="stage-ms">${ms}<small>ms</small></p>
          <p class="stage-progress">当前 ${roundNumber}/${TOTAL_ROUNDS} 次</p>
          <p class="stage-sub">${quickComment(ms)} · 点击此区域开始下一轮</p>
        </div>
      `,
      `第 ${roundNumber} 轮成绩 ${ms} 毫秒`,
    );
  }

  function renderEarly() {
    setStage(
      'early',
      `
        <div class="stage-face stage-face--early">
          <p class="stage-kicker">FALSE START</p>
          <h3>太早了</h3>
          <p class="stage-sub">等到绿色出现再点击 · 点击此区域重试本轮</p>
        </div>
      `,
      '抢跑，本轮作废，点击按钮重试',
    );
  }

  function renderPaused() {
    setStage(
      'paused',
      `
        <div class="stage-face stage-face--paused">
          <span class="paused-icon"><svg class="icon" aria-hidden="true"><use href="#i-clock"/></svg></span>
          <p class="stage-kicker">PAUSED</p>
          <h3>测试暂停</h3>
          <p class="stage-sub">检测到页面切换，本轮作废。点击此区域继续</p>
        </div>
      `,
      '测试已暂停，点击按钮继续本轮',
    );
  }

  function renderComplete(avgMs, tier) {
    setStage(
      'complete',
      `
        <div class="stage-face stage-face--complete">
          <p class="stage-kicker">TEST COMPLETE</p>
          <p class="stage-ms">${avgMs}<small>ms</small></p>
          <p class="stage-progress">当前 5/5 次</p><p class="stage-sub">5 轮平均反应</p>
          <span class="stage-tier">${tier.name}</span>
        </div>
      `,
      `测试完成，平均 ${avgMs} 毫秒，${tier.name}`,
    );
  }

  function beginRound() {
    if (state.phase === 'complete') return;
    if (document.hidden) {
      renderPaused();
      return;
    }
    clearTimers();
    renderWaiting();
    announce(`第 ${state.rounds.length + 1} 轮，等待绿色信号。`);

    const delay = WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS);
    later(() => {
      if (state.phase !== 'waiting') return;
      if (document.hidden) {
        renderPaused();
        return;
      }
      state.signalFrame = requestAnimationFrame(() => {
        state.signalFrame = null;
        if (state.phase !== 'waiting' || document.hidden) return;
        renderReady();
        state.readyAt = performance.now();
        announce('绿色出现，立即点击。');
      });
    }, delay);
  }

  function startSession() {
    usageSessionId = crypto.randomUUID();
    reportUsage('start');
    clearTimers();
    state.rounds = [];
    state.falseStarts = 0;
    state.readyAt = 0;
    state.result = null;
    state.submitted = false;
    hideResultSheet();
    updateMetrics();
    beginRound();
  }

  function respond() {
    if (state.phase === 'waiting') {
      handleEarlyStart();
      return;
    }
    if (state.phase !== 'ready') return;

    const respondedAt = performance.now();
    clearTimers();
    const elapsed = respondedAt - state.readyAt;
    if (elapsed < 80) {
      resetTest();
      setStage('cancelled', `<div class="stage-face stage-face--early"><p class="stage-kicker">PREDICTION</p><h3>成绩已取消</h3><p class="stage-sub">反应低于80ms，视为预测。点击此区域重新开始五轮测试。</p></div>`, '检测到预测，整次成绩取消，点击重新开始');
      announce('反应低于80毫秒，整次成绩取消，不会保存或上传。');
      return;
    }
    const ms = Math.round(elapsed);
    state.readyAt = 0;
    state.rounds.push(ms);
    renderRoundResult(ms);
    updateMetrics();
    announce(`第 ${state.rounds.length} 轮，${ms} 毫秒。`);

    if (state.rounds.length >= TOTAL_ROUNDS) {
      finishSession();
    }
  }

  function handleEarlyStart() {
    clearTimers();
    state.falseStarts += 1;
    if (state.falseStarts > 5) {
      startSession();
      announce('抢跑超过5次，已清空本次成绩并重新开始五轮测试。');
      return;
    }
    renderEarly();
    updateMetrics();
    state.readyAt = 0;
    announce('点击太早了，本轮作废，请点击重试本轮。');
  }

  function finishSession() {
    if (state.rounds.length !== TOTAL_ROUNDS) return;
    reportUsage('complete');
    clearTimers();

    const rounds = [...state.rounds];
    const sum = rounds.reduce((total, value) => total + value, 0);
    const avgMs = Math.round(sum / rounds.length);
    const bestMs = Math.min(...rounds);
    const worstMs = Math.max(...rounds);
    const tier = tierFor(avgMs);
    const previousBest = getPersonalBest();

    state.result = {
      submissionId: crypto.randomUUID(),
      avgMs,
      bestMs,
      worstMs,
      rounds,
      falseStarts: state.falseStarts,
    };
    state.submitted = false;

    renderComplete(avgMs, tier);
    saveSession(state.result);
    updateMetrics();
    updateHeroPb();

    const isNewBest = previousBest === null || avgMs < previousBest;
    populateResultSheet(tier, isNewBest);
    showResultSheet();
    if (WEBSITE_MODE && account) void handleSubmit({ preventDefault() {} });
    announce(`测试完成，平均 ${avgMs} 毫秒，${tier.name}。成绩已保存到本地。`);

    later(() => {
      if (els.resultSheet.hidden) return;
      const rect = els.resultSheet.getBoundingClientRect();
      if (rect.top > window.innerHeight - 80) {
        els.resultSheet.scrollIntoView({
          behavior: reducedMotionQuery.matches ? 'auto' : 'smooth',
          block: 'center',
        });
      }
    }, 180);
  }

  function resetSubmitUI() {
    els.submitForm.hidden = false;
    els.submitSuccess.hidden = true;
    els.nickname.disabled = false;
    els.submitBtn.disabled = false;
    els.submitBtnLabel.textContent = WEBSITE_MODE ? (account ? '上传 / 重试' : '登录后上榜') : '提交到排行榜';
    els.nickname.value = loadNickname();
    els.submitNote.className = 'form-note';
    updateSubmitNote();
  }

  function populateResultSheet(tier, isNewBest) {
    els.resultTier.textContent = tier.name;
    els.resultAvg.textContent = String(state.result.avgMs);
    els.resultBest.textContent = `${state.result.bestMs} ms`;
    els.resultWorst.textContent = `${state.result.worstMs} ms`;
    els.resultEarly.textContent = `${state.result.falseStarts} 次`;
    els.resultNote.textContent = `${tier.note}${isNewBest ? ' 本局也刷新了你的个人最佳。' : ''}`;

    const fragment = document.createDocumentFragment();
    state.result.rounds.forEach((ms, index) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      const value = document.createElement('strong');
      const unit = document.createElement('small');
      label.textContent = `R${index + 1}`;
      value.textContent = String(ms);
      unit.textContent = 'ms';
      value.append(unit);
      item.append(label, value);
      fragment.append(item);
    });
    els.resultRounds.replaceChildren(fragment);

    resetSubmitUI();
  }

  function showResultSheet() {
    els.resultSheet.hidden = false;
    els.resultSheet.classList.remove('is-visible');
    void els.resultSheet.offsetWidth;
    els.resultSheet.classList.add('is-visible');
  }

  function hideResultSheet() {
    els.resultSheet.classList.remove('is-visible');
    els.resultSheet.hidden = true;
  }

  function resetTest() {
    clearTimers();
    state.rounds = [];
    state.falseStarts = 0;
    state.readyAt = 0;
    state.result = null;
    state.submitted = false;
    hideResultSheet();
    renderIdle();
    updateMetrics();
  }

  function setConnection(status) {
    const labels = {
      checking: '连接中',
      online: '排行榜在线',
      offline: '本地模式',
    };
    state.online = status === 'online' ? true : status === 'offline' ? false : null;
    els.connState.dataset.state = status;
    els.connLabel.textContent = labels[status];
  }

  function setSubmitNote(message, tone = '') {
    els.submitNote.className = `form-note${tone ? ` is-${tone}` : ''}`;
    els.submitNote.textContent = message;
  }

  function updateSubmitNote() {
    if (!state.result || state.submitted || els.submitForm.hidden) return;
    if (WEBSITE_MODE) {
      setSubmitNote(account ? `使用 ${account.name} 自动上传本次五轮成绩，点击榜单玩家可查看主页。` : '本地成绩已保存，登录后才可上传排行榜。');
      els.submitBtnLabel.textContent = account ? '上传 / 重试' : '登录后上榜';
      return;
    }
    if (state.online === false) {
      setSubmitNote('排行榜当前离线，成绩已保存在本地。恢复连接后可再次提交。', 'warn');
    } else {
      setSubmitNote('昵称会公开显示，其他信息仅保存在本地。');
    }
  }

  function setSubmitting(isSubmitting) {
    els.submitBtn.disabled = isSubmitting;
    els.nickname.disabled = isSubmitting;
    els.retryBtn.disabled = isSubmitting;
    els.submitBtnLabel.textContent = isSubmitting ? '正在提交…' : '提交到排行榜';
  }

  function showSubmitSuccess(data) {
    const total = Number(data.total) || 0;
    const rank = Number(data.rank) || 0;
    const percentile = Number(data.percentile) || 0;

    els.submitForm.hidden = true;
    els.submitSuccess.hidden = false;
    els.submitResultText.textContent =
      WEBSITE_MODE && data.personalBest && data.isPersonalBest === false
        ? `本局成绩已保存，榜单保留你的最佳平均 ${data.personalBest.avgMs} ms（同局最快 ${data.personalBest.bestMs} ms），当前第 ${rank} 名。`
        : total <= 1
        ? '你是第一位上榜的玩家，抢占先机。'
        : `当前排名第 ${rank} 名，击败了 ${percentile}% 的玩家（共 ${formatNumber(total)} 人）。`;

    els.submitSuccess.setAttribute('tabindex', '-1');
    els.submitSuccess.focus({ preventScroll: true });
  }

  function showToast(message, tone = 'info') {
    window.clearTimeout(showToast.timer);
    els.toast.textContent = message;
    els.toast.dataset.tone = tone;
    els.toast.classList.add('is-visible');
    showToast.timer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 3200);
  }

  async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(apiUrl(path), {
        ...options,
        cache: 'no-store',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        signal: controller.signal,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          payload && typeof (payload.error || payload.message) === 'string'
            ? (payload.error || payload.message)
            : `请求失败（${response.status}）`;
        throw new HttpError(message, response.status);
      }
      if (payload === null) throw new Error('服务器返回了无法解析的数据。');
      return payload && payload.success === true ? payload.data : payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查网络连接。');
      if (error instanceof HttpError) throw error;
      throw new Error('无法连接服务器。');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function formatWhen(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    const delta = date.getTime() - Date.now();
    const abs = Math.abs(delta);
    if (abs < 60_000) return '刚刚';
    if (abs < 3_600_000) return relativeTime.format(Math.round(delta / 60_000), 'minute');
    if (abs < 86_400_000) return relativeTime.format(Math.round(delta / 3_600_000), 'hour');
    if (abs < 7 * 86_400_000) return relativeTime.format(Math.round(delta / 86_400_000), 'day');
    return date.getFullYear() === new Date().getFullYear()
      ? shortDate.format(date)
      : longDate.format(date);
  }

  function renderBoardSkeleton() {
    els.boardBody.innerHTML = `
      <div class="board-skeleton" aria-label="正在加载排行榜">
        <div class="skeleton-row"><span></span><span></span><span></span><span></span></div>
        <div class="skeleton-row"><span></span><span></span><span></span><span></span></div>
        <div class="skeleton-row"><span></span><span></span><span></span><span></span></div>
        <div class="skeleton-row"><span></span><span></span><span></span><span></span></div>
        <div class="skeleton-row"><span></span><span></span><span></span><span></span></div>
      </div>
    `;
  }

  function createBoardState({ iconId, title, description, actionHtml = '' }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'board-state';
    wrapper.innerHTML = `
      <span class="board-state-icon" aria-hidden="true"><svg class="icon"><use href="#${iconId}"/></svg></span>
      <h3></h3>
      <p></p>
      ${actionHtml}
    `;
    wrapper.querySelector('h3').textContent = title;
    wrapper.querySelector('p').textContent = description;
    return wrapper;
  }

  function renderBoardEmpty() {
    const wrapper = createBoardState({
      iconId: 'i-target',
      title: '榜上还没有成绩',
      description: '完成 5 轮测试并上传，你就是第一位上榜的玩家。',
      actionHtml: '<a class="btn btn-ghost" href="#test">去抢第一名</a>',
    });
    els.boardBody.replaceChildren(wrapper);
  }

  function renderBoardError() {
    const wrapper = createBoardState({
      iconId: 'i-refresh',
      title: '排行榜暂时无法连接',
      description: '服务器没有响应。你仍然可以完成测试，成绩会保存在本地，恢复连接后再提交。',
      actionHtml: '<button class="btn btn-ghost" type="button" data-action="retry-board">重新连接</button>',
    });
    els.boardBody.replaceChildren(wrapper);
  }

  function buildTimeCell(ms, extraClass = '') {
    const cell = document.createElement('td');
    cell.className = `col-time ${extraClass}`.trim();
    const value = document.createElement('span');
    value.className = 'time-cell';
    value.append(String(ms));
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = 'ms';
    value.append(unit);
    cell.append(value);
    return cell;
  }

  function renderBoard() {
    if (state.boardEntries.length === 0) {
      renderBoardEmpty();
      return;
    }

    const table = document.createElement('table');
    table.className = 'board-table';

    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent =
      state.boardSort === 'best' ? '按单轮最快排序的反应排行榜' : '按平均成绩排序的反应排行榜';
    table.append(caption);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    [
      ['名次', 'col-rank'],
      ['玩家', 'col-player'],
      ['平均', 'col-time'],
      ['最快', 'col-time col-best'],
      ['时间', 'col-date'],
    ].forEach(([label, className]) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.className = className;
      th.textContent = label;
      headRow.append(th);
    });
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    state.boardEntries.forEach((entry) => {
      const row = document.createElement('tr');
      const isSelf = account?.id === entry.accountId || (state.lastScoreId !== null && Number(entry.id) === Number(state.lastScoreId));
      if (isSelf) row.classList.add('is-self');

      const rankCell = document.createElement('td');
      rankCell.className = 'col-rank';
      const rankBadge = document.createElement('span');
      rankBadge.className = `rank-badge${entry.rank <= 3 ? ` rank-${entry.rank}` : ''}`;
      rankBadge.textContent = String(entry.rank);
      rankCell.append(rankBadge);

      const playerCell = document.createElement('td');
      playerCell.className = 'col-player';
      const profilePath = typeof entry.profilePath === 'string' && /^\/players\/(?:[0-9]+|[0-9a-f-]{36})$/i.test(entry.profilePath) ? entry.profilePath : null;
      const playerName = document.createElement(profilePath ? 'a' : 'span');
      if (profilePath) { playerName.href = profilePath; if (WEBSITE_MODE) playerName.target = '_top'; }
      playerName.className = 'player-name';
      playerName.textContent = entry.name;
      playerName.title = entry.name;
      if (typeof entry.avatarUrl === 'string' && /^\/uploads\/[A-Za-z0-9/_.-]+$/.test(entry.avatarUrl) && !entry.avatarUrl.includes('..')) {
        const avatar = document.createElement('img'); avatar.src = entry.avatarUrl; avatar.alt = ''; avatar.className = 'board-avatar'; avatar.loading = 'lazy';
        avatar.addEventListener('error', () => avatar.remove(), { once: true }); playerCell.append(avatar);
      }
      playerCell.append(playerName);
      if (isSelf) {
        const tag = document.createElement('span');
        tag.className = 'self-tag';
        tag.textContent = '我的成绩';
        playerCell.append(tag);
      }

      row.append(
        rankCell,
        playerCell,
        buildTimeCell(entry.avgMs),
        buildTimeCell(entry.bestMs, 'col-best'),
      );

      const dateCell = document.createElement('td');
      dateCell.className = 'col-date';
      dateCell.textContent = formatWhen(entry.createdAt);
      row.append(dateCell);

      tbody.append(row);
      if (BOARD_MODE && typeof entry.accountId === 'string' && /^[0-9a-f-]{36}$/i.test(entry.accountId)) {
        const toggle = document.createElement('button');
        toggle.className = 'details-toggle'; toggle.type = 'button';
        toggle.textContent = '展开前 5 局'; toggle.setAttribute('aria-expanded', 'false');
        playerCell.append(toggle);
        let detailsRow = null;
        toggle.addEventListener('click', async () => {
          if (detailsRow) { detailsRow.remove(); detailsRow = null; toggle.textContent = '展开前 5 局'; toggle.setAttribute('aria-expanded', 'false'); return; }
          const expanded = document.createElement('tr'); detailsRow = expanded;
          const cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'session-details'; cell.textContent = '正在加载…'; expanded.append(cell);
          row.after(expanded); toggle.disabled = true; toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = '收起';
          try {
            const detail = await apiRequest(`/api/leaderboard/accounts/${encodeURIComponent(entry.accountId)}`);
            if (!row.isConnected || detailsRow !== expanded) return;
            const title = document.createElement('p'); title.textContent = `累计 ${Number(detail.total) || 0} 局 · 平均成绩最佳的前 5 局`;
            const list = document.createElement('ol'); list.className = 'session-list';
            for (const session of Array.isArray(detail.sessions) ? detail.sessions.slice(0, 5) : []) {
              const item = document.createElement('li');
              const label = document.createElement('strong'); label.textContent = `平均 ${session.avgMs} ms · 最快 ${session.bestMs} ms`;
              const rounds = document.createElement('span'); rounds.textContent = `五轮：${Array.isArray(session.rounds) ? session.rounds.join(' / ') : '—'} ms`;
              const time = document.createElement('span'); time.textContent = formatWhen(session.createdAt);
              item.append(label, rounds, time); list.append(item);
            }
            cell.replaceChildren(title, list);
          } catch { cell.textContent = '成绩明细加载失败，请收起后重新展开。'; }
          finally { toggle.disabled = false; }
        });
      }
    });
    table.append(tbody);
    els.boardBody.replaceChildren(table);
  }

  function syncSortButtons() {
    els.boardTabs.forEach((button) => {
      const active = button.dataset.sort === state.boardSort;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  async function loadBoard({ silent = false } = {}) {
    const sequence = ++state.boardSeq;
    state.boardLoading = true;
    els.refreshBtn.classList.add('is-spinning');
    if (!silent) renderBoardSkeleton();

    try {
      const data = await apiRequest(
        `/api/leaderboard?sort=${encodeURIComponent(state.boardSort)}&limit=${BOARD_LIMIT}`,
      );
      if (sequence !== state.boardSeq) return;

      state.boardEntries = Array.isArray(data.entries) ? data.entries : [];
      state.boardTotal = Number(data.total) || 0;
      setConnection('online');
      els.heroTotal.textContent = formatNumber(state.boardTotal);
      els.boardCount.textContent = `${formatNumber(state.boardTotal)} 位用户`;
      renderBoard();
      updateSubmitNote();
    } catch {
      if (sequence !== state.boardSeq) return;
      setConnection('offline');
      els.heroTotal.textContent = '—';
      els.boardCount.textContent = '离线';
      if (state.boardEntries.length === 0) {
        renderBoardError();
      } else if (!silent) {
        showToast('排行榜刷新失败，当前展示的是上次数据。', 'error');
      }
      updateSubmitNote();
    } finally {
      if (sequence === state.boardSeq) {
        state.boardLoading = false;
        els.refreshBtn.classList.remove('is-spinning');
      }
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!state.result || state.submitted || els.submitBtn.disabled) return;

    if (WEBSITE_MODE && !account) {
      if (parent !== window) parent.postMessage({ type: 'yuz1-reaction-login' }, location.origin);
      else location.assign('/login?redirect=/tools/reaction');
      return;
    }
    const run = state.result;
    const name = WEBSITE_MODE ? account.name : els.nickname.value.trim();
    const nameLength = Array.from(name).length;
    if (nameLength < 1) {
      setSubmitNote('请输入昵称后再提交。', 'error');
      els.nickname.focus();
      return;
    }
    if (!WEBSITE_MODE && nameLength > 16) {
      setSubmitNote('昵称最多 16 个字符。', 'error');
      els.nickname.focus();
      return;
    }

    setSubmitting(true);
    setSubmitNote('正在提交，请稍候…');
    try {
      const data = WEBSITE_MODE ? await parentRequest(run) : await apiRequest('/api/scores', {
        method: 'POST',
        body: JSON.stringify({ name, rounds: state.result.rounds }),
      });

      if (state.result !== run) return;
      state.submitted = true;
      state.lastScoreId = Number(data.personalBest?.id ?? data.score?.id) || null;
      state.boardTotal = Number(data.total) || state.boardTotal;
      saveNickname(name);
      setConnection('online');
      els.heroTotal.textContent = formatNumber(state.boardTotal);
      els.boardCount.textContent = `${formatNumber(state.boardTotal)} 位用户`;
      showSubmitSuccess(data);

      state.boardSort = 'avg';
      syncSortButtons();
      loadBoard({ silent: true });
      showToast('成绩已提交到排行榜。', 'success');
    } catch (error) {
      if (state.result !== run) return;
      if (error instanceof HttpError) {
        setSubmitNote(error.message, 'error');
      } else {
        setConnection('offline');
        setSubmitNote('无法连接服务器，本局成绩仍保存在本地。请启动服务后重试。', 'error');
      }
    } finally {
      if (state.result === run) setSubmitting(false);
    }
  }

  function isInteractiveElement(element) {
    if (!(element instanceof Element)) return false;
    return (
      ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(element.tagName) ||
      element.isContentEditable
    );
  }

  els.stage.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (state.phase === 'idle' || state.phase === 'cancelled') {
      startSession();
      return;
    }
    if (['result', 'early', 'paused'].includes(state.phase)) {
      event.preventDefault(); beginRound(); return;
    }
    if (state.phase === 'waiting' || state.phase === 'ready') {
      event.preventDefault();
      respond();
    }
  });

  els.stage.addEventListener('contextmenu', (event) => {
    if (state.phase === 'waiting' || state.phase === 'ready') event.preventDefault();
  });

  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code !== 'Space' && event.code !== 'Enter') return;

    const active = document.activeElement;
    if (active && active !== els.stage && isInteractiveElement(active)) return;

    if (state.phase === 'idle' || state.phase === 'cancelled') {
      if (!state.testVisible) return;
      event.preventDefault();
      startSession();
      return;
    }
    if (['result', 'early', 'paused'].includes(state.phase)) {
      event.preventDefault(); beginRound(); return;
    }
    if (state.phase === 'waiting' || state.phase === 'ready') {
      event.preventDefault();
      respond();
    }
  });

  function pauseActiveRound() {
    if (state.phase !== 'waiting' && state.phase !== 'ready') return;
    clearTimers();
    state.readyAt = 0;
    renderPaused();
    announce('本轮已暂停，请手动点击继续本轮。');
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseActiveRound(); });
  window.addEventListener('blur', pauseActiveRound);
  window.addEventListener('pagehide', () => { pauseActiveRound(); clearTimers(); });
  els.resetBtn.addEventListener('click', () => {
    resetTest();
    els.stage.focus({ preventScroll: true });
    announce('测试已重置。');
  });

  els.retryBtn.addEventListener('click', () => {
    resetTest();
    els.stage.scrollIntoView({
      behavior: reducedMotionQuery.matches ? 'auto' : 'smooth',
      block: 'center',
    });
    els.stage.focus({ preventScroll: true });
    startSession();
  });

  els.submitForm.addEventListener('submit', handleSubmit);

  els.nickname.addEventListener('input', () => {
    if (els.submitNote.classList.contains('is-error')) {
      updateSubmitNote();
    }
  });

  els.refreshBtn.addEventListener('click', () => {
    if (!state.boardLoading) loadBoard();
  });

  els.boardTabs.forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.sort === state.boardSort || state.boardLoading) return;
      state.boardSort = button.dataset.sort;
      syncSortButtons();
      loadBoard();
    });
  });

  els.boardBody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-action="retry-board"]')) loadBoard();
  });

  function init() {
    els.year.textContent = String(new Date().getFullYear());
    els.nickname.value = loadNickname();
    renderIdle();
    updateMetrics();
    updateHeroPb();
    syncSortButtons();
    setConnection('checking');

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          state.testVisible = entries.some((entry) => entry.isIntersecting);
        },
        { threshold: 0.25 },
      );
      observer.observe(els.testSection);
    } else {
      state.testVisible = true;
    }

    if (WEBSITE_MODE && parent !== window) parent.postMessage({ type: 'yuz1-reaction-ready' }, location.origin);
    if (WEBSITE_MODE) { els.nickname.hidden = true; els.nickname.required = false; els.nickname.closest('form').querySelector('label').hidden = true; document.querySelector('.result-submit-copy').textContent = '登录后，完整五轮成绩自动使用本站账号上传。'; }
    loadBoard();
  }

  init();
})();
