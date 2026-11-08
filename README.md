# pi-extensions

Pi 扩展集合与开发工作区。已发布扩展拥有独立仓库，通过 Git submodule 管理；开发中的本地扩展可直接从目录加载。

## 扩展目录

| 扩展 | 功能 | 仓库 |
| --- | --- | --- |
| `pi-qser3ne-patch` | Codex 账号与额度、Fast 支持、Daybreak Blue 控制、响应速度统计 | [GitHub](https://github.com/Qser3ne/pi-qser3ne-patch) |
| `pi-herdr-ask` | 将 Pi 提问状态同步到 herdr | [GitHub](https://github.com/Qser3ne/pi-herdr-ask) |
| `pi-communication` | 同机独立 Pi 会话间的发现、请求与显式回复 | [GitHub](https://github.com/Qser3ne/pi-communication) |
| `pi-token-usage` | 查询所有渠道、跨项目的本机历史 token 用量 | 本地开发，尚未发布 |

### pi-qser3ne-patch

面向 Pi 的账号、服务状态与性能体验扩展，提供：

- Codex 双账号支持、Fast 兼容和订阅额度显示。
- Daybreak Blue 开关及服务端确认状态。
- 实时 token 速度、首 token 延迟（TTFT）和长窗口平均速度。

配置与使用方式见 [pi-qser3ne-patch/README.md](pi-qser3ne-patch/README.md)。

### pi-herdr-ask

连接 Pi 的 `ask_user_question` 与 herdr 状态显示：提问期间上报 `blocked/question`，回答或取消后恢复 Pi 原生状态。

环境要求与使用方式见 [pi-herdr-ask/README.md](pi-herdr-ask/README.md)。

### pi-communication

让同机、同一系统用户下已打开且启用扩展的 Pi 会话互相发现，通过 Unix socket 发送请求并显式回复。

- 模型工具：`peer_list`、`peer_send`、`peer_reply`、`peer_status`。
- 用户命令：`/peers`、`/peers pause`、`/peers resume`。
- 支持忙时排队、steer 投递和一次性空闲通知。
- 不启动会话，不自动重试业务任务；普通模型回答不会自动转发。

来信不构成用户授权，接收会话仍须遵守自身权限。运行环境、操作示例与安全边界见 [pi-communication/README.md](pi-communication/README.md)。

### pi-token-usage

通过 `/tokens 24h`、`/tokens 7d` 等查询本机所有项目、会话及渠道的已保存用量，包含缓存明细，支持自定义正整数小时或天数。历史扫描配合增量缓存，不调用模型。

临时试用：`pi -e ./pi-token-usage/src/index.ts`。完整统计口径和本地安装方式见 [pi-token-usage/README.md](pi-token-usage/README.md)。该包尚未发布，不适用下面的 Git 固定版本安装命令。

## 环境要求

- Git。
- Node.js >=22.19.0。
- Pi；`pi-communication` 要求 Pi >=1.5.0。
- 开发依赖、平台限制及外部服务要求以各扩展 README 为准。

## 获取工作区

克隆仓库及全部子模块：

```bash
git clone --recurse-submodules https://github.com/Qser3ne/pi-extensions.git
cd pi-extensions
```

同步工作区：

```bash
git pull --ff-only
git submodule update --init --recursive
```

父仓库固定各扩展的提交版本。子模块处于 detached HEAD 是正常状态；同步前请确认没有未提交的开发改动。

## 安装到 Pi

在工作区根目录选择扩展，并固定到工作区记录的提交安装：

```bash
# 可选：pi-qser3ne-patch、pi-herdr-ask、pi-communication
extension=pi-communication
commit=$(git -C "$extension" rev-parse HEAD) || exit 1
pi install "git:github.com/Qser3ne/$extension@$commit"
```

安装后，在需要使用扩展的 Pi 会话中执行 `/reload`。会话通信需要每个参与会话都加载 `pi-communication`。

Pi 管理的安装副本与开发目录相互独立。更新工作区不会自动更新已安装的扩展；安装指定版本时，该提交必须已推送到对应远程仓库。可使用 `pi list` 查看安装来源，使用 `pi remove <完整来源>` 卸载扩展。

## 开发与发布

1. 进入对应子模块，切换到开发分支。
2. 按该扩展的 README 安装依赖、修改代码并运行验证。
3. 在子仓库中提交改动并推送。
4. 回到工作区根目录，提交并推送子模块指针。

例如，发布 `pi-communication` 的已提交改动：

```bash
# 在子仓库推送开发分支
cd pi-communication
git push origin HEAD

# 在父仓库记录该扩展的提交
cd ..
git add pi-communication
git commit -m "Update pi-communication reference"
git push origin HEAD
```

必须先推送子仓库，再推送父仓库指针，确保其他人能够获取对应提交。需要将发布版本加载到 Pi 时，按安装步骤固定提交安装并执行 `/reload`。

检查工作区与子模块状态：

```bash
git status
git submodule status
```

子模块的 Git 数据由父仓库 `.git/modules/` 管理，不要手动删除子模块目录中的 `.git` 文件。
