import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, normalizeUsage, parseRange, recordKey } from '../src/query.ts';
import * as query from '../src/query.ts';
import type { TokenUsage, UsageRecord } from '../src/types.ts';

const now = Date.parse('2026-11-08T20:00:00Z');
const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });

test('provider totals share range filtering and deduplication with overall weighted cache rate', () => {
  const range = parseRange('1d', now);
  const a: UsageRecord = { key: 'a', timestamp: range.start, usage: tokens(10, 10, 90), provider: 'a', source: 'a', kind: 'assistant' };
  const b: UsageRecord = { key: 'b', timestamp: now, usage: tokens(90, 1000, 0, 810), provider: 'b', source: 'b', kind: 'assistant' };
  const report = aggregate([a, { ...a, source: 'fork' }, b,
    { ...a, key: 'old', timestamp: range.start - 1 },
    { ...b, key: 'future', timestamp: now + 1 }], range);
  assert.deepEqual(report.providers?.map(p => p.provider), ['b', 'a']);
  assert.deepEqual(report.usage, { input: 100, output: 1010, cacheRead: 90, cacheWrite: 810, totalTokens: 2010 });
  assert.equal(report.recordCount, 2);
  assert.equal(query.cacheHitRate(report.providers[0].usage), 0);
  assert.equal(query.cacheHitRate(report.providers[1].usage), 0.9);
  assert.equal(query.cacheHitRate(report.usage), 0.09);
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    assert.equal(report.providers.reduce((n, p) => n + p.usage[field], 0), report.usage[field]);
  assert.equal(report.providers.reduce((n, p) => n + p.recordCount, 0), 2);
});

test('multiple calls accumulate within each known and unknown provider bucket', () => {
  const records: UsageRecord[] = [
    { key: 'a1', provider: 'a', usage: tokens(2) },
    { key: 'a2', provider: 'a', usage: tokens(3) },
    { key: 'b', provider: 'b', usage: tokens(4) },
    { key: 'u1', usage: tokens(5) },
    { key: 'u2', usage: tokens(6) },
  ].map(r => ({ ...r, timestamp: now, source: 's', kind: 'assistant' }));
  const report = aggregate(records, parseRange('1d', now));
  assert.deepEqual(report.providers?.map(p => [p.provider, p.usage.totalTokens, p.recordCount]),
    [[undefined, 11, 2], ['a', 5, 2], ['b', 4, 1]]);
  assert.equal(report.usage.totalTokens, 20);
});

test('unknown attribution cannot collide with real provider names or object prototype keys', () => {
  const records: UsageRecord[] = [undefined, '未知', 'unknown', '__proto__', 'constructor'].map((provider, i) =>
    ({ key: String(i), timestamp: now, usage: tokens(1), provider, source: 's', kind: 'assistant' }));
  const report = aggregate(records, parseRange('1d', now));
  assert.deepEqual(report.providers?.map(p => p.provider), ['__proto__', 'constructor', 'unknown', '未知', undefined]);
  assert.deepEqual(report.providers.map(p => p.usage.totalTokens), [1, 1, 1, 1, 1]);
});

test('cache rate excludes output and distinguishes zero-input from a real zero-percent hit rate', () => {
  for (const [usage, expected] of [
    [tokens(0), undefined], [tokens(0, 500), undefined],
    [tokens(10, 9999), 0], [tokens(0, 0, 90, 10), 0.9],
    [tokens(0, 0, 100), 1],
  ] as const) assert.equal(query.cacheHitRate?.(usage), expected);
  assert.deepEqual(aggregate([], parseRange('1d', now)).providers, []);
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
