/*
 * WordFind 关键词雷达 - 共享核心
 * 被 background、侧边栏和内容脚本共同加载（普通脚本，挂到 globalThis.WF）。
 */
(function (root) {
  'use strict';

  var MAX_GROUP_SIZE = 5;

  var DEFAULT_SETTINGS = {
    dateRange: 'now 7-d',
    geo: '',
    customStart: '',
    customEnd: '',
    hl: 'zh-CN',
    openMode: 'all',
    injectTools: true,
    injectStatus: true,
    copyTranslation: false,
    targetLang: 'zh-CN'
  };

  var DATE_OPTIONS = [
    { label: '过去 24 小时', value: 'now 1-d' },
    { label: '过去 7 天', value: 'now 7-d' },
    { label: '过去 30 天', value: 'today 1-m' },
    { label: '过去 90 天', value: 'today 3-m' },
    { label: '过去 12 个月', value: 'today 12-m' },
    { label: '过去 5 年', value: 'today 5-y' },
    { label: '自定义', value: 'custom' }
  ];

  var GEO_OPTIONS = [
    { label: '全球', value: '' },
    { label: '美国', value: 'US' },
    { label: '英国', value: 'GB' },
    { label: '德国', value: 'DE' },
    { label: '日本', value: 'JP' },
    { label: '韩国', value: 'KR' },
    { label: '中国', value: 'CN' },
    { label: '中国香港', value: 'HK' },
    { label: '中国台湾', value: 'TW' },
    { label: '新加坡', value: 'SG' },
    { label: '印度', value: 'IN' },
    { label: '加拿大', value: 'CA' },
    { label: '澳大利亚', value: 'AU' },
    { label: '法国', value: 'FR' },
    { label: '西班牙', value: 'ES' },
    { label: '意大利', value: 'IT' },
    { label: '荷兰', value: 'NL' },
    { label: '巴西', value: 'BR' },
    { label: '俄罗斯', value: 'RU' }
  ];

  var TARGET_LANGS = [
    { label: '简体中文', value: 'zh-CN' },
    { label: '繁體中文', value: 'zh-TW' },
    { label: 'English', value: 'en' },
    { label: '日本語', value: 'ja' },
    { label: '한국어', value: 'ko' },
    { label: 'Deutsch', value: 'de' },
    { label: 'Français', value: 'fr' },
    { label: 'Español', value: 'es' },
    { label: 'Português', value: 'pt' },
    { label: 'Русский', value: 'ru' },
    { label: 'العربية', value: 'ar' }
  ];

  /**
   * 按逗号切分一组关键词，支持英文双引号包裹的短语。
   * 英文逗号、中文逗号、顿号、分号都视为分隔符。
   */
  function splitTerms(line) {
    var text = String(line == null ? '' : line);
    var terms = [];
    var current = '';
    var quoted = false;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (ch === '"') {
        quoted = !quoted;
        current += ch;
        continue;
      }
      if (!quoted && (ch === ',' || ch === '，' || ch === '、' || ch === ';' || ch === '；')) {
        terms.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    terms.push(current);
    return terms
      .map(function (term) {
        return term.trim();
      })
      .filter(Boolean);
  }

  function parseGroups(text) {
    return String(text == null ? '' : text)
      .split(/\r?\n/)
      .map(splitTerms)
      .filter(function (group) {
        return group.length > 0;
      });
  }

  function groupLine(group) {
    return (group || []).join(', ');
  }

  function groupsToText(groups) {
    return (groups || [])
      .map(groupLine)
      .filter(function (line) {
        return line.trim();
      })
      .join('\n');
  }

  function stripQuotes(term) {
    var text = String(term == null ? '' : term).trim();
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  function keywordKey(term) {
    return stripQuotes(term).replace(/\s+/g, ' ').toLowerCase();
  }

  function toggleQuotes(term) {
    var text = String(term == null ? '' : term).trim();
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
      return text.slice(1, -1);
    }
    return '"' + text + '"';
  }

  /** 去重、去空、组内大小写不重复；返回新数组。 */
  function normalizeGroups(groups) {
    var seenGroups = Object.create(null);
    var result = [];
    (groups || []).forEach(function (group) {
      var seenTerms = Object.create(null);
      var next = [];
      (group || []).forEach(function (raw) {
        var term = String(raw == null ? '' : raw).trim();
        if (!term) return;
        var key = keywordKey(term);
        if (!key || seenTerms[key]) return;
        seenTerms[key] = true;
        next.push(term);
      });
      if (!next.length) return;
      var groupKey = next.map(keywordKey).join('\u0001');
      if (seenGroups[groupKey]) return;
      seenGroups[groupKey] = true;
      result.push(next);
    });
    return result;
  }

  function dedupeGroups(groups) {
    return normalizeGroups(groups);
  }

  function sortGroups(groups) {
    var collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    return normalizeGroups(groups)
      .map(function (group) {
        return group.slice().sort(collator.compare);
      })
      .sort(function (a, b) {
        return collator.compare(a.join(' '), b.join(' '));
      });
  }

  function dateRangeValue(settings) {
    var s = settings || {};
    if (s.dateRange !== 'custom') {
      return s.dateRange || DEFAULT_SETTINGS.dateRange;
    }
    if (s.customStart && s.customEnd) {
      return s.customStart + ' ' + s.customEnd;
    }
    if (s.customStart) {
      return s.customStart + ' ' + todayISO();
    }
    return DEFAULT_SETTINGS.dateRange;
  }

  function buildTrendsUrl(terms, settings) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var q = (terms || [])
      .filter(Boolean)
      .slice(0, MAX_GROUP_SIZE)
      .map(function (term) {
        return encodeURIComponent(term);
      })
      .join(',');
    var date = encodeURIComponent(dateRangeValue(s));
    var geo = s.geo ? '&geo=' + encodeURIComponent(s.geo) : '';
    var hl = encodeURIComponent(s.hl || 'zh-CN');
    return 'https://trends.google.com/trends/explore?date=' + date + '&q=' + q + geo + '&hl=' + hl;
  }

  function todayISO() {
    var now = new Date();
    var month = String(now.getMonth() + 1).padStart(2, '0');
    var day = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + month + '-' + day;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '—';
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return '—';
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    return formatDate(timestamp) + ' ' + hh + ':' + mm;
  }

  function geoLabel(value) {
    var match = GEO_OPTIONS.find(function (item) {
      return item.value === (value || '');
    });
    return match ? match.label : value || '全球';
  }

  function dateLabel(value, settings) {
    var match = DATE_OPTIONS.find(function (item) {
      return item.value === value;
    });
    if (value === 'custom') {
      return dateRangeValue(settings).replace(' ', ' 至 ');
    }
    return match ? match.label : value;
  }

  var WF = {
    MAX_GROUP_SIZE: MAX_GROUP_SIZE,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DATE_OPTIONS: DATE_OPTIONS,
    GEO_OPTIONS: GEO_OPTIONS,
    TARGET_LANGS: TARGET_LANGS,
    splitTerms: splitTerms,
    parseGroups: parseGroups,
    groupLine: groupLine,
    groupsToText: groupsToText,
    stripQuotes: stripQuotes,
    keywordKey: keywordKey,
    toggleQuotes: toggleQuotes,
    normalizeGroups: normalizeGroups,
    dedupeGroups: dedupeGroups,
    sortGroups: sortGroups,
    dateRangeValue: dateRangeValue,
    buildTrendsUrl: buildTrendsUrl,
    todayISO: todayISO,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    geoLabel: geoLabel,
    dateLabel: dateLabel
  };

  root.WF = WF;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WF;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
