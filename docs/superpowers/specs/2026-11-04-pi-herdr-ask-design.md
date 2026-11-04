# pi-herdr-ask：提问等待状态桥接

状态：待用户批准设计。用户已选择“仅提问工具”范围。

## 目标

新增独立 Pi 扩展，让当前 `ask_user_question` 等待用户回答期间，herdr 显示 `ask` 而不是 `working`。回答、取消或异常结束等待后恢复正常状态。

## 已确认的现状与根因

- 当前安装 `@juicesharp/rpiv-ask-user-question@2.15.0`。
- 问卷通过 `ctx.ui.custom()` 显示，未传入 Pi 原生状态上报所需的 `blocked` 选项。Pi 的该选项还不适用于 overlay。
- 提问插件已公开 `rpiv:ask-user:blocked` 事件，载荷为 `{ active, toolCallId }`，并在 finally 中结束等待；目前没有桥接该事件的扩展。
- 当前 herdr-core 为 0.1.14；当前会话使用 `HC_TERMINAL_ID` 和 OSC 7501。core 返回的状态为 `{ app: "pi", state: "working" }`。
- `~/.pi/agent/extensions/herdr-agent-state.ts` 是旧版 HERDR 环境/socket 托管集成，当前会话未启用，不能通过仅转发 `herdr:blocked` 解决。
- 当前协议的等待状态是 `blocked`，问题类型是 `question`，不是直接发送 `state=ask`。herdr 界面是否显示目标文案 `ask` 必须通过实际验收确认。

## 方案比较

1. **独立扩展接入提问插件的等待事件（已选择）**：范围精确，兼容问卷重挂载及 overlay；不修改上游源码。需要处理与 Pi 原生状态上报的恢复和覆盖关系。
2. **接入所有 `ui_prompt_start/end`**：覆盖范围更广，但会把非问卷自定义界面纳入；用户未选择。
3. **修改提问插件或 Pi 内核**：可以从上游修复，但不符合本次新增独立扩展的交付方式，升级也可能覆盖修改。

## 设计

- 在本工作区新增独立 TypeScript 包 `pi-herdr-ask/`，不合并到现有 `pi-qser3ne-patch`，不修改托管集成和提问插件。目录与语言是实现建议，不是用户单独指定的要求。
- 接收 `rpiv:ask-user:blocked`，按 `toolCallId` 保存未完成问卷集合；重复开始/结束幂等，未知结束事件不误清理其他问卷。
- 有问卷等待时，向当前交互终端上报 OSC 7501 `state=blocked:app=pi:kind=question`；不发送问题正文、选项或回答等敏感内容。
- 最后一个问卷结束时恢复当时应有的状态；普通运行仍由 Pi 负责 `working/done/error/idle`。实现时验证事件顺序，避免原生上报覆盖等待状态或结束后残留 `ask`。
- 会话关闭、重载时移除监听并清理扩展拥有的等待状态，不影响其他扩展。
- 只在 herdr 交互式 TUI 环境工作；RPC、print/JSON、子代理非交互进程不写终端控制序列。
- 当前版本仅支持已确认的 HC/OSC 路径；不额外实现旧版 HERDR socket 协议，也不增加轮询或常驻子进程。

## 验证与交付

- 单元测试：等待开始/结束、重复事件、并发问卷、无关事件、取消/异常清理、重载/关闭，以及非 TUI 环境无输出。
- 集成测试：使用真实 Pi 事件与 herdr-core 观察 `working → blocked(question) → working`，并检查运行最终状态不被覆盖。
- 人工验收：真实提问界面打开时 herdr 显示 `ask`，回答或 Esc 取消后恢复；若无法观察 GUI，明确保留此项未验证，不宣称完成。
- 提供包入口、测试、README 安装/卸载步骤；需要 `/reload` 才能让当前会话加载扩展。
