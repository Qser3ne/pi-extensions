import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, normalizeUsage, parseRange, recordKey } from '../src/query.ts';
import * as query from '../src/query.ts';
import type { TokenUsage, UsageRecord } from '../src/types.ts';

const now = Date.parse('2026-11-08T20:00:00Z');
const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });

test('model groups share range filtering and deduplication with overall weighted cache rate', () => {
  const range = parseRange('1d', now);
  const a: UsageRecord = { key: 'a', timestamp: range.start, usage: tokens(10, 10, 90), provider: 'a', source: 'a', kind: 'assistant' };
  const b: UsageRecord = { key: 'b', timestamp: now, usage: tokens(90, 1000, 0, 810), provider: 'b', source: 'b', kind: 'assistant' };
  const report = aggregate([a, { ...a, source: 'fork' }, b,
    { ...a, key: 'old', timestamp: range.start - 1 },
    { ...b, key: 'future', timestamp: now + 1 }], range);
  assert.deepEqual(report.models?.map(p => p.provider), ['b', 'a']);
  assert.deepEqual(report.usage, { input: 100, output: 1010, cacheRead: 90, cacheWrite: 810, totalTokens: 2010 });
  assert.equal(report.recordCount, 2);
  assert.equal(query.cacheHitRate(report.models[0].usage), 0);
  assert.equal(query.cacheHitRate(report.models[1].usage), 0.9);
  assert.equal(query.cacheHitRate(report.usage), 0.09);
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    assert.equal(report.models.reduce((n, p) => n + p.usage[field], 0), report.usage[field]);
  assert.equal(report.models.reduce((n, p) => n + p.recordCount, 0), 2);
});

test('multiple calls accumulate within each known and unknown provider-model bucket', () => {
  const records: UsageRecord[] = [
    { key: 'a1', provider: 'a', usage: tokens(2) },
    { key: 'a2', provider: 'a', usage: tokens(3) },
    { key: 'b', provider: 'b', usage: tokens(4) },
    { key: 'u1', usage: tokens(5) },
    { key: 'u2', usage: tokens(6) },
  ].map(r => ({ ...r, timestamp: now, source: 's', kind: 'assistant' }));
  const report = aggregate(records, parseRange('1d', now));
  assert.deepEqual(report.models?.map(p => [p.provider, p.usage.totalTokens, p.recordCount]),
    [[undefined, 11, 2], ['a', 5, 2], ['b', 4, 1]]);
  assert.equal(report.usage.totalTokens, 20);
});

test('unknown attribution cannot collide with real provider names or object prototype keys', () => {
  const records: UsageRecord[] = [undefined, '未知', 'unknown', '__proto__', 'constructor'].map((provider, i) =>
    ({ key: String(i), timestamp: now, usage: tokens(1), provider, source: 's', kind: 'assistant' }));
  const report = aggregate(records, parseRange('1d', now));
  assert.deepEqual(report.models?.map(p => p.provider), ['__proto__', 'constructor', 'unknown', '未知', undefined]);
  assert.deepEqual(report.models.map(p => p.usage.totalTokens), [1, 1, 1, 1, 1]);
});

test('cache rate excludes output and distinguishes zero-input from a real zero-percent hit rate', () => {
  for (const [usage, expected] of [
    [tokens(0), undefined], [tokens(0, 500), undefined],
    [tokens(10, 9999), 0], [tokens(0, 0, 90, 10), 0.9],
    [tokens(0, 0, 100), 1],
  ] as const) assert.equal(query.cacheHitRate?.(usage), expected);
  assert.deepEqual(aggregate([], parseRange('1d', now)).models, []);
});

test('aggregation rejects unsafe component and reported-total sums', () => {
  for (const usage of [
    tokens(Number.MAX_SAFE_INTEGER),
    { ...tokens(0), totalTokens: Number.MAX_SAFE_INTEGER },
  ]) {
    const a: UsageRecord = { key: 'a', timestamp: now, usage, source: 's', kind: 'assistant', provider: 'a' };
    assert.throws(() => aggregate([a, { ...a, key: 'b', usage: tokens(1), provider: 'b' }], parseRange('1d', now)), RangeError);
  }
});

test('provider-model tuples separate models and accumulate repeated calls', () => {
  const rows = [
    { provider: 'p1', model: 'mA', usage: tokens(2) },
    { provider: 'p1', model: 'mA', usage: tokens(3) },
    { provider: 'p1', model: 'mB', usage: tokens(7) },
    { provider: 'p2', model: 'mA', usage: tokens(11) },
  ];
  const records: UsageRecord[] = rows.map((r, i) => ({ ...r, key: String(i), timestamp: now, source: String(i), kind: 'assistant' }));
  const report = aggregate(records, parseRange('1d', now));
  assert.deepEqual(report.models?.map(g => [g.provider, g.model, g.usage.totalTokens]),
    [['p2', 'mA', 11], ['p1', 'mB', 7], ['p1', 'mA', 5]]);
  assert.equal(report.usage.totalTokens, 23);
  assert.equal(report.models[2].recordCount, 2);
  assert.equal('providers' in report, false);
});

