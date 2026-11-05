# 在其他 Windows 机器上换成这个版本的 superagent

适用场景：那台机器**已经装过** dsh-superagent（DSH 里能看到 Superagent 面板/插件），现在要把 DSH 实际加载的
`dsh-superagent` 从官方版本换成这份修改版（Windows 适配 + schedule 来源 + Claude Code 桥接 + 面板/任务类型等改动）。

整条链路只有三件事：**拿到仓库 → 构建 `lib/` → 把 DSH profile 的依赖指到这个仓库**。脚本会把三件事一起做完。

## 0. 先决条件

- Node.js 22.19+ 或 24+（`node -v`）
- git（`git --version`）
- DeepSeek Harness（`dsh --version`，需落在 `package.json` 的 `engines.dsh` 范围内，当前为 `^0.2.1-alpha.2`）
- 机器上已经有至少一个引用 `dsh-superagent` 的 DSH profile（`<DSH_HOME>\profiles\*\package.json` 里有这个依赖）

`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`；如果这台机器把它改到别处（例如 `D:\aiworkspace\dsh-data`），脚本读环境变量，无需额外配置。

## 1. 把仓库放到这台机器上

```powershell
git clone https://github.com/vHao11/dsh-superagent.git D:\aiworkspace\dsh-superagent
cd D:\aiworkspace\dsh-superagent
git switch windows-adapt
```

如果这台机器在公司内网、`git clone` 卡住或报 `Could not resolve host`，先按「4. 网络：内网 DNS 拦截了 GitHub API」
起本地固定 IP 代理，再带上代理重试：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:8899'
git clone https://github.com/vHao11/dsh-superagent.git D:\aiworkspace\dsh-superagent
```

## 2. 一键切换（推荐）

先演练一次，看看会改哪些文件：

```powershell
powershell -ExecutionPolicy Bypass -File D:\aiworkspace\dsh-superagent\scripts\install-other-machine.ps1 -DryRun
```

确认无误后正式执行：

```powershell
powershell -ExecutionPolicy Bypass -File D:\aiworkspace\dsh-superagent\scripts\install-other-machine.ps1
```

脚本按顺序做：

1. 需要时 `git pull --ff-only`（加 `-Update` 才做）；
2. `node_modules` 缺失时装依赖：优先用 **corepack 指定的 pnpm**（与 `packageManager: pnpm@11.7.0` 一致，
   `--frozen-lockfile` 精确按 `pnpm-lock.yaml` 安装），其次本机 pnpm，最后 npm；
3. `npm run build` 构建 `lib/`（DSH 运行时读的就是它，**没有 `lib/` 或用旧 `lib/` 都等于没切换**）；
4. 扫描 `<DSH_HOME>\profiles\*`，把依赖 `dsh-superagent` 改写成 `link:<这个仓库>`，改之前备份
   `package.json.bak-<时间戳>`，再执行 `dsh plugin --profile <名字> install` 重建 `node_modules` 链接；
5. 打印要重启什么。

只想改某个 profile 时加 `-Profile web`（或 `-Profile superagent`）。

公司镜像（Artifactory）缺包、装依赖失败时，换公共源重试：

```powershell
powershell -ExecutionPolicy Bypass -File D:\aiworkspace\dsh-superagent\scripts\install-other-machine.ps1 -Registry https://registry.npmjs.org/
```

## 3. 重启，让新版本生效

- 面板 / Web UI 的 DSH（例如 `dsh web`）：关掉进程再启动；
- 专用的 superagent profile 服务：`scripts\dsh-superagent.cmd restart --profile superagent`。

重启后确认：面板侧栏的 **Superagent** 能打开、`GET /orchestrator/api/state` 返回 200，说明加载的是新构建。

## 4. 网络：内网 DNS 拦截了 GitHub API

这台机器所在的网络里，内网 DNS 对 `api.github.com`、`codeload.github.com` 返回 NXDOMAIN，而 `github.com`
能解析、但直连会抖（时好时坏）。改 hosts 需要管理员，所以仓库里带了一个小工具：本地 HTTP CONNECT 代理，
把 GitHub 的几个域名固定到实测可用的 IP 上。

```powershell
# 后台起一个 127.0.0.1:8899 的代理（窗口可以留着，或加 Start-Process -WindowStyle Hidden）
node <仓库路径>\tools\github-pin-proxy.mjs 8899
```

然后只对需要的进程设置代理，不要写进用户级环境变量（会把 DeepSeek 直连一起带坏）：

```powershell
$env:HTTP_PROXY  = 'http://127.0.0.1:8899'
$env:HTTPS_PROXY = 'http://127.0.0.1:8899'
```

`scripts\install-other-machine.ps1 -Update -ProxyPort 8899` 会在执行 `git pull` 时临时设置这两个变量，
跑完即恢复——不要让代理常驻，否则 npm/pnpm 访问公司 Artifactory 也会被带着走代理而失败。
装依赖失败时用 `-Registry https://registry.npmjs.org/` 换公共源（见第 2 节）。

IP 会随 GitHub 调度漂移，失效时改 `tools/github-pin-proxy.mjs` 里的 `PINS`（先用 `Test-NetConnection <ip> -Port 443` 验）。

## 5. 以后更新

```powershell
powershell -ExecutionPolicy Bypass -File D:\aiworkspace\dsh-superagent\scripts\install-other-machine.ps1 -Update -ProxyPort 8899
```

等价于：`git pull` → 重新构建 → 确认 profile 链接没变 → 重启 DSH。

## 6. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 切换后行为没变 | DSH 加载的是 `lib/`。确认构建成功、`lib/index.js` 的修改时间是最新的，并重启宿主进程。 |
| `pnpm` 报 `resolve pnpm@11.7.0 … 404` / `Not Found` | 仓库把 pnpm 版本 pin 在 `packageManager`，pnpm 会尝试从当前 registry 解析这个版本。脚本改用 `corepack pnpm@11.7.0`（Node 自带 corepack，从公共源取 pnpm 本体），并按 `--frozen-lockfile` 精确安装，避开本机 pnpm 版本不匹配导致的整树重解析。 |
| 装依赖报 `404`（Artifactory 缺包，如 `@asamuzakjp/*`） | 公司镜像没有镜像全量 npm 包。加 `-Registry https://registry.npmjs.org/` 重跑（脚本会用它装依赖，同时用于 corepack 取 pnpm）。 |
| `dsh plugin --profile … install` 失败 | 多半是源/网络问题。修好后手动重跑这句；也可以直接在 profile 目录里 `pnpm install`。 |
| 面板打不开 / `/orchestrator/api/*` 全 404 | 多半是插件没重新加载，或 `stateDir` 的锁没释放。先干净重启宿主进程；仍是 404 再看 `stateDir\*.lock`。 |
| 测试有一批失败 | `npm test` 里有一部分用例依赖 Linux 工具（`tmux`、`sleep`、Python 脚本语义），Windows 上属已知失败，基线同样如此；类型检查和构建应保持通过。 |
| 想回滚 | 脚本改过的每个 profile 都留了 `package.json.bak-<时间戳>`，恢复它并 `dsh plugin --profile <名字> install`，然后重启。 |

## 7. 不要做的事

- 不要让两台机器同时指向同一个 `stateDir`（SQLite + 锁文件会冲突）。
- 不要手工编辑 profile 的 `node_modules` 链接；用 `dsh plugin` 或本脚本。
- 不要在编辑 `src/` 后不构建就重启——运行时不吃 `src/`。
