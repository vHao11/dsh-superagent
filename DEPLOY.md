# DEPLOY — dsh-superagent 部署基线

本文件记录本机（Windows，3080 `dsh web` 宿主）的可追溯部署基线：部署 commit、数据库 schema、
构建方式、数据库备份/回滚步骤，以及 upstream 同步流程。

当前基线：**`deploy/2026-11-07` 分支，tag `deploy-2026-11-07`，数据库 schema 13**。

## 1. 当前基线

| 项目 | 值 |
|---|---|
| 部署分支 | `deploy/2026-11-07` |
| 部署 tag | `deploy-2026-11-07`（annotated） |
| 代码基线 commit | `2e60e9c`（合并结果；tag 提交只比它多 `DEPLOY.md`/`AGENTS.md`/`GIT-WORKFLOW.md` 文档改动，代码树相同） |
| 上一基线 | tag `baseline-20261104`（`de144d1`，schema 11）、tag `raw-snapshot-20261104`（`a925546`） |
| 数据库 schema | 13（`src/app/migration.ts` 的 `SCHEMA_VERSION`；`OLDEST_SCHEMA = 10`） |
| 构建产物 | `lib/`（已 gitignore，不提交、不手改） |
| 3080 宿主 | `dsh web --no-open`，Node `D:\aiworkspace\tools\node-v24.22.2-win-x64\node.exe` |
| 活动 profile 配置 | `D:\aiworkspace\dsh-data\profiles\web\cordis.patch.yml` |
| stateDir | `D:/aiworkspace/dsh-data/state/superagent` |
| 数据库 | `D:\aiworkspace\dsh-data\state\superagent\orchestrator.sqlite`（WAL：`-wal`、`-shm`） |
| 面板 | `http://127.0.0.1:3080`（带 token 的地址在 `D:\aiworkspace\dsh-data\web-url.txt`） |

解析部署 commit（tag 指向的提交就是本次构建/部署的 commit；它的代码树与 `2e60e9c` 相同）：

```powershell
git rev-parse 'deploy-2026-11-07^{commit}'
```

## 2. 合并顺序与内容

`deploy/2026-11-07` 从 `origin/windows-adapt` 的 `d189f20`（已含 PR #1）拉出，按 PR 依赖顺序逐个
`git merge --no-ff`。PR 的 base 关系是：#3 基于 #2 的分支、#4 基于 #3、#5 基于 #4、#6 基于
`windows-adapt`；#2 的分支又包含 PR #1 合入后的后续提交。因此下表顺序就是依赖顺序。

| 顺序 | 来源分支 | 分支 tip | 合并提交 | 说明 |
|---|---|---|---|---|
| 0 | `windows-adapt`（`origin/windows-adapt`） | `d189f20` | — | 基线；含 PR #1 |
| 1 | `feat/s-lane-sources-batching` | `2efa7bc` | `09f0b4c` | PR #1 后续提交（`6f8e2db`、`dd25223`、`2efa7bc`） |
| 2 | `feat/i-lane-integration-hotfixes` | `bf039fe` | `abd36c0` | PR #2 |
| 3 | `feat/s-lane-phase2` | `4646ad9` | `773f4da` | PR #3 |
| 4 | `agent/engine-tasktype-impl-84aaf5bfb968` | `b7b302d` | `9ccd47c` | PR #4 |
| 5 | `agent/engine-model-picker-fcdacdfaaa6a` | `8be5448` | `3dcc8b1` | PR #5（schema 12 → 13） |
| 6 | `agent/restart-rule-sup-935ef8a228bd` | `796f32f` | `2e60e9c` | PR #6；AGENTS.md 重启约定 |

合并过程无冲突。合并后代码树与 `8be5448` 完全一致，只多出 `AGENTS.md`（`796f32f`）；随后只追加
部署文档。`git diff --stat 8be5448 HEAD` 应只剩文档文件。PR #2–#6 仍保持 open，deploy 分支只是
部署集成快照，不替代各 PR 自己的评审与合并。

## 3. 数据库 schema 13

