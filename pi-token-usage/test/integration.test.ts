import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { cp, mkdir, readFile } from 'node:fs/promises';
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

test('live Pi RPC executes tokens and exits without starting an agent turn', { timeout: 20000 }, async t => {
  const root = await temporary(t), agent = join(root, 'agent'), sources = join(agent, 'sessions');
  await mkdir(sources, { recursive: true });
  await session(join(sources, 'fixture.jsonl'), [message('rpc', 123, { timestamp: new Date().toISOString() })]);
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'cli.js');
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-tools', '--no-themes', '-e', join(repo, 'src/index.ts')],
    { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const records: any[] = []; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const record = JSON.parse(line); records.push(record);
      if (record.type === 'response' && record.id === 'query') child.stdin.end();
    } catch { /* Final assertions reject missing protocol responses. */ }
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('RPC deadline: ' + stderr)); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.write(JSON.stringify({ id: 'query', type: 'prompt', message: '/tokens 24h' }) + '\n');
  assert.equal(await exit, 0, stderr);
  assert.ok(records.some(r => r.type === 'response' && r.id === 'query' && r.success === true), JSON.stringify(records));
  assert.ok(records.some(r => r.type === 'extension_ui_request' && r.method === 'notify' && String(r.message).includes('总计：123')));
  assert.equal(records.some(r => r.type === 'agent_start'), false);
});

test('production-only package loads through actual Pi bundled loader with only tokens', async t => {
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
    assert.deepEqual([...loaded.extensions[0].commands.keys()], ['tokens']);
    assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 0);
    assert.equal(loaded.extensions[0].tools.size, 0);
  } finally { loaded.runtime.invalidate(); }
});
