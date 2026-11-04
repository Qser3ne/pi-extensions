# pi-extensions

Pi 插件的开发工作区，包含以下独立插件仓库：

| 子模块 | 远程仓库 |
| --- | --- |
| `pi-qser3ne-patch` | [Qser3ne/pi-qser3ne-patch](https://github.com/Qser3ne/pi-qser3ne-patch) |
| `pi-herdr-ask` | 本地独立子仓库，尚未配置远程；桥接提问等待状态到 herdr |

原 `pi-daybreak`、`pi-token-speed` 的代码、测试及完整 Git 提交历史已合并进入 `pi-qser3ne-patch`，不再作为独立子模块。统一包只有一个扩展入口 `src/index.ts`，提供：

- Codex 双账号、Fast 兼容和订阅额度显示。
- Daybreak Blue 开关及服务端确认状态。
- 实时 token 速度、TTFT 和长窗口平均速度。

详细使用说明见 [pi-qser3ne-patch/README.md](pi-qser3ne-patch/README.md)。旧 GitHub 仓库不删除，但后续统一在新仓库维护。

## herdr 提问状态扩展

`pi-herdr-ask/` 仅接入 `ask_user_question`，提问期间上报 `blocked/question`，回答或取消后恢复 Pi 原生状态。安装：

```bash
pi install /home/qser3ne/application/pi-extensions/pi-herdr-ask
# 然后在 Pi 执行 /reload
```

详见本地 `pi-herdr-ask/README.md`。该目录有独立 Git 历史，父仓库暂时忽略其内容；尚未发布远程，因此克隆父仓库不会获得它。配置远程后再登记为正式子模块，避免提交不可克隆的子模块地址。

## 安装统一补丁到 Pi

开发目录与 Pi 管理的 Git 安装副本相互独立。先推送插件仓库，再固定到审核过的提交安装：

```bash
commit=$(git -C pi-qser3ne-patch rev-parse HEAD) || exit 1
pi install "git:github.com/Qser3ne/pi-qser3ne-patch@$commit"
```

迁移旧安装时，用 `pi list` 查找 `pi-daybreak`、`pi-token-speed` 或旧名 `pi-sub2api-usage` 的完整来源，分别执行 `pi remove <完整旧来源>`，避免重复加载。独立 `@narumitw/pi-usage` 保留 `extensions: []` 配置，因为统一插件已内置其兼容模块。

若还有手动安装的 `~/.pi/agent/extensions/daybreak/` 或速度统计入口，请先备份并移出自动发现目录。最后在当前 Pi 会话执行 `/reload`；凭据、Fast 偏好和 Daybreak 会话状态无需迁移。

## 克隆与同步

```bash
git clone --recurse-submodules git@github.com:Qser3ne/pi-extensions.git
cd pi-extensions
git pull --ff-only
git submodule update --init --recursive
```

父仓库记录统一插件的固定提交；子模块处于 detached HEAD 是正常现象。更新前确保没有未提交的开发改动。

## 开发与发布

需要 Node.js >=22.19.0：

```bash
cd pi-qser3ne-patch
git switch main
npm ci
npm run typecheck
npm test
# 修改、测试并提交后：
git push origin main

cd ..
git add pi-qser3ne-patch
git commit -m "Update unified patch extension"
git push origin main
```

必须先推送子仓库，再推送父仓库指针；然后更新 Pi 安装提交。开发源码变化不会自动同步到已安装副本。

```bash
git status
git submodule status
```

不要手动删除子模块 `.git` 文件；其 Git 数据由父仓库 `.git/modules/` 管理。