- `src/app/migration.ts`：`SCHEMA_VERSION = 13`，`OLDEST_SCHEMA = 10`，`migrateTo13()` 在 Store 打开时执行。
- schema 12 → 13 的迁移把原按引擎分开的模型参数（executor 的 `claudeModel`/`claudeEffort`/`opencodeModel`，
  任务类型的 `claude.model`/`claude.effort`/`opencode.model`）折算为统一 `model`（`provider`/`model`/
  `reasoningEffort`），并从当前设置与历史 revision 中移除旧字段。迁移在事务内完成；失败时数据库保持原
  schema，不会半迁移。
- 迁移只支持向前。**旧构建（schema ≤ 12，如 `baseline-20261104`）不能打开 schema 13 数据库**：
  用旧版本启动会报 `Unsupported orchestrator database version 13`。跨 schema 回滚必须连同迁移前的数据库
  备份一起回滚。
- 本机当前数据库在 2026-11-07 已是 schema 13（3080 之前运行的 lib 就是这些分支叠加构建的产物）。
  因此本次部署不会触发 12 → 13 迁移；仍然要求重启前备份。

## 4. 构建

本机 3080 使用 Node 24.22.2；`package.json` 要求 `^22.19.0 || >=24`。构建也使用同一 Node，并把
pnpm 的自动版本切换关掉（本机内网 registry 没有仓库 pin 的 `pnpm@11.7.0`，否则 corepack/pnpm
会尝试下载并失败）：

```powershell
$env:PATH = 'D:\aiworkspace\tools\node-v24.22.2-win-x64;' + $env:PATH
$env:COREPACK_ENABLE_PROJECT_SPEC = '0'
$env:npm_config_manage_package_manager_versions = 'false'

# 只有 package.json / pnpm-lock.yaml 变化时才需要
pnpm install --frozen-lockfile

pnpm typecheck
node_modules\.bin\vitest.cmd run tests/bqa.spec.ts tests/ume.spec.ts tests/batches.spec.ts `
  tests/core-engine.spec.ts tests/task-types.spec.ts tests/migration.spec.ts tests/settings.spec.ts `
  tests/policy.spec.ts tests/engine-models.spec.ts tests/claude-code-driver.spec.ts tests/opencode.spec.ts `
  tests/opencode-driver.spec.ts tests/panel-execution.spec.tsx tests/panel-settings.spec.tsx `
  tests/panel-source.spec.tsx tests/tools.spec.ts tests/views.spec.ts tests/registry.spec.ts `
  tests/bundle-patch.spec.ts
