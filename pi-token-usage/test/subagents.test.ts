import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { extractChildSummary, reconcileSubagents, splitSummary } from '../src/subagents.ts';
import { readUsageFile } from '../src/reader.ts';
import { aggregate, parseRange } from '../src/query.ts';
import { message, session, temporary, time } from './fixtures.ts';
import type { UsageRecord } from '../src/types.ts';
const range = parseRange('7d', Date.parse(time));
const usage = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n });
const record = (key: string, source: string, n: number): UsageRecord => ({ key, source, usage: usage(n), timestamp: range.end, kind: 'assistant' });
const summary = (key: string, refs: string[], n: number): UsageRecord => ({ ...record(key, '/parent', n), kind: 'toolResult', toolName: 'subagent', childRefs: refs, summaryKey: refs.join('|') });

test('subagent summaries do not inherit the parent provider when split or kept whole', () => {
  const parent = { ...summary('p', ['/child'], 30), provider: 'parent-provider', model: 'parent-model' };
  const messages = [
    { toolName: 'subagent', details: { results: [{ sessionFile: '/child', usage: usage(30) }] } },
    { toolName: 'bg_wait', details: { completions: [{ results: [{ sessionFile: '/child' }] }] } },
  ];
  for (const message of messages) {
    const records = splitSummary(parent, message);
    assert.equal(records[0].provider, undefined);
    assert.equal(records[0].model, undefined);
    assert.equal(records[0].usage.totalTokens, 30);
  }
});

test('missing child residual is unknown while known child keeps its own provider', () => {
  const child = { ...record('c', '/child', 10), provider: 'child-provider', model: 'child-model' };
  const parent = { ...summary('s', ['/child'], 30), provider: 'parent-provider', model: 'parent-model' };
  const result = reconcileSubagents([child, parent], new Set(['/child', '/parent']));
  assert.equal(result.records.find(r => r.key === 'c')?.provider, 'child-provider');
  assert.equal(result.records.find(r => r.key === 'c')?.model, 'child-model');
  const residual = result.records.find(r => r.key.startsWith('residual:'));
  assert.equal(residual?.usage.totalTokens, 20);
  assert.equal(residual?.provider, undefined);
  assert.equal(residual?.model, undefined);
});

test('fork and clone shared history count once but new branches remain', async t => {
  const root = await temporary(t), a = join(root, 'a.jsonl'), b = join(root, 'b.jsonl');
  await session(a, [message('shared', 10), message('original', 20)]);
  await session(b, [message('shared', 10), message('fork', 30)]);
  const all = [...(await readUsageFile(a)).records, ...(await readUsageFile(b)).records];
  assert.equal(aggregate(all, range).usage.totalTokens, 60);
});
test('recognize public foreground and bg_wait child references', () => {
  const child = { agent: 'worker', sessionFile: '/child', usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
  for (const message of [
    { toolName: 'subagent', details: { mode: 'single', results: [child] } },
    { toolName: 'bg_wait', details: { completions: [{ runId: 'r1', results: [child] }] } },
  ]) assert.deepEqual(extractChildSummary(message, '/parent').childRefs, ['/child']);
  assert.equal(extractChildSummary({ toolName: 'bash', details: { sessionFile: '/secret' } }, '/parent').recognized, false);
});
test('child transcript replaces parent aggregate and repeated waits do not inflate', () => {
  const records = [{ ...record('child', '/child', 10), timestamp: range.end - 2 },
    { ...summary('s1', ['/child'], 10), timestamp: range.end - 1 },
    { ...summary('s2', ['/child'], 10), timestamp: range.end - 1 }, record('new', '/child', 5)];
  const result = reconcileSubagents(records, new Set(['/child', '/parent']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 15);
  assert.match(result.warnings.join(' '), /调用边界/);
});
test('missing child summaries count once at summary time with warning', () => {
  const result = reconcileSubagents([summary('s1', ['/missing'], 10), summary('s2', ['/missing'], 10)], new Set(['/parent']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 10);
  assert.match(result.warnings.join(' '), /不精确/);
});
test('partial child coverage adds only missing residual, not the full aggregate again', () => {
  const result = reconcileSubagents([record('c1', '/child', 10), summary('s1', ['/child', '/missing'], 30)], new Set(['/child', '/parent']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 30);
  assert.ok(result.warnings.length > 0);
});
test('unknown nested tools keep usage and unrecognized subagent overlaps warn', () => {
  const ordinary = { ...record('tool', '/parent', 7), kind: 'toolResult', toolName: 'classify' };
  const unknown = { ...record('unknown', '/parent', 11), kind: 'toolResult', toolName: 'subagent' };
  const result = reconcileSubagents([ordinary, unknown], new Set(['/parent']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 18);
  assert.ok(result.warnings.length > 0);
});
test('inherited fork history and unrelated tool usage cannot hide missing attempt-owned assistant usage', () => {
  const inherited = record('inherited', '/parent', 100);
  const copied = { ...inherited, source: '/child', inherited: true };
  const unrelated = { ...record('cache', '/child', 50), kind: 'usage' };
  const result = reconcileSubagents([inherited, copied, record('own', '/child', 10), unrelated, summary('s', ['/child'], 30)], new Set(['/parent', '/child']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 180);
  assert.match(result.warnings.join(' '), /不精确/);
});

test('prior resumed-attempt usage cannot silently prove a partial later attempt complete', () => {
  const result = reconcileSubagents([record('prior-attempt', '/child', 100), record('current-partial', '/child', 10), summary('s', ['/child'], 30)], new Set(['/child', '/parent']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 110);
  assert.match(result.warnings.join(' '), /调用边界/);
});

test('native nested summaries cover own assistant usage, not descendant tokens', () => {
  const records = [record('child-own', '/child', 10), record('grandchild-own', '/grandchild', 20),
    { ...summary('grandchild-summary', ['/grandchild'], 20), source: '/child' }, summary('child-summary', ['/child'], 10)];
  const result = reconcileSubagents(records, new Set(['/parent', '/child', '/grandchild']));
  assert.equal(aggregate(result.records, range).usage.totalTokens, 30);
  assert.deepEqual(result.warnings, []);
});

test('reader marks copied fork history as inherited for attempt coverage', async t => {
  const root = await temporary(t), path = join(root, 'fork.jsonl');
  const started = '2026-11-08T12:00:01.000Z';
  await session(path, [message('inherited', 100), message('own', 10, { timestamp: '2026-11-08T12:00:02.000Z' })],
    { type: 'session', version: 3, id: 'child', cwd: root, timestamp: started, parentSession: '/parent' } as any);
  const r = await readUsageFile(path);
  assert.equal(r.records[0].inherited, true);
  assert.notEqual(r.records[1].inherited, true);
});

test('reader preserves recognized summary identity without storing details bodies', async t => {
  const root = await temporary(t), path = join(root, 'p.jsonl');
  await session(path, [{ type: 'message', id: 'tool', timestamp: time, message: {
    role: 'toolResult', toolName: 'subagent', usage: usage(10), details: { results: [{ sessionFile: '/child', finalOutput: 'PRIVATE-BODY' }] }
  } }]);
  const r = await readUsageFile(path);
  assert.deepEqual(r.records[0].childRefs, ['/child']);
  assert.equal(JSON.stringify(r).includes('PRIVATE-BODY'), false);
});
