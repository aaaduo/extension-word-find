/*
 * WordFind 关键词雷达 - 自动挖词核心算法
 * 纯函数，无 chrome API 依赖，便于在 Node 中测试。
 * 算法参考 Trends Radar 的公开行为：拦截 Google Trends 的相关搜索与时间线数据，
 * 用“起点为 0 + 末三点递增 + 相对基准词达到阈值”判定有效新词。
 */
(function (root) {
  'use strict';

  var MAX_BATCH_SEEDS = 4;

  function stripXssi(raw) {
    return String(raw == null ? '' : raw).replace(/^\)\]\}'[^\n]*(?:\n|$)/, '').trim();
  }

  function parsePayload(raw) {
    var text = stripXssi(raw);
    if (!text) return null;
    var start = text.indexOf('{');
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch (error) {
      return null;
    }
  }

  function extractRelatedQueries(payload) {
    var ranked =
      payload && payload.default && Array.isArray(payload.default.rankedList)
        ? payload.default.rankedList
        : null;
    if (!ranked) return [];
    var rising = ranked[1] && Array.isArray(ranked[1].rankedKeyword) ? ranked[1].rankedKeyword : [];
    var top = ranked[0] && Array.isArray(ranked[0].rankedKeyword) ? ranked[0].rankedKeyword : [];
    var source = rising.length ? rising : top;
    return source
      .map(function (item) {
        return String((item && item.query) || '').trim();
      })
      .filter(Boolean);
  }

  function collectRelated(payloads) {
    var seen = Object.create(null);
    var result = [];
    (payloads || []).forEach(function (payload) {
      extractRelatedQueries(payload).forEach(function (keyword) {
        var key = keyword.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        result.push(keyword);
      });
    });
    return result;
  }

  function isValidRelated(keyword) {
    var text = String(keyword == null ? '' : keyword).trim();
    if (!text || text.length > 100) return false;
    if (text.indexOf(',') >= 0) return false;
    if (text.split(/\s+/).filter(Boolean).length > 6) return false;
    return true;
  }

  function toInt(value) {
    var number = parseInt(value, 10);
    return Number.isFinite(number) ? number : 0;
  }

  /**
   * 分析一批关键词的时间线，返回符合“有效新词”条件的关键词。
   * @param {Array} timelineData Google Trends multiline timelineData
   * @param {Array<string>} keywords 本批关键词（不含基准词）
   * @param {number} threshold 百分比阈值
   */
  function analyzeTimeline(timelineData, keywords, threshold) {
    var points = Array.isArray(timelineData) ? timelineData : [];
    if (points.length < 10) return [];
    if (!points[0] || !Array.isArray(points[0].value)) return [];

    var columns = points[0].value.length;
    var baseSeries = points.map(function (point) {
      return toInt(point.value && point.value[0]);
    });
    var baseLast = baseSeries[baseSeries.length - 1];
    var limit = Number(threshold);
    if (!Number.isFinite(limit)) limit = 0;

    var results = [];
    for (var i = 1; i < columns; i += 1) {
      var keyword = keywords[i - 1];
      if (!keyword) continue;

      var series = points.map(function (point) {
        return toInt(point.value && point.value[i]);
      });
      var startsFromZero = series.slice(0, 2).every(function (value) {
        return value === 0;
      });
      var tail = series.slice(-3);
      var increasing =
        tail.length === 3 &&
        tail.every(function (value, index) {
          return index === 0 || value >= tail[index - 1];
        });
      var last = series[series.length - 1];
      var percentage;
      if (baseLast > 0) {
        percentage = (last / baseLast) * 100;
      } else {
        percentage = last > 0 ? Infinity : 0;
      }

      if (startsFromZero && increasing && percentage >= limit) {
        results.push({
          keyword: keyword,
          percentage: Number.isFinite(percentage) ? Math.round(percentage) : null,
          lastValue: last,
          baseLastValue: baseLast
        });
      }
    }
    return results;
  }

  var api = {
    MAX_BATCH_SEEDS: MAX_BATCH_SEEDS,
    stripXssi: stripXssi,
    parsePayload: parsePayload,
    extractRelatedQueries: extractRelatedQueries,
    collectRelated: collectRelated,
    isValidRelated: isValidRelated,
    analyzeTimeline: analyzeTimeline
  };

  root.WFRadar = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
