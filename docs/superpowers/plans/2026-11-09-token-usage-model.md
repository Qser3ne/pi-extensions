# Provider/Model 用量报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 provider 明细替换为 provider/model 明细，只展示查询窗口内实际有 token 用量的模型组合，保留整体统计与缓存命中率。

**Architecture:** 读取历史时保留明确 model 归属并升级缓存；在原有过滤、子代理协调和去重后，以结构化 provider/model 二元组汇总。报告结构与格式化在同一任务端到端切换至 models，避免中间提交破坏现有渲染及测试；不枚举模型配置。

**Tech Stack:** TypeScript、Node.js >=22.19.0、node:test、现有 Pi Text renderer；无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-09-token-usage-model-design.md`

## Global Constraints

- 仅支持 `/tokens xh`、`/tokens xd`，命令及时间窗口不变。
- 按 provider/model 组合区分，同 model ID 在不同 provider 下分别显示；不增加独立 provider 汇总。
- 任一 token 分项或 totalTokens 大于 0 才展示该组合；全零、窗口外和从未使用的组合不显示。
- 缓存命中率 = `cacheRead / (input + cacheRead + cacheWrite) × 100%`；先汇总再计算，两位小数，零分母显示 `—`。
- 保留总 token 口径、去重及父子协调语义，整块精度警告继续隐藏，底层诊断与真正错误提示保留。
- 仅使用源记录自身明确的 provider/model，不推断当前模型、相邻消息或父代理归属；缓存不保存正文。
- 沿用隔离 worktree、本会话直接实现方式；不新增子代理委派，不修改 settings，不覆盖无关修改，不推送远程。

## Review Focus

1. 含斜杠、空缺和字面 `unknown` 的 provider/model：二元组不能碰撞或误合并（Task 2）。
2. totalTokens 为 0 但某个分项大于 0：仍属于实际用量；仅 totalTokens 大于 0 但分项全零也应显示（Task 2）。
3. 同一模型仅在窗口外使用或只有全零失败调用：不得在模型区占位，也不能通过配置模型名单填充（Task 2）。
4. 历史报告有 providers、无 models：仍渲染整体，不能将 provider 列表冒充模型或崩溃（Task 2）。
5. 已知子模型加缺失差额、旧协议缓存和增量追加：模型不能继承父级，重建/追加后归属不能丢失（Task 1）。

---

## File Structure

- `pi-token-usage/src/types.ts`：可选模型元数据与新 models 报告结构。
- `pi-token-usage/src/reader.ts`、`src/cache.ts`：读取 model、验证并失效旧快照。
- `pi-token-usage/src/subagents.ts`：清除无法证明的父级模型归属。
- `pi-token-usage/src/query.ts`、`src/format.ts`：二元组汇总、仅显示使用组合、模型明细及旧报告兼容。
- `pi-token-usage/test/{reader,cache,subagents,query,format,extension,integration}.test.ts`：回归和真实 Pi RPC。
- `pi-token-usage/README.md`、`pi-token-usage/docs/verification.md`：新口径与实际验证证据。
- `src/index.ts` / `src/collector.ts` 无须改变命令、采集入口或提示级别；由新报告类型继续约束接口。

### Task 1: 保留 model 并升级文件缓存

**Files:** Modify `pi-token-usage/src/{types,reader,cache,subagents}.ts`; Test `pi-token-usage/test/{reader,cache,subagents}.test.ts`.

**Interfaces:**
- Consumes: existing `UsageRecord.provider?: string`, `FileSnapshot`, `readUsageFile(path, previous?)`, `loadSnapshot`, `splitSummary`, `reconcileSubagents`.
- Produces: `UsageRecord.model?: string`; `FileSnapshot.version: 4`; existing function signatures unchanged.
- For assistant/toolResult entries read explicit `message.model`; for standalone usage/compaction/branch_summary read explicit `entry.model`. Trim nonblank strings; invalid or missing values mean undefined. Never infer from model_change or a neighboring assistant.
- Recognized subagent/bg_wait summaries and uncovered residuals have neither parent provider nor parent model, including direct calls to reconciliation.

- [ ] **Step 1: Add failing regressions.** Extend reader tests: assistant model-a, standalone ` local-model `, missing model following model_change, compaction/branch_summary and explicit nested tool model; assert exact model values and preservation of usage for invalid model `null`, `42`, `''`, `' '`. Extend cache tests to reject protocol 3, rebuild unchanged old snapshots both via loader and direct reader, reject malformed model metadata, preserve model-a/model-b across persistent reuse and append without copying PRIVATE-BODY. Extend summary tests so parent-model is absent from split/whole/residual records while a known child retains child-model.

  Core test names: `reader retains explicit source models without inheriting model selection`, `protocol 3 snapshots rebuild with model attribution`, `child residual cannot inherit parent model`. Core assertions:
  ```typescript
  assert.deepEqual(snapshot.records.map(r => r.model), ['model-a', 'local-model', undefined, 'compact-model', 'branch-model', 'tool-model']);
  assert.equal(await loadSnapshot(cacheDir, path), undefined); // written protocol-3 fixture
  assert.equal(residual.model, undefined);
  assert.equal(child.model, 'child-model');
  ```
- [ ] **Step 2: Run RED.** `cd pi-token-usage && node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/reader.test.ts test/cache.test.ts test/subagents.test.ts`. Expected: assertions fail because model metadata is absent, parent model leaks or protocol 3 is reused.
- [ ] **Step 3: Implement the interfaces.** Add optional model extraction and validation alongside provider; upgrade cache writer, loader and reader's reuse eligibility to protocol 4, keeping cache-v1 directory. Clear model in the same recognized-summary paths that clear provider. Preserve existing event hashes, time windows and usage normalization.
- [ ] **Step 4: Run GREEN and baseline suite.** Repeat targeted command, then `cd pi-token-usage && npm test && npm run typecheck`. Expected: all commands exit 0; existing provider report remains working during this additive task.
- [ ] **Step 5: Checkpoint.** `git diff --check`, then commit only Task 1 source/tests on the feature branch.

### Task 2: 端到端替换为仅展示已使用的模型报告

**Files:** Modify `pi-token-usage/src/{types,query,format}.ts`, `pi-token-usage/test/{query,format,extension,integration}.test.ts`, `pi-token-usage/README.md`, `pi-token-usage/docs/verification.md`.

**Interfaces:**
- Consumes: Task 1 `UsageRecord.provider?: string`, `UsageRecord.model?: string`, unchanged reconciliation and `cacheHitRate(usage)`.
- Produces: `ModelUsage { provider?: string; model?: string; usage: TokenUsage; recordCount: number }`; `UsageReport.models: ModelUsage[]` replaces new reports' `providers`; remove the obsolete exported ProviderUsage type.
- `aggregate(records, range, warnings?)` still returns UsageReport. Use a collision-free tuple key such as `JSON.stringify([provider ?? null, model ?? null])`, never provider + '/' + model. Derive groups solely from in-range deduplicated records. Retain overall recordCount semantics; omit only groups whose five token fields are all zero.
- Sort descending totalTokens; on ties complete attribution precedes missing attribution, then compare provider and model with deterministic binary string order and missing fields after known fields.
- `formatReport(report: UsageReport): string` displays `按模型统计` and `模型：<provider>/<model>` plus unchanged token/rate detail lines. Missing labels are `未知渠道` / `未知模型`. At runtime tolerate old reports lacking models and ignore their old providers field; show overall only. Do not enumerate modelRegistry or settings.

- [ ] **Step 1: Add failing aggregation regressions.** Use p1/mA calls of 2 and 3 tokens, p1/mB of 7, p2/mA of 11: expect groups `[['p2','mA',11],['p1','mB',7],['p1','mA',5]]`, overall 23. Add `['p/a','m']` versus `['p','a/m']`, missing versus literal unknown names, duplicate/fork and window endpoints, stable tied names, and assertions that all grouped token fields sum to overall. Preserve the existing weighted-rate test of 90%, 0%, overall 9%. Assert zero-only and out-of-window models are absent, but input=1/totalTokens=0 and input=0/totalTokens=1 groups remain; preserve overflow rejection and empty-report behavior. Adapt existing provider-level tests to the new model report interface without weakening their deduplication/unknown-name assertions.

  Core test names: `provider-model tuples separate models and accumulate repeated calls`, `tuple keys do not collide on slash-containing names`, `only nonzero in-window model groups are listed`. Core assertions:
  ```typescript
  assert.deepEqual(report.models.map(g => [g.provider, g.model, g.usage.totalTokens]), [['p2', 'mA', 11], ['p1', 'mB', 7], ['p1', 'mA', 5]]);
  assert.equal(report.usage.totalTokens, 23);
  assert.equal(filtered.models.some(g => g.model === 'zero-only' || g.model === 'outside-window'), false);
  assert.equal(filtered.models.some(g => g.model === 'positive-input-zero-total'), true);
  assert.equal(filtered.models.some(g => g.model === 'positive-total-zero-components'), true);
  ```
- [ ] **Step 2: Add failing display and integration regressions.** Change formatter fixture to models, assert full provider/model labels, all integer detail fields, two-place rate and unknown labels, no old provider section, no diagnostic text. Test legacy report carrying providers but no models renders overall only. Update command integration to cover one provider using different models and one model used by different providers, hidden partial-tail diagnostics, cached repeat equality, and a zero-use model absent from TUI/RPC. Update real Pi RPC fixture to include two used provider/model pairs, one all-zero model and one model used 48h ago; `/tokens 24h` must retain total 123 and rates 81.30% / 97.09% / 0.00%, show only used pairs, emit no warning block or agent_start, and exit 0.

  Core test names: `model report replaces provider breakdown without unused placeholders`, `legacy provider report renders overall only`, `live RPC lists only used provider-model pairs`. Core assertions on the emitted notification:
  ```typescript
  assert.ok(text.includes('provider-a/model-a') && text.includes('provider-b/model-a'));
  assert.ok(text.includes('缓存命中率：81.30%'));
  assert.equal(text.includes('unused-model') || text.includes('old-model') || text.includes('按 provider 统计'), false);
  assert.equal(text.includes('数据存在缺失或不精确部分'), false);
  ```
- [ ] **Step 3: Run RED.** `cd pi-token-usage && node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/query.test.ts test/format.test.ts test/extension.test.ts test/integration.test.ts`. Expected: missing models, obsolete provider rendering or unused-model assertions fail for feature reasons, not fixture syntax.
- [ ] **Step 4: Implement the report interfaces together.** Replace provider grouping with structured model grouping, keep checked summation and filter/sort rules above. Switch formatter to models; preserve overall, source text, cache rate function, hidden warnings and true errors. Update typed report fixtures consistently so no intermediate broken consumer remains.
- [ ] **Step 5: Run GREEN and final checks.** `cd pi-token-usage && npm test && npm run typecheck && npm pack --dry-run`; then `git diff --check`. Expected: all exit 0, no skipped new regressions, actual Pi RPC and bundled loader still pass. Verify cold and cached synthetic model groups agree and no unused or old provider section is rendered.
- [ ] **Step 6: Document and checkpoint.** Update README from provider-only to provider/model display, used-only rule, unknown model behavior, protocol 4 rebuild and old-report compatibility. Record observed verification results, not hypothetical counts or manual TUI claims. Commit only scoped source/tests/docs after `git diff --check`.

## Execution Handoff

Wait for plan approval. Preserve direct implementation in this session and the existing isolated worktree preference; no new independent-agent dispatch is authorized by this plan. At execution, invoke executing-plans/worktree/TDD/verification skills, read applicable Pi API/session docs, and keep a plan-specific ledger. After implementation, perform a separate author review, synchronize `docs/archive/token-usage/archive.md`, then use finishing-a-development-branch for the user's integration decision. Do not assume merge, push or /reload approval from implementation approval.
