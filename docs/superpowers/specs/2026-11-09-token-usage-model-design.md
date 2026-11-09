# 按 provider/model 展示用量设计

状态：用户已批准，2026-11-09；按 provider/model 区分。

## 目的

将现有 `/tokens xh`、`/tokens xd` 报告的 provider 明细替换为 model 明细，展示实际使用的模型及其缓存效果，不列出配置中未使用的模型。

## Approaches

- 按 model ID 跨 provider 合并：条目更少，但无法比较同名模型在不同渠道的用量和缓存效果。不采用。
- 按 provider/model 组合区分：保留渠道差异。同名模型在不同 provider 下各一项，用户已选择此方案。
- 不增加命令、筛选参数或独立 provider 汇总区块，复用现有报告。

## 用户可见行为

- 保留整体总量、输入、输出、缓存读取、缓存写入、整体缓存命中率和来源说明。
- 模型明细显示 provider/model、总 token、输入、输出、缓存读取、缓存写入、缓存命中率。
- 仅从查询时间窗口内已读取、有效、去重及协调后的用量记录生成条目，不枚举配置或模型目录；任一 token 分项或 totalTokens 大于 0 才展示该组合。全零、仅窗口外使用或从未使用的组合不展示。
- 按总 token 降序；同量按 provider、model ID 稳定排序，缺失归属同量置后。分组身份用结构化二元组，不用简单字符串拼接，以免含斜杠的名称碰撞。
- 缓存命中率仍为 `cacheRead / (input + cacheRead + cacheWrite) × 100%`，先汇总再计算，保留两位小数，零分母显示 `—`。
- provider 与 model 只取用量记录自身明确归属，不从当前模型、邻近消息、父代理或路径推断；缺少信息分别显示未知渠道、未知模型。未知用量实际存在才显示未知组合，不能漏掉总量或虚构已知模型。
- 子会话真实记录保留自身 provider/model；无法确认归属的子代理汇总及未覆盖差额不继承父代理的模型。
- 整块精度警告继续隐藏，内部诊断保留；无效参数和真正查询失败仍提示。报告继续不进入模型上下文，不触发模型调用。

## 实现者的选择与边界

- 在现有最小统计记录中新增可选 model；从 assistant/toolResult 的 message.model 或独立 usage/summary 的 entry.model 读取，不改变原始事件身份。
- 新报告保存 models 分组，移除新报告的 providers 汇总。已保存旧报告没有 models 时只展示整体统计，不将 provider 明细冒充 model 明细。
- 文件快照协议升级到 4，目录仍为 cache-v1；旧缓存从源记录自动重建，首次查询可能重新扫描历史。只新增模型 ID 元数据，仍不保存正文。
- 沿用现有 TypeScript、Node 内置测试与 Text renderer，不新增依赖，不改 settings，不覆盖 pi-qser3ne-patch/AGENTS.md 的现有改动，不推送远程。

## 验收

验证同模型不同 provider 分开、同 provider 多个 model 分开、同组合跨会话累计、含斜杠名称不碰撞、全零与窗口外模型不显示、未知归属与子代理差额不误归属、旧缓存重建与追加、旧报告兼容，以及 TUI/RPC 明细与隐藏警告。完整测试、类型检查和打包预检通过后再交付。
