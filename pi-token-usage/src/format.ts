import { cacheHitRate } from './query.ts';
import type { TokenUsage, UsageReport } from './types.ts';
export const usageHelp = '用法：/tokens xh 或 /tokens xd（x 为正整数，例如 /tokens 24h、/tokens 7d）';
export function formatReport(report: UsageReport): string {
  const number = (n: number) => n.toLocaleString('en-US');
  const date = (n: number) => new Date(n).toLocaleString('zh-CN', { hour12: false });
  const details = (usage: TokenUsage): string[] => {
    const rate = cacheHitRate(usage);
    return [
      `总计：${number(usage.totalTokens)} tokens`,
      `输入：${number(usage.input)}    输出：${number(usage.output)}`,
      `缓存读取：${number(usage.cacheRead)}    缓存写入：${number(usage.cacheWrite)}`,
      `缓存命中率：${rate === undefined ? '—' : (rate * 100).toFixed(2) + '%'}`,
    ];
  };
  const { range, usage } = report;
  const lines = [
    `Token 用量 · 最近 ${range.amount} ${range.unit === 'h' ? '小时' : '天'} · 所有渠道`,
    `范围：${date(range.start)} → ${date(range.end)}（本地时间）`,
    ...details(usage),
  ];
  // Old durable reports predate provider grouping; do not fabricate attribution.
  if (report.providers?.length) {
    lines.push('', '按 provider 统计');
    for (const group of report.providers) {
      lines.push('', `provider：${group.provider ?? '未知（未记录 provider）'}`, ...details(group.usage));
    }
  }
  lines.push('', '来源：本机 Pi 已保存记录（跨项目、跨会话、含已保存子代理；非服务商账单）');
  return lines.join('\n');
}
