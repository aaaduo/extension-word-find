/*
 * WordFind 关键词雷达 - 后台服务
 * 负责：右键菜单、侧边栏入口、翻译/相关词代理、自动挖词爬虫、词库写入。
 */
importScripts('shared.js', 'radar.js');

const WF = self.WF;
const WFRadar = self.WFRadar;
const MENU_ROOT = 'wf-root';

/* ---------------- 基础存储 ---------------- */

async function ensureStorage() {
  const data = await chrome.storage.local.get(['settings', 'input', 'library']);
  const patch = {};
  if (!data.settings || typeof data.settings !== 'object') {
    patch.settings = { ...WF.DEFAULT_SETTINGS };
  }
  if (typeof data.input !== 'string') {
    patch.input = '';
  }
  if (!Array.isArray(data.library)) {
    patch.library = [];
  }
  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
}

async function ensureMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: 'WordFind 关键词雷达',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'wf-analyze',
    parentId: MENU_ROOT,
    title: '分析选中关键词',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'wf-compare',
    parentId: MENU_ROOT,
    title: '与对比组一起打开',
    contexts: ['selection']
  });
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function openPanel() {
  const tab = await getCurrentTab();
  if (tab && tab.id) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
      return true;
    } catch (error) {
      console.warn('[WordFind] sidePanel.open 失败，改用独立窗口。', error);
    }
  }
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html'),
      type: 'popup',
      width: 460,
      height: 860
    });
    return true;
  } catch (error) {
    console.error('[WordFind] 无法打开侧边栏。', error);
    return false;
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...WF.DEFAULT_SETTINGS, ...(settings || {}) };
}

/* ---------------- 翻译与相关词 ---------------- */

async function translate(text, targetLang) {
  const source = String(text || '').trim();
  if (!source) return '';
  const tl = targetLang || 'zh-CN';
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(tl) +
    '&dt=t&q=' +
    encodeURIComponent(source);
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    throw new Error('翻译服务返回 ' + response.status);
  }
  const data = await response.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('翻译结果格式异常');
  }
  return data[0]
    .map((segment) => (segment && segment[0]) || '')
    .join('')
    .trim();
}

async function suggestKeywords(keyword, geo, hl) {
  const term = String(keyword || '').trim();
  if (!term) return [];
  const gl = String(geo || 'US').toLowerCase();
  const url =
    'https://suggestqueries.google.com/complete/search?client=chrome&hl=' +
    encodeURIComponent(hl || 'zh-CN') +
    '&gl=' +
    encodeURIComponent(gl) +
    '&q=' +
    encodeURIComponent(term);
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    throw new Error('相关词服务返回 ' + response.status);
  }
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error('相关词结果格式异常');
  }
  const list = Array.isArray(data && data[1]) ? data[1] : [];
  return list
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

/* ---------------- 自动挖词 ---------------- */

const DEFAULT_RADAR = {
  phase: 'idle', // idle | running | paused | done | error | stopped
  message: '',
  compare: '',
  roots: [],
  totalSeeds: 0,
  queue: 0,
  processed: 0,
  maxKeywords: 200,
  threshold: 20,
  related: [],
  effective: [],
  nextBatchAt: 0,
  startedAt: 0,
  finishedAt: 0,
  current: '',
  tabId: null,
  closeTab: true,
  dateRange: 'now 7-d',
  geo: ''
};

let radarState = { ...DEFAULT_RADAR };
let radarQueue = [];
let radarRuntime = null;
let radarTimer = null;
let radarBatchTimer = null;
let radarGraceTimer = null;
let radarStarting = false;

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

async function saveRadar() {
  await chrome.storage.local.set({ radar: radarState });
}

