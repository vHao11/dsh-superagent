# 项目代理工作规则（dsh-superagent-prototype）

本文件适用于 `D:\aiworkspace\dsh-superagent-prototype` 仓库。系统、开发者和用户的直接指令高于本文件；
更深层目录中的 `AGENTS.md` 可以补充其目录内的规则，发生冲突时以更深层规则为准。

## 本机关键操作约定：重启 DSH Web（3080）

本机 3080 是 `dsh web`（dsh-superagent 宿主），日常由**最高权限计划任务**启动，因此它通常是提权进程。
需要重启 3080 时，**不要在 Agent 会话的子进程里直接执行重启脚本**，统一按下面的方式做。

> **协调规则（重要）**：重启会中断 3080 上所有会话与正在执行的工单。**有其它任务在执行时，不得自行重启**；
> 必须在本轮报告中提出重启需求（说明重启原因和当前进展），由 orchestrator 统一安排重启时间。
> 确认没有其它任务在执行时，才可按本节方式触发。

> **预授权**：确认没有其它任务执行时，3080 重启属于日常运维动作，用户已授权 Agent 直接执行，
> 不要每次重启都向用户确认或等待批准；按本节约定的方式触发后，用落盘状态回读验证并在会话里留下结果即可。

- **不要这样做**（均已在本机实测失败）：
  - 在会话 `pwsh` 里直接执行 `& D:\aiworkspace\dsh-data\restart-superagent-now.ps1`（或用 `Start-Process` 包装）：
    会话子进程位于 3080 宿主的进程树/作业对象内，旧宿主被结束时调用方会被连带清理，脚本走不完
    “杀旧 → 起新 → 写 `web-url.txt` → 回读 ready”；
  - 用 RunLevel 为 `Limited`（非提权）的计划任务执行：无权结束提权的 3080，表现为脚本瞬间返回、旧进程仍在；
  - 用 WMI `Win32_Process.Create` 做分离启动：本机返回 `ReturnValue=8`，进程不会被创建。
- **正确做法：复用已注册的最高权限计划任务** `DshLaneIRestartHighest`（On demand、`RunLevel=HighestAvailable`、
  `LogonType=InteractiveToken`，动作是 `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File
  "D:\aiworkspace\dsh-data\restart-with-bqa-laneI.ps1"`）：

  ```powershell
  schtasks /Run /TN "DshLaneIRestartHighest"
  # 或：Start-ScheduledTask -TaskName 'DshLaneIRestartHighest'
  ```

  - wrapper 会读取 `D:\aiworkspace\dsh-data\bqa-shared-secret.txt` 注入 `BQA_SHARED_SECRET`/`BQA_SHARED`/
    `BQA_BASE_URL`，再调用 `restart-superagent-now.ps1 -DelaySeconds 40`（约 40 秒延迟）；任务进程由任务计划
    程序服务独立启动，不属于 3080 进程树。
  - **每次重启都复用同一个任务**，不要每次重启新建任务；触发前用
    `schtasks /Query /TN "DshLaneIRestartHighest" /V /FO LIST` 确认 `Status: Ready` 且 `Task To Run` 指向 wrapper。
- 触发后**不要在前台等待/轮询**：重启会中断 3080 上所有会话与正在执行的工单。先把当前工单的必要状态落盘，
  再结束本轮；恢复后回读验证：
  - `D:\aiworkspace\dsh-data\web-restart-status.txt`：`pid=`、`api_http=200`、`runtime=ready`、`finished=`；
  - `D:\aiworkspace\dsh-data\web-url.txt`：新 token URL（提示用户刷新页面或用新 URL 重开）；
  - `GET http://127.0.0.1:3080/orchestrator/api/state`（请求头 `x-orchestrator-request: 1`）应 200 且
    `health.runtime.state=ready`。
- 任务缺失或动作被改坏时，在提权的 PowerShell 中重建（幂等）：

  ```powershell
  $file = 'D:\aiworkspace\dsh-data\restart-with-bqa-laneI.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $file + '"')
  $principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -RunLevel Highest -LogonType Interactive
  Register-ScheduledTask -TaskName 'DshLaneIRestartHighest' -Action $action -Principal $principal -Force
  ```

- 该约定可推广到其他“需要结束/重启由更高权限启动的进程”的操作：不要在会话子进程内直接做，改为
  “最高权限计划任务 + 任务内脚本 + 落盘状态回读”。

排障过程与证据见
`D:\aiworkspace\workenvfix\cases\2026-11-05-restart-3080-requires-highest-privilege-scheduled-task.md`；
同节参考 `D:\aiworkspace\workenvfix\AGENTS.md` 的「本机关键操作约定：重启 DSH Web（3080）」。
