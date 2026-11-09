import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { normalizeUsage, recordKey } from './query.ts';
import { splitSummary } from './subagents.ts';
import type { UsageRecord } from './types.ts';

export interface FileSnapshot {
  version: 4; path: string; device: number; inode: number; size: number;
  mtimeMs: number; ctimeMs: number; offset: number; boundaryHash: string; prefixHash: string;
  headerValid: boolean; parentSource?: string; startedAt?: number; records: UsageRecord[]; warnings: string[];
}
export async function discoverFiles(roots: string[]): Promise<{ files: string[]; warnings: string[] }> {
  const files = new Set<string>(), warnings: string[] = [], visited = new Set<string>();
  let pending: string[] = [];
  const enqueue = (path: string) => {
    if (!visited.has(path)) { visited.add(path); pending.push(path); }
  };
  for (const root of roots) {
    if (!root) continue;
    try { enqueue(await realpath(resolve(root))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`无法读取会话根目录：${root}`); }
  }
  while (pending.length) {
    const batch = pending; pending = [];
    let next = 0;
    async function worker(): Promise<void> {
      while (next < batch.length) {
        const path = batch[next++];
        try {
          // Recheck queued directories: their type may have changed since readdir.
          const stat = await lstat(path);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            for (const item of await readdir(path, { withFileTypes: true })) {
              const child = join(path, item.name);
              if (item.isDirectory()) enqueue(child);
              else if (item.isFile() && item.name.endsWith('.jsonl')) files.add(child);
            }
          } else if (stat.isFile() && path.endsWith('.jsonl')) files.add(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`无法读取会话路径：${path}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, batch.length) }, () => worker()));
  }
  return { files: [...files].sort(), warnings };
}

function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function extract(entry: Record<string, any>, source: string, warn: (text: string) => void): UsageRecord | undefined {
  const message = object(entry.message);
  const isMessage = entry.type === 'message' && (message?.role === 'assistant' || message?.role === 'toolResult');
  const isUsage = ['usage', 'compaction', 'branch_summary'].includes(entry.type);
  if (!isMessage && !isUsage) return;
  const value = isMessage ? message?.usage : entry.usage;
  if (value === undefined) {
    if (message?.role === 'assistant') warn('部分 assistant 记录缺少 usage，未估算');
    return;
  }
  const usage = normalizeUsage(value);
  if (!usage) { warn('部分记录的 usage 无效，已跳过'); return; }
  const timestamp = entry.timestamp === undefined ? message?.timestamp :
    typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : entry.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
    warn('部分用量记录时间无效，已跳过'); return;
  }
  const record: UsageRecord = { key: recordKey(entry), timestamp, usage, source,
    kind: isMessage ? message!.role : entry.type };
  for (const field of ['provider', 'model'] as const) {
    const value = isMessage ? message?.[field] : entry[field];
    if (typeof value === 'string' && value.trim()) record[field] = value.trim();
  }
  if (message?.role === 'toolResult' && typeof message.toolName === 'string') record.toolName = message.toolName;
  return record;
}

async function hashBytes(file: FileHandle, start: number, length: number): Promise<string> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, start);
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
}
export async function readUsageFile(path: string, previous?: FileSnapshot): Promise<FileSnapshot> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    const sameFile = previous?.version === 4 && previous.path === path && previous.device === stat.dev && previous.inode === stat.ino;
    if (sameFile && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs) return previous;
    const boundarySize = Math.min(previous?.offset ?? 0, 256);
    const prefixSize = Math.min(previous?.offset ?? 0, 4096);
    const append = sameFile && previous.headerValid && stat.size > previous.size && previous.offset <= previous.size &&
      await hashBytes(file, previous.offset - boundarySize, boundarySize) === previous.boundaryHash &&
      await hashBytes(file, 0, prefixSize) === previous.prefixHash;
    const snapshot: FileSnapshot = { version: 4, path, device: stat.dev, inode: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, offset: append ? previous.offset : 0, boundaryHash: '', prefixHash: '',
      headerValid: append ? previous.headerValid : false, parentSource: append ? previous.parentSource : undefined,
      startedAt: append ? previous.startedAt : undefined, records: append ? [...previous.records] : [], warnings: [] };
    const warnings = new Set<string>(append ? previous.warnings.filter(w => !w.includes('末行尚未写完')) : []);
    const warn = (text: string) => warnings.add(`${path}：${text}`);
    let pending = Buffer.alloc(0), first = !append;
    if (stat.size > snapshot.offset) {
      const stream = file.createReadStream({ start: snapshot.offset, end: stat.size - 1, autoClose: false });
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline).toString('utf8').trim();
          snapshot.offset += newline + 1;
          pending = pending.subarray(newline + 1);
          if (!line) continue;
          let entry: Record<string, any> | undefined;
          try { entry = object(JSON.parse(line)); }
          catch { warn('存在损坏 JSON 行，已跳过'); continue; }
          if (first) {
            first = false;
            snapshot.headerValid = entry?.type === 'session' && typeof entry.id === 'string';
            if (!snapshot.headerValid) break;
            if (typeof entry?.parentSession === 'string') snapshot.parentSource = resolve(dirname(path), entry.parentSession);
            const startedAt = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
            if (Number.isFinite(startedAt)) snapshot.startedAt = startedAt;
          } else if (entry) {
            const record = extract(entry, path, warn);
            if (record) {
              if (snapshot.parentSource && snapshot.startedAt !== undefined && record.timestamp <= snapshot.startedAt) record.inherited = true;
              snapshot.records.push(...splitSummary(record, entry.message));
            }
          }
        }
        if (!first && !snapshot.headerValid) break;
      }
    }
    if (pending.length && snapshot.headerValid) warn('末行尚未写完，本次未计入');
    if (snapshot.offset) {
      const length = Math.min(snapshot.offset, 256);
      snapshot.boundaryHash = await hashBytes(file, snapshot.offset - length, length);
      snapshot.prefixHash = await hashBytes(file, 0, Math.min(snapshot.offset, 4096));
    }
    const after = await file.stat();
    if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) {
      throw new Error('会话在扫描期间被重写，请重新查询');
    }
    snapshot.warnings = snapshot.headerValid ? [...warnings] : [];
    return snapshot;
  } finally { await file.close(); }
}
