import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectUsage } from '../src/collector.ts';
import { SnapshotCache, loadSnapshot, saveSnapshot } from '../src/cache.ts';
import { readUsageFile } from '../src/reader.ts';
import { parseRange } from '../src/query.ts';
import { message, session, temporary, time } from './fixtures.ts';
const range = parseRange('7d', Date.parse(time));

test('unchanged file reuses parsed records and append reads only complete new bytes', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl');
  await session(path, [message('a', 10)]);
  const first = await readUsageFile(path);
  const same = await readUsageFile(path, first);
  assert.equal(same.records, first.records);
  const line = JSON.stringify(message('b', 20));
  await appendFile(path, line.slice(0, 12));
  const partial = await readUsageFile(path, first);
  assert.equal(partial.records.length, 1); assert.equal(partial.records[0], first.records[0]);
  await appendFile(path, line.slice(12) + '\n');
  const next = await readUsageFile(path, partial);
  assert.equal(next.records.length, 2); assert.equal(next.records[0], first.records[0]);
  assert.equal(next.warnings.some(w => w.includes('末行')), false);
});
test('replace truncate and same-size rewrite invalidate cached records', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl');
  await session(path, [message('a', 10)]);
  const first = await readUsageFile(path);
  await session(path, [message('a', 20)]);
  const rewritten = await readUsageFile(path, first);
  assert.equal(rewritten.records[0].usage.totalTokens, 20);
  await session(join(root, 'new'), [message('new', 30)]); await rename(join(root, 'new'), path);
  const replaced = await readUsageFile(path, rewritten);
  assert.equal(replaced.records[0].usage.totalTokens, 30);
  await writeFile(path, ''); assert.equal((await readUsageFile(path, replaced)).records.length, 0);
});
test('collector excludes deleted sources and caches no prompts', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache');
  await mkdir(sources); const path = join(sources, 's.jsonl');
  await session(path, [message('a', 10)]);
  const options = { roots: [sources], cacheDir, range };
  assert.equal((await collectUsage(options)).usage.totalTokens, 10);
  const files = await readdir(cacheDir);
  const raw = await readFile(join(cacheDir, files[0]), 'utf8');
  assert.equal(raw.includes('PRIVATE-BODY'), false);
  assert.equal((await collectUsage(options)).usage.totalTokens, 10);
  await rm(path); assert.equal((await collectUsage(options)).usage.totalTokens, 0);
});
test('bad cache schema versions numbers and unwritable cache fall back to scan', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache');
  await mkdir(sources); const path = join(sources, 's.jsonl'); await session(path, [message()]);
  const snapshot = await readUsageFile(path); await saveSnapshot(cacheDir, snapshot);
  const cache = join(cacheDir, (await readdir(cacheDir))[0]);
  for (const raw of ['not json', JSON.stringify({ ...snapshot, version: 99 }), JSON.stringify({ ...snapshot, records: [{ ...snapshot.records[0], usage: { input: -1 } }] })]) {
    await writeFile(cache, raw);
    assert.equal(await loadSnapshot(cacheDir, path), undefined);
    assert.equal((await collectUsage({ roots: [sources], cacheDir, range })).usage.totalTokens, 10);
  }
  const blocked = join(root, 'file-not-directory'); await writeFile(blocked, 'blocked');
  const fallback = await collectUsage({ roots: [sources], cacheDir: blocked, range });
  assert.equal(fallback.usage.totalTokens, 10); assert.ok(fallback.warnings.length > 0);
});
test('concurrent atomic writers leave a valid snapshot and no temporary files', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message()]); const snapshot = await readUsageFile(path);
  await Promise.all(Array.from({ length: 12 }, () => saveSnapshot(cacheDir, snapshot)));
  assert.equal((await loadSnapshot(cacheDir, path))?.records.length, 1);
  assert.equal((await readdir(cacheDir)).length, 1);
});
test('separate Node processes can concurrently publish the shared cache', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message()]);
  const code = `import { readUsageFile } from ${JSON.stringify(new URL('../src/reader.ts', import.meta.url).href)};
    import { saveSnapshot } from ${JSON.stringify(new URL('../src/cache.ts', import.meta.url).href)};
    await saveSnapshot(process.argv[1], await readUsageFile(process.argv[2]));`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code, cacheDir, path]);
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal((await loadSnapshot(cacheDir, path))?.records[0].usage.totalTokens, 10);
  assert.equal((await readdir(cacheDir)).length, 1);
});

