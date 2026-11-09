import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { collectUsage } from './collector.ts';
import { formatReport, usageHelp } from './format.ts';
import { parseRange } from './query.ts';
import type { UsageReport } from './types.ts';

const reportType = 'pi-token-usage.report';
export default function tokenUsage(pi: ExtensionAPI): void {
  let generation = 0;
  let queried = false;
  pi.on('session_shutdown', () => { generation++; });
  pi.on('session_start', () => { generation++; });
  pi.registerEntryRenderer<UsageReport>(reportType, (entry, _options, theme) =>
    new Text(theme.fg('text', entry.data ? formatReport(entry.data) : 'Token 用量报告不可用'), 1, 1));
  pi.registerCommand('tokens', {
    description: '查询所有渠道的本机 Pi token 用量：/tokens xh 或 /tokens xd',
    handler: async (args, ctx) => {
      const now = Date.now();
      let range;
      try { range = parseRange(args, now); }
      catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof RangeError ? error.message : usageHelp, 'warning');
        return;
      }
      const current = generation;
      const agentDir = getAgentDir();
      const roots = [join(agentDir, 'sessions'), ctx.sessionManager.getSessionDir()];
      if (!queried && ctx.hasUI) ctx.ui.notify('正在读取本机 Pi 用量；首次查询可能较慢…', 'info');
      queried = true;
      let report: UsageReport;
      try { report = await collectUsage({ roots, cacheDir: join(agentDir, 'pi-token-usage', 'cache-v1'), range }); }
      catch (error) {
        if (current === generation && ctx.hasUI) ctx.ui.notify(`用量查询失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        return;
      }
      if (current !== generation) return; // A replaced session must not receive an old report.
      pi.appendEntry<UsageReport>(reportType, report);
      if (ctx.mode === 'rpc') ctx.ui.notify(formatReport(report), 'info');
    },
  });
}
