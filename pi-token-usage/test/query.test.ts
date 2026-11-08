import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, normalizeUsage, parseRange, recordKey } from '../src/query.ts';

const now = Date.parse('2026-11-08T20:00:00Z');
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
