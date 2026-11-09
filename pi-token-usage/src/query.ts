import { createHash } from 'node:crypto';
import type { ModelUsage, TimeRange, TokenUsage, UsageRecord, UsageReport } from './types.ts';

export function parseRange(args: string, now: number): TimeRange {
  const match = /^([1-9]\d*)([hd])$/.exec(args.trim());
  if (!match) throw new RangeError('用法：/token xh 或 /token xd（x 为正整数）');
  const amount = Number(match[1]);
  const unit = match[2] as 'h' | 'd';
  const duration = amount * (unit === 'h' ? 3600000 : 86400000);
  const start = now - duration;
  if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(start) || !Number.isFinite(new Date(start).getTime())) {
    throw new RangeError('查询时长超出可表示范围');
  }
  return { start, end: now, amount, unit };
}

export function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  if (!fields.some(k => obj[k] !== undefined)) return;
  if (fields.some(k => obj[k] !== undefined && (typeof obj[k] !== 'number' ||
      !Number.isSafeInteger(obj[k]) || (obj[k] as number) < 0))) return;
  const usage = Object.fromEntries(fields.map(k => [k, obj[k] ?? 0])) as unknown as TokenUsage;
  usage.totalTokens = (obj.totalTokens as number | undefined) ??
    (usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
  if (!Number.isSafeInteger(usage.totalTokens)) return;
  return usage;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().filter(k => obj[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export function recordKey(entry: unknown): string {
  // Pi can re-chain copied entries around removed labels without new consumption.
  let identity = entry;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const { parentId: _parent, firstKeptEntryId: _kept, fromId: _from, ...event } = entry as Record<string, unknown>;
    identity = event;
  }
  return createHash('sha256').update(canonical(identity)).digest('hex');
}

export function cacheHitRate(usage: TokenUsage): number | undefined {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return inputTokens > 0 ? usage.cacheRead / inputTokens : undefined;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}
function addUsage(target: TokenUsage, usage: TokenUsage): void {
  for (const field of Object.keys(target) as (keyof TokenUsage)[]) {
    target[field] += usage[field];
    if (!Number.isSafeInteger(target[field])) throw new RangeError('用量总和超出安全整数范围');
  }
}

function compareName(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

export function modelKey(provider: string | undefined, model: string | undefined): string {
  return JSON.stringify([provider ?? null, model ?? null]);
}

export function aggregate(records: UsageRecord[], range: TimeRange, warnings: string[] = []): UsageReport {
  const usage = emptyUsage(), groups = new Map<string, ModelUsage>();
  const seen = new Set<string>();
  for (const r of records) {
    if (r.timestamp < range.start || r.timestamp > range.end || seen.has(r.key)) continue;
    seen.add(r.key);
    addUsage(usage, r.usage);
    const key = modelKey(r.provider, r.model);
    let group = groups.get(key);
    if (!group) {
      group = { provider: r.provider, model: r.model, usage: emptyUsage(), recordCount: 0 };
      groups.set(key, group);
    }
    addUsage(group.usage, r.usage);
    group.recordCount++;
  }
  const models = [...groups.values()].filter(g => Object.values(g.usage).some(n => n > 0)).sort((a, b) => {
    const difference = b.usage.totalTokens - a.usage.totalTokens;
    const complete = (g: ModelUsage) => Number(g.provider !== undefined && g.model !== undefined);
    return difference || complete(b) - complete(a) || compareName(a.provider, b.provider) || compareName(a.model, b.model);
  });
  return { range, usage, models, warnings: [...new Set(warnings)], recordCount: seen.size };
}
