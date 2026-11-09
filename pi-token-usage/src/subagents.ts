import { dirname, resolve } from 'node:path';
import { normalizeUsage, recordKey } from './query.ts';
import type { ScanResult, TokenUsage, UsageRecord } from './types.ts';

type ChildPart = { ref?: string; identity: string; usage: TokenUsage };
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
export function extractChildSummary(value: unknown, source: string): {
  childRefs: string[]; summaryKey?: string; recognized: boolean; parts?: ChildPart[];
} {
  const message = value as any;
  if (!message || !['subagent', 'bg_wait'].includes(message.toolName)) return { childRefs: [], recognized: false };
  const details = message.details;
  const children: { child: any; runId?: string; index: number }[] = [];
  if (Array.isArray(details?.results)) details.results.forEach((child: any, index: number) => children.push({ child, runId: details.runId, index }));
  if (Array.isArray(details?.completions)) for (const completion of details.completions) {
    if (Array.isArray(completion?.results)) completion.results.forEach((child: any, index: number) => children.push({ child, runId: completion.runId, index }));
  }
  const refs: string[] = [], identities: string[] = [], parts: ChildPart[] = [];
  for (const { child, runId, index } of children) {
    if (!child || typeof child !== 'object') continue;
    const ref = typeof child.sessionFile === 'string' && child.sessionFile ? resolve(dirname(source), child.sessionFile) : undefined;
    const run = typeof child.runId === 'string' ? child.runId : typeof runId === 'string' ? runId + ':' + index : undefined;
    const identity = ref ?? (run ? 'run:' + run : undefined);
    if (ref) refs.push(ref);
    if (!identity) continue;
    identities.push(identity);
    const usage = normalizeUsage(child.usage);
    if (usage) parts.push({ ref, identity, usage });
  }
  return { recognized: true, childRefs: [...new Set(refs)].sort(),
    summaryKey: identities.length ? recordKey([...new Set(identities)].sort()) : undefined,
    parts: parts.length === children.length && children.length ? parts : undefined };
}

/** Replace a known aggregate with per-child identities only when the split reconciles exactly. */
export function splitSummary(record: UsageRecord, message: unknown): UsageRecord[] {
  const summary = extractChildSummary(message, record.source);
  if (!summary.recognized) return [record];
  // A tool aggregate can span models/providers; the parent's selection is not attribution.
  record = { ...record, provider: undefined, model: undefined };
  if (summary.parts && fields.every(field => summary.parts!.reduce((n, p) => n + p.usage[field], 0) === record.usage[field])) {
    return summary.parts.map((part, index) => ({ ...record, key: record.key + ':' + index, usage: part.usage,
      childRefs: part.ref ? [part.ref] : [], summaryKey: part.identity }));
  }
  return [{ ...record, childRefs: summary.childRefs, summaryKey: summary.summaryKey }];
}

export function reconcileSubagents(records: UsageRecord[], availableFiles: Set<string>): ScanResult {
  const warnings = new Set<string>();
  const regular = records.filter(r => !['subagent', 'bg_wait'].includes(r.toolName ?? ''));
  const summaries = records.filter(r => ['subagent', 'bg_wait'].includes(r.toolName ?? ''))
    .map(r => ({ ...r, provider: undefined, model: undefined }));
  const groups = new Map<string, UsageRecord>();
  for (const r of summaries) {
    if (!r.summaryKey) {
      regular.push(r);
      warnings.add('存在无法识别身份的子代理汇总，可能与子会话重叠；总量不保证精确');
      continue;
    }
    const old = groups.get(r.summaryKey);
    if (!old || r.usage.totalTokens > old.usage.totalTokens || (r.usage.totalTokens === old.usage.totalTokens && r.timestamp < old.timestamp)) groups.set(r.summaryKey, r);
    if (old && old.key !== r.key) warnings.add('同一子会话存在多个汇总但缺少独立调用边界；仅保留最大值回退，时间与完整性不保证精确');
  }
  const pending = new Set(groups.values());
  const active = new Set<UsageRecord>();
  function reconcile(r: UsageRecord): void {
    if (!pending.has(r)) return;
    if (active.has(r)) { warnings.add('子代理引用存在循环，无法保证完整统计'); return; }
    active.add(r);
    const refs = new Set(r.childRefs ?? []);
    for (const child of pending) if (child !== r && refs.has(child.source) && !active.has(child)) reconcile(child);
    const seen = new Set<string>();
    const covered: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const child of regular) {
      // Native pi-subagents attempt summaries cover its own assistant messages,
      // not inherited context, cache warming, compactions, or nested tools.
      if (!refs.has(child.source) || child.kind !== 'assistant' || child.inherited || child.timestamp > r.timestamp || seen.has(child.key)) continue;
      seen.add(child.key);
      for (const field of fields) covered[field] += child.usage[field];
    }
    if (fields.some(field => covered[field] > r.usage[field])) {
      warnings.add('子会话含超出汇总的历史用量，无法确认重试调用边界；未另加无法证明的差额，总量可能是下界');
    }
    const residual = Object.fromEntries(fields.map(field => [field, Math.max(0, r.usage[field] - covered[field])])) as unknown as TokenUsage;
    if (fields.some(field => residual[field] > 0)) {
      regular.push({ ...r, usage: residual, key: 'residual:' + r.summaryKey });
      warnings.add('部分子代理会话缺失或不完整，差额按父级汇总时间回退；时间归属不精确');
    } else if (!refs.size || [...refs].some(ref => !availableFiles.has(ref))) {
      warnings.add('部分子代理来源不在扫描范围，无法保证覆盖完整');
    }
    pending.delete(r); active.delete(r);
  }
  for (const r of [...pending]) reconcile(r);
  return { records: regular, warnings: [...warnings] };
}
