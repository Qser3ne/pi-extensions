# Token 命令与当前模型过滤交付

## 范围与结果

- 基线 main=58e01f0；隔离 worktree `/home/qser3ne/.cache/pi-worktrees/pi-extensions/token-usage`，分支 feat/token-usage-current-models。
- 用户选择当前 /model 默认范围，补充 `/tokens` 改为 `/token`，最终批准设计和计划、确认本会话直接实现。
- `/token-usage` 固定滚动近 24h，无参数；`/token xh`、`/token xd` 保留正整数及单位规则；仅注册两个新命令，不保留旧别名。
- 有非空 scopedModels 时用该范围，否则 getAvailable 本地快照；逐次复制名单，不刷新目录、不解析认证、不调用模型。
- 白名单按 provider/model ID 二元组精确匹配，在完整继承/子代理协调之后过滤，总量、记录数、明细、缓存率口径一致；未知及名单外记录不计入新查询。
- 空名单显示零，名单读取异常显示查询 error，不能退回无过滤统计。内部 collectUsage 缺省 allowedModels 保持旧无过滤能力，但两个用户命令均显式传入名单。
- 完整文件/内存快照保留，不变更协议 4；切换名单可重新纳入先前排除的历史。新报告 scope=current-models；旧报告不被误标为已过滤，不重算，不恢复脚注或警告块。

## TDD 与验证

- 基线 83/83 与 typecheck 通过。
- Task 1：先观察 5 个过滤断言失败；定向 5/5、全量 88/88、严格类型检查通过。提交 a15c280。
- Task 2：先观察 12 个命令/范围/RPC/loader 回归失败；定向 20/20、全量 92/92、严格类型检查、打包预检与 diff 检查通过。提交 5610627。
- 真实 RPC：先读取 get_commands，避免把尚不存在的命令误发给模型；在离线假凭据夹具中依次执行两个新命令。provider-a/model-a 与 provider-b/model-a 合计 123，整体缓存率 81.30%；名单外 provider-c/model-a 的 700 不计入；两份成功报告、零 agent_start、进程退出 0。
- 完整 suite 还覆盖：同名跨渠道/斜线/null/unknown/原型键、空名单、重复名单、当前范围切换、名单读取异常、混合子模型与未知差额、继承复制、完整两级缓存、旧范围展示及已有追加/替换/删除/权限/并发测试。0 失败、0 跳过。
- 收尾 shell 曾因 brace group 内 cd 泄漏父 cwd 导致读取相对日志失败；日志中的全量测试实际已通过。改用绝对工作区路径/子 shell 并重新完成 task-done 验证；无产品修补。

## 作者自检

单独一遍核对 58e01f0..5610627 产品及测试 diff、SDK picker 默认逻辑、五项 Review Focus、文档和兼容路径；未发现 Critical/Important。仅本会话作者自检，不是独立或 fresh-context 审查，无新增子代理。

## Rulings I made

1. 流程脚本用本计划 scratch 可执行副本：共享脚本无执行位，不修改已安装技能；若错误只影响流程记账，不影响产品。
2. 人工 live TUI、其他 Pi/OS 及原始冷历史性能不作验证保证：本轮实际覆盖为当前宿主接口、mock UI、真实 RPC/loader；代价是这些环境仍需单独验收，不能由 92 项通过推断。
3. 未注册的旧 `/tokens` 不由本扩展拦截：遵循批准的改名及“仅两个命令”设计；代价是继续输入旧命令可能被 Pi 当作普通提示词并触发模型，请使用新命令。

## Deferred minors

本轮未新增。

## 行为档案同步

- 文件 `docs/archive/token-usage/archive.md`；独立提交 eb301d0。
- 新增 Requirement：当前模型名单过滤（精确身份、当前范围变化、空名单、失败、完整协调及完整缓存）。
- 修改 Requirement：查询命令、本机覆盖边界、provider/model 归属、报告范围兼容；单一查询命令重命名为用量查询命令。
- 移除旧条目中的 `/tokens` 接口、禁止独立快捷命令、未知组合继续计入新查询、所有来源均参与统计等失效描述；未删除无关 Requirement。
- 作者提出并经用户批准的行为：未知归属排除、空名单零结果、旧报告 scope 兼容、快捷命令拒绝参数；并非未告知的执行裁决。执行期脚本及覆盖保证裁决不改变产品行为。
- 已检索整个 docs/archive，旧接口和失效口径无残留；本轮范围外未发现需报告的不一致。

## 集成状态

用户选择本地合入 main，已从 58e01f0 快进至 cfc55a0；合入后主工作区再次验证 92/92 测试（0 失败、0 跳过）、严格类型检查、打包预检及 diff 检查，均通过。未推送、未执行 /reload、未改全局 settings。原有隔离 worktree 与分支保留；主工作区原有 pi-qser3ne-patch 改动与 AGENTS.md 保持不变。
