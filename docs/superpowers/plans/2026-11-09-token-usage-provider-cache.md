# Provider 用量与缓存命中率 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 token 报告中显示整体及各 provider 的用量和输入缓存命中率，隐藏整块精度警告。

**Architecture:** 在源记录解析时保留明确的 provider，经过现有子代理协调和去重后，一次遍历同时聚合整体及 provider 明细。格式化层计算百分比并隐藏警告；原始诊断保留在报告数据。升级文件缓存协议，防止旧缓存永久丢失 provider。

**Tech Stack:** TypeScript、Node.js >=22.19.0、node:test、现有 Pi Text renderer，无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-09-token-usage-provider-cache-design.md`

## Global Constraints

- 仅支持 `/tokens xh`、`/tokens xd`，x 为正整数，必须带单位。
- 缓存命中率 = `cacheRead / (input + cacheRead + cacheWrite) × 100%`，两位小数，零分母显示 `—`。
- 保持总 token、时间范围、去重和子代理协调语义，不使用当前 provider 推测历史归属。
- 底层诊断保留，不展示警告标题和列表；真正错误仍提示。
- 无新增依赖、网络或模型调用，缓存不保存正文。
- 保留无关工作区改动，不修改 settings，不推送远程。

## Review Focus

1. 已保存旧报告缺少 provider 数组：仍能渲染，不报错、不编造分组（Task 3）。
2. 名为 `unknown` 或“未知”的真实 provider：不与缺失归属混为一个内部桶（Task 2）。
3. 父子使用不同 provider、且子历史不完整：已知部分属于子 provider，剩余未知，不能归给父 provider（Task 1/2）。
4. 缓存命中但旧协议记录无 provider：不能复用旧缓存；重建后追加和再次查询归属一致（Task 1）。
5. 分组顺序、同量稳定排序、0 输入但有输出：分组可复现，百分比不出现 NaN/Infinity（Task 2/3）。

---

## File Structure

- `pi-token-usage/src/types.ts`：provider 元数据及分组报告结构。
- `pi-token-usage/src/reader.ts`、`src/cache.ts`：明确 provider 提取、协议 3 验证与失效。
- `pi-token-usage/src/subagents.ts`：汇总/残差不能继承父 provider。
- `pi-token-usage/src/query.ts`：整体、provider 聚合及缓存命中率函数。
- `pi-token-usage/src/format.ts`、`src/index.ts`：展示与 RPC 提示级别。
- 现有 `test/{reader,cache,subagents,query,extension}.test.ts`、新增 `test/format.test.ts`：回归。
- `pi-token-usage/README.md`、`docs/verification.md`：新展示、口径及验证证据。

### Task 1: 保留 provider 并安全升级缓存

**Files:** Modify `pi-token-usage/src/{types,reader,cache,subagents}.ts`; Test `pi-token-usage/test/{reader,cache,subagents}.test.ts`.

**Interfaces:**
- Consumes: existing `UsageRecord`, `FileSnapshot`, `readUsageFile(path, previous?)`, `splitSummary(record, message)`.
- Produces: `UsageRecord.provider?: string`; `FileSnapshot.version: 3`; existing reading/cache signatures unchanged.
- For message entries use a nonblank explicit `message.provider`; for standalone usage/summary entries use explicit `entry.provider`. Trim surrounding whitespace. Never infer from current selection.
- Recognized subagent/bg_wait summary records and residuals have no provider, even if their tool message contains the parent's provider.

- [ ] **Step 1: Add failing regressions.** Reader test asserts providers `['provider-a', 'custom', undefined]` for assistant, explicit standalone usage and missing attribution. Add mixed-provider source records and summary tests asserting known child keeps its provider and unknown residual has `provider === undefined`. Cache test injects protocol 2 and invalid non-string/blank provider; `loadSnapshot(...)` must return undefined. Pass a protocol-2 previous snapshot directly to reader and assert it is rebuilt.
- [ ] **Step 2: Run RED.** `cd pi-token-usage && node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/reader.test.ts test/cache.test.ts test/subagents.test.ts`. Expect failures at provider/version assertions.
- [ ] **Step 3: Implement the interfaces.** Add provider extraction; preserve source identity hashes. Clear provider on recognized summaries. Update snapshot creation, previous-snapshot eligibility and cache validation to protocol 3; retain cache-v1 directory. Validate optional provider is a trimmed nonblank string.
- [ ] **Step 4: Run GREEN.** Repeat the targeted command, expect all pass. Add cached repeated-query and append assertions proving provider is preserved and no message body is stored.
- [ ] **Step 5: Checkpoint.** Review `git diff --check` and commit only Task 1 files on the isolated feature branch.

### Task 2: 聚合 provider 用量与缓存命中率

**Files:** Modify `pi-token-usage/src/{types,query}.ts`; Test `pi-token-usage/test/query.test.ts`.

**Interfaces:**
- Consumes: Task 1 `UsageRecord.provider?: string`, unchanged reconciliation output.
- Produces: `ProviderUsage { provider?: string; usage: TokenUsage; recordCount: number }`; `UsageReport.providers: ProviderUsage[]`; `cacheHitRate(usage: TokenUsage): number | undefined`, returning a ratio in [0, 1] or undefined for no input.
- Existing `aggregate(records, range, warnings?)` returns both overall and per-provider sums from the same filtered, deduplicated records. Unknown uses an undefined Map key, not a magic string.

- [ ] **Step 1: Add failing regressions.** Two providers have `(input=10, cacheRead=90, output=10)` and `(input=90, cacheRead=0, cacheWrite=810, output=1000)`; assert rates `0.9`, `0`, overall `0.09`, excluding output. Assert unknown bucket differs from literal `unknown` provider. Duplicate and out-of-window records change neither overall nor provider totals. Assert every summed provider field equals overall and each provider recordCount sums to overall. Pin descending total order, deterministic name tie-break, empty input and output-only undefined rates, zero providers for no records, and existing unsafe-integer rejection.
- [ ] **Step 2: Run RED.** `cd pi-token-usage && node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/query.test.ts`. Expect missing helper/provider assertions to fail.
- [ ] **Step 3: Implement interfaces.** Add a checked summation helper reused for both totals; group only after existing seen/range checks. Sort descending totalTokens, ties by provider string using a locale-independent comparison, unknown last on ties. Calculate ratios from summed input-side components only.
- [ ] **Step 4: Run GREEN.** Repeat targeted query tests, expect all pass; run `npm run typecheck` and fix report fixtures for the new required providers array.
- [ ] **Step 5: Checkpoint.** Review `git diff --check` and commit only Task 2 files.

### Task 3: 展示缓存命中率与 provider，隐藏整块警告

**Files:** Modify `pi-token-usage/src/{format,index}.ts`, `pi-token-usage/README.md`, `pi-token-usage/docs/verification.md`; Create `pi-token-usage/test/format.test.ts`; Modify `pi-token-usage/test/extension.test.ts`.

**Interfaces:**
- Consumes: Task 2 UsageReport/providers, cacheHitRate helper.
- Produces: existing `formatReport(report: UsageReport): string`, same command and renderer registration. Runtime compatibility allows old stored reports without providers.
- Show overall `缓存命中率：90.00%`; after overall totals show `按 provider 统计` and each provider's total, input/output, cache read/write and rate. Use full integers. Unknown label `未知（未记录 provider）` avoids a real provider called 未知 looking identical.

- [ ] **Step 1: Add failing formatter regressions.** Assert overall/provider `90.00%`, `0.00%`, zero-input `—`, exact integer token values, unknown label, no warning heading or unique warning body despite nonempty report.warnings. Assert old report without providers renders overall without a fabricated provider section; empty providers render no section.
- [ ] **Step 2: Add failing integration regressions.** Create two synthetic providers and a partial JSONL tail. TUI and RPC outputs must show provider names/rates, omit warning title/body, while appended report data retains warnings. RPC report notification is info even with diagnostics. Invalid arguments still warn; create two distinct assistant entries with input/totalTokens `Number.MAX_SAFE_INTEGER` and `1` to force checked-aggregation failure, and assert `用量查询失败` notification remains error. Assert renderer handles an old report.
- [ ] **Step 3: Run RED.** `cd pi-token-usage && node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/format.test.ts test/extension.test.ts`. Expect absent rate/provider and exposed warning assertions to fail.
- [ ] **Step 4: Implement presentation.** Reuse rate helper, display two decimals or `—`; add provider blocks with no wide-table dependency; remove warning rendering without mutating diagnostics; send successful RPC reports at info level. Do not change actual failure handling.
- [ ] **Step 5: Run GREEN and final verification.** `cd pi-token-usage && npm test && npm run typecheck && npm pack --dry-run`; then `git diff --check`. All must exit 0. Verify cold and cached synthetic queries produce identical provider/overall sums and rates; existing child/fork regressions still pass.
- [ ] **Step 6: Document and checkpoint.** Update README with formula, provider attribution, unknown bucket, hidden diagnostics and cache rebuild behavior. Record observed commands/results in verification.md without claiming manual TUI testing. Commit only scoped files. Keep unrelated modifications intact; no push or settings changes.

## Execution Handoff

Preserve the previous direct-in-session implementation approach and isolated worktree preference. This plan is for approval before implementation; no new subagent dispatch is authorized by its existence. At execution time load executing-plans, worktree, TDD and verification skills and applicable Pi docs before changes. Archive behavior changes before any requested local merge; do not claim integration or reload unless actually performed.
