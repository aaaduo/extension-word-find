#!/usr/bin/env node
/*
 * WordFind 后台挖词编排测试（Node + vm 模拟 chrome API）。
 * 运行：node tools/background-test.cjs
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const store = { settings: {}, input: '', library: [] };
const listeners = { webRequest: [], tabRemoved: [], message: [] };
let nextTabId = 100;
let removedTabs = [];

function pick(keys) {
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const out = {};
    keys.forEach((key) => {
      out[key] = store[key];
    });
    return out;
  }
  return { ...store };
}

const chrome = {
  storage: {
    local: {
      get: (keys) => Promise.resolve(pick(keys)),
      set: (values) => {
        Object.assign(store, values);
        return Promise.resolve();
      },
      remove: (keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
        return Promise.resolve();
      }
    }
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onConnect: { addListener: () => {} },
    sendMessage: () => Promise.resolve()
  },
  contextMenus: {
    removeAll: () => Promise.resolve(),
    create: () => {},
    onClicked: { addListener: () => {} }
  },
  sidePanel: {
    setPanelBehavior: () => Promise.resolve(),
    open: () => Promise.resolve()
  },
  windows: { create: () => Promise.resolve({}) },
  tabs: {
    create: (options) => {
      const tab = { id: nextTabId, ...options };
      nextTabId += 1;
      return Promise.resolve(tab);
    },
    update: (tabId) => Promise.resolve({ id: tabId }),
    remove: (tabId) => {
      removedTabs.push(tabId);
      return Promise.resolve();
    },
    query: () => Promise.resolve([{ id: 1 }]),
    onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) }
  },
  webRequest: {
    onCompleted: {
      addListener: (fn) => listeners.webRequest.push(fn)
    }
  }
};

const timeline = JSON.stringify({
  default: {
    timelineData: Array.from({ length: 12 }, (_, index) => ({
      value: [10, index < 2 ? 0 : index * 5]
    }))
  }
});

const related = JSON.stringify({
  default: {
    rankedList: [
      { rankedKeyword: [{ query: 'top fallback' }] },
      { rankedKeyword: [{ query: 'rising keyword' }] }
    ]
  }
});

function fakeFetch(url) {
  if (String(url).includes('relatedsearches')) {
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(")]}'\n" + related)
    });
  }
  if (String(url).includes('multiline')) {
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(")]}'\n" + timeline)
    });
  }
  return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
}

const sandbox = {
  chrome,
  console,
  fetch: fakeFetch,
  URL,
  AbortSignal,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (...files) => {
  files.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  });
};

const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, {
  filename: 'background.js'
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await wait(30); // 等 radarReady 恢复完成

  assert.strictEqual(typeof context.startRadar, 'function');
  assert.strictEqual(listeners.webRequest.length, 1);

  const started = await context.startRadar({
    seeds: ['seed one'],
    compare: 'base',
    maxKeywords: 1,
    threshold: 100,
    dateRange: 'now 7-d',
    geo: 'US',
    closeTab: true
  });
  assert.strictEqual(started.total, 1);
  assert.strictEqual(store.radar.phase, 'running');
  const tabId = store.radar.tabId;
  assert.ok(tabId);

  const handler = listeners.webRequest[0];
  handler({
    tabId,
    url:
      'https://trends.google.com/trends/api/widgetdata/relatedsearches?req=' +
      encodeURIComponent('{"keywordType":"QUERY"}')
  });
  handler({
    tabId,
    url: 'https://trends.google.com/trends/api/widgetdata/multiline?req=x'
  });

  await wait(200);

  assert.strictEqual(store.radar.phase, 'done');
  assert.strictEqual(store.radar.processed, 1);
  assert.strictEqual(store.radar.effective.length, 1);
  assert.strictEqual(store.radar.effective[0].keyword, 'seed one');
  assert.strictEqual(store.radar.effective[0].percentage, 550);
  assert.ok(store.radar.related.includes('rising keyword'));
  assert.ok(removedTabs.includes(tabId));

  await context.startRadar({
    seeds: ['alpha', 'beta'],
    compare: 'base',
    maxKeywords: 5,
    threshold: 100,
    dateRange: 'now 7-d',
    geo: 'US',
    closeTab: true
  });
  assert.strictEqual(store.radar.phase, 'running');
  const stopTab = store.radar.tabId;
  await context.stopRadar();
  assert.strictEqual(store.radar.phase, 'stopped');
  assert.ok(removedTabs.includes(stopTab));

  await context.favoriteKeyword('Running Shoes');
  assert.strictEqual(store.library.length, 1);
  assert.strictEqual(store.library[0].keyword, 'Running Shoes');
  assert.strictEqual(store.library[0].favorite, true);

  await context.favoriteKeyword('running shoes');
  assert.strictEqual(store.library.length, 1);

  await context.startRadar({
    seeds: ['alpha', 'beta'],
    compare: 'base',
    maxKeywords: 2,
    threshold: 100,
    dateRange: 'now 7-d',
    geo: 'US',
    closeTab: true
  });
  const graceTab = store.radar.tabId;
  handler({
    tabId: graceTab,
    url:
      'https://trends.google.com/trends/api/widgetdata/relatedsearches?req=' +
      encodeURIComponent('{"keywordType":"QUERY"}')
  });
  handler({
    tabId: graceTab,
    url: 'https://trends.google.com/trends/api/widgetdata/multiline?req=x'
  });
  await wait(2900);
  assert.strictEqual(store.radar.phase, 'done');
  assert.strictEqual(store.radar.processed, 2);

  console.log('ok - 挖词：启动 → 拦截接口 → 有效新词 → 完成');
  console.log('ok - 挖词：停止并关闭后台标签页');
  console.log('ok - 挖词：相关响应不齐时宽限期后继续');
  console.log('ok - 词库：收藏写入与大小写去重');
  console.log('\n4 checks passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
