import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport } from '../src/format.ts';
import { parseRange } from '../src/query.ts';
import type { UsageReport } from '../src/types.ts';

const report: UsageReport = {
  range: parseRange('24h', Date.parse('2026-11-09T12:00:00Z')),
  usage: { input: 110, output: 1234574, cacheRead: 90, cacheWrite: 0, totalTokens: 1234774 },
  models: [
    { provider: 'provider-a', model: 'model-a', usage: { input: 10, output: 1234567, cacheRead: 90, cacheWrite: 0, totalTokens: 1234667 }, recordCount: 1 },
    { provider: 'provider-b', model: 'model-b', usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, recordCount: 1 },
    { usage: { input: 0, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }, recordCount: 1 },
  ],
  warnings: ['HIDDEN-DIAGNOSTIC'],
  recordCount: 3,
};

test('model report replaces provider breakdown without unused placeholders', () => {
  const rendered = formatReport(report);
  for (const text of ['总计：1,234,774 tokens', '缓存命中率：45.00%', '按模型统计',
    '模型：provider-a/model-a', '总计：1,234,667 tokens', '输入：10', '输出：1,234,567',
    '缓存读取：90', '缓存写入：0', '缓存命中率：90.00%', '模型：provider-b/model-b',
    '缓存命中率：0.00%', '模型：未知渠道/未知模型', '缓存命中率：—']) assert.ok(rendered.includes(text), text);
  assert.equal(rendered.includes('按 provider 统计'), false);
  assert.ok(rendered.indexOf('provider-a/model-a') < rendered.indexOf('provider-b/model-b'));
});

test('range labeling preserves old durable reports without claiming they were filtered', () => {
  const scoped = formatReport({ ...report, scope: 'current-models' });
  assert.match(scoped.split('\n')[0], /当前模型列表/);
  assert.equal(scoped.includes('所有渠道'), false);
  assert.match(formatReport(report).split('\n')[0], /所有渠道/);
  const { models: _models, ...legacy } = report;
  assert.match(formatReport(legacy as UsageReport).split('\n')[0], /所有渠道/);
});

test('reports omit the source footer for current legacy and empty data', () => {
  const { models: _models, ...legacy } = report;
  const empty = { ...report, models: [], recordCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
  for (const data of [report, legacy as UsageReport, empty]) {
    const rendered = formatReport(data);
    assert.equal(rendered.includes('来源：'), false);
    assert.equal(rendered.includes('本机 Pi 已保存记录'), false);
    assert.equal(rendered.endsWith('\n'), false);
  }
});

test('partially unknown attribution displays each missing label independently', () => {
  const rendered = formatReport({ ...report, models: [
    { ...report.models[0], provider: undefined },
    { ...report.models[1], model: undefined },
  ] });
  assert.ok(rendered.includes('模型：未知渠道/model-a'));
  assert.ok(rendered.includes('模型：provider-b/未知模型'));
});

test('all warning presentation is hidden without removing retained diagnostics', () => {
  const warnings = Array.from({ length: 12 }, (_, i) => 'PRIVATE-DIAGNOSTIC-' + i);
  const rendered = formatReport({ ...report, warnings });
  assert.equal(rendered.includes('数据存在缺失或不精确部分'), false);
  assert.equal(rendered.includes('PRIVATE-DIAGNOSTIC'), false);
  assert.equal(rendered.includes('条警告'), false);
  assert.equal(warnings.length, 12);
});

test('legacy provider report renders overall only', () => {
  const { models: _models, ...old } = report;
  const rendered = formatReport({ ...old, providers: [
    { provider: 'legacy-only-provider', usage: report.usage, recordCount: 3 },
  ] } as unknown as UsageReport);
  assert.match(rendered, /总计：1,234,774/);
  assert.ok(rendered.includes('缓存命中率：45.00%'));
  for (const text of ['按模型统计', '按 provider 统计', 'legacy-only-provider']) assert.equal(rendered.includes(text), false);
});

test('empty reports show undefined cache rate and no invented model breakdown', () => {
  const rendered = formatReport({ ...report,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    models: [], recordCount: 0 });
  assert.match(rendered, /总计：0 tokens/);
  assert.ok(rendered.includes('缓存命中率：—'));
  assert.equal(rendered.includes('按模型统计'), false);
  assert.equal(rendered.includes('按 provider 统计'), false);
  assert.equal(/NaN|Infinity/.test(rendered), false);
});