const radarReady = (async () => {
  try {
    const { radar } = await chrome.storage.local.get('radar');
    if (!radar) return;
    if (radar.phase === 'running' || radar.phase === 'paused') {
      radarState = {
        ...DEFAULT_RADAR,
        ...radar,
        phase: 'error',
        message: '后台任务被浏览器回收，挖词已中断，请重新开始。',
        tabId: null,
        nextBatchAt: 0
      };
      await saveRadar();
      if (radar.tabId) {
        chrome.tabs.remove(radar.tabId).catch(() => {});
      }
    } else {
      radarState = { ...DEFAULT_RADAR, ...radar };
    }
  } catch (error) {
    console.warn('[WordFind] 恢复挖词状态失败', error);
  }
})();

function clearRadarTimers() {
  clearTimeout(radarTimer);
  clearTimeout(radarBatchTimer);
  clearTimeout(radarGraceTimer);
  radarTimer = null;
  radarBatchTimer = null;
  radarGraceTimer = null;
}

/** 部分冷门词不会返回完整的相关搜索响应，收到最后一条后再等 2.5 秒就处理。 */
function scheduleRadarGrace(runtime) {
  clearTimeout(radarGraceTimer);
  radarGraceTimer = setTimeout(() => {
    radarGraceTimer = null;
    if (radarRuntime === runtime && radarState.phase === 'running' && runtime.multiline) {
      maybeProcessRadarBatch(runtime, true).catch((error) => failRadarBatch(error));
    }
  }, 2500);
}

async function closeRadarTab() {
  const tabId = radarState.tabId;
  radarState.tabId = null;
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // 标签页可能已被用户关闭
  }
}

async function startRadar(config) {
  if (radarStarting) {
    throw new Error('挖词正在启动，请稍候');
  }
  radarStarting = true;
  try {
    return await startRadarInternal(config);
  } finally {
    radarStarting = false;
  }
}

async function startRadarInternal(config) {
  await radarReady;
  const rawSeeds = Array.isArray(config.seeds) ? config.seeds : WF.parseSeeds(config.seeds);
  let seeds = WF.uniqueKeywords(rawSeeds);
  let compare = String(config.compare || '').trim();

  if (!compare) {
    if (seeds.length < 2) {
      throw new Error('至少需要两个关键词：一个作为基准词，一个作为种子');
    }
    compare = seeds.shift();
  }

  seeds = seeds.filter((keyword) => WF.keywordKey(keyword) !== WF.keywordKey(compare));
  if (!seeds.length) {
    throw new Error('种子关键词不能全部与基准词相同');
  }

  clearRadarTimers();
  if (radarState.tabId) {
    await closeRadarTab();
  }
  radarRuntime = null;
  radarQueue = [];

  radarState = {
    ...DEFAULT_RADAR,
    phase: 'running',
    message: '准备打开 Google Trends…',
    compare,
    roots: seeds.slice(),
    totalSeeds: seeds.length,
    queue: seeds.length,
    maxKeywords: clampInt(config.maxKeywords, 1, 500, 200),
    threshold: clampInt(config.threshold, 0, 1000, 20),
    dateRange: config.dateRange || 'now 7-d',
    geo: config.geo || '',
    closeTab: config.closeTab !== false,
    startedAt: Date.now(),
    tabId: null
  };
  radarQueue = seeds.slice();
  await saveRadar();
  await nextRadarBatch();
  return { total: seeds.length, compare };
}

