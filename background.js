/*
 * WordFind 关键词雷达 - 后台服务
 * 负责：右键菜单、侧边栏入口、翻译与相关词请求代理。
 */
importScripts('shared.js');

const WF = self.WF;
const MENU_ROOT = 'wf-root';

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

chrome.runtime.onInstalled.addListener(() => {
  ensureStorage().catch((error) => console.error('[WordFind] 初始化存储失败', error));
  ensureMenus().catch((error) => console.error('[WordFind] 创建右键菜单失败', error));
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn('[WordFind] 设置侧边栏打开方式失败', error));
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
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === 'wf:suggest') {
    suggestKeywords(message.keyword, message.geo, message.hl)
      .then((list) => sendResponse({ ok: true, list }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  return undefined;
});
