import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectUsage } from '../src/collector.ts';
import { loadSnapshot, saveSnapshot } from '../src/cache.ts';
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

test('large irrelevant message content is not copied into statistical records', async t => {
  const root = await temporary(t), path = join(root, 's.jsonl');
  await session(path, [{ type: 'message', message: { role: 'user', content: 'z'.repeat(2_000_000) } }, message()]);
  const snapshot = await readUsageFile(path);
  assert.equal(snapshot.records.length, 1); assert.ok(JSON.stringify(snapshot).length < 3000);
});