async function nextRadarBatch(retryBatch, attempt) {
  if (!radarState || radarState.phase !== 'running') return;
  if (radarState.processed >= radarState.maxKeywords) {
    await finishRadar('done', '已达到最大词数，挖词完成。');
    return;
  }

  let batch;
  if (Array.isArray(retryBatch) && retryBatch.length) {
    batch = retryBatch.slice();
  } else {
    if (!radarQueue.length) {
      await finishRadar('done', '种子队列已跑完，挖词完成。');
      return;
    }
    batch = radarQueue.splice(0, Math.min(WFRadar.MAX_BATCH_SEEDS, radarQueue.length));
  }

  const terms = [radarState.compare].concat(batch).slice(0, 5);
  const url = WF.buildTrendsUrl(terms, {
    dateRange: radarState.dateRange,
    geo: radarState.geo,
    hl: 'en-US'
  });

  clearTimeout(radarGraceTimer);
  radarGraceTimer = null;
  radarRuntime = {
    batch,
    terms,
    related: [],
    multiline: null,
    processing: false,
    attempt: attempt || 0,
    startedAt: Date.now()
  };

  radarState.current = batch.join(', ');
  radarState.queue = radarQueue.length;
  radarState.message = '正在分析：' + radarState.current;
  radarState.nextBatchAt = 0;
  await saveRadar();

  try {
    if (!radarState.tabId) {
      const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: false,
        autoDiscardable: false
      });
      radarState.tabId = tab.id;
      await saveRadar();
    }
    await chrome.tabs.update(radarState.tabId, { url });
  } catch (error) {
    try {
      radarState.tabId = null;
      const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: false,
        autoDiscardable: false
      });
      radarState.tabId = tab.id;
      await saveRadar();
      await chrome.tabs.update(tab.id, { url });
    } catch (secondError) {
      await failRadarBatch(secondError);
      return;
    }
  }

  clearTimeout(radarBatchTimer);
  radarBatchTimer = setTimeout(() => {
    if (radarRuntime && !radarRuntime.processing) {
      failRadarBatch(new Error('等待 Google Trends 数据超时'));
    }
  }, 50000);
}

async function maybeProcessRadarBatch(runtime, force) {
  if (!runtime || runtime.processing) return;
  if (radarState.phase !== 'running') return;
  if (!runtime.multiline) return;
  if (!force && runtime.related.length < runtime.batch.length) return;
  if (radarRuntime !== runtime) return;

  runtime.processing = true;
  clearTimeout(radarBatchTimer);
  clearTimeout(radarGraceTimer);
  radarGraceTimer = null;

  const timeline =
    runtime.multiline && runtime.multiline.default
      ? runtime.multiline.default.timelineData
      : null;
  const effective = WFRadar.analyzeTimeline(timeline, runtime.batch, radarState.threshold);

  const effectiveKeys = new Set(radarState.effective.map((item) => WF.keywordKey(item.keyword)));
  let newEffective = 0;
  effective.forEach((item) => {
    const key = WF.keywordKey(item.keyword);
    if (!key || effectiveKeys.has(key)) return;
    effectiveKeys.add(key);
    radarState.effective.push(item);
    newEffective += 1;
  });

  const found = WFRadar.collectRelated(runtime.related).filter(WFRadar.isValidRelated);
  const known = new Set(
    radarState.roots
      .concat(radarState.related)
      .concat(radarState.effective.map((item) => item.keyword))
      .concat(radarQueue)
      .concat([radarState.compare])
      .map(WF.keywordKey)
  );

  let capacity = Math.max(
    0,
    radarState.maxKeywords - radarState.processed - runtime.batch.length - radarQueue.length
  );
  let added = 0;

  found.forEach((keyword) => {
    const key = WF.keywordKey(keyword);
    if (!key || known.has(key)) return;
    known.add(key);
    radarState.related.push(keyword);
    if (capacity > 0) {
      radarQueue.push(keyword);
      capacity -= 1;
      added += 1;
    }
  });

  radarState.related = radarState.related.slice(0, 1000);
  radarState.effective = radarState.effective.slice(0, 1000);
  radarState.processed += runtime.batch.length;
  radarState.queue = radarQueue.length;
  radarState.current = '';
  radarState.message =
    '本批新增 ' + added + ' 个相关词，有效新词 ' + newEffective + ' 个。';
  radarRuntime = null;

  if (radarState.processed >= radarState.maxKeywords) {
    await finishRadar('done', '已达到最大词数，挖词完成。');
    return;
  }
  if (!radarQueue.length) {
    await finishRadar('done', '种子队列已跑完，挖词完成。');
    return;
  }

  const delay = 4000 + Math.floor(Math.random() * 2000);
  radarState.nextBatchAt = Date.now() + delay;
  await saveRadar();
  clearTimeout(radarTimer);
  radarTimer = setTimeout(() => {
    nextRadarBatch().catch((error) => failRadarBatch(error));
  }, delay);
}

