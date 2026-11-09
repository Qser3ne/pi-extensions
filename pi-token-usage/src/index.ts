import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { collectUsage } from './collector.ts';
import { SnapshotCache } from './cache.ts';
import { formatReport, shortcutHelp, usageHelp } from './format.ts';
import { parseRange } from './query.ts';
import type { UsageReport } from './types.ts';

const reportType = 'pi-token-usage.report';
export default function tokenUsage(pi: ExtensionAPI): void {
  const memoryCache = new SnapshotCache();
  let generation = 0;
  let queried = false;
  pi.on('session_shutdown', () => { generation++; });
  pi.on('session_start', () => { generation++; });
  pi.registerEntryRenderer<UsageReport>(reportType, (entry, _options, theme) =>
    new Text(theme.fg('text', entry.data ? formatReport(entry.data) : 'Token 用量报告不可用'), 1, 1));
  async function query(args: string, ctx: ExtensionCommandContext, shortcut = false): Promise<void> {
    const now = Date.now();
    let range;
    try {
      if (shortcut && args.trim()) throw new RangeError(shortcutHelp);
      range = parseRange(shortcut ? '24h' : args, now);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof RangeError ? error.message : usageHelp, 'warning');
      return;
    }
    const current = generation;
    const agentDir = getAgentDir();
    const roots = [join(agentDir, 'sessions'), ctx.sessionManager.getSessionDir()];
    if (!queried && ctx.hasUI) ctx.ui.notify('正在读取本机 Pi 用量；首次查询可能较慢…', 'info');
    queried = true;
    let report: UsageReport;
    try {
      const scoped = ctx.scopedModels;
      // Freeze the picker-default list locally; never refresh catalogues or resolve credentials.
      const allowedModels = (scoped.length ? scoped.map(entry => entry.model) : ctx.modelRegistry.getAvailable())
        .map(({ provider, id }) => ({ provider, id }));
      report = await collectUsage({ roots, cacheDir: join(agentDir, 'pi-token-usage', 'cache-v1'), range, memoryCache, allowedModels });
    } catch (error) {
      if (current === generation && ctx.hasUI) ctx.ui.notify(`用量查询失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (current !== generation) return; // A replaced session must not receive an old report.
    pi.appendEntry<UsageReport>(reportType, report);
    if (ctx.mode === 'rpc') ctx.ui.notify(formatReport(report), 'info');
  }
  pi.registerCommand('token', {
    description: '查询当前模型列表的本机 Pi token 用量：/token xh 或 /token xd',
    handler: (args, ctx) => query(args, ctx),
  });
  pi.registerCommand('token-usage', {
    description: '查询当前模型列表最近 24 小时的本机 Pi token 用量',
    handler: (args, ctx) => query(args, ctx, true),
  });
}