test('filesystem write permission denial preserves querying', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('requires non-root POSIX permissions'); return; }
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache');
  await mkdir(sources); await mkdir(cacheDir); await session(join(sources, 's.jsonl'), [message()]);
  await chmod(cacheDir, 0o500);
  try {
    const r = await collectUsage({ roots: [sources], cacheDir, range });
    assert.equal(r.usage.totalTokens, 10); assert.ok(r.warnings.some(w => w.includes('缓存无法写入')));
  } finally { await chmod(cacheDir, 0o700); }
});

test('selected symlink root aliases resolve child references without broadening discovery', async t => {
  const root = await temporary(t), physical = join(root, 'real'), alias = join(root, 'alias');
  await mkdir(physical); await symlink(physical, alias);
  await session(join(physical, 'child.jsonl'), [message('child', 10)]);
  await session(join(physical, 'parent.jsonl'), [{ type: 'message', id: 'summary', timestamp: time, message: {
    role: 'toolResult', toolName: 'subagent', usage: { input: 10 }, details: { results: [{ sessionFile: join(alias, 'child.jsonl'), usage: { input: 10 } }] }
  } }]);
  const r = await collectUsage({ roots: [alias], cacheDir: join(root, 'cache'), range });
  assert.equal(r.usage.totalTokens, 10); assert.deepEqual(r.warnings, []);
});

test('post-cutoff child summary cannot replace an eligible in-window summary', async t => {
  const root = await temporary(t), path = join(root, 'parent.jsonl');
  const result = (id: string, tokens: number, timestamp: number) => ({ type: 'message', id, timestamp: new Date(timestamp).toISOString(), message: {
    role: 'toolResult', toolName: 'subagent', usage: { input: tokens },
    details: { results: [{ sessionFile: join(root, 'missing.jsonl'), usage: { input: tokens } }] }
  } });
  await session(path, [result('before', 10, range.end - 1), result('after', 20, range.end + 1)]);
  const r = await collectUsage({ roots: [root], cacheDir: join(root, 'cache'), range });
  assert.equal(r.usage.totalTokens, 10);
});

test('old protocol snapshots are rebuilt even for unchanged files', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message()]);
  const snapshot = await readUsageFile(path);
  const old = { ...snapshot, version: 2, records: snapshot.records.map(({ provider: _provider, ...r }) => r) };
  await saveSnapshot(cacheDir, old as any);
  assert.equal(await loadSnapshot(cacheDir, path), undefined);
  const rebuilt = await readUsageFile(path, old as any);
  assert.equal(rebuilt.records[0].provider, 'provider-a');
  assert.notEqual(rebuilt.records, old.records);
});

test('cache rejects invalid provider metadata rather than permanently misattributing usage', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message()]);
  const snapshot = await readUsageFile(path);
  for (const provider of [42, null, '', ' ', ' provider-a ']) {
    await saveSnapshot(cacheDir, { ...snapshot, records: [{ ...snapshot.records[0], provider }] } as any);
    assert.equal(await loadSnapshot(cacheDir, path), undefined, JSON.stringify(provider));
  }
});

