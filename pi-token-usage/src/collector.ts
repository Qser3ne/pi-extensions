import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { loadSnapshot, saveSnapshot } from './cache.ts';
import { aggregate, recordKey } from './query.ts';
import { discoverFiles, readUsageFile, type FileSnapshot } from './reader.ts';
import { reconcileSubagents } from './subagents.ts';
import type { TimeRange, UsageRecord, UsageReport } from './types.ts';

export async function collectUsage(options: { roots: string[]; cacheDir: string; range: TimeRange }): Promise<UsageReport> {
  const discovery = await discoverFiles(options.roots);
  const warnings = [...discovery.warnings], records: UsageRecord[] = [];
  const available = new Set<string>();
  const snapshots: FileSnapshot[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < discovery.files.length) {
      const path = discovery.files[next++];
      let cached;
      try { cached = await loadSnapshot(options.cacheDir, path); }
      catch { warnings.push('部分缓存无法读取，已回退会话扫描'); }
      try {
        const snapshot = await readUsageFile(path, cached);
        if (snapshot.headerValid) available.add(path);
        snapshots.push(snapshot);
        records.push(...snapshot.records); warnings.push(...snapshot.warnings);
        try { if (snapshot !== cached) await saveSnapshot(options.cacheDir, snapshot); }
        catch { warnings.push('部分缓存无法写入，本次统计仍有效；下次可能重新扫描'); }
      } catch (error) {
        warnings.push(`无法完整扫描会话：${path}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, discovery.files.length) }, () => worker()));
  const aliases: [string, string][] = [];
  for (const root of options.roots) {
    if (!root) continue;
    try { aliases.push([resolve(root), await realpath(root)]); } catch { /* Discovery already reports inaccessible roots. */ }
  }
  aliases.sort((a, b) => b[0].length - a[0].length);
  const canonicalRef = (path: string): string => {
    for (const [from, to] of aliases) if (path === from || path.startsWith(from + sep)) return to + path.slice(from.length);
    return path;
  };
  const bySource = new Map(snapshots.map(s => [s.path, s]));
  const inherited = new Map<string, Set<string>>();
  for (const s of snapshots) {
    const parent = s.parentSource ? bySource.get(canonicalRef(s.parentSource)) : undefined;
    if (parent) inherited.set(s.path, new Set(parent.records.map(r => r.key)));
  }
  // Keep pre-window history for coverage, but never let a post-cutoff
  // cumulative snapshot replace one eligible for this fixed query endpoint.
  const normalized = records.filter(r => r.timestamp <= options.range.end).map(r => {
    const childRefs = r.childRefs?.map(canonicalRef);
    return { ...r, inherited: r.inherited || inherited.get(r.source)?.has(r.key), childRefs,
      summaryKey: childRefs?.length ? recordKey([...new Set(childRefs)].sort()) : r.summaryKey };
  });
  const reconciled = reconcileSubagents(normalized, available);
  return aggregate(reconciled.records, options.range, [...warnings, ...reconciled.warnings]);
}
