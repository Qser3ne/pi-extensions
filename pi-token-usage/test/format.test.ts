import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport } from '../src/format.ts';
import { parseRange } from '../src/query.ts';
import type { UsageReport } from '../src/types.ts';

const report: UsageReport = {
  range: parseRange('24h', Date.parse('2026-11-09T12:00:00Z')),
  usage: { input: 110, output: 1234574, cacheRead: 90, cacheWrite: 0, totalTokens: 1234774 },
  providers: [
    { provider: 'provider-a', usage: { input: 10, output: 1234567, cacheRead: 90, cacheWrite: 0, totalTokens: 1234667 }, recordCount: 1 },
    { provider: 'provider-b', usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, recordCount: 1 },
    { usage: { input: 0, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }, recordCount: 1 },
  ],
  warnings: ['HIDDEN-DIAGNOSTIC'],
  recordCount: 3,
};

test('report displays overall and provider cache rates without abbreviating token counts', () => {
  const rendered = formatReport(report);
  assert.match(rendered, /总计：1,234,774 tokens/);
  assert.match(rendered, /缓存命中率：45\.00%/);
  assert.match(rendered, /按 provider 统计/);
  assert.match(rendered, /provider-a/);
  assert.match(rendered, /1,234,667/);
  assert.match(rendered, /1,234,567/);
  assert.match(rendered, /缓存命中率：90\.00%/);
  assert.match(rendered, /provider-b/);
  assert.match(rendered, /缓存命中率：0\.00%/);
  assert.match(rendered, /未知（未记录 provider）/);
  assert.match(rendered, /缓存命中率：—/);
  assert.ok(rendered.indexOf('provider-a') < rendered.indexOf('provider-b'));
});

test('all warning presentation is hidden without removing retained diagnostics', () => {
  const warnings = Array.from({ length: 12 }, (_, i) => 'PRIVATE-DIAGNOSTIC-' + i);
  const rendered = formatReport({ ...report, warnings });
  assert.equal(rendered.includes('数据存在缺失或不精确部分'), false);
  assert.equal(rendered.includes('PRIVATE-DIAGNOSTIC'), false);
  assert.equal(rendered.includes('条警告'), false);
  assert.equal(warnings.length, 12);
});

test('old persisted report without providers still renders overall cache rate', () => {
  const { providers: _providers, ...old } = report;
  const rendered = formatReport(old as UsageReport);
  assert.match(rendered, /总计：1,234,774/);
  assert.match(rendered, /缓存命中率：45\.00%/);
  assert.equal(rendered.includes('按 provider 统计'), false);
});

test('empty reports show undefined cache rate and no invented provider breakdown', () => {
  const rendered = formatReport({ ...report,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    providers: [], recordCount: 0 });
  assert.match(rendered, /总计：0 tokens/);
  assert.match(rendered, /缓存命中率：—/);
  assert.equal(rendered.includes('按 provider 统计'), false);
  assert.equal(/NaN|Infinity/.test(rendered), false);
});
