import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeUsage, recordKey } from './query.ts';
import type { FileSnapshot } from './reader.ts';
export { SnapshotCache } from './memory-cache.ts';

function cachePath(dir: string, path: string): string { return join(dir, recordKey(path) + '.json'); }
function valid(value: unknown, path: string): value is FileSnapshot {
  const v = value as FileSnapshot;
  if (!v || v.version !== 4 || v.path !== path || typeof v.headerValid !== 'boolean' ||
      typeof v.boundaryHash !== 'string' || typeof v.prefixHash !== 'string') return false;
  for (const field of ['device', 'inode', 'size', 'offset', 'mtimeMs', 'ctimeMs'] as const) {
    if (typeof v[field] !== 'number' || !Number.isFinite(v[field]) || v[field] < 0) return false;
  }
  if (!Number.isSafeInteger(v.offset) || !Number.isSafeInteger(v.size) || v.offset > v.size) return false;
  if ((v.parentSource !== undefined && typeof v.parentSource !== 'string') ||
      (v.startedAt !== undefined && !Number.isFinite(v.startedAt))) return false;
  if (!Array.isArray(v.warnings) || !v.warnings.every(w => typeof w === 'string') || !Array.isArray(v.records)) return false;
  return v.records.every(r => r && typeof r.key === 'string' && typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) &&
    r.source === path && typeof r.kind === 'string' && !!normalizeUsage(r.usage) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(k => typeof (r.usage as any)[k] === 'number') &&
    (r.provider === undefined || (typeof r.provider === 'string' && r.provider.length > 0 && r.provider === r.provider.trim())) &&
    (r.model === undefined || (typeof r.model === 'string' && r.model.length > 0 && r.model === r.model.trim())) &&
    (r.toolName === undefined || typeof r.toolName === 'string') &&
    (r.inherited === undefined || typeof r.inherited === 'boolean') &&
    (r.summaryKey === undefined || typeof r.summaryKey === 'string') &&
    (r.childRefs === undefined || (Array.isArray(r.childRefs) && r.childRefs.every(p => typeof p === 'string'))));
}
export async function loadSnapshot(cacheDir: string, path: string): Promise<FileSnapshot | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(cachePath(cacheDir, path), 'utf8'));
    return valid(value, path) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export async function saveSnapshot(cacheDir: string, snapshot: FileSnapshot): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const target = cachePath(cacheDir, snapshot.path);
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
