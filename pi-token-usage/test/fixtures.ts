import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
export const time = '2026-11-08T12:00:00.000Z';
export const header = { type: 'session', version: 3, id: 'session-a', cwd: '/project', timestamp: time };
export function message(id = 'one', tokens = 10, extra: Record<string, unknown> = {}) {
  return { type: 'message', id, parentId: null, timestamp: time,
    message: { role: 'assistant', provider: 'provider-a', model: 'model-a', content: [{ type: 'text', text: 'PRIVATE-BODY-你好' }],
      timestamp: Date.parse(time), usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens } }, ...extra };
}
export async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-token-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function session(path: string, entries: unknown[], sessionHeader = header) {
  await writeFile(path, [sessionHeader, ...entries].map(v => JSON.stringify(v)).join('\n') + '\n');
}
