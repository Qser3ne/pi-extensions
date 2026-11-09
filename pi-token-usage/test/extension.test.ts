import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
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
  for (const text of ['12,345', '输入', '输出', '缓存读取', '缓存写入', '所有渠道', '本机 Pi 已保存记录']) assert.ok(rendered.includes(text), text);
});
test('provider rates render in TUI and RPC while hidden diagnostics remain in saved report data', async t => {
  const root = await temporary(t), sources = join(root, 'sessions');
  await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const now = new Date().toISOString();
  const a = message('a', 0, { timestamp: now }), b = message('b', 0, { timestamp: now });
  a.message.provider = 'alpha'; a.message.usage = { input: 10, output: 10, cacheRead: 90, cacheWrite: 0, totalTokens: 110 };
  b.message.provider = 'beta'; b.message.usage = { input: 90, output: 1000, cacheRead: 0, cacheWrite: 810, totalTokens: 1900 };
  const path = join(sources, 'providers.jsonl');
  await session(path, [a, b]); await appendFile(path, '{"unfinished":');
  for (const mode of ['tui', 'rpc']) {
    const h = host(mode, sources); await h.run('24h');
    const data = h.entries[0].data;
    assert.ok(data.warnings.some((w: string) => w.includes('末行尚未写完')));
    assert.deepEqual(data.providers.map((p: any) => p.provider), ['beta', 'alpha']);
    const renderer = h.renderers.get('pi-token-usage.report');
    const rendered = renderer({ data }, {}, { fg: (_: unknown, text: string) => text }).render(120).join('\n');
    for (const text of ['总计：2,010', 'alpha', 'beta', '缓存命中率：9.00%', '缓存命中率：90.00%', '缓存命中率：0.00%'])
      assert.ok(rendered.includes(text), text);
    for (const text of ['数据存在缺失或不精确部分', '末行尚未写完'])
      assert.equal(rendered.includes(text), false, text);
    if (mode === 'rpc') {
      assert.ok(h.notices.at(-1)?.includes('缓存命中率：9.00%'));
      assert.equal(h.notices.at(-1)?.includes('末行尚未写完'), false);
      assert.equal(h.noticeLevels.at(-1), 'info');
    }
    const { providers: _providers, ...old } = data;
    const oldRendered = renderer({ data: old }, {}, { fg: (_: unknown, text: string) => text }).render(120).join('\n');
    assert.ok(oldRendered.includes('总计：2,010'));
    assert.equal(oldRendered.includes('按 provider 统计'), false);
    await h.run('24h');
    assert.deepEqual(h.entries[1].data.usage, data.usage);
    assert.deepEqual(h.entries[1].data.providers, data.providers);
  }
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
