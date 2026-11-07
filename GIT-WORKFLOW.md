# 本地 Git 工作流（Windows）

本仓库是 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
的 Windows 修改版，由 DSH profile 以 `link:<本仓库绝对路径>` 加载。运行时读取构建产物 `lib/`，
因此改完 `src/` 必须重新构建，再让 DSH 重新加载插件。

远端：`origin` = `https://github.com/vHao11/dsh-superagent.git`（个人仓库），
`upstream` = `https://github.com/deepseek-ai/dsh-superagent-prototype.git`（上游原型，只 fetch 不 push）。

## 分支与标签

| 名称 | 用途 |
|---|---|
| `windows-adapt` | 本仓库的默认分支：Windows 适配 + schedule 来源 + Claude Code 桥接 + 面板/任务类型改动；日常修改在此提交 |
| `main` | 上游原型快照（`deepseek-ai/dsh-superagent-prototype` 的 `8c32a9d`），保持原样，不直接提交 |
| `deploy/<日期>` | 部署快照分支：从 `windows-adapt` 拉出，按 PR 依赖顺序合并功能分支，验证后打 `deploy-<日期>` tag；当前为 `deploy/2026-11-07`（tag `deploy-2026-11-07`） |
| `baseline-20261104` | 建立 Git 基线时的标签（行尾规范化后） |

部署基线、数据库备份/回滚与 upstream 同步流程见 [DEPLOY.md](DEPLOY.md)。

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
git diff --stat windows-adapt~1       # 最近一次提交带来的改动
git log --oneline --decorate -10
```

如果 `git diff` 突然出现大量整文件差异，先判断是否为行尾噪声：

```powershell
git diff --ignore-cr-at-eol --stat
```

本仓库使用 `.gitattributes` 把文本归一化为 LF；`*.cmd/*.bat/*.ps1` 保持 CRLF，无需手工转换。

## 构建与重载

```powershell
node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit
node_modules\.bin\vitest.cmd run
node_modules\.bin\tsdown.cmd
```

如果 pnpm 可用（`packageManager` 里 pin 的版本能被源解析）：

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test
pnpm.cmd run build
```

`lib/` 是构建产物，已被 `.gitignore` 忽略，不提交。构建完成后让 DSH 重新加载 `dsh-superagent`
插件（或在 DSH Web GUI 中禁用/启用该插件；必要时冷启动宿主进程）。

## 推送（内网 DNS 拦了 GitHub API 时）

`github.com` 在内网能解析但直连会抖，`api.github.com` 直接被 DNS 拒绝。推之前先起本地固定 IP 代理：

```powershell
Start-Process node -ArgumentList '<本仓库>\tools\github-pin-proxy.mjs','8899' -WindowStyle Hidden
$env:HTTPS_PROXY = 'http://127.0.0.1:8899'
git push origin windows-adapt
```

`git` 也支持不改环境变量、只对单条命令固定 IP：

```powershell
git -c http.curloptResolve=+github.com:443:20.205.243.166 push origin windows-adapt
```

代理的 IP 会漂移，失效时改 `tools/github-pin-proxy.mjs` 的 `PINS`。

## 工作区约定

- **源码修改工作区**：本仓库（`D:\aiworkspace\dsh-superagent-prototype`）
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

## 其他机器

装/更新步骤见 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)；脚本是
`scripts/install-other-machine.ps1`。