pnpm build
```

- `pnpm` 在脚本前会尝试一次依赖校验，内网 registry 缺包时会打印 `ERR_PNPM_META_FETCH_FAIL` 并继续执行
  脚本（`node_modules` 已就绪，lockfile 未变）。这是本机已知噪声，不是构建失败。
- `pnpm build` 由 `tsdown.config.ts` 生成 `lib/index.js`、`lib/index.d.ts`、`lib/client.js`、
  `lib/standalone.js`、`lib/*-watch.js` 等。`lib/` 是构建产物，不要手改。
- 2026-11-07 基线验证结果：`pnpm typecheck` 通过；上述 19 个定向测试文件 **671 passed / 2 skipped**；
  `pnpm build` 通过（tsdown 0.22.14）。
- 全量 `pnpm test` 在本机有 9 个测试文件、47 个用例失败，集中在 Windows 环境限制（POSIX `sh`/`sleep`/`tmux`、
  `chmod` 权限位、路径分隔符、`lark-cli` 测试桩）与既有断言；本次合并后的代码树与 `8be5448` 相同，
  定向测试覆盖本次合入模块并通过，因此全量套件不作为本次部署门禁。失败文件：`commands`、`deployment`、
  `docs`、`environment`、`prompts`、`runtime`、`service-script`、`sources`、`store`。

## 5. 重启 3080（由集成阶段执行）

重启会中断 3080 上所有会话与正在执行的工单。**必须由 orchestrator 统一安排，确认没有其它任务
在跑之后**再执行；Agent 会话内不要直接运行重启脚本或结束进程（原因见 AGENTS.md）。

1. 先做数据库备份（第 6 节）。
2. 触发最高权限计划任务（不要新建任务）：

   ```powershell
   schtasks /Run /TN "DshLaneIRestartHighest"
   # 或：Start-ScheduledTask -TaskName 'DshLaneIRestartHighest'
   ```

   该任务执行 `D:\aiworkspace\dsh-data\restart-with-bqa-laneI.ps1`，注入 BQA 环境变量后调用
   `restart-superagent-now.ps1 -DelaySeconds 40`：约 40 秒后结束旧宿主、清 `state\superagent.lock`、
   用 Node 24.22.2 启动 `dsh web --no-open`、写 `web-url.txt` 并轮询 API。
3. 不要在前台等待/轮询；恢复后回读：
   - `D:\aiworkspace\dsh-data\web-restart-status.txt` 应有 `pid=`、`api_http=200`、`runtime=ready`、`finished=`；
   - `D:\aiworkspace\dsh-data\web-url.txt` 是新 token URL；
   - `GET http://127.0.0.1:3080/orchestrator/api/state`（请求头 `x-orchestrator-request: 1`）返回 200，
     `health.runtime.state` 为 `ready`（或 `paused`）。
4. Smoke 检查：
   - 面板能打开，`dsh-superagent` 插件已加载，Overview 没有 setup 问题；
   - `GET /orchestrator/api/sources` 中 UME / BQA 来源状态正常，设置、任务类型与 prompt 历史仍在；
   - 数据库 schema 仍为 13（第 6 节的只读检查命令）。
5. 若启动失败：先看 `D:\aiworkspace\dsh-data\logs\web-restart-*.err.log` 和 DSH 日志；不要反复触发重启。

## 6. 数据库备份

数据库是 WAL 模式，运行中直接复制 `orchestrator.sqlite` 可能漏掉 `-wal` 中的已提交事务。用 SQLite 的
`VACUUM INTO` 做在线一致性备份（无需停 3080）：

```powershell
$node = 'D:\aiworkspace\tools\node-v24.22.2-win-x64\node.exe'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = 'D:\aiworkspace\dsh-data\backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$dst = Join-Path $dir "orchestrator-$stamp.sqlite"

$js = @'
const { DatabaseSync } = require('node:sqlite')
const [src, dst] = process.argv.slice(2)
const db = new DatabaseSync(src)
db.exec(`VACUUM INTO '${dst}'`)
db.close()
'@
$js | & $node - 'D:/aiworkspace/dsh-data/state/superagent/orchestrator.sqlite' ($dst -replace '\\','/')
```

校验备份（应为 `integrity_check=ok`、`schema=13`）：

```powershell
$check = @'
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[2], { readOnly: true })
console.log(JSON.stringify({
  integrity: db.prepare('PRAGMA integrity_check').get(),
  schema: db.prepare("select value from kv where key = 'schema'").get(),
}))
db.close()
'@
$check | & $node - ($dst -replace '\\','/')
```

- 该命令已在 2026-11-07 对本机数据库实测：`integrity_check=ok`、`schema=13`，备份约 1.5 MB。
- 备份放在 `D:\aiworkspace\dsh-data\backups\`（仓库外），不要提交数据库；保留最近若干份并标注版本/tag。
- 停服务后的等价做法：结束 3080 后复制 `orchestrator.sqlite`、`orchestrator.sqlite-wal`、
  `orchestrator.sqlite-shm` 三个文件；恢复时三个一起放回。

## 7. 回滚

回滚必须由集成阶段协调，且先确认没有 Executor 在跑。

1. 停止 3080（通过计划任务/受控重启机制；不要在 Agent 会话内直接 `Stop-Process`）。
2. 恢复数据库：
   - 删除 `orchestrator.sqlite`、`orchestrator.sqlite-wal`、`orchestrator.sqlite-shm`；
   - 把第 6 节的备份复制为 `orchestrator.sqlite`。
   - **schema 兼容性**：当前数据库是 13，只能被 schema 13 的构建打开。回滚到 `baseline-20261104`
     （schema 11）等旧构建时，必须使用 schema 13 之前的备份；没有该备份就不能用旧构建启动。
3. 切回上一个已知可用的部署 tag/commit 并重建：

   ```powershell
   git switch --detach deploy-2026-11-07   # 或上一个已知可用的 tag/commit
   pnpm build
   ```

4. 重新触发第 5 节的重启任务，按第 5 节验证 `/orchestrator/api/state` 与 smoke。
5. 回滚完成后记录实际运行的 commit/tag，并更新本文件的“当前基线”与变更记录；不要停留在
   detached HEAD 上继续开发，需要开发时切回 `windows-adapt` 或 `deploy/<日期>`。

## 8. upstream 同步流程

`upstream` = `https://github.com/deepseek-ai/dsh-superagent-prototype.git`（只 fetch，不 push）；
`origin` = `https://github.com/vHao11/dsh-superagent.git`；`main` 只镜像 upstream 快照，
`windows-adapt` 是集成分支，`deploy/<日期>` 是部署快照。

1. **拉取 upstream**：

   ```powershell
   git fetch upstream --prune --tags
   ```

2. **合入 `windows-adapt`**：

   ```powershell
   git switch windows-adapt
   git merge --no-ff upstream/main
   ```

   解冲突时保留 upstream 的共享代码语义，再重新应用 Windows 适配；冲突解决后先跑
   `pnpm typecheck`、定向测试和 `pnpm build`。

3. **按 PR 依赖链把 `windows-adapt` 同步到仍在评审的功能分支**：

   ```powershell
   # 从依赖链底部往上，逐级把上游分支合入下游分支；合并方向以 PR base 为准
   git switch feat/i-lane-integration-hotfixes          # PR #2
   git merge --no-ff windows-adapt
   git switch feat/s-lane-phase2                        # PR #3，base 是 #2
   git merge --no-ff feat/i-lane-integration-hotfixes
   git switch agent/engine-tasktype-impl-84aaf5bfb968   # PR #4，base 是 #3
   git merge --no-ff feat/s-lane-phase2
   git switch agent/engine-model-picker-fcdacdfaaa6a    # PR #5，base 是 #4
   git merge --no-ff agent/engine-tasktype-impl-84aaf5bfb968
   git switch agent/restart-rule-sup-935ef8a228bd       # PR #6，base 是 windows-adapt
   git merge --no-ff windows-adapt
   ```

   每一级解冲突并至少跑一次 `pnpm typecheck`；不要跳过上游分支直接合顶层分支。

4. **重建部署分支**（新日期）：

   ```powershell
   git switch -c deploy/<新日期> windows-adapt
   git merge --no-ff feat/s-lane-sources-batching
   git merge --no-ff feat/i-lane-integration-hotfixes
   git merge --no-ff feat/s-lane-phase2
   git merge --no-ff agent/engine-tasktype-impl-84aaf5bfb968
   git merge --no-ff agent/engine-model-picker-fcdacdfaaa6a
   git merge --no-ff agent/restart-rule-sup-935ef8a228bd
   ```

   解冲突后按第 4 节跑 typecheck、定向 vitest、build；确认代码树等于预期分支叠加的结果。

5. **打 tag**：

   ```powershell
   git tag -a deploy-<新日期> -m "Deploy baseline <新日期>: windows-adapt + PRs, schema 13"
   ```

6. **备份数据库**（第 6 节），然后由 orchestrator 统一安排第 5 节的重启，验证 `/state` 与 smoke。

7. **推送 origin（不推 upstream）**：

   ```powershell
   git push origin windows-adapt
   git push origin deploy/<新日期>
   git push origin deploy-<新日期>
   ```

   内网直连 GitHub 不稳定时的代理/固定 IP 做法见 `GIT-WORKFLOW.md` 的“推送”一节。

冲突与分支约定：

- `windows-adapt` 是唯一日常集成分支；`main` 不进新提交；`deploy/<日期>` 只做部署合并与文档，不在其上
  开发功能。
- 功能分支按 PR base 依赖顺序合并（sources-batching → i-lane #2 → s-lane-phase2 #3 →
  engine-tasktype #4 → engine-model-picker #5 → restart-rule #6）；不要跳过上游分支直接合顶层分支，
  否则冲突会集中爆发且难以定位。
- 每次部署只认 tag；部署前必须备份数据库，部署后必须记录实际 commit 与验证结果。

## 9. 变更记录

| 日期 | tag / 分支 | 代码基线 | schema | 说明 |
|---|---|---|---|---|
| 2026-11-07 | `deploy-2026-11-07` / `deploy/2026-11-07` | `2e60e9c` | 13 | 首次建立可追溯部署基线：合并 windows-adapt 与 PR #2–#6；typecheck、19 个定向测试文件、build 通过 |
