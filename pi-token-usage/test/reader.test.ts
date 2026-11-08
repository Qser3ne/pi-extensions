import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
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

test('empty or missing discovery root is a valid empty scan', async t => {
  const root = await temporary(t);
  assert.deepEqual((await discoverFiles([join(root, 'missing')])).files, []);
});
