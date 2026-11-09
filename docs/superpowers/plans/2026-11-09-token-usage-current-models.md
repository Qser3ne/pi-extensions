# Current-model Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供 `/token-usage` 近 24h 快捷命令，将 `/tokens` 改名为 `/token`，并按当前 /model 默认列表过滤所有新查询。

**Architecture:** 使用已有运行时名单，不刷新或访问模型服务。先发现、读取、去重并协调完整历史，再按 provider/model 白名单过滤聚合；两级快照保持完整且模型无关。保存新报告的范围标记，兼容旧报告。

**Tech Stack:** Node.js >=22.19.0、TypeScript、现有 Pi Extension API、node:test；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-09-token-usage-current-models-design.md`

## Global Constraints

- `/token-usage` 固定滚动 24 小时，不接受额外参数；`/token xh`、`/token xd` 的 x 为正整数；不保留 `/tokens` 别名。
- 非空 `ctx.scopedModels` 优先，否则 `ctx.modelRegistry.getAvailable()`；仅使用同步运行时快照，每次查询冻结名单。
- 总量、记录数、模型明细和缓存率采用同一名单；未知归属与名单外记录不计入；空名单返回零，不回退全历史。
- 名单读取失败报真正查询错误；无名单参数的内部 collectUsage 调用保留既有无过滤行为，所有命令必须显式传入名单。
- 不改变 token 口径、缓存协议 4、来源发现边界、有界并发及内存限额；不缓存最终报告，不删除被过滤历史。
- 不恢复来源脚注/缺失警告块，不调用模型或认证解析，不新增设置、依赖或后台任务。
- 在已有隔离 worktree 本会话执行与作者自检，不新增子代理；合入、推送、/reload 另需授权。

## Review Focus

1. 非空 scope 之外的可用模型不能漏入；空 available 与名单读取失败不能变成无过滤查询（Task 2）。
2. provider/model 带斜线或看似未知占位名时仍为精确二元组，缺失字段不能与真实字符串混淆（Task 1）。
3. 同一子代理汇总混合允许/排除模型时，必须先完整协调，未知父差额不能归到父模型（Task 1）。
4. 同一个内存/磁盘缓存切换名单后可重新纳入旧记录，不能把过滤结果写回快照（Task 1）。
5. 旧的 provider-only、model-grouped 报告不能被新标题误标为已按当前名单过滤（Task 2）。

---

### Task 1: 聚合前过滤与报告范围元数据

**Files:** 修改 `pi-token-usage/src/types.ts`、`src/query.ts`、`src/collector.ts`；新增 `pi-token-usage/test/model-filter.test.ts`。

**Interfaces:**
- 消费：现有 `reconcileSubagents`、`aggregate`、`readUsageFile`、`SnapshotCache`；统计输入不预裁剪。
- 产出：`ModelIdentity { provider: string; id: string }`；`UsageReport.scope?: 'current-models'`。
- 产出：`modelKey(provider: string | undefined, model: string | undefined): string`，JSON 二元组编码，供既有分组和名单匹配共用。
- 扩展：`collectUsage(options)` 新增 `allowedModels?: readonly ModelIdentity[]`；undefined 保留旧内部行为，[] 严格零结果，存在参数时返回 scope 标记。

- [x] **Step 1: 写失败回归**
  - `filters totals groups counts and cache rates by exact model pairs`：允许 A/shared（input 10、cacheRead 90、total 100），排除 B/shared（total 900）及未知来源（7）；断言 total=100、recordCount=1、models 只有 A/shared、缓存率=90%，空名单为 0。
  - `model identities do not collide`：A/B + C 与 A + B/C 不串组；真实 unknown/null 字符串不等于缺失归属；重复名单不重复计数。
  - `filtering follows full child reconciliation`：子文件 A/kept=10、B/removed=20，父工具汇总带父模型与总量 35；只允许 A 与父模型，结果只含 10，不能把子汇总或未知差额 5 计回父模型。含继承/复制记录的变体仍只计一次。
  - `model changes reuse complete snapshots`：同一 SnapshotCache 依次查询 [A]、[B]、[]、[A,B]，总量依次 100、900、0、1000；磁盘命中与无过滤内部调用仍保留所有历史，快照未丢未知记录。
- [x] **Step 2: 运行 RED**：`node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/model-filter.test.ts`；应因缺少过滤/范围标记或 helper 失败，不因夹具错误。
- [x] **Step 3: 最小实现**：引入类型及共用 modelKey，仅在 collector 的 reconcile 后、aggregate 前裁剪记录；可选参数存在时加 scope。不要修改 reader/cache/subagents 算法或快照内容。
- [x] **Step 4: 运行 GREEN**：上述定向测试、`npm test && npm run typecheck`；全部通过且旧内部收集测试口径不变。
- [x] **Step 5: 提交**：`feat: filter usage by selected provider-model identities`，仅包含本任务源文件和测试。

### Task 2: 两个命令、名单读取及兼容展示

**Files:** 修改 `pi-token-usage/src/index.ts`、`src/format.ts`、`src/query.ts`（参数提示）、`test/extension.test.ts`、`test/integration.test.ts`、`test/format.test.ts`、`test/query.test.ts`（如含命令断言）、`README.md`、`docs/verification.md`；同步根 `README.md` 中该扩展当前命令说明（如有）。

**Interfaces:**
- 消费 Task 1 的 `ModelIdentity`、`collectUsage({allowedModels})`、`UsageReport.scope`。
- 产出：仅注册 `token` 和 `token-usage`，共用查询处理路径、同一实例内存快照、过时会话抑制与 context-free 输出。
- `/token-usage` 空白参数映射 `parseRange('24h', Date.now())`；有其他参数提示其固定 24h。`/token` 仍传入原参数给 parseRange，提示文案使用新命令名。
- 名单在收集前读取：非空 scope 取 `entry.model`，否则 `getAvailable()`；复制成 `{provider,id}`，在查询 try/catch 内处理失败，不调用 refresh/getApiKey/complete。
- formatReport 仅在 `scope === 'current-models'` 时将标题范围显示为“当前模型列表”；缺少标记的旧报告保留“所有渠道”。

- [x] **Step 1: 写失败回归并更新明确淘汰的旧命令断言**
  - `registers token and token-usage only`：keys 为这两个命令，旧 tokens 不存在；无效输入不扫描、不读取名单。
  - `shortcut equals explicit 24h`：固定时钟下两命令 range、usage、models、recordCount 相同；shortcut 拒绝 `7d` 等参数且不扫描，token 仍拒绝无单位/零/负数。
  - `current picker scope is read on every command`：scoped=[A]、available=[A,B] 时仅 A；清 scope 后 A+B；两命令都在同一实例重复切换名单且结果即时变化。scoped 非空时 getAvailable 设为抛错也不应调用；空 available 得到零而非全历史。
  - `registry failure remains a query error`：名单 getter 抛错则无报告、有 error；注册表 refresh/认证/生成桩均抛错确保不触发。
  - `range labeling preserves old durable reports`：新范围标记显示当前模型列表；无标记的旧分组报告与 provider-only 报告仍显示所有渠道，不恢复脚注或警告。
  - 真实 RPC 配置本地模型夹具与假 apiKey，`--offline` 无模型生成；一个进程依次调用两命令，允许/排除的同 ID 跨 provider 结果正确、24h 相等且无 agent_start；用离线 scope 保证环境密钥不扩大名单。
  - bundled loader 仅注册两个新命令，不增加模型 provider 或工具。
- [x] **Step 2: 运行 RED**：定向 extension/format/integration 测试；确认失败来自命令、范围和名单行为未实现。
- [x] **Step 3: 最小实现及用户文档同步**：命令共用查询路径；按 Interfaces 读取名单与设置范围。更新所有活跃用法中的 /tokens，保留仅用于说明旧命令已移除的历史提及。
- [x] **Step 4: 运行 GREEN**：定向测试、`npm test && npm run typecheck && npm pack --dry-run && git diff --check`；真实 RPC 与 bundled loader 不跳过。
- [x] **Step 5: 提交**：`feat: add token-usage shortcut and rename token command`。

## 收尾（不是独立代码任务）

完成两任务后做本会话作者自检并明确不是独立审查；按 custom-archive-docs 更新冲突的“未知归属计入总量”“只注册 /tokens”“不枚举模型配置”条目，解释为仅获取本地运行时名单而非远端枚举。档案独立提交。交付报告记录最终验证、作者裁决及覆盖限制；最终重新验证后询问集成范围。

## 计划作者自检

规范各项已映射到两个任务或收尾；五个 Review Focus 均落在上述回归。身份接口与 SDK model.id 一致，源记录仍使用 model；未增加跨任务未知函数。两任务均有明确 RED/GREEN/提交边界，未授权任何新子代理。用户已确认直接实现，两任务的 RED/GREEN、提交及完整验证均已完成。
