# Token Usage Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低目录发现和重复查询成本，同时保持历史统计结果与覆盖边界。

**Architecture:** 目录按有界分层批次发现，利用 Dirent 避免逐文件 lstat；扩展实例持有限额 SnapshotCache，collector 仍逐文件检查源数据，并继续使用协议 4 磁盘快照。最终报告不缓存。

**Tech Stack:** TypeScript、Node.js >=22.19.0、node:test，无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-09-token-usage-performance-design.md`

## Global Constraints

- 目录最多 8 路处理，文件读取仍最多 4 路；不创建无界 Promise，不跟随内部符号链接，保留根目录真实路径与重叠去重。
- 每实例内存额度为序列化统计元数据估算的 64 MiB、最多 4096 文件；不宣称精确堆内存上限，不存正文或最终报告。
- 保留快照协议 4、追加/重建校验、事件时间窗口、去重、继承历史及子代理协调；不按文件年龄跳过历史。
- 磁盘保存失败不得通过内存命中掩盖诊断或阻止后续重试。
- 不新增用户设置、依赖、命令、后台监视器或模型调用，不修改 settings。
- 本会话隔离实现、无新子代理；作者自检不冒充独立审查。合入、推送和 reload 另行确认。

## Review Focus

1. 根目录文件、多个重叠根以及中途目录变成符号链接：保持候选集和不跟随边界（Task 1）。
2. 目录工作队列先只有一个根：不能因空闲 worker 提前退出而退化为全程串行；宽目录并发需大于 1 且不超过 8（Task 1）。
3. 超大项、零额度、同对象重复 set 与跨 cacheDir 同源文件：容量计重正确、不误共享、不无界保留（Task 2）。
4. 磁盘写入失败后恢复，以及读源失败/删除后重建：不能永久使用未落盘内存快照或继续累计旧用量（Task 3）。
5. 并发查询、移动窗口及源文件追加/同大小改写：复用快照不等于复用最终报告，统计必须仍与无内存模式一致（Task 3）。

## File Structure

- Modify `pi-token-usage/src/reader.ts`：有界目录发现；readUsageFile 的元数据/追加判断保持不变。
- Create `pi-token-usage/src/memory-cache.ts`：SnapshotCache，单一职责为限额快照保留。
- Modify `pi-token-usage/src/cache.ts`：重导出 SnapshotCache，原有磁盘实现保持。
- Modify `pi-token-usage/src/{collector,index}.ts`：可选内存存储与每实例生命周期。
- Modify `pi-token-usage/test/{reader,cache,extension}.test.ts`; Create `pi-token-usage/test/memory-cache.test.ts`。
- Update README、verification、性能报告；产品验证后独立同步 docs/archive。

### Task 1: 有界并发目录发现

**Interfaces:** Preserve `discoverFiles(roots: string[]): Promise<{ files: string[]; warnings: string[] }>` and its exports. No new user-facing options.

- [x] **Step 1: Add failing tests.** In reader.test.ts instrument real `node:fs/promises` calls using mock.method and syncBuiltinESMExports, restoring bindings after each test. Assert ordinary child files receive zero explicit lstat calls; a broad tree has peak readdir concurrency `> 1 && <= 8`. Keep real filesystem results, roots/links deduplication and sorting assertions. Add explicit root-file, deep tree and non-root POSIX discovery permission tests.
- [x] **Step 2: Run RED.** `cd pi-token-usage && node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/reader.test.ts`. Expected failure: redundant file checks and peak concurrency 1, not fixture/import failures.
- [x] **Step 3: Implement discovery.** Process directory frontiers with at most 8 workers, checking directory lstat before readdir, classifying children via Dirent, deduplicating paths and sorting results. Preserve direct file roots, missing paths and warnings. Avoid a dynamic worker loop that loses concurrency when initial queue length is one.
- [x] **Step 4: Run GREEN.** Repeat reader test and `npm test && npm run typecheck`. All exit 0, no new skipped regressions on this POSIX host.
- [x] **Step 5: Commit.** Diff check, then scoped reader/source tests commit.

### Task 2: 限额快照存储

**Interfaces:** Create `SnapshotCache` in memory-cache.ts and re-export from cache.ts. Constructor `(options?: { maxBytes?: number; maxEntries?: number })`, defaults `64 * 1024 * 1024` and `4096`; safe nonnegative integers only, zero disables retention. Methods `get(cacheDir: string, path: string): FileSnapshot | undefined`, `set(cacheDir: string, snapshot: FileSnapshot): void`, `delete(cacheDir: string, path: string): void`, `prune(cacheDir: string, paths: Set<string>): void`; read-only `size: number`, `bytes: number` describe retained entries and serialized-byte accounting.

- [x] **Step 1: Add failing tests.** New memory-cache.test.ts imports cache module as namespace so absence of SnapshotCache is a clear feature assertion. Assert get returns exact stored snapshot, constructor defaults/invalid limits, key isolation across cacheDir and instances, access-order eviction at maxEntries=2, serialized weight under maxBytes, oversized replacement drops old entry, zero retention, repeated same-object set does not double-count, delete and namespace-specific prune update counters correctly.
- [x] **Step 2: Run RED.** Run only memory-cache.test.ts. Expected failure: missing SnapshotCache constructor.
- [x] **Step 3: Implement storage.** Use structured namespace/path keys and a Map in access order. Weight via UTF-8 JSON serialized snapshot bytes only on new/changed object; skip oversized admission and evict until both limits satisfied. Keep raw conversation content out by accepting FileSnapshot only.
- [x] **Step 4: Run GREEN.** Targeted tests then full suite and strict typecheck, all exit 0.
- [x] **Step 5: Commit.** Diff check; commit only cache primitive, export and tests.

### Task 3: 集成快照复用与一致性验证

**Interfaces:** Add optional `memoryCache?: SnapshotCache` to collectUsage options; existing callers stay valid. index.ts creates one SnapshotCache per extension factory invocation. Other command/report interfaces unchanged.

- [x] **Step 1: Add failing tests.** Extend cache.test.ts: warm query then replace on-disk cache JSON with a directory causing EISDIR; in-memory repeat must match original totals/models and avoid cache-read fallback warnings. Restore cache files afterward. Compare memory/no-memory reports under fixed endpoints for append, replacement, same-size rewrite, deletion, reappearance, changing windows and parallel calls. Simulate cache unwritable via file-not-directory then restore directory: warnings persist while blocked, then disk snapshot appears and warnings clear. Add separate extension instances assertion so one instance cannot inherit another's memory store.
- [x] **Step 2: Run RED.** Run cache/extension tests; expected new reuse assertion fails because collector reloads disk and records a fallback warning.
- [x] **Step 3: Implement integration.** Prune only current namespace against discovered paths; prefer memory snapshot, otherwise disk load. Always call readUsageFile to verify source metadata and preserve existing incremental logic. Admit unchanged valid cached snapshot or successfully saved new snapshot; evict on source-read or disk-save failure so future queries retry. Rebuild all reconciliation/window aggregation on every call. Create store inside extension factory, not globally.
- [x] **Step 4: Verify and benchmark.** `npm test && npm run typecheck && npm pack --dry-run && git diff --check`. Use isolated caches and fixed synthetic sources for before/after/cold/warm equality; real history compare current sources from one frozen metadata view where possible, detect rather than hide concurrent changes. Report actual warm-disk, memory-repeat and discovery timings, not promised speedups. Include real RPC and bundled loader.
- [x] **Step 5: Document and commit.** Record capacity/invalidations, unchanged coverage, observed results and review limits; commit scoped implementation/tests/docs. Author-only final review, then archive sync in its own commit before integration menu.

## Execution Handoff

User approved the design and explicitly authorized plan creation followed by direct execution without another plan-confirmation round. Preserve inline execution and isolation. Self-review: all design sections map to Tasks 1–3; interfaces/types agree; review-focus cases have owning tests; no new delegation authorized.
