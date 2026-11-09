# provider/model 用量报告交付

## 实现

- 仅从本机历史读取明确的 provider/model；字段缺失显示未知，不借用父代理或模型选择。
- 模型明细替换 provider 区，保留整体统计和输入侧缓存命中率；同名模型跨渠道分开。
- 仅列出查询窗口内任一 token 字段为正的组合；全零、仅窗口外、未使用模型不占位。
- 二元组身份避免斜线、unknown、原型键碰撞；总量降序，同量完整归属优先、名称稳定排序。
- 文件快照协议 4，目录仍 cache-v1；旧快照自动重建，追加保留 model；不缓存正文。
- 子代理汇总及差额清除父 provider/model；旧报告缺 models 时只显示整体，不将 providers 冒充模型。
- 命令、总量口径、去重、隐藏警告与真正错误提示不变；未修改设置、未推送、未执行 /reload。

## 提交与证据

- 设计/计划：aafe476。
- Task 1：04865ec；RED 6 项失败后，定向 38 项及完整 60 项通过。
- Task 2：1bae4f4；RED 13 项失败后，定向 27 项及完整 65 项通过，0 失败、0 跳过。
- 严格 TypeScript、npm pack --dry-run 和 git diff --check 通过。
- 实际 Pi RPC：/tokens 24h，仅 provider-a/model-a、provider-b/model-a；总量 123，缓存率整体 81.30%、分组 97.09%/0.00%；全零 unused-model 与 48 小时前 old-model 不显示，无精度警告、无 agent_start，退出 0。
- mock TUI/RPC：三种实际组合、全零隐藏、重复缓存查询相等、底层诊断仍保存。
- 真实 bundled loader、跨进程并发缓存、POSIX 权限拒绝、包内容测试均通过。

## 作者自检

本轮按批准的边界未委派新审查，只有本会话作者单独自检，不能称为独立审查。检查 f977f9d..1bae4f4 的读取、缓存、协调、聚合、格式化、入口消费者与回归，未发现需修复的问题。其保证弱于 fresh-context 独立审查。

未做手动交互式 TUI /reload、崩溃/断电、其他 Pi 版本/平台测试，未重新测量真实历史性能；不以先前版本耗时冒充本轮结果。远程账单核对不在本地历史统计范围。

## 行为档案

文件：docs/archive/token-usage/archive.md（单独提交 d77c6c5）。

- 修改：provider/model 分组与缓存命中率（替换旧 provider 分组）；报告不进入模型上下文中的模型展示与旧报告兼容场景；可重建增量缓存中的模型字段与协议 4。
- 新增：仅展示窗口内实际使用的模型；同渠道不同模型、同模型不同渠道的组合身份场景。
- 删除：无独立 Requirement 被直接删除，旧 provider 分组条目已改名并改写。
- 模型自行决定的新产品行为：无；排序、未知归属及兼容边界均来自已批准计划。
- 全局检索 docs/archive 仅发现 token-usage 受影响；旧 provider 标题、未知 provider 标签、协议 3 等过时术语无残留。合法的 provider 字段及旧 providers 报告兼容说明保留。
- 范围外档案不一致：未发现。

## 集成状态

用户选择本地合入 main 后，已从 f977f9d 快进合入 ea7c567。合并后的主工作区重新验证：65/65 测试通过、0 跳过，严格类型检查、npm 打包预检与 diff 检查均通过。未推送、未执行 /reload，主工作区的 pi-qser3ne-patch 与 AGENTS.md 未改动。现有隔离 worktree 及其分支继续保留，不删除其中的历史执行记录。
