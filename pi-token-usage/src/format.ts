import { cacheHitRate } from './query.ts';
import type { TokenUsage, UsageReport } from './types.ts';
export const usageHelp = '用法：/token xh 或 /token xd（x 为正整数，例如 /token 24h、/token 7d）';
export const shortcutHelp = '用法：/token-usage（固定最近 24 小时，不接受参数）；自定义范围请用 /token xh 或 /token xd';
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
    `Token 用量 · 最近 ${range.amount} ${range.unit === 'h' ? '小时' : '天'} · ${report.scope === 'current-models' ? '当前模型列表' : '所有渠道'}`,
    `范围：${date(range.start)} → ${date(range.end)}（本地时间）`,
    ...details(usage),
  ];
  // Old durable reports lack model grouping; never treat providers as models.
  if (report.models?.length) {
    lines.push('', '按模型统计');
    for (const group of report.models) {
      lines.push('', `模型：${group.provider ?? '未知渠道'}/${group.model ?? '未知模型'}`, ...details(group.usage));
    }
  }
  return lines.join('\n');
}
