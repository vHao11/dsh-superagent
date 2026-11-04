# Windows 运行说明（本地适配）

这个目录是 `deepseek-ai/dsh-superagent-prototype` 的克隆，并按本机（Windows）做了少量适配。
原型的服务脚本 `scripts/dsh-superagent` 是 Python + `tmux` + `fcntl`，Windows 上无法运行；其余部署步骤与
`docs/006-deployment.md` 一致。

## 本机安装位置

| 项 | 值 |
| --- | --- |
| 隔离的 DSH CLI | `%USERPROFILE%\src\dsh-cli`（`@deepseek-ai/dsh` 0.2.1-rc.3；全局 `dsh` 仍是 0.2.1-rc.2，未改动） |
| profile | `~/.dsh/profiles/superagent`（面板端口 **3082**） |
| stateDir | `%USERPROFILE%\.dsh\state\superagent` |
| 工作副本（prepare 用它建 worktree） | `%USERPROFILE%\src\superagent-playground` |
| agent 账号 | `<agent-account>` |
| agent 的 gh 配置目录 | `%USERPROFILE%\.config\gh-agent`（通过 `GH_CONFIG_DIR`，不碰操作者自己的 gh） |

`GH_CONFIG_DIR` 和 DSH 入口写在 `.artifacts/service-env.json`，启动器 spawn 时注入。

## 启动 / 停止 / 状态

```powershell
cd "$env:USERPROFILE\src\dsh-superagent-prototype"
node scripts\dsh-superagent.mjs status  --profile superagent   # 0 正常 / 1 未运行或出错 / 2 部件报错 / 3 等 setup
node scripts\dsh-superagent.mjs start   --profile superagent
node scripts\dsh-superagent.mjs stop    --profile superagent
node scripts\dsh-superagent.mjs restart --profile superagent
```

- 启动后面板 URL（含一次性 token）打在 `.artifacts\dsh-superagent-superagent-*.log`；面板左侧 **Superagent** 是入口。
- 退出码含义与 `docs/006-deployment.md` 相同。
- `stop` 在 Windows 上先 `POST executor/pause` 等执行器跑完，再 `taskkill /T /F`（Windows 没有安全的 SIGINT 传递）。

## 与原型不同的 4 处

1. `src/deployment.ts`：`stateDir` 绝对路径校验接受 `C:\` / `C:/`；`executable()` 在 Windows 上按 PATHEXT 追加
   `.exe/.cmd/.bat`（否则 `gh` 这类命令名在 PATH 上找不到）。
2. `src/app/sessions.ts`：主 Session 的工具白名单与 `noWait` 守卫按平台选 `bash`/`pwsh`。Windows 上 DSH 只注册
   `pwsh`；不改这一处，恢复 orchestrator Session 时会报
   `tools.restrict() names unknown global tool "bash"`，插件整体挂载失败。
3. `scripts/dsh-superagent.mjs` + `.cmd`：服务管理器的 Windows 等价实现（无 tmux、无 fcntl），状态、退出码、
   `.artifacts` 日志与 `--respect-stop` 语义对齐原 Python 脚本。
4. gh 账号隔离：用 `GH_CONFIG_DIR` 代替 `~/.local/bin/gh-agent` 这类 `#!/bin/sh` 包装脚本——原型的 `worker-bin`
   sh shim 在 Windows 不执行，所以 `blockedCommands` 在 Windows **不生效**，而 `gh` 仍以 agent 账号运行
   （继承服务进程的 `GH_CONFIG_DIR`）。

Execution settings 的 prepare 命令用 Git for Windows 的 `sh` 执行（`sh.exe` 在 PATH 上），路径写成 `C:/...` 形式。

## 已知限制

- `blockedCommands` 不生效（见上）。
- 停止是 pause + `taskkill`，不等待 Session 的清理回调（SQLite 崩溃安全，可接受）。
- 面板 URL 每次重启变化，是 DSH 的 token 机制，与 superagent 无关。
- 每小时自检（每小时一次）建在操作者常用的 profile 里，
  服务挂掉时由它重启；它不依赖本服务。

