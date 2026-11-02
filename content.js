/*
 * WordFind 关键词雷达 - Google Trends 页面注入
 * 合并原扩展的三套注入逻辑：趋势图关键词行、搜索结果表格、搜索框与相关词。
 */
(function () {
  'use strict';

  const WF = self.WF;
  if (!WF) return;

  const EXPLORE_PATH = '/trends/explore';
  const MAX_LABEL = 2;

  let settings = { ...WF.DEFAULT_SETTINGS };
  let input = '';
  let library = [];
  let libraryMap = new Map();
  let scanTimer = 0;

  function rebuildLibraryMap() {
    libraryMap = new Map();
    library.forEach((record) => {
      if (!record || !record.keyword) return;
      libraryMap.set(WF.keywordKey(record.keyword), record);
    });
  }

  function findRecord(keyword) {
    return libraryMap.get(WF.keywordKey(keyword)) || null;
  }

  async function loadState() {
    const data = await chrome.storage.local.get(['settings', 'input', 'library']);
    settings = { ...WF.DEFAULT_SETTINGS, ...(data.settings || {}) };
    input = typeof data.input === 'string' ? data.input : '';
    library = Array.isArray(data.library) ? data.library : [];
    rebuildLibraryMap();
    scan();
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
    area.style.opacity = '0';
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

  function openUrl(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function compareUrl(keyword) {
    const groups = WF.parseGroups(input);
    const base = (groups[0] || []).slice(0, WF.MAX_GROUP_SIZE - 1);
    const exists = base.some((term) => WF.keywordKey(term) === WF.keywordKey(keyword));
    if (!exists) base.push(keyword);
    return WF.buildTrendsUrl(base, settings);
  }

  function analyze(keyword) {
    const text = String(keyword || '').trim();
    if (!text) return;
    chrome.storage.local.set({ pending: { text, ts: Date.now() } });
    chrome.runtime.sendMessage({ type: 'wf:open-panel' }, () => void chrome.runtime.lastError);
  }

  function toggleQuotesInUrl(keyword) {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('q');
    if (!q) return false;
    const target = WF.keywordKey(keyword);
    let found = false;
    const next = q.split(',').map((part) => {
      const raw = part.trim();
      if (!found && WF.keywordKey(raw) === target) {
        found = true;
        return WF.toggleQuotes(raw);
      }
      return raw;
    });
    if (!found) return false;
    url.searchParams.set('q', next.join(','));
    window.location.assign(url.toString());
    return true;
  }

  function removeTermFromUrl(keyword) {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('q');
    if (!q) return false;
    const target = WF.keywordKey(keyword);
    const parts = q.split(',').map((part) => part.trim()).filter(Boolean);
    const next = parts.filter((part) => WF.keywordKey(part) !== target);
    if (next.length === parts.length) return false;
    if (next.length) {
      url.searchParams.set('q', next.join(','));
    } else {
      url.searchParams.delete('q');
    }
    window.location.assign(url.toString());
    return true;
  }

  function makeButton(label, title, onClick, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    if (className) button.className = className;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(button);
    });
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    return button;
  }

  function buildTools(keyword, compact) {
    const wrapper = document.createElement('span');
    wrapper.className = 'wf-tools' + (compact ? ' wf-compact' : '');
    wrapper.dataset.kw = keyword;

    wrapper.appendChild(
      makeButton(compact ? '复' : '复制', '复制关键词', (button) => {
        copyText(keyword).then((ok) => {
          flash(button, ok ? '✓' : '×');
        });
      })
    );

    wrapper.appendChild(
      makeButton(compact ? '比' : '对比', '与第一组关键词一起打开 Trends', () => {
        openUrl(compareUrl(keyword));
      })
    );

    wrapper.appendChild(
      makeButton(compact ? '析' : '分析', '发送到 WordFind 侧边栏', () => {
        analyze(keyword);
      })
    );

    wrapper.appendChild(
      makeButton(compact ? '藏' : '收藏', '加入 WordFind 词库收藏', (button) => {
        chrome.runtime.sendMessage({ type: 'wf:favorite', keyword }, (response) => {
          if (chrome.runtime.lastError) {
            flash(button, '×');
            return;
          }
          flash(button, response && response.ok ? '✓' : '×');
        });
      })
    );

    wrapper.appendChild(
      makeButton(
        compact ? '引' : '引号',
        '为此关键词添加或去掉双引号',
        () => {
          toggleQuotesInUrl(keyword);
        }
      )
    );

    if (compact) {
      wrapper.appendChild(
        makeButton(
          '删',
          '从当前对比中移除该关键词',
          () => {
            removeTermFromUrl(keyword);
          },
          'wf-danger'
        )
      );
    }

    return wrapper;
  }

  function flash(button, text) {
    const previous = button.textContent;
    button.textContent = text;
    button.disabled = true;
    setTimeout(() => {
      button.textContent = previous;
      button.disabled = false;
    }, 1000);
  }

  function ensureTools(container, keyword, compact) {
    if (!container || !keyword) return;
    if (!settings.injectTools) return;
    const variant = compact ? 'compact' : 'full';
    const existing = container.querySelector(':scope > .wf-tools');
    if (existing && existing.dataset.kw === keyword && existing.dataset.variant === variant) {
      return;
    }
    if (existing) existing.remove();
    const tools = buildTools(keyword, compact);
    tools.dataset.variant = variant;
    container.appendChild(tools);
  }

  function ensureBadges(container, keyword) {
    if (!container || !keyword) return;
    const existing = container.querySelector(':scope > .wf-badges');
    if (!settings.injectStatus) {
      if (existing) existing.remove();
      return;
    }
    const record = findRecord(keyword);
    if (!record) {
      if (existing) existing.remove();
      return;
    }
    const count = Number(record.count) || 0;
    if (!record.favorite && !record.root && !count) {
      if (existing) existing.remove();
      return;
    }
    let holder = existing;
    if (!holder) {
      holder = document.createElement('span');
      holder.className = 'wf-badges';
      container.appendChild(holder);
    }
    const signature = [Boolean(record.favorite), Boolean(record.root), count].join('|');
    if (holder.dataset.sig === signature) return;
    holder.dataset.sig = signature;
    holder.textContent = '';
    if (record.favorite) holder.appendChild(makeBadge('★', '已收藏', 'wf-fav'));
    if (record.root) holder.appendChild(makeBadge('根', '词根关键词', 'wf-root'));
    if (count > 0) holder.appendChild(makeBadge(String(count), '已分析 ' + count + ' 次', 'wf-count'));
  }

  function makeBadge(text, title, className) {
    const badge = document.createElement('span');
    badge.className = 'wf-badge ' + className;
    badge.textContent = text;
    badge.title = title;
    return badge;
  }

  /** 复制节点并移除已注入内容，避免把按钮文字读进关键词。 */
  function readKeyword(container) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll('.wf-tools, .wf-badges').forEach((node) => node.remove());
    return clone.innerText.trim();
  }

  function decorateLegend() {
    document.querySelectorAll('.progress-label').forEach((label) => {
      const holder = label.querySelector('.label-text');
      if (!holder) return;
      const keyword = readKeyword(holder);
      if (!keyword) return;
      ensureTools(holder, keyword, false);
      ensureBadges(holder, keyword);
    });

    document.querySelectorAll('.sticky-legend-term').forEach((term) => {
      const holder = term.querySelector('.sticky-legend-term-title');
      if (!holder) return;
      const keyword = readKeyword(holder);
      if (!keyword) return;
      ensureTools(holder, keyword, true);
      ensureBadges(holder, keyword);
    });
  }

  function decorateSearchTerms() {
    document.querySelectorAll('.search-term-wrapper').forEach((wrapper) => {
      const inputEl = wrapper.querySelector('input');
      if (!inputEl) return;
      const keyword = String(inputEl.value || '').trim();
      if (!keyword) return;
      ensureTools(wrapper, keyword, true);
      ensureBadges(wrapper, keyword);
    });
  }

  function decorateRelated() {
    if (!settings.injectTools) return;
    document.querySelectorAll('.fe-related-queries').forEach((box) => {
      const title = box.querySelector('.fe-atoms-generic-title');
      if (!title || title.querySelector(':scope > .wf-related-btn')) return;
      const terms = Array.from(box.querySelectorAll('span[ng-bind="bidiText"]'))
        .map((node) => node.textContent.trim())
        .filter(Boolean);
      if (!terms.length) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wf-related-btn';
      button.textContent = '分析这组相关词';
      button.title = '把这 ' + terms.length + ' 个相关词发送到侧边栏';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        analyze(terms.join(','));
      });
      button.addEventListener('mousedown', (event) => event.stopPropagation());
      title.appendChild(button);
    });
  }

  function decorateTables() {
    document.querySelectorAll('table tr').forEach((row) => {
      const cell = row.querySelector('td:nth-child(2)');
      if (!cell) return;
      const textEl = cell.querySelector('div span') || cell.querySelector('span');
      if (!textEl) return;
      const keyword = textEl.innerText.trim();
      if (!keyword) return;
      ensureTools(cell, keyword, true);
      ensureBadges(cell, keyword);
    });
  }

  function removeAll(selector) {
    document.querySelectorAll(selector).forEach((node) => node.remove());
  }

  function scan() {
    if (!settings.injectTools) {
      removeAll('.wf-tools');
      removeAll('.wf-related-btn');
    }
    if (!settings.injectStatus) {
      removeAll('.wf-badges');
    }
    if (!settings.injectTools && !settings.injectStatus) return;

    try {
      const path = window.location.pathname;
      if (path.startsWith(EXPLORE_PATH)) {
        decorateLegend();
        decorateSearchTerms();
        decorateRelated();
      } else if (path.startsWith('/trending') || path.startsWith('/explore')) {
        decorateTables();
      }
    } catch (error) {
      console.warn('[WordFind] 页面注入失败', error);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let dirty = false;
    if (changes.settings) {
      settings = { ...WF.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      dirty = true;
    }
    if (changes.input) {
      input = typeof changes.input.newValue === 'string' ? changes.input.newValue : '';
      dirty = true;
    }
    if (changes.library) {
      library = Array.isArray(changes.library.newValue) ? changes.library.newValue : [];
      rebuildLibraryMap();
      dirty = true;
    }
    if (dirty) scheduleScan();
  });

  window.addEventListener('load', scheduleScan, { once: true });
  loadState().catch((error) => console.warn('[WordFind] 读取配置失败', error));
})();