test('tuple keys do not collide on slash-containing or unknown-like names', () => {
  const rows: [string | undefined, string | undefined, number][] = [
    ['p/a', 'm', 2], ['p', 'a/m', 3], [undefined, 'm', 1],
    ['unknown', 'm', 1], ['p', undefined, 1], ['p', 'unknown', 1],
    ['__proto__', 'constructor', 1],
  ];
  const records: UsageRecord[] = rows.map(([provider, model, n], i) =>
    ({ key: String(i), timestamp: now, usage: tokens(n), provider, model, source: 's', kind: 'assistant' }));
  const report = aggregate(records, parseRange('1d', now));
  assert.equal(report.models?.length, 7);
  assert.deepEqual(report.models.filter(g => g.provider === 'p' && g.model === 'a/m').map(g => g.usage.totalTokens), [3]);
  assert.deepEqual(report.models.filter(g => g.provider === 'p/a' && g.model === 'm').map(g => g.usage.totalTokens), [2]);
  assert.equal(report.usage.totalTokens, 10);
});

test('only nonzero in-window model groups are listed', () => {
  const range = parseRange('1d', now);
  const rows = [
    { model: 'zero-only', usage: tokens(0), timestamp: now },
    { model: 'outside-window', usage: tokens(100), timestamp: range.start - 1 },
    { model: 'future-only', usage: tokens(100), timestamp: now + 1 },
    { model: 'start-model', usage: tokens(1), timestamp: range.start },
    { model: 'cache-only', usage: tokens(0, 0, 1), timestamp: now },
    { model: 'positive-input-zero-total', usage: { ...tokens(1), totalTokens: 0 }, timestamp: now },
    { model: 'positive-total-zero-components', usage: { ...tokens(0), totalTokens: 1 }, timestamp: now },
  ];
  const records: UsageRecord[] = rows.map((r, i) =>
    ({ ...r, key: String(i), provider: 'p', source: 's', kind: 'assistant' }));
  const report = aggregate(records, range);
  assert.deepEqual(report.models?.map(g => g.model),
    ['cache-only', 'positive-total-zero-components', 'start-model', 'positive-input-zero-total']);
  assert.equal(report.usage.totalTokens, 3);
  assert.equal(report.recordCount, 5);
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    assert.equal(report.models.reduce((n, g) => n + g.usage[field], 0), report.usage[field]);
  assert.deepEqual(aggregate([records[0]], range).models, []);
});

test('model ties are stable with complete attribution before missing attribution', () => {
  const rows: [string | undefined, string | undefined][] = [
    [undefined, undefined], ['z', 'a'], [undefined, 'a'], ['a', undefined], ['a', 'z'], ['a', 'a'],
  ];
  const records: UsageRecord[] = rows.map(([provider, model], i) =>
    ({ key: String(i), timestamp: now, usage: tokens(1), provider, model, source: 's', kind: 'assistant' }));
  assert.deepEqual(aggregate(records, parseRange('1d', now)).models?.map(g => [g.provider, g.model]),
    [['a', 'a'], ['a', 'z'], ['z', 'a'], ['a', undefined], [undefined, 'a'], [undefined, undefined]]);
});

test('parse hours and days as rolling windows', () => {
  for (const [arg, ms] of [['24h', 86400000], ['1d', 86400000], ['7d', 604800000]] as const) {
    const r = parseRange(arg, now);
    assert.equal(r.start, now - ms); assert.equal(r.end, now);
  }
  assert.equal(parseRange(' 3d ', now).amount, 3);
});
test('reject invalid ranges and unsafe durations', () => {
  for (const arg of ['', '15', 'help', '0h', '-1d', '1.5d', '1w', '1d extra', '999999999999999999d']) {
    assert.throws(() => parseRange(arg, now), RangeError, arg);
  }
});
test('sum usage exactly once without adding reasoning or cacheWrite1h', () => {
  assert.deepEqual(normalizeUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, cacheWrite1h: 9 }),
    { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 });
  assert.equal(normalizeUsage({ input: 1, totalTokens: 80 })?.totalTokens, 80);
  assert.equal(normalizeUsage({ output: 7 })?.totalTokens, 7);
  assert.equal(normalizeUsage({}), undefined);
  for (const value of [-1, NaN, Infinity, '10', 1.5]) assert.equal(normalizeUsage({ input: value }), undefined);
});
test('range endpoints are inclusive and record identities preserve distinct short-ID collisions', () => {
  const range = parseRange('1d', now);
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
  const a = { key: 'a', timestamp: range.start, usage, source: 'one', kind: 'assistant' };
  const report = aggregate([a, { ...a, source: 'fork' }, { ...a, key: 'b', timestamp: now },
    { ...a, key: 'future', timestamp: now + 1 }, { ...a, key: 'old', timestamp: range.start - 1 }], range);
  assert.equal(report.usage.totalTokens, 20); assert.equal(report.recordCount, 2);
  assert.notEqual(recordKey({ id: 'a', timestamp: now, text: 'one' }), recordKey({ id: 'a', timestamp: now, text: 'two' }));
  assert.equal(recordKey({ id: 'a', usage }), recordKey({ usage, id: 'a' }));
});
