import type { UsageReport } from './types.ts';
export const usageHelp = '用法：/tokens xh 或 /tokens xd（x 为正整数，例如 /tokens 24h、/tokens 7d）';
export function formatReport(report: UsageReport): string {
  const number = (n: number) => n.toLocaleString('en-US');
  const date = (n: number) => new Date(n).toLocaleString('zh-CN', { hour12: false });
  const { range, usage, warnings } = report;
  const lines = [
    `Token 用量 · 最近 ${range.amount} ${range.unit === 'h' ? '小时' : '天'} · 所有渠道`,
    `范围：${date(range.start)} → ${date(range.end)}（本地时间）`,
    `总计：${number(usage.totalTokens)} tokens`,
    `输入：${number(usage.input)}    输出：${number(usage.output)}`,
    `缓存读取：${number(usage.cacheRead)}    缓存写入：${number(usage.cacheWrite)}`,
    '',
    '来源：本机 Pi 已保存记录（跨项目、跨会话、含已保存子代理；非服务商账单）',
  ];
  if (warnings.length) {
    lines.push('', '⚠ 数据存在缺失或不精确部分：', ...warnings.slice(0, 10).map(w => '• ' + w));
    if (warnings.length > 10) lines.push(`另有 ${warnings.length - 10} 条警告，可在本条报告数据中查看。`);
  }
  return lines.join('\n');
}
