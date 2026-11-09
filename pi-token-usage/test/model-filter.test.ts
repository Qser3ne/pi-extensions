import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collectUsage } from '../src/collector.ts';
import { SnapshotCache } from '../src/cache.ts';
import { cacheHitRate, parseRange } from '../src/query.ts';
import { header, message, session, temporary, time } from './fixtures.ts';

const range = parseRange('24h', Date.parse(time));
const A = { provider: 'A', id: 'shared' }, B = { provider: 'B', id: 'shared' };
function attributed(id: string, tokens: number, provider?: string, model?: string) {
  const entry = message(id, tokens);
  return { ...entry, message: { ...entry.message, provider, model } };
}
function records() {
  const a = attributed('a', 100, 'A', 'shared');
  a.message.usage = { input: 10, output: 0, cacheRead: 90, cacheWrite: 0, totalTokens: 100 };
  return [a, attributed('b', 900, 'B', 'shared'), attributed('unknown', 7)];
}

test('filters totals groups counts and cache rates by exact model pairs', async t => {
  const root = await temporary(t), path = join(root, 'source.jsonl'); await session(path, records());
  const report = await collectUsage({ roots: [path], cacheDir: join(root, 'cache'), range, allowedModels: [A] });
  assert.equal(report.usage.totalTokens, 100);
  assert.equal(report.recordCount, 1);
  assert.deepEqual(report.models.map(g => [g.provider, g.model]), [['A', 'shared']]);
  assert.equal(cacheHitRate(report.usage), 0.9);
  assert.equal(report.scope, 'current-models');
});

test('empty model list never falls back to all history', async t => {
  const root = await temporary(t), path = join(root, 'source.jsonl'); await session(path, records());
  const report = await collectUsage({ roots: [path], cacheDir: join(root, 'cache'), range, allowedModels: [] });
  assert.deepEqual(report.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  assert.equal(report.recordCount, 0); assert.deepEqual(report.models, []);
  assert.equal(report.scope, 'current-models');
});

test('model identities do not collide or conflate missing attribution with literal names', async t => {
  const root = await temporary(t), path = join(root, 'source.jsonl');
  await session(path, [attributed('slash-a', 1, 'A/B', 'C'), attributed('slash-b', 20, 'A', 'B/C'),
    attributed('literal', 3, 'unknown', 'null'), attributed('missing', 100),
    attributed('missing-provider', 1000, undefined, 'null'), attributed('missing-model', 10000, 'unknown'),
    attributed('prototype', 5, '__proto__', 'constructor')]);
  const report = await collectUsage({ roots: [path], cacheDir: join(root, 'cache'), range,
    allowedModels: [{ provider: 'A/B', id: 'C' }, { provider: 'unknown', id: 'null' },
      { provider: '__proto__', id: 'constructor' }, { provider: 'A/B', id: 'C' }] });
  assert.equal(report.usage.totalTokens, 9); assert.equal(report.recordCount, 3);
  assert.deepEqual(report.models.map(g => [g.provider, g.model]),
    [['__proto__', 'constructor'], ['unknown', 'null'], ['A/B', 'C']]);
});

test('filtering follows full child reconciliation and inherited-copy deduplication', async t => {
  const root = await temporary(t), kept = join(root, 'kept.jsonl'), removed = join(root, 'removed.jsonl');
  const child = attributed('kept', 10, 'A', 'kept');
  await session(kept, [child]); await session(removed, [attributed('removed', 20, 'B', 'removed')]);
  const forkHeader = { ...header, id: 'fork', parentSession: kept };
  await session(join(root, 'fork.jsonl'), [child], forkHeader);
  await session(join(root, 'parent.jsonl'), [{ type: 'message', id: 'summary', timestamp: time, message: {
    role: 'toolResult', toolName: 'subagent', provider: 'parent', model: 'parent-model',
    usage: { input: 35, totalTokens: 35 }, details: { results: [
      { sessionFile: kept, usage: { input: 10, totalTokens: 10 } },
      { sessionFile: removed, usage: { input: 20, totalTokens: 20 } },
    ] },
  } }]);
  const report = await collectUsage({ roots: [root], cacheDir: join(root, 'cache'), range,
    allowedModels: [{ provider: 'A', id: 'kept' }, { provider: 'parent', id: 'parent-model' }] });
  assert.equal(report.usage.totalTokens, 10); assert.equal(report.recordCount, 1);
  assert.deepEqual(report.models.map(g => [g.provider, g.model]), [['A', 'kept']]);
  assert.ok(report.warnings.some(w => w.includes('差额')));
});

test('model changes reuse complete memory and disk snapshots without losing excluded history', async t => {
  const root = await temporary(t), path = join(root, 'source.jsonl'), cacheDir = join(root, 'cache');
  await session(path, records());
  const memoryCache = new SnapshotCache(), options = { roots: [path], cacheDir, range, memoryCache };
  for (const [allowedModels, expected] of [[ [A], 100 ], [ [B], 900 ], [ [], 0 ], [ [A, B], 1000 ]] as const) {
    const report = await collectUsage({ ...options, allowedModels });
    assert.equal(report.usage.totalTokens, expected);
  }
  const disk = await collectUsage({ ...options, memoryCache: undefined, allowedModels: [B] });
  assert.equal(disk.usage.totalTokens, 900);
  const all = await collectUsage(options);
  assert.equal(all.usage.totalTokens, 1007); assert.equal(all.recordCount, 3); assert.equal(all.scope, undefined);
  assert.equal(memoryCache.get(cacheDir, path)?.records.length, 3);
  const saved = JSON.parse(await readFile(join(cacheDir, (await readdir(cacheDir))[0]), 'utf8'));
  assert.equal(saved.records.length, 3);
});