test('provider attribution survives persistent cache reuse and incremental append without prompts', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message('a', 10)]);
  const first = await readUsageFile(path); await saveSnapshot(cacheDir, first);
  const cached = await loadSnapshot(cacheDir, path);
  assert.equal(cached?.records[0].provider, 'provider-a');
  assert.equal(cached?.records[0].model, 'model-a');
  const same = await readUsageFile(path, cached);
  assert.equal(same.records, cached?.records);
  const b = message('b', 20); b.message.provider = 'provider-b'; b.message.model = 'model-b';
  await appendFile(path, JSON.stringify(b) + '\n');
  const next = await readUsageFile(path, same); await saveSnapshot(cacheDir, next);
  assert.deepEqual((await loadSnapshot(cacheDir, path))?.records.map(r => [r.provider, r.model]),
    [['provider-a', 'model-a'], ['provider-b', 'model-b']]);
  assert.equal(JSON.stringify(next).includes('PRIVATE-BODY'), false);
});

test('protocol 3 snapshots rebuild with model attribution even for unchanged sources', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message()]);
  const snapshot = await readUsageFile(path);
  const old = { ...snapshot, version: 3, records: snapshot.records.map(({ model: _model, ...r }) => r) };
  await saveSnapshot(cacheDir, old as any);
  assert.equal(await loadSnapshot(cacheDir, path), undefined);
  const rebuilt = await readUsageFile(path, old as any);
  assert.notEqual(rebuilt.records, old.records);
  assert.equal(rebuilt.records[0].model, 'model-a');
});

test('cache rejects malformed model metadata rather than reusing corrupt attribution', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl'), cacheDir = join(root, 'cache');
  await session(path, [message()]);
  const snapshot = await readUsageFile(path);
  for (const model of [42, null, '', ' ', ' model-a ']) {
    await saveSnapshot(cacheDir, { ...snapshot, records: [{ ...snapshot.records[0], model }] } as any);
    assert.equal(await loadSnapshot(cacheDir, path), undefined, JSON.stringify(model));
  }
});

test('warm memory snapshots avoid rereading disk JSON while checking source files', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache');
  await mkdir(sources); await session(join(sources, 's.jsonl'), [message('a', 10)]);
  const memoryCache = new SnapshotCache(), options = { roots: [sources], cacheDir, range, memoryCache };
  const first = await collectUsage(options);
  const disk = join(cacheDir, (await readdir(cacheDir))[0]), saved = disk + '.saved';
  await rename(disk, saved); await mkdir(disk);
  try {
    const second = await collectUsage(options);
    assert.equal(second.usage.totalTokens, 10);
    assert.deepEqual(second.models, first.models);
    assert.equal(second.warnings.some(w => w.includes('缓存无法读取')), false);
    assert.equal(second.warnings.some(w => w.includes('缓存无法写入')), false);
  } finally { await rm(disk, { recursive: true }); await rename(saved, disk); }
});

test('memory reuse preserves append rewrite replacement deletion moving windows and concurrent totals', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache'), path = join(sources, 's.jsonl');
  await mkdir(sources);
  const memoryCache = new SnapshotCache(), options = { roots: [sources], cacheDir, range, memoryCache };
  const check = async (want: number) => {
    const actual = await collectUsage(options);
    const baseline = await collectUsage({ ...options, memoryCache: undefined, cacheDir: join(root, 'baseline') });
    assert.equal(actual.usage.totalTokens, want);
    assert.deepEqual({ usage: actual.usage, models: actual.models, records: actual.recordCount },
      { usage: baseline.usage, models: baseline.models, records: baseline.recordCount });
  };
  await session(path, [message('a', 10)]); await check(10);
  const b = message('b', 20); b.message.provider = 'other'; b.message.model = 'model-b';
  await appendFile(path, JSON.stringify(b) + '\n'); await check(30);
  const oldSize = (await readFile(path)).length;
  await session(path, [message('a', 40), b]);
  assert.equal((await readFile(path)).length, oldSize);
  await check(60);
  const replacement = join(root, 'new.jsonl'); await session(replacement, [message('c', 7)]);
  await rename(replacement, path); await check(7);
  await rm(path); await check(0); assert.equal(memoryCache.get(cacheDir, path), undefined);
  await session(path, [message('d', 3)]); await check(3);
  const moved = await collectUsage({ ...options, range: parseRange('1h', range.end + 86400000) });
  assert.equal(moved.usage.totalTokens, 0); assert.deepEqual(moved.models, []);
  const parallel = await Promise.all(Array.from({ length: 4 }, () => collectUsage(options)));
  assert.deepEqual(parallel.map(r => r.usage.totalTokens), [3, 3, 3, 3]);
  assert.ok(parallel.every(r => r.recordCount === 1));
});