## 已知问题与修复

### 间歇性弹出 `gh` 控制台窗口（2026-11-01 修复）

现象：服务运行期间大约每分钟闪一批控制台窗口，每批 6–8 个。

根因：GitHub Source 每 60 秒轮询一次，每次用 `execFile` 起 6–8 个 `gh`
（notifications、PR、check-runs、statuses、comments 等）。Node 的 `execFile` 默认 `windowsHide: false`，
而服务进程本身没有控制台（启动器 detached + `windowsHide`），于是每个 `gh.exe` 都会新建一个控制台窗口闪一下。

修复：`src/infra/commands.ts` 的 `exec` 加 `windowsHide: true`；`src/sources/feishu-loops.ts` 的 `spawn` 同样加上；
启动器自己的 `where`/`taskkill` 也加了 `windowsHide`。

实测（95 秒观察窗，覆盖 1–2 个轮询周期）：修复前 15 个控制台窗口，修复后 0 个。

### 强制停止后立刻启动失败：`Lock file is already being held`（2026-11-01 修复）

`src/app/runtime.ts` 用 `lockSync(machine.stateDir, { stale: 30_000 })` 锁 `<stateDir>.lock`。Windows 上 `stop` 只能
`taskkill`（没有安全的 SIGINT 传递），进程不会释放锁，紧接着 `start` 就会失败 30 秒。

启动器的处理（2026-11-01 追加一次修正）：`stop`/`restart` 结束前**无条件**强制清掉该锁；`start` 在
「没有存活 pid 且 URL 上没有 orchestrator 应答」时也无条件强制清理，不再等 30 秒过期。
原因：一次失败的重启可能已经把 `service.pid` 删掉、却留下新鲜的锁目录，随后立刻重启就会
`dsh-superagent` 插件挂载失败（管理 API 全部 404，面板会显示服务无响应），等 30 秒再启才恢复。
另外「超过 31 秒自动清理」仍然保留，作为外部崩溃后的兜底。


## 验证记录（2026-11-01）

Issue #1 提及 agent → 约 1 分钟内生成 Ticket → 执行器在 `stateDir\work\...` 建 worktree → PR，作者是 agent 账号（noreply 邮箱）；Issue 收到一条确认与一条完成回复。

## 追加：从 DSH NEXT 面板拉起服务时的 PATH 修复（2026-11-01）

DSH NEXT 里装了配套面板插件 `@dsh-external/dsh-superagent-panel`（侧栏入口 + 内嵌完整面板，源码见 `dsh-superagent-panel` 仓库）。它的「启动/重启」会直接调用本目录的
`scripts/dsh-superagent.mjs`，于是暴露出一个之前从 Git Bash 启动时看不见的问题：

- 插件 setup 探针跑 `env PATH=… <gh> api user`，prepare 命令跑 `sh -c …`
- Git for Windows 把 `env.exe` / `sh.exe` 放在 `Git\usr\bin`，而安装器只把 `Git\cmd` 加进用户 PATH
- 从 Git Bash 启动服务时 `usr\bin` 天然在 PATH 里；从 DSH NEXT 面板（宿主是桌面进程）拉起时不在
  → `setup: agentCliSignedOut`，`values.output = "spawn env ENOENT"`，服务永远卡在等待 setup

修复：启动器新增 `ensureGitBashPath()`，start 时把 `Git\cmd`、`Git\usr\bin`、`Git\mingw64\bin`、`Git\bin`
（存在的那些）追加到子进程 PATH 最前面，仅在缺失时补。

验证：把 PATH 收缩为 `C:\Windows\System32;C:\Windows;C:\Program Files\nodejs` 后再 `restart`，
服务照常起来且 `setup: null`（对照：修复前同样条件卡在 `spawn env ENOENT`）。