async function failRadarBatch(error) {
  const runtime = radarRuntime;
  if (!runtime) return;
  clearTimeout(radarBatchTimer);
  clearTimeout(radarGraceTimer);
  radarGraceTimer = null;
  radarRuntime = null;
  const message = error && error.message ? error.message : String(error);

  if (runtime.attempt < 1) {
    radarState.message = '本批失败，5 秒后重试：' + message;
    await saveRadar();
    clearTimeout(radarTimer);
    radarTimer = setTimeout(() => {
      nextRadarBatch(runtime.batch, runtime.attempt + 1).catch((nextError) =>
        failRadarBatch(nextError)
      );
    }, 5000);
    return;
  }

  radarState.processed += runtime.batch.length;
  radarState.queue = radarQueue.length;
  radarState.message = '已跳过一批：' + message;
  await saveRadar();

  if (radarState.processed >= radarState.maxKeywords) {
    await finishRadar('done', '已达到最大词数，挖词完成。');
    return;
  }
  if (!radarQueue.length) {
    await finishRadar('done', '种子队列已跑完，挖词完成。');
    return;
  }

  clearTimeout(radarTimer);
  radarTimer = setTimeout(() => {
    nextRadarBatch().catch((nextError) => failRadarBatch(nextError));
  }, 5000);
}

async function finishRadar(phase, message) {
  clearRadarTimers();
  radarRuntime = null;
  radarQueue = [];
  radarState.phase = phase;
  radarState.message = message || '';
  radarState.queue = 0;
  radarState.current = '';
  radarState.nextBatchAt = 0;
  radarState.finishedAt = Date.now();
  await saveRadar();
  if (radarState.closeTab !== false) {
    await closeRadarTab();
    await saveRadar();
  }
}

async function pauseRadar() {
  await radarReady;
  if (radarState.phase !== 'running') return;
  clearRadarTimers();
  if (radarRuntime) {
    radarQueue.unshift(...radarRuntime.batch);
    radarState.queue = radarQueue.length;
    radarRuntime = null;
  }
  radarState.phase = 'paused';
  radarState.message = '已暂停，可随时继续。';
  radarState.nextBatchAt = 0;
  await saveRadar();
}

async function resumeRadar() {
  await radarReady;
  if (radarState.phase !== 'paused') return;
  radarState.phase = 'running';
  radarState.message = '继续挖词…';
  await saveRadar();
  await nextRadarBatch();
}

