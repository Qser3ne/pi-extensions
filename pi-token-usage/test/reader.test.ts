import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverFiles, readUsageFile } from '../src/reader.ts';
import { header, message, session, temporary, time } from './fixtures.ts';

test('extract all usage classes and retain all branches after compaction', async t => {
  const root = await temporary(t); const path = join(root, 'session.jsonl');
  await session(path, [message('a'), message('b', 20, { parentId: null }),
    { type: 'usage', id: 'u', timestamp: time, kind: 'cache_warm', usage: { cacheRead: 30 } },
    { type: 'compaction', id: 'c', timestamp: time, usage: { output: 40 } },
    { type: 'branch_summary', id: 's', timestamp: time, usage: { output: 50 } },
    { type: 'message', id: 't', timestamp: time, message: { role: 'toolResult', toolName: 'classifier', usage: { input: 60 } } },
    { type: 'message', id: 'x', timestamp: time, message: { role: 'user', content: 'ignore', usage: { input: 999 } } },
    { type: 'custom', id: 'custom', timestamp: time, usage: { input: 999 } }]);
  const r = await readUsageFile(path);
  assert.equal(r.records.length, 6);
  assert.equal(r.records.reduce((n, x) => n + x.usage.totalTokens, 0), 210);
  assert.deepEqual(r.warnings, []);
  assert.equal(JSON.stringify(r).includes('PRIVATE-BODY'), false);
});
test('discover recursively without duplicate roots or symlink loops; ignore artifact JSONL', async t => {
  const root = await temporary(t); await mkdir(join(root, 'children'));
  await session(join(root, 'a.jsonl'), [message()]);
  await session(join(root, 'children', 'b.jsonl'), [message('b')]);
  await writeFile(join(root, 'events.jsonl'), JSON.stringify({ type: 'event', usage: { input: 999 } }) + '\n');
  await symlink(root, join(root, 'children', 'loop'));
  const found = await discoverFiles([root, root, join(root, 'children')]);
  assert.equal(found.files.length, 3);
  const artifact = await readUsageFile(join(root, 'events.jsonl'));
  assert.equal(artifact.records.length, 0);
});
test('discovery uses directory entries without statting every ordinary child file', async t => {
  const root = await temporary(t), child = join(root, 'child'); await mkdir(child);
  await session(join(child, 's.jsonl'), [message()]);
  for (let i = 0; i < 20; i++) await writeFile(join(child, i + '.txt'), 'artifact');
  const original = fs.promises.lstat, checked: string[] = [];
  t.mock.method(fs.promises, 'lstat', (...args: any[]) => {
    checked.push(String(args[0])); return Reflect.apply(original, fs.promises, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual((await discoverFiles([root])).files, [join(child, 's.jsonl')]);
  assert.deepEqual(checked.filter(p => p.endsWith('.txt') || p.endsWith('.jsonl')), []);
});

test('wide discovery overlaps directory reads without exceeding eight active reads', async t => {
  const root = await temporary(t);
  const expected: string[] = [];
  for (let i = 0; i < 24; i++) {
    const dir = join(root, String(i)); await mkdir(dir);
    const path = join(dir, 's.jsonl'); await session(path, [message(String(i))]); expected.push(path);
  }
  const original = fs.promises.readdir; let active = 0, peak = 0;
  t.mock.method(fs.promises, 'readdir', async (...args: any[]) => {
    active++; peak = Math.max(peak, active);
    try { return await Reflect.apply(original, fs.promises, args); }
    finally { active--; }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual((await discoverFiles([root])).files, expected.sort());
  assert.ok(peak > 1 && peak <= 8, 'peak directory reads: ' + peak);
});

test('deep discovery preserves explicit file roots root aliases and sorted deduplication', async t => {
  const root = await temporary(t), top = join(root, 'top.jsonl'), alias = join(root, 'alias');
  await session(top, [message('top')]);
  let dir = root;
  for (let i = 0; i < 30; i++) { dir = join(dir, 'd'); await mkdir(dir); }
  const deep = join(dir, 'deep.jsonl'); await session(deep, [message('deep')]);
  await symlink(root, alias);
  const result = await discoverFiles([alias, top, dir, root, deep]);
  assert.deepEqual(result.files, [top, deep].sort());
  assert.deepEqual(result.warnings, []);
});

test('a queued directory replaced by an internal symlink is not followed', async t => {
  const root = await temporary(t), outside = await temporary(t), child = join(root, 'child');
  await mkdir(child); await session(join(outside, 'secret.jsonl'), [message()]);
  const original = fs.promises.readdir; let replaced = false;
  t.mock.method(fs.promises, 'readdir', async (...args: any[]) => {
    const result = await Reflect.apply(original, fs.promises, args);
    if (String(args[0]) === root && !replaced) {
      replaced = true; await fs.promises.rmdir(child); await symlink(outside, child);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await discoverFiles([root]);
  assert.equal(replaced, true);
  assert.deepEqual(result.files, []);
});

test('discovery retains permission diagnostics while scanning accessible siblings', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('requires non-root POSIX permissions'); return; }
  const root = await temporary(t), denied = join(root, 'denied'), visible = join(root, 'visible.jsonl');
  await mkdir(denied); await session(visible, [message()]);
  await chmod(denied, 0o000);
  try {
    const result = await discoverFiles([root]);
    assert.deepEqual(result.files, [visible]);
    assert.ok(result.warnings.some(w => w.includes(denied)));
  } finally { await chmod(denied, 0o700); }
});

test('timestamp belongs to each record with message fallback and invalid usage warnings', async t => {
  const root = await temporary(t); const path = join(root, 'a.jsonl');
  const a = message('a', 10, { timestamp: '2026-11-07T10:00:00Z' });
  const b = message('b', 20); delete (b as { timestamp?: string }).timestamp;
  await session(path, [a, b, message('bad-time', 99, { timestamp: 'invalid' }),
    { type: 'usage', timestamp: time, usage: { input: -1 } },
    { type: 'message', timestamp: time, message: { role: 'assistant' } }],
    { ...header, timestamp: '2020-01-01T00:00:00Z' });
  const r = await readUsageFile(path);
  assert.equal(r.records[0].timestamp, Date.parse('2026-11-07T10:00:00Z'));
  assert.equal(r.records[1].timestamp, Date.parse(time));
  assert.equal(r.records.length, 2); assert.ok(r.warnings.length > 0);
});
test('recover malformed lines and append partial UTF-8 lines exactly once', async t => {
  const root = await temporary(t); const path = join(root, 'a.jsonl');
  const raw = Buffer.from(JSON.stringify(message('中文', 12)));
  const split = raw.indexOf(Buffer.from('你')) + 1;
  await writeFile(path, JSON.stringify(header) + '\r\n\r\nnot json\n');
  await appendFile(path, raw.subarray(0, split));
  const before = await readUsageFile(path);
  assert.equal(before.records.length, 0); assert.ok(before.warnings.length > 0);
  await appendFile(path, Buffer.concat([raw.subarray(split), Buffer.from('\n')]));
  const after = await readUsageFile(path, before);
  assert.equal(after.records.length, 1); assert.equal(after.records[0].usage.totalTokens, 12);
});
test('empty in-memory session root never expands to the current working directory', async t => {
  const root = await temporary(t); await session(join(root, 'not-selected.jsonl'), [message()]);
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.deepEqual((await discoverFiles([''])).files, []);
  } finally { process.chdir(cwd); }
});

test('provider attribution uses only the usage entry itself, never adjacent model selection', async t => {
  const root = await temporary(t), path = join(root, 'providers.jsonl');
  const assistant = message('assistant', 10);
  const missing = message('missing', 20);
  delete (missing.message as { provider?: string }).provider;
  await session(path, [
    { type: 'model_change', provider: 'not-the-source', modelId: 'm', timestamp: time },
    assistant,
    { type: 'usage', timestamp: time, provider: ' custom ', usage: { input: 30 } },
    missing,
    { type: 'compaction', timestamp: time, usage: { output: 40 } },
    { type: 'branch_summary', timestamp: time, provider: 'summary-provider', usage: { output: 50 } },
    { type: 'message', timestamp: time, message: { role: 'toolResult', toolName: 'classify', provider: 'classifier', usage: { input: 60 } } },
  ]);
  const snapshot = await readUsageFile(path);
  assert.deepEqual(snapshot.records.map(r => r.provider),
    ['provider-a', 'custom', undefined, undefined, 'summary-provider', 'classifier']);
});

test('invalid provider values keep valid usage unattributed', async t => {
  const root = await temporary(t), path = join(root, 'providers.jsonl');
  await session(path, [null, 42, '', '  '].map((provider, i) =>
    ({ type: 'usage', id: String(i), timestamp: time, provider, usage: { input: 1 } })));
  const snapshot = await readUsageFile(path);
  assert.equal(snapshot.records.length, 4);
  assert.ok(snapshot.records.every(r => r.provider === undefined));
});

test('reader retains explicit source models without inheriting model selection', async t => {
  const root = await temporary(t), path = join(root, 'models.jsonl');
  const missing = message('missing', 20);
  delete (missing.message as { model?: string }).model;
  await session(path, [
    { type: 'model_change', timestamp: time, provider: 'selected', modelId: 'must-not-inherit' },
    message('a', 10),
    { type: 'usage', timestamp: time, model: ' local-model ', usage: { input: 30 } },
    missing,
    { type: 'compaction', timestamp: time, model: 'compact-model', usage: { output: 40 } },
    { type: 'branch_summary', timestamp: time, model: 'branch-model', usage: { output: 50 } },
    { type: 'message', timestamp: time, message: { role: 'toolResult', toolName: 'classify', model: 'tool-model', usage: { input: 60 } } },
  ]);
  const snapshot = await readUsageFile(path);
  assert.deepEqual(snapshot.records.map(r => r.model),
    ['model-a', 'local-model', undefined, 'compact-model', 'branch-model', 'tool-model']);
});

test('invalid model metadata preserves valid usage with unknown model attribution', async t => {
  const root = await temporary(t), path = join(root, 'models.jsonl');
  await session(path, [null, 42, '', ' '].map((model, i) =>
    ({ type: 'usage', id: String(i), timestamp: time, model, usage: { input: 1 } })));
  const snapshot = await readUsageFile(path);
  assert.equal(snapshot.records.length, 4);
  assert.ok(snapshot.records.every(r => r.model === undefined));
});

test('empty or missing discovery root is a valid empty scan', async t => {
  const root = await temporary(t);
  assert.deepEqual((await discoverFiles([join(root, 'missing')])).files, []);
});
