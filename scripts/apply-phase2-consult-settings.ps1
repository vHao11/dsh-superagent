<#
.SYNOPSIS
  Applies the phase-2 read-only consult task type settings to a running dsh-superagent host, after the phase-2 build is loaded.

.DESCRIPTION
  A schema newer than the host is refused by an older build, so this script only succeeds after the integration restart that loads
  the phase-2 bundle. It reads settings/executor, sets the `consult` task type's `readOnly` flag and BQA MCP-first instructions,
  and saves the block against its current revision. Running it twice is a no-op once the values are applied.

.PARAMETER BaseUrl
  The dsh-superagent management root, http://127.0.0.1:3080 by default.

.PARAMETER Token
  The web token. When omitted, it is read from the `token=` query of D:\aiworkspace\dsh-data\web-url.txt.

.PARAMETER Apply
  Save the change. Without it the script prints the planned instruction text and exits without a request.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-phase2-consult-settings.ps1 -Apply
#>
param(
  [string]$BaseUrl = 'http://127.0.0.1:3080',
  [string]$Token = '',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $Token) {
  $urlFile = 'D:\aiworkspace\dsh-data\web-url.txt'
  if (-not (Test-Path -LiteralPath $urlFile)) { throw "Token not given and $urlFile is missing" }
  $match = [regex]::Match([System.IO.File]::ReadAllText($urlFile), 'token=([^&\s]+)')
  if (-not $match.Success) { throw "No token in $urlFile; pass -Token" }
  $Token = $match.Groups[1].Value
}
$headers = @{ 'x-orchestrator-request' = '1'; authorization = "Bearer $Token" }
$instructions = '只读咨询：资料只能用 BQA 只读检索工具获取——优先 mcp__bqa__search_knowledge / mcp__bqa__search_code / mcp__bqa__read_excerpt（MCP --current 绑定活动资料版本，无需 requestId）；会话未提供 MCP 工具时回退 bqa-search.cmd，并把工单 scope 里的 requestId 原样传入。禁止写入/编辑任何文件、禁止 git 操作、禁止执行检索之外的命令；工具面已按只读收紧。答案必须给出来源 id，证据不足时明确说明，不要猜测、不要向用户反问。答案正文由 superagent 直回 BQA。'
$base = $BaseUrl.TrimEnd('/')
$current = Invoke-RestMethod "$base/orchestrator/api/settings/executor" -Headers $headers -TimeoutSec 20
$value = $current.value
$consult = @($value.taskTypes) | Where-Object { $_.id -eq 'consult' } | Select-Object -First 1
if (-not $consult) { throw 'The executor settings define no consult task type; create it first' }
if ($consult.readOnly -eq $true -and $consult.instructions -eq $instructions) {
  Write-Output 'consult is already the phase-2 read-only task type; nothing to do.'
  return
}
$consult | Add-Member -NotePropertyName readOnly -NotePropertyValue $true -Force
$consult.instructions = $instructions
$value.taskTypes = @($value.taskTypes | ForEach-Object { if ($_.id -eq 'consult') { $consult } else { $_ } })
if (-not $Apply) {
  Write-Output 'Dry run: pass -Apply to save. Planned consult settings:'
  $consult | ConvertTo-Json -Depth 6
  return
}
$body = @{ value = $value; revision = $current.revision } | ConvertTo-Json -Depth 20
Invoke-RestMethod "$base/orchestrator/api/settings/executor" -Method Put -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | ConvertTo-Json -Depth 4
