# 本地 Git 工作流（Windows）

本仓库是 `deepseek-ai/dsh-superagent-prototype` 的本地源码树，由 dsh `web` profile 以
`link:D:/aiworkspace/dsh-superagent-prototype` 加载。运行时读取 `lib/`，因此改源码后必须重新构建。

## 分支与标签

| 名称 | 用途 |
|---|---|
| `main` | 上游原型提交 `8c32a9d`，保持原样，不直接提交 |
| `windows-adapt` | 本地集成分支：Windows 适配 + schedule 来源 + Claude Code 桥接；日常修改在此提交 |
| `baseline-20261104` | 建立 Git 基线时的标签（行尾规范化后） |

功能开发建议从 `windows-adapt` 拉短分支：

```powershell
git switch -c feat/my-change windows-adapt
# ... 修改、构建、测试 ...
git add -A
git commit -m "feat: ..."
git switch windows-adapt
git merge --no-ff feat/my-change
```

## 日常检查

```powershell
git status --short
git diff --stat main          # 相对上游的真实改动
git log --oneline --decorate -10
```

如果 `git diff` 突然出现大量整文件差异，先判断是否为行尾噪声：

```powershell
git diff --ignore-cr-at-eol --stat
```

本仓库使用 `.gitattributes` 把文本归一化为 LF；`*.cmd/*.bat/*.ps1` 保持 CRLF，无需手工转换。

## 构建与重载

本机 pnpm 会尝试解析 `packageManager: pnpm@11.7.0`，而公司 Artifactory 返回 404；当前先用本地二进制：

```powershell
node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit
node_modules\.bin\vitest.cmd run
node_modules\.bin\tsdown.cmd
```

如果之后安装了 pnpm 11.7.0 或切换了可用源，也可以：

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test
pnpm.cmd run build
```

`lib/` 是构建产物，已被 `.gitignore` 忽略，不提交。构建完成后让 dsh 重新加载
`dsh-superagent` 插件（或在 dsh Web GUI 中禁用/启用该插件；必要时冷启动 3080）。

## 工作区约定

- **源码修改工作区**：`D:\aiworkspace\dsh-superagent-prototype`
- `D:\aiworkspace\superagent-source-20261104`：来源机拷贝，只读参考，不要在这里改。
- `D:\aiworkspace\dsh-superagent-prototype-backup-20261104-1640`：合并前备份，只读。
- `D:\aiworkspace\superagent-playground`：搭建记录与补丁，不是插件源码。
- `D:\aiworkspace\workenvfix`：环境排障档案与工具，不是 superagent 源码。

## 提交身份

本仓库使用仓库级身份（`git config --local`）：

```powershell
git config user.name
git config user.email
```

如需修改，只影响本仓库；不要改 dsh 注入的全局 `worker-gitconfig`。