async function stopRadar() {
  await radarReady;
  clearRadarTimers();
  radarRuntime = null;
  radarQueue = [];
  radarState.phase = 'stopped';
  radarState.message = '已停止，结果保留在下方。';
  radarState.queue = 0;
  radarState.current = '';
  radarState.nextBatchAt = 0;
  radarState.finishedAt = Date.now();
  await saveRadar();
  if (radarState.closeTab !== false) {
    await closeRadarTab();
    await saveRadar();
  }
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!radarRuntime || !radarState || radarState.phase !== 'running') return;
    if (details.tabId !== radarState.tabId) return;

    let url;
    try {
      url = new URL(details.url);
    } catch (error) {
      return;
    }

    const req = url.searchParams.get('req') || '';
    const compareBlock = '{"type":"BROAD","value":"' + (radarState.compare || '') + '"}';
    const isRelated =
      url.pathname === '/trends/api/widgetdata/relatedsearches' &&
      req.includes('"keywordType":"QUERY"') &&
      !req.includes(compareBlock);
    const isMultiline = url.pathname === '/trends/api/widgetdata/multiline';
    if (!isRelated && !isMultiline) return;

    const runtime = radarRuntime;
    (async () => {
      try {
        const response = await fetch(details.url, { credentials: 'include' });
        if (!response.ok) {
          throw new Error('Trends 接口返回 ' + response.status);
        }
        const raw = await response.text();
        if (radarRuntime !== runtime || radarState.phase !== 'running') return;
        const data = WFRadar.parsePayload(raw);
        if (!data) return;
        if (isRelated) {
          runtime.related.push(data);
          scheduleRadarGrace(runtime);
        } else {
          runtime.multiline = data;
          scheduleRadarGrace(runtime);
        }
        await maybeProcessRadarBatch(runtime);
      } catch (error) {
        if (radarRuntime === runtime) {
          await failRadarBatch(error);
        }
      }
    })();
  },
  { urls: ['*://trends.google.com/trends/api/*'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!radarState || radarState.tabId !== tabId) return;
  if (radarState.phase !== 'running' && radarState.phase !== 'paused') return;
  clearRadarTimers();
  radarRuntime = null;
  radarQueue = [];
  radarState.phase = 'error';
  radarState.message = 'Trends 标签页被关闭，挖词中断。';
  radarState.tabId = null;
  radarState.queue = 0;
  radarState.current = '';
  radarState.nextBatchAt = 0;
  saveRadar().catch(() => {});
});

/* ---------------- 词库写入 ---------------- */

async function favoriteKeyword(keyword) {
  const text = String(keyword || '').trim();
  if (!text) return { ok: false, error: '关键词为空' };
  const data = await chrome.storage.local.get('library');
  const library = Array.isArray(data.library) ? data.library.map((item) => ({ ...item })) : [];
  const key = WF.keywordKey(text);
  const record = library.find((item) => item && WF.keywordKey(item.keyword) === key);
  const now = Date.now();
  if (record) {
    record.favorite = true;
  } else {
    library.push({
      keyword: text,
      favorite: true,
      root: false,
      count: 0,
      firstSeen: now,
      lastUsed: 0
    });
  }
  await chrome.storage.local.set({ library });
  return { ok: true };
}

/* ---------------- 事件注册 ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  ensureStorage().catch((error) => console.error('[WordFind] 初始化存储失败', error));
  ensureMenus().catch((error) => console.error('[WordFind] 创建右键菜单失败', error));
  const behavior = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (behavior && behavior.catch) {
    behavior.catch((error) => console.warn('[WordFind] 设置侧边栏打开方式失败', error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureMenus().catch((error) => console.error('[WordFind] 重建右键菜单失败', error));
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const text = String(info.selectionText || '').trim();
  if (!text) return;

  if (info.menuItemId === 'wf-analyze') {
    await chrome.storage.local.set({ pending: { text, ts: Date.now() } });
    await openPanel();
    return;
  }

  if (info.menuItemId === 'wf-compare') {
    const { input } = await chrome.storage.local.get('input');
    const settings = await getSettings();
    const groups = WF.parseGroups(input || '');
    const base = (groups[0] || []).slice(0, WF.MAX_GROUP_SIZE - 1);
    const url = WF.buildTrendsUrl(base.concat(text), settings);
    await chrome.tabs.create({ url });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'wf:open-panel') {
    openPanel()
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'wf:translate') {
    translate(message.text, message.targetLang)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
      );
    return true;
  }

  if (message.type === 'wf:suggest') {
    suggestKeywords(message.keyword, message.geo, message.hl)
      .then((list) => sendResponse({ ok: true, list }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
      );
    return true;
  }

  if (message.type === 'wf:favorite') {
    favoriteKeyword(message.keyword)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'wf:radar-start') {
    startRadar(message.config || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
      );
    return true;
  }

  if (message.type === 'wf:radar-pause') {
    pauseRadar()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'wf:radar-resume') {
    resumeRadar()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'wf:radar-stop') {
    stopRadar()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return undefined;
});