test('failed cache writes keep retrying and recover before admitting memory snapshots', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'blocked');
  await mkdir(sources); await session(join(sources, 's.jsonl'), [message('a', 10)]);
  await writeFile(cacheDir, 'not a directory');
  const memoryCache = new SnapshotCache(), options = { roots: [sources], cacheDir, range, memoryCache };
  for (let i = 0; i < 2; i++) {
    const report = await collectUsage(options);
    assert.equal(report.usage.totalTokens, 10);
    assert.ok(report.warnings.some(w => w.includes('缓存无法写入')));
    assert.equal(memoryCache.size, 0);
  }
  await rm(cacheDir);
  const recovered = await collectUsage(options);
  assert.equal(recovered.usage.totalTokens, 10);
  assert.equal(recovered.warnings.some(w => w.includes('缓存无法写入')), false);
  assert.equal((await readdir(cacheDir)).length, 1);
  assert.equal(memoryCache.size, 1);
});

test('a changed source cannot retain its new memory snapshot after persistence fails', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache'), path = join(sources, 's.jsonl');
  await mkdir(sources); await session(path, [message('a', 10)]);
  const memoryCache = new SnapshotCache(), options = { roots: [sources], cacheDir, range, memoryCache };
  await collectUsage(options); assert.equal(memoryCache.size, 1);
  await rm(cacheDir, { recursive: true }); await writeFile(cacheDir, 'blocked');
  await appendFile(path, JSON.stringify(message('b', 20)) + '\n');
  for (let i = 0; i < 2; i++) {
    const report = await collectUsage(options);
    assert.equal(report.usage.totalTokens, 30);
    assert.ok(report.warnings.some(w => w.includes('缓存无法写入')));
    assert.equal(memoryCache.size, 0);
  }
  await rm(cacheDir);
  const recovered = await collectUsage(options);
  assert.equal(recovered.usage.totalTokens, 30);
  assert.equal(recovered.warnings.some(w => w.includes('缓存无法写入')), false);
  const disk = await loadSnapshot(cacheDir, path);
  assert.equal(disk?.records.length, 2); assert.equal(memoryCache.size, 1);
});

test('unreadable sources cannot reuse prior memory consumption', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('requires non-root POSIX permissions'); return; }
  const root = await temporary(t), sources = join(root, 'sessions'), cacheDir = join(root, 'cache'), path = join(sources, 's.jsonl');
  await mkdir(sources); await session(path, [message('a', 10)]);
  const memoryCache = new SnapshotCache(), options = { roots: [sources], cacheDir, range, memoryCache };
  assert.equal((await collectUsage(options)).usage.totalTokens, 10);
  await chmod(path, 0o000);
  try {
    const unreadable = await collectUsage(options);
    assert.equal(unreadable.usage.totalTokens, 0);
    assert.ok(unreadable.warnings.some(w => w.includes('无法完整扫描会话')));
    assert.equal(memoryCache.get(cacheDir, path), undefined);
  } finally { await chmod(path, 0o600); }
  assert.equal((await collectUsage(options)).usage.totalTokens, 10);
});

test('large irrelevant message content is not copied into statistical records', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl');
  await session(path, [{ type: 'message', message: { role: 'user', content: 'z'.repeat(2_000_000) } }, message()]);
  const snapshot = await readUsageFile(path);
  assert.equal(snapshot.records.length, 1); assert.ok(JSON.stringify(snapshot).length < 3000);
});
