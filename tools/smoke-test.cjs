#!/usr/bin/env node
/*
 * WordFind 共享逻辑冒烟测试（不依赖浏览器）。
 * 运行：node tools/smoke-test.cjs
 */
const assert = require('node:assert');
const path = require('node:path');
const WF = require(path.join(__dirname, '..', 'shared.js'));

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

console.log('\n' + passed + ' checks passed');
