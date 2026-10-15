# pi-extensions

使用 Git Submodule 汇总管理独立的 Pi 扩展仓库。父仓库只记录各子仓库的地址和固定提交，不复制其完整历史。

| 子模块 | 远程仓库 |
| --- | --- |
| `pi-sub2api-usage` | [Qser3ne/pi-sub2api-usage](https://github.com/Qser3ne/pi-sub2api-usage) |
| `pi-token-speed` | [Qser3ne/pi-token-speed](https://github.com/Qser3ne/pi-token-speed) |

## 克隆

将 `<父仓库地址>` 替换为此仓库发布后的远程地址：

```bash
git clone --recurse-submodules <父仓库地址>
```

子模块使用 SSH 地址，需要具备相应的 GitHub SSH 访问权限。

如果已经克隆了父仓库，在父仓库根目录执行：

```bash
git submodule update --init --recursive
```

## 同步父仓库记录的版本

```bash
git pull --ff-only
git submodule update --init --recursive
```

这会检出父仓库固定的子模块提交，不一定是子仓库最新版本；子模块处于 detached HEAD 状态是正常的。

## 修改子模块

先进入对应子模块，切换到工作分支，再按普通仓库的流程修改、测试、提交和推送。例如：

```bash
cd pi-token-speed
git switch main
# 修改并测试后：
git add <修改的文件>
git commit -m "Describe extension changes"
git push origin main

# 回到父仓库，记录新的子模块提交：
cd ..
git add pi-token-speed
git commit -m "Update pi-token-speed submodule"
# 配置父仓库远程地址后再推送：
git push origin main
```

应先推送子仓库提交，再推送父仓库指针，避免其他人无法获取对应提交。

## 将子模块升级到远程 main

以下命令会改变父仓库记录的版本，应确保子模块没有未提交改动，并在检查、测试后提交：

```bash
git -C pi-sub2api-usage fetch origin
git -C pi-sub2api-usage switch main
git -C pi-sub2api-usage merge --ff-only origin/main

git -C pi-token-speed fetch origin
git -C pi-token-speed switch main
git -C pi-token-speed merge --ff-only origin/main

git add pi-sub2api-usage pi-token-speed
git commit -m "Update extension submodules"
```

## 查看状态

```bash
git status
git submodule status
```

不要直接删除子模块中的 `.git` 文件；实际 Git 数据存放在父仓库的 `.git/modules/` 下。若要把子模块拆回独立目录，需要先迁移其 Git 数据。
