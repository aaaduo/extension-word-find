/*
 * WordFind 关键词雷达 - 侧边栏逻辑
 * 三个页签共用一套关键词模型：输入组、词库记录、设置。
 */
(function () {
  'use strict';

  const WF = window.WF;
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  const state = {
    settings: { ...WF.DEFAULT_SETTINGS },
    input: '',
    library: [],
    filters: { q: '', tag: 'all', sort: 'recent' },
    selected: new Set(),
    expanded: {},
    lastPendingTs: 0
  };

  /* ---------------- 基础工具 ---------------- */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(response || { ok: false, error: '后台没有响应' });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  let toastTimer = 0;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function fillSelect(select, options) {
    select.innerHTML = options
      .map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`)
      .join('');
  }

  function switchTab(name) {
    $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === name));
    $$('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === 'panel-' + name));
    if (name === 'library') renderLibrary();
    if (name === 'settings') syncSettingsControls();
  }

  /* ---------------- 存储 ---------------- */

  async function loadState() {
    const data = await chrome.storage.local.get(['settings', 'input', 'library', 'pending']);
    state.settings = { ...WF.DEFAULT_SETTINGS, ...(data.settings || {}) };
    state.input = typeof data.input === 'string' ? data.input : '';
    state.library = Array.isArray(data.library) ? data.library.filter((item) => item && item.keyword) : [];
    if (data.pending) {
      await applyPending(data.pending);
    }
  }

  async function saveSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    await chrome.storage.local.set({ settings: state.settings });
    syncSettingsControls();
    renderWorkbench();
  }

  async function saveInput(text) {
    state.input = String(text == null ? '' : text);
    await chrome.storage.local.set({ input: state.input });
    const box = $('#inputBox');
    if (document.activeElement !== box && box.value !== state.input) {
      box.value = state.input;
    }
    renderWorkbench();
  }

  async function saveLibrary(records) {
    state.library = records;
    await chrome.storage.local.set({ library: state.library });
    renderStats();
    renderWorkbench();
    renderLibrary();
  }

  /* ---------------- 数据模型 ---------------- */

  function getGroups() {
    return WF.parseGroups(state.input);
  }

  function libraryMap() {
    const map = new Map();
    state.library.forEach((record) => {
      if (record && record.keyword) map.set(WF.keywordKey(record.keyword), record);
    });
    return map;
  }

  async function touchKeywords(terms) {
    const records = state.library.map((record) => ({ ...record }));
    const map = new Map();
    records.forEach((record) => map.set(WF.keywordKey(record.keyword), record));
    const now = Date.now();
    let changed = false;
    (terms || []).forEach((term) => {
      const keyword = WF.stripQuotes(term).replace(/\s+/g, ' ').trim();
      if (!keyword) return;
      const key = WF.keywordKey(keyword);
      const record = map.get(key);
      if (record) {
        record.count = (Number(record.count) || 0) + 1;
        record.lastUsed = now;
        changed = true;
      } else {
        const next = {
          keyword,
          favorite: false,
          root: false,
          count: 1,
          firstSeen: now,
          lastUsed: now
        };
        map.set(key, next);
        records.push(next);
        changed = true;
      }
    });
    if (changed) await saveLibrary(records);
  }

  async function addGroupToLibrary(group, flags) {
    const records = state.library.map((record) => ({ ...record }));
    const map = new Map();
    records.forEach((record) => map.set(WF.keywordKey(record.keyword), record));
    const now = Date.now();
    let added = 0;
    group.forEach((term) => {
      const keyword = WF.stripQuotes(term).replace(/\s+/g, ' ').trim();
      if (!keyword) return;
      const key = WF.keywordKey(keyword);
      const record = map.get(key);
      if (record) {
        Object.assign(record, flags);
      } else {
        const next = {
          keyword,
          favorite: false,
          root: false,
          count: 0,
          firstSeen: now,
          lastUsed: 0,
          ...flags
        };
        map.set(key, next);
        records.push(next);
        added += 1;
      }
    });
    await saveLibrary(records);
    return added;
  }

  /* ---------------- 关键词工作台 ---------------- */

  function targetLangLabel() {
    const found = WF.TARGET_LANGS.find((item) => item.value === state.settings.targetLang);
    return found ? found.label : state.settings.targetLang;
  }

  function chipHtml(term, map) {
    const record = map.get(WF.keywordKey(term));
    let marks = '';
    if (record && record.favorite) marks += '<span class="mini fav" title="已收藏">★</span>';
    if (record && record.root) marks += '<span class="mini root" title="词根">根</span>';
    if (record && record.count) {
      marks += `<span class="mini count" title="已分析 ${record.count} 次">${record.count}</span>`;
    }
    return `<span class="chip" data-term="${esc(term)}" title="点击打开单个关键词趋势">${esc(term)}${marks}</span>`;
  }

  function renderGroupPanel(index) {
    const panel = state.expanded[index];
    if (!panel) return '';

    if (panel.kind === 'translate') {
      let body;
      if (panel.loading) {
        body = '<div class="loading">翻译中…</div>';
      } else if (panel.error) {
        body = `<div class="error">${esc(panel.error)}</div>`;
      } else {
        body = `<p class="translation">${esc(panel.text || '—')}</p>`;
      }
      return `<div class="inline-panel">
        <div class="panel-head">
          <span>翻译 · ${esc(targetLangLabel())}</span>
          <button class="link-btn" type="button" data-act="translate" data-index="${index}">重新翻译</button>
        </div>
        ${body}
      </div>`;
    }

    if (panel.kind === 'related') {
      const items = panel.items || [];
      let body;
      if (panel.loading && !items.length) {
        body = '<div class="loading">正在获取相关词…</div>';
      } else if (panel.error) {
        body = `<div class="error">${esc(panel.error)}</div>`;
      } else if (!items.length) {
        body = '<div class="muted">没有获取到相关词</div>';
      } else {
        body = `<ul class="sug-list">${items
          .map(
            (item) => `<li>
              <span>${esc(item)}</span>
              <div>
                <button class="mini-btn" type="button" data-add="${esc(item)}" data-index="${index}">加入</button>
                <button class="mini-btn" type="button" data-search="${esc(item)}">搜索</button>
              </div>
            </li>`
          )
          .join('')}</ul>`;
      }
      return `<div class="inline-panel">
        <div class="panel-head">
          <span>相关词${items.length ? ' · ' + items.length : ''}</span>
          <button class="link-btn" type="button" data-act="related" data-index="${index}">刷新</button>
        </div>
        ${panel.loading && items.length ? '<div class="loading">更新中…</div>' : ''}
        ${body}
      </div>`;
    }

    return '';
  }

  function renderGroups(groups) {
    const map = libraryMap();
    const list = groups || getGroups();
    $('#groupList').innerHTML = list
      .map((group, index) => {
        const over = group.length > WF.MAX_GROUP_SIZE;
        const sub = `${group.length} 个关键词${over ? ' · 仅前 ' + WF.MAX_GROUP_SIZE + ' 个参与分析' : ''}`;
        return `<article class="group-card" data-index="${index}">
          <div class="group-head">
            <div class="group-title">
              <span class="group-index">${String(index + 1).padStart(2, '0')}</span>
              <div>
                <div class="group-name">关键词组<span class="tag-count">${sub}</span></div>
                <div class="group-sub">点击下方关键词可单独打开趋势</div>
              </div>
            </div>
            <div class="group-actions">
              <button class="icon-btn" type="button" data-act="open" data-index="${index}" title="在 Google Trends 打开本组">打开</button>
              <button class="icon-btn" type="button" data-act="copylink" data-index="${index}" title="复制本组趋势链接">链接</button>
              <button class="icon-btn" type="button" data-act="quotes" data-index="${index}" title="为本组关键词添加或去掉双引号">引号</button>
              <button class="icon-btn" type="button" data-act="translate" data-index="${index}" title="翻译本组关键词">翻译</button>
              <button class="icon-btn" type="button" data-act="related" data-index="${index}" title="获取本组相关词">相关词</button>
              <button class="icon-btn" type="button" data-act="favorite" data-index="${index}" title="把本组关键词加入收藏">收藏</button>
              <button class="icon-btn danger" type="button" data-act="delete" data-index="${index}" title="删除本组">删除</button>
            </div>
          </div>
          <div class="chips">${group.map((term) => chipHtml(term, map)).join('')}</div>
          ${renderGroupPanel(index)}
        </article>`;
      })
      .join('');
  }

  function renderAnalyzeHint(groups) {
    if (!groups.length) {
      $('#analyzeHint').textContent = '';
      return;
    }
    const mode = state.settings.openMode === 'first' ? '只打开第一组' : '每组打开一个标签页';
    $('#analyzeHint').textContent =
      '当前条件：' +
      WF.dateLabel(state.settings.dateRange, state.settings) +
      ' · ' +
      WF.geoLabel(state.settings.geo) +
      '；' +
      mode +
      '，共 ' +
      groups.length +
      ' 组。';
  }

  function renderWorkbench() {
    const groups = getGroups();
    const total = groups.reduce((sum, group) => sum + group.length, 0);
    $('#groupSummary').textContent = groups.length + ' 组 · ' + total + ' 个词';
    $('#emptyState').hidden = groups.length > 0;
    renderGroups(groups);
    renderAnalyzeHint(groups);
  }

  function renderStats() {
    const count = state.library.length;
    $('#statLibrary').textContent = String(count);
    $('#badgeLibrary').textContent = String(count);
  }

  async function translateGroup(index) {
    const groups = getGroups();
    const group = groups[index];
    if (!group) return;
    state.expanded[index] = { kind: 'translate', loading: true };
    renderGroups(groups);
    try {
      const results = await Promise.all(
        group.map((term) =>
          sendMessage({ type: 'wf:translate', text: term, targetLang: state.settings.targetLang })
        )
      );
      const translations = results.map((result) => (result && result.ok ? result.text : ''));
      const text = group
        .map((term, i) => term + ' → ' + (translations[i] || '（翻译失败）'))
        .join('\n');
      state.expanded[index] = { kind: 'translate', loading: false, text };
      if (state.settings.copyTranslation) {
        const plain = translations.filter(Boolean).join('\n');
        if (plain) {
          const ok = await copyText(plain);
          if (ok) toast('翻译完成，已复制');
        }
      }
    } catch (error) {
      state.expanded[index] = {
        kind: 'translate',
        loading: false,
        error: '翻译失败：' + (error && error.message ? error.message : error)
      };
    }
    renderGroups(groups);
  }

  async function loadRelated(index) {
    const groups = getGroups();
    const group = groups[index];
    if (!group) return;
    const previous = state.expanded[index];
    state.expanded[index] = {
      kind: 'related',
      loading: true,
      items: previous && previous.kind === 'related' ? previous.items : []
    };
    renderGroups(groups);
    try {
      const results = await Promise.all(
        group.map((term) =>
          sendMessage({
            type: 'wf:suggest',
            keyword: term,
            geo: state.settings.geo,
            hl: state.settings.hl
          })
        )
      );
      const existing = new Set(group.map(WF.keywordKey));
      const items = [];
      const seen = new Set();
      let firstError = '';
      results.forEach((result) => {
        if (!result || !result.ok) {
          if (!firstError && result && result.error) firstError = result.error;
          return;
        }
        (result.list || []).forEach((item) => {
          const key = WF.keywordKey(item);
          if (!key || existing.has(key) || seen.has(key)) return;
          seen.add(key);
          items.push(item);
        });
      });
      state.expanded[index] = {
        kind: 'related',
        loading: false,
        items: items.slice(0, 40),
        error: items.length ? '' : firstError ? '获取失败：' + firstError : ''
      };
    } catch (error) {
      state.expanded[index] = {
        kind: 'related',
        loading: false,
        items: [],
        error: '获取失败：' + (error && error.message ? error.message : error)
      };
    }
    renderGroups(groups);
  }

  async function addSuggestion(index, term) {
    const groups = getGroups();
    const group = groups[index];
    if (!group) return;
    if (group.some((item) => WF.keywordKey(item) === WF.keywordKey(term))) {
      toast('这个关键词已在组内');
      return;
    }
    if (group.length >= WF.MAX_GROUP_SIZE) {
      toast('该组已满 ' + WF.MAX_GROUP_SIZE + ' 个词，请新建一行');
      return;
    }
    group.push(term);
    groups[index] = group;
    await saveInput(WF.groupsToText(groups));
    toast('已加入关键词组');
  }

  async function handleGroupAction(action, index) {
    const groups = getGroups();
    const group = groups[index];
    if (!group) return;
    switch (action) {
      case 'open': {
        await chrome.tabs.create({ url: WF.buildTrendsUrl(group, state.settings) });
        await touchKeywords(group);
        break;
      }
      case 'copylink': {
        const ok = await copyText(WF.buildTrendsUrl(group, state.settings));
        toast(ok ? '趋势链接已复制' : '复制失败');
        break;
      }
      case 'quotes': {
        groups[index] = group.map(WF.toggleQuotes);
        await saveInput(WF.groupsToText(groups));
        toast('已切换引号');
        break;
      }
      case 'translate':
        await translateGroup(index);
        break;
      case 'related':
        await loadRelated(index);
        break;
      case 'favorite': {
        const added = await addGroupToLibrary(group, { favorite: true });
        toast(added ? '已收藏本组关键词' : '本组关键词已更新收藏');
        break;
      }
      case 'delete': {
        groups.splice(index, 1);
        const shifted = {};
        Object.keys(state.expanded).forEach((key) => {
          const position = Number(key);
          if (position < index) shifted[position] = state.expanded[key];
          else if (position > index) shifted[position - 1] = state.expanded[key];
        });
        state.expanded = shifted;
        await saveInput(WF.groupsToText(groups));
        toast('已删除该组');
        break;
      }
      default:
        break;
    }
  }

  async function analyzeAll() {
    const groups = getGroups();
    if (!groups.length) {
      toast('先输入关键词');
      return;
    }
    const targets = state.settings.openMode === 'first' ? groups.slice(0, 1) : groups;
    if (targets.length > 6) {
      const ok = window.confirm('将打开 ' + targets.length + ' 个 Google Trends 标签页，继续吗？');
      if (!ok) return;
    }
    targets.forEach((group, index) => {
      setTimeout(() => {
        chrome.tabs.create({ url: WF.buildTrendsUrl(group, state.settings) });
      }, index * 220);
    });
    await touchKeywords(groups.reduce((all, group) => all.concat(group), []));
    toast(state.settings.openMode === 'first' ? '已打开第一组' : '已打开 ' + targets.length + ' 个标签页');
  }

  async function copyAllLinks() {
    const groups = getGroups();
    if (!groups.length) {
      toast('先输入关键词');
      return;
    }
    const links = groups.map((group) => WF.buildTrendsUrl(group, state.settings)).join('\n');
    const ok = await copyText(links);
    toast(ok ? '已复制 ' + groups.length + ' 条链接' : '复制失败');
  }

  /* ---------------- 词库 ---------------- */

  function visibleLibrary() {
    const query = state.filters.q.trim().toLowerCase();
    let items = state.library.slice();
    if (query) {
      items = items.filter((record) => String(record.keyword).toLowerCase().includes(query));
    }
    if (state.filters.tag === 'favorite') items = items.filter((record) => record.favorite);
    if (state.filters.tag === 'root') items = items.filter((record) => record.root);
    if (state.filters.tag === 'history') items = items.filter((record) => (Number(record.count) || 0) > 0);

    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    items.sort((a, b) => {
      if (state.filters.sort === 'name') return collator.compare(a.keyword, b.keyword);
      if (state.filters.sort === 'count') {
        return (Number(b.count) || 0) - (Number(a.count) || 0) || (Number(b.lastUsed) || 0) - (Number(a.lastUsed) || 0);
      }
      return (Number(b.lastUsed) || 0) - (Number(a.lastUsed) || 0) || (Number(b.firstSeen) || 0) - (Number(a.firstSeen) || 0);
    });
    return items;
  }

  function renderLibrary() {
    const map = libraryMap();
    const keys = new Set(map.keys());
    state.selected.forEach((key) => {
      if (!keys.has(key)) state.selected.delete(key);
    });

    const items = visibleLibrary();
    const list = $('#libList');
    list.innerHTML = items
      .map((record) => {
        const key = WF.keywordKey(record.keyword);
        const checked = state.selected.has(key) ? ' checked' : '';
        const tags =
          (record.favorite ? '<span class="lib-tag fav">收藏</span>' : '') +
          (record.root ? '<span class="lib-tag root">词根</span>' : '');
        const meta =
          ((Number(record.count) || 0) > 0 ? '使用 ' + record.count + ' 次' : '未分析') +
          ' · 最近 ' +
          WF.formatDate(record.lastUsed);
        return `<div class="lib-row${checked ? ' is-selected' : ''}" data-key="${esc(key)}">
          <input type="checkbox" data-select="${esc(key)}"${checked} aria-label="选择 ${esc(record.keyword)}" />
          <div class="lib-main">
            <div class="lib-word">${esc(record.keyword)}${tags}</div>
            <div class="lib-meta">${esc(meta)}</div>
          </div>
          <div class="lib-acts">
            <button type="button" data-libact="input" data-key="${esc(key)}" title="加入关键词输入框">加入</button>
            <button type="button" data-libact="compare" data-key="${esc(key)}" title="与第一组关键词一起打开 Trends">对比</button>
            <button type="button" data-libact="copy" data-key="${esc(key)}" title="复制关键词">复制</button>
            <button type="button" data-libact="favorite" data-key="${esc(key)}" title="切换收藏">${record.favorite ? '★' : '☆'}</button>
            <button type="button" data-libact="root" data-key="${esc(key)}" title="切换词根">根</button>
            <button type="button" class="danger" data-libact="delete" data-key="${esc(key)}" title="从词库删除">删</button>
          </div>
        </div>`;
      })
      .join('');

    const empty = $('#libEmpty');
    empty.hidden = items.length > 0;
    if (!items.length) {
      empty.querySelector('h2').textContent = state.library.length ? '没有匹配的关键词' : '词库还是空的';
      empty.querySelector('p').textContent = state.library.length
        ? '换个筛选条件或搜索词试试。'
        : '分析过的关键词会自动记入历史；收藏和词根可以手动标记。';
    }

    $('#selCount').textContent = state.selected.size ? '已选 ' + state.selected.size + ' 个' : '未选择';
    const selectAll = $('#selectAll');
    const visibleKeys = items.map((record) => WF.keywordKey(record.keyword));
    const selectedVisible = visibleKeys.filter((key) => state.selected.has(key)).length;
    selectAll.checked = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleKeys.length;
  }

  async function addKeywordToInput(keyword) {
    const line = String(keyword || '').trim();
    if (!line) return;
    const next = (state.input.trim() ? state.input.replace(/\s+$/, '') + '\n' : '') + line;
    await saveInput(next);
    switchTab('workbench');
    toast('已加入输入框');
  }

  async function addKeywordToFirstGroup(keyword) {
    const groups = getGroups();
    const term = String(keyword || '').trim();
    if (!term) return;
    if (!groups.length) {
      groups.push([term]);
    } else {
      const first = groups[0];
      if (first.some((item) => WF.keywordKey(item) === WF.keywordKey(term))) {
        toast('这个关键词已在第一组');
        switchTab('workbench');
        return;
      }
      if (first.length >= WF.MAX_GROUP_SIZE) {
        groups.unshift([term]);
        toast('第一组已满，已新建一组对比');
      } else {
        first.push(term);
        groups[0] = first;
        toast('已加入第一组对比');
      }
    }
    await saveInput(WF.groupsToText(groups));
    switchTab('workbench');
  }

  async function updateRecord(key, patch) {
    const records = state.library.map((record) => {
      if (WF.keywordKey(record.keyword) !== key) return record;
      return { ...record, ...patch };
    });
    await saveLibrary(records);
  }

  async function deleteRecord(key) {
    const record = libraryMap().get(key);
    if (!record) return;
    const ok = window.confirm('从词库删除「' + record.keyword + '」？');
    if (!ok) return;
    const records = state.library.filter((item) => WF.keywordKey(item.keyword) !== key);
    state.selected.delete(key);
    await saveLibrary(records);
    toast('已从词库删除');
  }

  async function bulkAction(action) {
    if (!state.selected.size) {
      toast('先勾选关键词');
      return;
    }
    const map = libraryMap();
    const records = Array.from(state.selected)
      .map((key) => map.get(key))
      .filter(Boolean);
    if (!records.length) return;

    if (action === 'input') {
      const lines = records.map((record) => record.keyword).join('\n');
      const next = (state.input.trim() ? state.input.replace(/\s+$/, '') + '\n' : '') + lines;
      await saveInput(next);
      switchTab('workbench');
      toast('已加入 ' + records.length + ' 个关键词');
      return;
    }

    if (action === 'delete') {
      const ok = window.confirm('从词库删除选中的 ' + records.length + ' 个关键词？');
      if (!ok) return;
      const keys = new Set(records.map((record) => WF.keywordKey(record.keyword)));
      state.selected.clear();
      await saveLibrary(state.library.filter((record) => !keys.has(WF.keywordKey(record.keyword))));
      toast('已删除 ' + keys.size + ' 个关键词');
      return;
    }

    const patch =
      action === 'favorite'
        ? { favorite: true }
        : action === 'unfavorite'
          ? { favorite: false }
          : action === 'root'
            ? { root: true }
            : null;
    if (!patch) return;

    const keys = new Set(records.map((record) => WF.keywordKey(record.keyword)));
    const next = state.library.map((record) => {
      if (!keys.has(WF.keywordKey(record.keyword))) return record;
      return { ...record, ...patch };
    });
    await saveLibrary(next);
    toast('已更新 ' + keys.size + ' 个关键词');
  }

  /* ---------------- 导入导出 ---------------- */

  function exportPayload() {
    return {
      app: 'WordFind 关键词雷达',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      input: state.input,
      library: state.library
    };
  }

  function exportJson() {
    downloadFile(
      'wordfind-词库-' + WF.todayISO() + '.json',
      JSON.stringify(exportPayload(), null, 2),
      'application/json'
    );
    toast('已导出 JSON');
  }

  function exportCsv() {
    const header = ['关键词', '收藏', '词根', '使用次数', '首次记录', '最近使用'];
    const rows = state.library.map((record) => [
      record.keyword,
      record.favorite ? '是' : '否',
      record.root ? '是' : '否',
      Number(record.count) || 0,
      WF.formatDate(record.firstSeen),
      WF.formatDate(record.lastUsed)
    ]);
    const csv =
      '\uFEFF' +
      [header]
        .concat(rows)
        .map((cells) =>
          cells
            .map((cell) => '"' + String(cell == null ? '' : cell).replace(/"/g, '""') + '"')
            .join(',')
        )
        .join('\r\n');
    downloadFile('wordfind-词库-' + WF.todayISO() + '.csv', csv, 'text/csv;charset=utf-8');
    toast('已导出 CSV');
  }

  function mergeLibrary(incoming) {
    const records = state.library.map((record) => ({ ...record }));
    const map = new Map();
    records.forEach((record) => map.set(WF.keywordKey(record.keyword), record));
    let added = 0;
    (incoming || []).forEach((item) => {
      if (!item || typeof item.keyword !== 'string') return;
      const keyword = item.keyword.trim();
      if (!keyword) return;
      const key = WF.keywordKey(keyword);
      const existing = map.get(key);
      if (existing) {
        existing.favorite = Boolean(existing.favorite || item.favorite);
        existing.root = Boolean(existing.root || item.root);
        existing.count = Math.max(Number(existing.count) || 0, Number(item.count) || 0);
        existing.firstSeen = Math.min(Number(existing.firstSeen) || Date.now(), Number(item.firstSeen) || Date.now());
        existing.lastUsed = Math.max(Number(existing.lastUsed) || 0, Number(item.lastUsed) || 0);
      } else {
        const next = {
          keyword,
          favorite: Boolean(item.favorite),
          root: Boolean(item.root),
          count: Number(item.count) || 0,
          firstSeen: Number(item.firstSeen) || Date.now(),
          lastUsed: Number(item.lastUsed) || 0
        };
        map.set(key, next);
        records.push(next);
        added += 1;
      }
    });
    return { records, added };
  }

  async function importFile(file, mode) {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      toast('文件不是有效的 JSON');
      return;
    }
    const incoming = Array.isArray(payload) ? payload : payload && Array.isArray(payload.library) ? payload.library : null;
    if (!incoming) {
      toast('文件里没有词库数据');
      return;
    }
    const { records, added } = mergeLibrary(incoming);
    await saveLibrary(records);
    if (mode === 'all' && payload && !Array.isArray(payload)) {
      if (payload.settings && typeof payload.settings === 'object') {
        state.settings = { ...state.settings, ...payload.settings };
        await chrome.storage.local.set({ settings: state.settings });
      }
      if (typeof payload.input === 'string') {
        await saveInput(payload.input);
      }
      syncSettingsControls();
    }
    toast('导入完成，新增 ' + added + ' 个关键词');
  }

  async function resetAll() {
    const ok = window.confirm('恢复默认会清空关键词输入、词库和设置，确定继续？');
    if (!ok) return;
    await chrome.storage.local.remove(['settings', 'input', 'library', 'pending']);
    state.settings = { ...WF.DEFAULT_SETTINGS };
    state.input = '';
    state.library = [];
    state.selected.clear();
    state.expanded = {};
    $('#inputBox').value = '';
    syncSettingsControls();
    renderStats();
    renderWorkbench();
    renderLibrary();
    toast('已恢复默认');
  }

  /* ---------------- 设置 ---------------- */

  function syncSettingsControls() {
    const dateRange = $('#dateRange');
    if (WF.DATE_OPTIONS.some((option) => option.value === state.settings.dateRange)) {
      dateRange.value = state.settings.dateRange;
    } else {
      dateRange.value = WF.DEFAULT_SETTINGS.dateRange;
    }
    const geo = $('#geo');
    const hasGeo = WF.GEO_OPTIONS.some((option) => option.value === (state.settings.geo || ''));
    if (!hasGeo && state.settings.geo) {
      const option = document.createElement('option');
      option.value = state.settings.geo;
      option.textContent = state.settings.geo + '（自定义）';
      geo.appendChild(option);
    }
    geo.value = state.settings.geo || '';
    $('#customDates').hidden = state.settings.dateRange !== 'custom';
    $('#customStart').value = state.settings.customStart || '';
    $('#customEnd').value = state.settings.customEnd || '';
    $('#setOpenMode').value = state.settings.openMode === 'first' ? 'first' : 'all';
    $('#setHl').value = state.settings.hl === 'en' ? 'en' : 'zh-CN';
    $('#setInjectTools').checked = Boolean(state.settings.injectTools);
    $('#setInjectStatus').checked = Boolean(state.settings.injectStatus);
    $('#setTargetLang').value = state.settings.targetLang;
    $('#setCopyTranslation').checked = Boolean(state.settings.copyTranslation);
  }

  /* ---------------- 待处理关键词 ---------------- */

  async function applyPending(pending) {
    if (!pending || typeof pending.text !== 'string') return;
    const ts = Number(pending.ts) || 0;
    if (ts && ts <= state.lastPendingTs) return;
    state.lastPendingTs = ts || Date.now();
    const text = pending.text.replace(/\r?\n+/g, ' ').trim();
    await chrome.storage.local.set({ pending: null });
    if (!text) return;
    const next = (state.input.trim() ? state.input.replace(/\s+$/, '') + '\n' : '') + text;
    await saveInput(next);
    switchTab('workbench');
    toast('已加入从页面选中的关键词');
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    $('#tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (tab) switchTab(tab.dataset.tab);
    });

    const inputBox = $('#inputBox');
    const saveInputDebounced = debounce(() => {
      saveInput(inputBox.value).catch((error) => toast('保存失败：' + error.message));
    }, 180);
    inputBox.addEventListener('input', saveInputDebounced);

    $('#toolRow').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-tool]');
      if (!button) return;
      const tool = button.dataset.tool;
      let groups = getGroups();
      if (tool === 'dedupe') {
        groups = WF.dedupeGroups(groups);
        toast('已去重');
      } else if (tool === 'sort') {
        groups = WF.sortGroups(groups);
        toast('已排序');
      } else if (tool === 'tidy') {
        groups = WF.normalizeGroups(groups);
        toast('已整理');
      } else if (tool === 'sample') {
        groups = [
          ['running shoes', 'trail shoes'],
          ['keyword research tool', 'google trends api'],
          ['ai seo writing']
        ];
        toast('已填入示例');
      } else if (tool === 'clear') {
        const ok = window.confirm('清空关键词输入框？');
        if (!ok) return;
        groups = [];
        toast('已清空');
      }
      await saveInput(WF.groupsToText(groups));
    });

    $('#dateRange').addEventListener('change', (event) => {
      saveSettings({ dateRange: event.target.value }).catch((error) => toast('保存失败：' + error.message));
    });
    $('#geo').addEventListener('change', (event) => {
      saveSettings({ geo: event.target.value }).catch((error) => toast('保存失败：' + error.message));
    });
    $('#customStart').addEventListener('change', (event) => {
      saveSettings({ customStart: event.target.value }).catch(() => {});
    });
    $('#customEnd').addEventListener('change', (event) => {
      saveSettings({ customEnd: event.target.value }).catch(() => {});
    });

    $('#analyzeAll').addEventListener('click', () => {
      analyzeAll().catch((error) => toast('操作失败：' + error.message));
    });
    $('#copyAllLinks').addEventListener('click', () => {
      copyAllLinks().catch((error) => toast('操作失败：' + error.message));
    });

    $('#groupList').addEventListener('click', (event) => {
      const addButton = event.target.closest('button[data-add]');
      if (addButton) {
        addSuggestion(Number(addButton.dataset.index), addButton.dataset.add).catch((error) =>
          toast('操作失败：' + error.message)
        );
        return;
      }
      const searchButton = event.target.closest('button[data-search]');
      if (searchButton) {
        chrome.tabs.create({
          url: 'https://www.google.com/search?q=' + encodeURIComponent(searchButton.dataset.search)
        });
        return;
      }
      const actionButton = event.target.closest('button[data-act]');
      if (actionButton) {
        const index = Number(actionButton.dataset.index);
        handleGroupAction(actionButton.dataset.act, index).catch((error) =>
          toast('操作失败：' + error.message)
        );
        return;
      }
      const chip = event.target.closest('.chip');
      if (chip) {
        const term = chip.dataset.term;
        chrome.tabs.create({ url: WF.buildTrendsUrl([term], state.settings) });
        touchKeywords([term]).catch(() => {});
      }
    });

    $('#libSearch').addEventListener(
      'input',
      debounce((event) => {
        state.filters.q = event.target.value;
        renderLibrary();
      }, 150)
    );

    $('#libSort').addEventListener('change', (event) => {
      state.filters.sort = event.target.value;
      renderLibrary();
    });

    $('#libFilters').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      state.filters.tag = button.dataset.filter;
      $$('#libFilters button').forEach((item) =>
        item.classList.toggle('is-active', item === button)
      );
      renderLibrary();
    });

    $('#selectAll').addEventListener('change', (event) => {
      const items = visibleLibrary();
      if (event.target.checked) {
        items.forEach((record) => state.selected.add(WF.keywordKey(record.keyword)));
      } else {
        items.forEach((record) => state.selected.delete(WF.keywordKey(record.keyword)));
      }
      renderLibrary();
    });

    $('#bulkActions').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-bulk]');
      if (!button) return;
      bulkAction(button.dataset.bulk).catch((error) => toast('操作失败：' + error.message));
    });

    $('#libList').addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[data-select]');
      if (!checkbox) return;
      const key = checkbox.dataset.select;
      if (checkbox.checked) state.selected.add(key);
      else state.selected.delete(key);
      renderLibrary();
    });

    $('#libList').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-libact]');
      if (!button) return;
      const key = button.dataset.key;
      const record = libraryMap().get(key);
      if (!record) return;
      const action = button.dataset.libact;

      if (action === 'input') {
        addKeywordToInput(record.keyword).catch((error) => toast('操作失败：' + error.message));
      } else if (action === 'compare') {
        addKeywordToFirstGroup(record.keyword).catch((error) => toast('操作失败：' + error.message));
      } else if (action === 'copy') {
        copyText(record.keyword).then((ok) => toast(ok ? '关键词已复制' : '复制失败'));
      } else if (action === 'favorite') {
        updateRecord(key, { favorite: !record.favorite }).catch((error) => toast('操作失败：' + error.message));
      } else if (action === 'root') {
        updateRecord(key, { root: !record.root }).catch((error) => toast('操作失败：' + error.message));
      } else if (action === 'delete') {
        deleteRecord(key).catch((error) => toast('操作失败：' + error.message));
      }
    });

    $('.lib-foot').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-lib]');
      if (!button) return;
      const action = button.dataset.lib;
      if (action === 'export-json') {
        exportJson();
      } else if (action === 'export-csv') {
        exportCsv();
      } else if (action === 'import') {
        const fileInput = $('#importFile');
        fileInput.dataset.mode = 'library';
        fileInput.value = '';
        fileInput.click();
      } else if (action === 'clear') {
        const ok = window.confirm('清空词库里的全部关键词？该操作不可撤销。');
        if (!ok) return;
        state.selected.clear();
        saveLibrary([]).then(() => toast('词库已清空')).catch((error) => toast('操作失败：' + error.message));
      }
    });

    $('#panel-settings').addEventListener('change', (event) => {
      const el = event.target;
      const patches = {
        setOpenMode: { openMode: el.value },
        setHl: { hl: el.value },
        setInjectTools: { injectTools: el.checked },
        setInjectStatus: { injectStatus: el.checked },
        setTargetLang: { targetLang: el.value },
        setCopyTranslation: { copyTranslation: el.checked }
      };
      if (patches[el.id]) {
        saveSettings(patches[el.id]).catch((error) => toast('保存失败：' + error.message));
      }
    });

    $('#panel-settings').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-data]');
      if (!button) return;
      const action = button.dataset.data;
      if (action === 'export') {
        downloadFile(
          'wordfind-全部数据-' + WF.todayISO() + '.json',
          JSON.stringify(exportPayload(), null, 2),
          'application/json'
        );
        toast('已导出全部数据');
      } else if (action === 'import') {
        const fileInput = $('#importFile');
        fileInput.dataset.mode = 'all';
        fileInput.value = '';
        fileInput.click();
      } else if (action === 'reset') {
        resetAll().catch((error) => toast('操作失败：' + error.message));
      }
    });

    $('#importFile').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const mode = event.target.dataset.mode === 'all' ? 'all' : 'library';
      try {
        await importFile(file, mode);
      } catch (error) {
        toast('导入失败：' + error.message);
      } finally {
        event.target.value = '';
      }
    });

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) {
        state.settings = { ...WF.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
        syncSettingsControls();
        renderWorkbench();
      }
      if (changes.library) {
        state.library = Array.isArray(changes.library.newValue)
          ? changes.library.newValue.filter((item) => item && item.keyword)
          : [];
        renderStats();
        renderLibrary();
        renderWorkbench();
      }
      if (changes.input) {
        const next = typeof changes.input.newValue === 'string' ? changes.input.newValue : '';
        if (next !== state.input) {
          state.input = next;
          const box = $('#inputBox');
          if (document.activeElement !== box) box.value = next;
          renderWorkbench();
        }
      }
      if (changes.pending && changes.pending.newValue) {
        await applyPending(changes.pending.newValue);
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    fillSelect($('#dateRange'), WF.DATE_OPTIONS);
    fillSelect($('#geo'), WF.GEO_OPTIONS);
    fillSelect($('#setTargetLang'), WF.TARGET_LANGS);
    bindEvents();
    await loadState();
    $('#inputBox').value = state.input;
    syncSettingsControls();
    renderStats();
    renderWorkbench();
    renderLibrary();
    switchTab('workbench');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init().catch((error) => console.error('[WordFind] 初始化失败', error));
    });
  } else {
    init().catch((error) => console.error('[WordFind] 初始化失败', error));
  }
})();
