<#
.SYNOPSIS
  Registers (or removes) the Windows scheduled task that refreshes the UME message-capture export every ten minutes.

.DESCRIPTION
  The UME Source reads only `data/tasks.json`; this task runs ume-message-capture's `scripts/refresh.ps1` in its default mode
  (it may start the UME client, so it must export) every ten minutes, hidden, without a pause prompt. The task never overlaps
  itself (`MultipleInstances=IgnoreNew`). Running this script twice is harmless.

.PARAMETER Action
  `install` (default) registers the task; `uninstall` removes it.

.PARAMETER RefreshScript
  ume-message-capture's refresh.ps1, by default at the standard workspace path.

.PARAMETER IntervalMinutes
  Refresh interval in minutes; the Source's pollSeconds only reads the exported file.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ume-refresh-task.ps1 -Action install

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ume-refresh-task.ps1 -Action uninstall

.NOTES
  The task runs as the current user. Registering it may require an elevated shell depending on local policy. The wrapper in
  the temp directory hides the PowerShell window with `wscript.exe //B`, which the UME ingest case verified.
#>
param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [string]$RefreshScript = 'D:\aiworkspace\ai-tools\ume-message-capture\scripts\refresh.ps1',
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 10,
  [string]$TaskName = 'DshUmeRefresh'
)
$ErrorActionPreference = 'Stop'

if ($Action -eq 'uninstall') {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) { Write-Output "No scheduled task named $TaskName."; return }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed scheduled task $TaskName."
  return
}

if (-not (Test-Path -LiteralPath $RefreshScript -PathType Leaf)) {
  throw "UME refresh script not found: $RefreshScript (pass -RefreshScript with the real path)"
}
$refresh = (Resolve-Path -LiteralPath $RefreshScript).Path
# A hidden launcher: wscript starts PowerShell with no window and returns at once, so a long export never shows a console.
# It lives in a per-user stable directory rather than the temp directory a cleanup may empty, which would leave the task silently failing.
$wrapperDirectory = Join-Path $env:LOCALAPPDATA 'dsh-superagent'
New-Item -ItemType Directory -Force -Path $wrapperDirectory | Out-Null
$wrapper = Join-Path $wrapperDirectory 'dsh-ume-refresh.vbs'
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$refresh`" -NoPause"
# WScript takes one string literal: every quote inside the command becomes a doubled quote, so the wrapper's own delimiters stay intact.
$vbs = 'CreateObject("WScript.Shell").Run "' + $command.Replace('"', '""') + '", 0, False'
[System.IO.File]::WriteAllText($wrapper, $vbs, (New-Object System.Text.UTF8Encoding($false)))

# `$Action` is this script's parameter and validates its own set, so the task action needs another name.
$taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B //Nologo `"$wrapper`""
# Windows rejects a TimeSpan.MaxValue repetition duration (P99999999D), so the task repeats for ten years instead.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration ([TimeSpan]::FromDays(3650))
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Description 'Refreshes the UME message-capture export for the dsh-superagent ume Source' -Force | Out-Null
Write-Output "Registered scheduled task $TaskName every $IntervalMinutes minute(s): $refresh (wrapper $wrapper)"
