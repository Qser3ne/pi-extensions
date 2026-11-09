import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';
import { temporary, session, message } from './fixtures.ts';

function host(mode = 'tui', sessionDir = '/nonexistent') {
  const commands = new Map<string, any>(), renderers = new Map<string, any>(), events = new Map<string, any>();
  const entries: any[] = [], notices: string[] = [], noticeLevels: string[] = [];
  const pi = {
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerEntryRenderer: (name: string, renderer: unknown) => renderers.set(name, renderer),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    on: (name: string, handler: unknown) => events.set(name, handler),
    sendMessage: () => { throw new Error('must not send context'); },
    sendUserMessage: () => { throw new Error('must not call model'); },
  } as unknown as ExtensionAPI;
  const ctx = { mode, hasUI: mode === 'tui' || mode === 'rpc',
    sessionManager: { getSessionDir: () => sessionDir },
    ui: { notify: (text: string, level = 'info') => { notices.push(text); noticeLevels.push(level); } },
  } as unknown as ExtensionCommandContext;
  extension(pi);
  return { pi, ctx, commands, renderers, events, entries, notices, noticeLevels,
    run: (arg: string) => commands.get('tokens').handler(arg, ctx) };
}
test('register only tokens and invalid inputs show usage without scanning or invoking models', async t => {
  const root = await temporary(t); process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const h = host();
  assert.deepEqual([...h.commands.keys()], ['tokens']);
  for (const arg of ['', '15', 'help', '0d', '1w']) await h.run(arg);
  assert.equal(h.entries.length, 0); assert.match(h.notices.join(' '), /tokens xh/);
  assert.deepEqual(await readdir(root), []);
});
test('query all agent and current custom-session roots into durable context-free report', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'), custom = join(root, 'custom');
  await mkdir(sources); await mkdir(custom);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const now = new Date().toISOString();
  await session(join(sources, 'a.jsonl'), [message('a', 10000, { timestamp: now })]);
  await session(join(custom, 'b.jsonl'), [message('b', 2345, { timestamp: now })]);
  const h = host('tui', custom); await h.run('24h');
  assert.equal(h.entries.length, 1); assert.equal(h.entries[0].type, 'pi-token-usage.report');
  assert.equal(h.entries[0].data.usage.totalTokens, 12345);
  const renderer = h.renderers.get('pi-token-usage.report');
  const component = renderer({ data: h.entries[0].data }, {}, { fg: (_: unknown, text: string) => text });
  const rendered = component.render(120).join('\n');
  for (const text of ['12,345', '输入', '输出', '缓存读取', '缓存写入', '所有渠道']) assert.ok(rendered.includes(text), text);
  assert.equal(rendered.includes('来源：'), false);
});
test('used model pairs render in TUI and RPC while hidden diagnostics remain in saved report data', async t => {
  const root = await temporary(t), sources = join(root, 'sessions');
  await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const now = new Date().toISOString();
  const a = message('a', 0, { timestamp: now }), b = message('b', 0, { timestamp: now });
  a.message.provider = 'alpha'; a.message.usage = { input: 10, output: 10, cacheRead: 90, cacheWrite: 0, totalTokens: 110 };
  b.message.provider = 'beta'; b.message.usage = { input: 90, output: 1000, cacheRead: 0, cacheWrite: 810, totalTokens: 1900 };
  const c = message('c', 0, { timestamp: now }); c.message.provider = 'alpha'; c.message.model = 'model-b';
  c.message.usage = { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };
  const zero = message('zero', 0, { timestamp: now }); zero.message.model = 'unused-model';
  const path = join(sources, 'models.jsonl');
  await session(path, [a, b, c, zero]); await appendFile(path, '{"unfinished":');
  for (const mode of ['tui', 'rpc']) {
    const h = host(mode, sources); await h.run('24h');
    const data = h.entries[0].data;
    assert.ok(data.warnings.some((w: string) => w.includes('末行尚未写完')));
    assert.deepEqual(data.models?.map((g: any) => [g.provider, g.model]),
      [['beta', 'model-a'], ['alpha', 'model-a'], ['alpha', 'model-b']]);
    const renderer = h.renderers.get('pi-token-usage.report');
    const rendered = renderer({ data }, {}, { fg: (_: unknown, text: string) => text }).render(120).join('\n');
    for (const text of ['总计：2,020', 'alpha/model-a', 'beta/model-a', 'alpha/model-b', '缓存命中率：9.00%', '缓存命中率：90.00%', '缓存命中率：0.00%'])
      assert.ok(rendered.includes(text), text);
    for (const text of ['数据存在缺失或不精确部分', '末行尚未写完', 'unused-model', '按 provider 统计', '来源：'])
      assert.equal(rendered.includes(text), false, text);
    if (mode === 'rpc') {
      assert.ok(h.notices.at(-1)?.includes('缓存命中率：9.00%'));
      assert.equal(h.notices.at(-1)?.includes('末行尚未写完'), false);
      assert.equal(h.notices.at(-1)?.includes('来源：'), false);
      assert.equal(h.noticeLevels.at(-1), 'info');
    }
    const { models: _models, ...old } = data;
    const oldRendered = renderer({ data: old }, {}, { fg: (_: unknown, text: string) => text }).render(120).join('\n');
    assert.ok(oldRendered.includes('总计：2,020'));
    assert.equal(oldRendered.includes('按模型统计'), false);
    assert.equal(oldRendered.includes('按 provider 统计'), false);
    await h.run('24h');
    assert.deepEqual(h.entries[1].data.usage, data.usage);
    assert.deepEqual(h.entries[1].data.models, data.models);
  }
});

test('extension instances retain independent warm snapshots rather than global state', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'); await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  await session(join(sources, 's.jsonl'), [message('a', 10, { timestamp: new Date().toISOString() })]);
  const first = host('rpc', sources); await first.run('1h');
  const cacheDir = join(root, 'pi-token-usage', 'cache-v1');
  const disk = join(cacheDir, (await readdir(cacheDir))[0]), saved = disk + '.saved';
  await rename(disk, saved); await mkdir(disk);
  try {
    await first.run('1h');
    assert.equal(first.entries[1].data.warnings.some((w: string) => w.includes('缓存无法读取')), false);
    const second = host('rpc', sources); await second.run('1h');
    assert.equal(second.entries[0].data.usage.totalTokens, 10);
    assert.ok(second.entries[0].data.warnings.some((w: string) => w.includes('缓存无法读取')));
  } finally { await rm(disk, { recursive: true }); await rename(saved, disk); }
});

test('invalid arguments still warn and true collection failures remain errors', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'); await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const h = host('rpc', sources);
  await h.run('invalid');
  assert.equal(h.noticeLevels.at(-1), 'warning');
  const now = new Date().toISOString();
  await session(join(sources, 'overflow.jsonl'), [
    message('huge', Number.MAX_SAFE_INTEGER, { timestamp: now }),
    message('one', 1, { timestamp: now }),
  ]);
  await h.run('24h');
  assert.equal(h.entries.length, 0);
  assert.match(h.notices.at(-1)!, /用量查询失败/);
  assert.equal(h.noticeLevels.at(-1), 'error');
});

test('rpc displays text notification and session shutdown suppresses stale query output', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'); await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const h = host('rpc', sources); await h.run('7d');
  assert.equal(h.entries[0].data.usage.totalTokens, 0);
  assert.match(h.notices.join(' '), /总计：0/);
  const late = host('tui', sources);
  const pending = late.run('1h'); late.events.get('session_shutdown')();
  await pending; assert.equal(late.entries.length, 0);
});
