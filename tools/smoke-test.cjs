#!/usr/bin/env node
/*
 * WordFind 共享逻辑冒烟测试（不依赖浏览器）。
 * 运行：node tools/smoke-test.cjs
 */
const assert = require('node:assert');
const path = require('node:path');
const WF = require(path.join(__dirname, '..', 'shared.js'));
const WFRadar = require(path.join(__dirname, '..', 'radar.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

check('按多种分隔符切分关键词组', () => {
  assert.deepStrictEqual(WF.splitTerms('a, b，c、d；e;f'), ['a', 'b', 'c', 'd', 'e', 'f']);
});

check('双引号内的逗号不切分', () => {
  assert.deepStrictEqual(WF.splitTerms('"running shoes, trail", socks'), ['"running shoes, trail"', 'socks']);
});

check('解析多行输入并跳过空行', () => {
  const groups = WF.parseGroups('a,b\n\n c , d \n');
  assert.deepStrictEqual(groups, [['a', 'b'], ['c', 'd']]);
});

check('keywordKey 忽略引号、大小写和多余空格', () => {
  assert.strictEqual(WF.keywordKey('"  Running   Shoes "'), 'running shoes');
});

check('toggleQuotes 可逆', () => {
  assert.strictEqual(WF.toggleQuotes('abc'), '"abc"');
  assert.strictEqual(WF.toggleQuotes('"abc"'), 'abc');
});

check('normalizeGroups 组内去重且丢弃重复组', () => {
  const groups = WF.normalizeGroups([
    ['a', 'A', 'b', ''],
    ['a', 'b'],
    ['c']
  ]);
  assert.deepStrictEqual(groups, [['a', 'b'], ['c']]);
});

check('sortGroups 组内与组间排序', () => {
  const groups = WF.sortGroups([['b', 'a'], ['c']]);
  assert.deepStrictEqual(groups, [['a', 'b'], ['c']]);
});

check('buildTrendsUrl 按 5 个上限截断并编码', () => {
  const url = WF.buildTrendsUrl(['a', 'b', 'c', 'd', 'e', 'f'], {
    dateRange: 'now 7-d',
    geo: 'US',
    hl: 'zh-CN'
  });
  assert.ok(url.includes('q=a,b,c,d,e'));
  assert.ok(!url.includes('q=a,b,c,d,e,f'));
  assert.ok(url.includes('geo=US'));
  assert.ok(url.includes('hl=zh-CN'));
});

check('自定义日期范围使用起止日期', () => {
  const value = WF.dateRangeValue({ dateRange: 'custom', customStart: '2025-01-01', customEnd: '2025-02-01' });
  assert.strictEqual(value, '2025-01-01 2025-02-01');
});

check('dateLabel 返回中文标签', () => {
  assert.strictEqual(WF.dateLabel('now 7-d', { dateRange: 'now 7-d' }), '过去 7 天');
});

check('groupsToText 可往返解析', () => {
  const text = WF.groupsToText([['a', 'b'], ['c']]);
  assert.deepStrictEqual(WF.parseGroups(text), [['a', 'b'], ['c']]);
});

check('parseSeeds 支持换行、分号并去重', () => {
  assert.deepStrictEqual(WF.parseSeeds('a\nb; A\n\nc；d'), ['a', 'b', 'c', 'd']);
});

check('preprocessTerm 处理连字符、下划线和 .html', () => {
  assert.strictEqual(WF.preprocessTerm('e-bike_motor.html'), 'e bike motor');
});

check('tidyGroups 清理并去重', () => {
  assert.deepStrictEqual(WF.tidyGroups([['e-bike', 'e_bike', 'x.html']]), [['e bike', 'x']]);
});

check('radar parsePayload 去掉 XSSI 前缀', () => {
  const payload = WFRadar.parsePayload(')]}\'\n{"default":{"ok":true}}');
  assert.deepStrictEqual(payload, { default: { ok: true } });
  assert.strictEqual(WFRadar.parsePayload('error'), null);
});

check('radar 相关词优先取 rising，缺失时回退 top', () => {
  const rising = {
    default: {
      rankedList: [
        { rankedKeyword: [{ query: 'top one' }] },
        { rankedKeyword: [{ query: 'rising one' }, { query: 'rising two' }] }
      ]
    }
  };
  assert.deepStrictEqual(WFRadar.extractRelatedQueries(rising), ['rising one', 'rising two']);
  rising.default.rankedList[1].rankedKeyword = [];
  assert.deepStrictEqual(WFRadar.extractRelatedQueries(rising), ['top one']);
});

check('radar 相关词过滤逗号、超长和长句', () => {
  assert.strictEqual(WFRadar.isValidRelated('running shoes'), true);
  assert.strictEqual(WFRadar.isValidRelated('a,b'), false);
  assert.strictEqual(WFRadar.isValidRelated('one two three four five six seven'), false);
  assert.strictEqual(WFRadar.isValidRelated('x'.repeat(101)), false);
});

check('radar collectRelated 去重', () => {
  const payload = (query) => ({
    default: { rankedList: [{ rankedKeyword: [{ query }] }, { rankedKeyword: [] }] }
  });
  assert.deepStrictEqual(WFRadar.collectRelated([payload('A'), payload('a'), payload('B')]), ['A', 'B']);
});

check('radar 有效新词：起点为 0 + 末三点递增 + 达阈值', () => {
  const timeline = Array.from({ length: 12 }, (_, index) => ({
    value: [10, index < 2 ? 0 : index * 5, 5 + index, index < 2 ? 0 : 1]
  }));
  const results = WFRadar.analyzeTimeline(timeline, ['k1', 'k2', 'k3'], 100);
  assert.deepStrictEqual(results.map((item) => item.keyword), ['k1']);
  assert.strictEqual(results[0].percentage, 550);
});

check('radar 有效新词：未达阈值不入选', () => {
  const timeline = Array.from({ length: 12 }, (_, index) => ({
    value: [100, index < 2 ? 0 : index, 0, 0]
  }));
  assert.deepStrictEqual(WFRadar.analyzeTimeline(timeline, ['k1'], 500), []);
});

console.log('\n' + passed + ' checks passed');
