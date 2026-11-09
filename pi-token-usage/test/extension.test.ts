import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';
import { temporary, session, message } from './fixtures.ts';

function fixtureModel(provider: string, id: string) {
  return { provider, id, name: id, api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1',
    reasoning: false, input: ['text'] as ['text'], contextWindow: 4096, maxTokens: 512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
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
  const catalog = { scoped: [] as ReturnType<typeof fixtureModel>[],
    available: [fixtureModel('provider-a', 'model-a'), fixtureModel('alpha', 'model-a'),
      fixtureModel('beta', 'model-a'), fixtureModel('alpha', 'model-b')] };
  const forbidden = () => { throw new Error('must not refresh, authenticate or invoke models'); };
  const ctx = { get scopedModels() { return catalog.scoped.map(model => ({ model })); },
    modelRegistry: { getAvailable: () => catalog.available, refresh: forbidden, getApiKey: forbidden,
      getApiKeyAndHeaders: forbidden, complete: forbidden, stream: forbidden, streamSimple: forbidden },
    mode, hasUI: mode === 'tui' || mode === 'rpc',
    sessionManager: { getSessionDir: () => sessionDir },
    ui: { notify: (text: string, level = 'info') => { notices.push(text); noticeLevels.push(level); } },
  } as unknown as ExtensionCommandContext;
  extension(pi);
  return { pi, ctx, catalog, commands, renderers, events, entries, notices, noticeLevels,
    run: (arg: string, command = 'token') => commands.get(command).handler(arg, ctx) };
}
test('register token and token-usage only; invalid inputs never scan or read model lists', async t => {
  const root = await temporary(t); process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const h = host();
  assert.deepEqual([...h.commands.keys()], ['token', 'token-usage']);
  Object.defineProperty(h.ctx, 'scopedModels', { get() { throw new Error('must not read invalid query scope'); } });
  for (const arg of ['', '15', 'help', '0d', '-1h', '1w']) await h.run(arg);
  assert.equal(h.entries.length, 0); assert.match(h.notices.join(' '), /token xh/);
  for (const arg of ['24h', '7d', 'extra']) await h.run(arg, 'token-usage');
  assert.match(h.notices.at(-1)!, /token-usage/);
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
  for (const text of ['12,345', '输入', '输出', '缓存读取', '缓存写入', '当前模型列表']) assert.ok(rendered.includes(text), text);
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

test('shortcut equals explicit 24h at a fixed clock', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'); await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const now = Date.parse('2026-11-09T12:00:00Z'); t.mock.method(Date, 'now', () => now);
  await session(join(sources, 's.jsonl'), [
    message('inside', 17, { timestamp: new Date(now - 12 * 3600000).toISOString() }),
    message('outside', 99, { timestamp: new Date(now - 25 * 3600000).toISOString() }),
  ]);
  const h = host('rpc', sources);
  await h.run('  ', 'token-usage'); await h.run('24h');
  for (const { data } of h.entries) {
    assert.deepEqual(data.range, { start: now - 86400000, end: now, amount: 24, unit: 'h' });
    assert.equal(data.usage.totalTokens, 17); assert.equal(data.recordCount, 1);
    assert.equal(data.scope, 'current-models');
  }
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.entries[0].data, h.entries[1].data);
});

test('current picker scope is read on every command without refreshing catalogues', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'); await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const a = message('a', 100, { timestamp: new Date().toISOString() });
  const b = message('b', 900, { timestamp: new Date().toISOString() }); b.message.provider = 'provider-b';
  await session(join(sources, 's.jsonl'), [a, b]);
  const h = host('rpc', sources);
  const A = fixtureModel('provider-a', 'model-a'), B = fixtureModel('provider-b', 'model-a');
  for (const command of ['token', 'token-usage']) {
    const args = command === 'token' ? '24h' : '';
    h.catalog.scoped = [A];
    h.ctx.modelRegistry.getAvailable = () => { throw new Error('nonempty scope must take priority'); };
    await h.run(args, command); assert.equal(h.entries.at(-1)?.data.usage.totalTokens, 100);
    h.catalog.scoped = [B];
    await h.run(args, command); assert.equal(h.entries.at(-1)?.data.usage.totalTokens, 900);
    h.catalog.scoped = []; h.catalog.available = [A, B];
    h.ctx.modelRegistry.getAvailable = () => h.catalog.available;
    await h.run(args, command); assert.equal(h.entries.at(-1)?.data.usage.totalTokens, 1000);
    h.catalog.available = [];
    await h.run(args, command);
    assert.equal(h.entries.at(-1)?.data.usage.totalTokens, 0);
    assert.deepEqual(h.entries.at(-1)?.data.models, []);
  }
  assert.equal(h.entries.length, 8);
});

test('registry and scope failures are query errors, never unfiltered fallbacks', async t => {
  const root = await temporary(t), sources = join(root, 'sessions'); await mkdir(sources);
  process.env.PI_CODING_AGENT_DIR = root; t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  await session(join(sources, 's.jsonl'), [message('a', 10, { timestamp: new Date().toISOString() })]);
  for (const command of ['token', 'token-usage']) for (const broken of ['scope', 'available']) {
    const h = host('rpc', sources);
    if (broken === 'scope') Object.defineProperty(h.ctx, 'scopedModels', { get() { throw new Error('scope unavailable'); } });
    else h.ctx.modelRegistry.getAvailable = () => { throw new Error('catalogue unavailable'); };
    await h.run(command === 'token' ? '24h' : '', command);
    assert.equal(h.entries.length, 0);
    assert.equal(h.noticeLevels.at(-1), 'error'); assert.match(h.notices.at(-1)!, /用量查询失败/);
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
