import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { message, session, temporary } from './fixtures.ts';
import { readUsageFile } from '../src/reader.ts';
import { aggregate, parseRange } from '../src/query.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const repo = fileURLToPath(new URL('..', import.meta.url));

test('npm package contains the executable extension and user documentation without tests or dependencies', async t => {
  const root = await temporary(t);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--cache', join(root, 'npm-cache')], { cwd: repo, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const files: string[] = JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path);
  assert.ok(files.includes('src/index.ts')); assert.ok(files.includes('README.md'));
  assert.ok(files.includes('docs/verification.md'));
  assert.equal(files.some(path => path.startsWith('test/') || path.startsWith('node_modules/')), false);
});

test('actual Pi labeled branching does not duplicate reparented assistant or compaction usage', async t => {
  const root = await temporary(t);
  const sm = SessionManager.create(root, root);
  const user = sm.appendMessage({ role: 'user', content: 'hello', timestamp: Date.now() });
  sm.appendLabelChange(user, 'label');
  const assistant = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }],
    api: 'openai-responses', provider: 'provider-a', model: 'model-a', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const original = sm.getSessionFile()!;
  const branched = sm.createBranchedSession(assistant)!;
  const all = [...(await readUsageFile(original)).records, ...(await readUsageFile(branched)).records];
  assert.equal(aggregate(all, parseRange('1d', Date.now())).usage.totalTokens, 20);
});

test('live RPC token commands filter current scoped model pairs without starting an agent turn', { timeout: 20000 }, async t => {
  const root = await temporary(t), agent = join(root, 'agent'), sources = join(agent, 'sessions');
  await mkdir(sources, { recursive: true });
  const providers = Object.fromEntries(['provider-a', 'provider-b', 'provider-c'].map(provider => [provider, {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-not-a-real-key',
    models: [{ id: 'model-a', name: 'Fixture model', reasoning: false, input: ['text'],
      contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  }]));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers }));
  const now = new Date().toISOString();
  const a = message('rpc-a', 103, { timestamp: now }), b = message('rpc-b', 20, { timestamp: now });
  a.message.usage = { input: 3, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 103 };
  b.message.provider = 'provider-b';
  const fixture = join(sources, 'fixture.jsonl');
  const zero = message('zero', 0, { timestamp: now }); zero.message.model = 'unused-model';
  const old = message('old', 999, { timestamp: new Date(Date.parse(now) - 48 * 3600000).toISOString() });
  old.message.model = 'old-model';
  const excluded = message('removed-provider', 700, { timestamp: now }); excluded.message.provider = 'provider-c';
  await session(fixture, [a, b, zero, old, excluded]); await appendFile(fixture, '{"unfinished":');
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'cli.js');
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--provider', 'provider-a', '--model', 'model-a',
    '--models', 'provider-a/model-a,provider-b/model-a', '--no-session', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-tools', '--no-themes', '-e', join(repo, 'src/index.ts')],
    { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const records: any[] = []; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const record = JSON.parse(line); records.push(record);
      if (record.type === 'response' && record.id === 'commands') {
        const names = new Set(record.data?.commands?.map((command: any) => command.name));
        // Never send an unknown slash command: it could otherwise be treated as a model prompt.
        if (names.has('token') && names.has('token-usage'))
          child.stdin.write(JSON.stringify({ id: 'shortcut', type: 'prompt', message: '/token-usage' }) + '\n');
        else child.stdin.end();
      }
      if (record.type === 'response' && record.id === 'shortcut')
        child.stdin.write(JSON.stringify({ id: 'query', type: 'prompt', message: '/token 24h' }) + '\n');
      if (record.type === 'response' && record.id === 'query') child.stdin.end();
    } catch { /* Final assertions reject missing protocol responses. */ }
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('RPC deadline: ' + stderr)); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
  assert.equal(await exit, 0, stderr);
  assert.ok(records.some(r => r.type === 'response' && r.id === 'query' && r.success === true), JSON.stringify(records));
  assert.ok(records.some(r => r.type === 'response' && r.id === 'shortcut' && r.success === true), JSON.stringify(records));
  const reports = records.filter(r => r.type === 'extension_ui_request' && r.method === 'notify' && String(r.message).includes('总计：123'));
  assert.equal(reports.length, 2, JSON.stringify(records));
  const report = reports[0];
  for (const current of reports) {
    assert.ok(current.message.includes('当前模型列表'));
    assert.equal(current.message.includes('provider-c'), false);
    assert.ok(current.message.includes('缓存命中率：81.30%'));
  }
  for (const text of ['按模型统计', 'provider-a/model-a', 'provider-b/model-a', '缓存命中率：81.30%', '缓存命中率：97.09%', '缓存命中率：0.00%'])
    assert.ok(report.message.includes(text), text);
  assert.equal(report.message.includes('数据存在缺失或不精确部分'), false);
  assert.equal(report.message.includes('末行尚未写完'), false);
  for (const text of ['unused-model', 'old-model', '按 provider 统计', '来源：']) assert.equal(report.message.includes(text), false);
  assert.equal(records.some(r => r.type === 'agent_start'), false);
});

test('production-only package loads through actual Pi bundled loader with token and token-usage only', async t => {
  const root = await temporary(t), pkg = join(root, 'package');
  await cp(join(repo, 'src'), join(pkg, 'src'), { recursive: true });
  await cp(join(repo, 'package.json'), join(pkg, 'package.json'));
  const bundle = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'index.js');
  const host = await import(pathToFileURL(bundle).href);
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  const entry = join(pkg, manifest.pi.extensions[0]);
  const loaded = await host.discoverAndLoadExtensions([entry], root, root);
  try {
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0].commands.keys()], ['token', 'token-usage']);
    assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 0);
    assert.equal(loaded.extensions[0].tools.size, 0);
  } finally { loaded.runtime.invalidate(); }
});
