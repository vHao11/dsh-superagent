<#
.SYNOPSIS
  Point a Windows machine's DeepSeek Harness profiles at this checkout of dsh-superagent,
  then build the bundle so the running DSH picks up this version instead of the stock one.

.DESCRIPTION
  Run from the root of a dsh-superagent checkout (or from anywhere: the script locates the
  checkout from its own path).

  The script:
    1. optionally fast-forwards the checkout (git pull --ff-only);
    2. installs dependencies when node_modules is missing (pnpm when available, otherwise npm);
    3. builds lib/ with the package's own build script;
    4. for every DSH profile whose package.json depends on dsh-superagent, rewrites that
       dependency to "link:<this checkout>" (backing up package.json first) and re-links the
       profile's node_modules through `dsh plugin --profile <name> install`;
    5. prints what to restart.

  Nothing is written until -DryRun is not given.

.PARAMETER Profile
  Only touch the named DSH profile(s). Default: every profile that references dsh-superagent.

.PARAMETER Update
  Run `git -C <checkout> pull --ff-only` before building.

.PARAMETER ProxyPort
  Route git through the local pinned-IP proxy on 127.0.0.1:<port>
  (tools/github-pin-proxy.mjs). Use on networks that cannot resolve api.github.com.

.PARAMETER SkipDeps
  Do not install dependencies; only build and re-link.

.PARAMETER SkipBuild
  Do not rebuild lib/; only update the profile links.

.PARAMETER DryRun
  Print the planned changes without writing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-other-machine.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-other-machine.ps1 -Update -ProxyPort 8899
#>
[CmdletBinding()]
param(
    [string[]] $Profile,
    [switch] $Update,
    [int] $ProxyPort = 0,
    [switch] $SkipDeps,
    [switch] $SkipBuild,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Sub  { param([string] $Message) Write-Host "    $Message" }
function Write-Ok   { param([string] $Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Note { param([string] $Message) Write-Host "    $Message" -ForegroundColor Yellow }

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    throw "Not a dsh-superagent checkout (no package.json next to scripts/): $root"
}
$linkValue = 'link:' + ($root -replace '\\', '/')

if ($ProxyPort -gt 0) {
    $proxyUrl = "http://127.0.0.1:$ProxyPort"
    $env:HTTP_PROXY = $proxyUrl
    $env:HTTPS_PROXY = $proxyUrl
    Write-Sub "git/network via pinned-IP proxy $proxyUrl"
}

Write-Step "Checkout: $root"
if ($DryRun) { Write-Note 'DRY RUN: nothing will be written' }

# --- 0. toolchain -----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node is not on PATH; install Node.js 22.19+ or 24+.' }
$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor = [int] ($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 22) { throw "Node.js $nodeVersion is too old; this package needs 22.19+ or 24+." }
Write-Sub "node $nodeVersion"

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesDir = Join-Path $dshHome 'profiles'
if (-not (Test-Path $profilesDir)) { throw "No DSH profiles directory: $profilesDir" }
Write-Sub "DSH home: $dshHome"

# --- 1. update checkout -----------------------------------------------------
if ($Update) {
    Write-Step 'Update checkout'
    $branch = (& git -C $root rev-parse --abbrev-ref HEAD).Trim()
    Write-Sub "branch $branch"
    if ($DryRun) {
        Write-Note 'git pull --ff-only (skipped)'
    } else {
        & git -C $root pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
        Write-Ok 'checkout updated'
    }
}

# --- 2. dependencies --------------------------------------------------------
$nodeModules = Join-Path $root 'node_modules'
if ($SkipDeps) {
    Write-Step 'Dependencies: skipped (-SkipDeps)'
} elseif (Test-Path (Join-Path $nodeModules 'tsdown')) {
    Write-Step 'Dependencies: already installed'
} else {
    Write-Step 'Install dependencies'
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($DryRun) {
        Write-Note $(if ($pnpm) { 'pnpm install' } else { 'npm install --no-package-lock' }) + ' (skipped)'
    } elseif ($pnpm) {
        & pnpm install --dir $root
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
        Write-Ok 'pnpm install done'
    } else {
        & npm install --prefix $root --no-package-lock --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
        Write-Ok 'npm install done'
    }
}

# --- 3. build ---------------------------------------------------------------
if ($SkipBuild) {
    Write-Step 'Build: skipped (-SkipBuild)'
} else {
    Write-Step 'Build bundle (lib/)'
    if ($DryRun) {
        Write-Note 'npm run build (skipped)'
    } else {
        Push-Location $root
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
        if (-not (Test-Path (Join-Path $root 'lib\index.js'))) { throw 'Build finished but lib/index.js is missing.' }
        Write-Ok 'lib/ rebuilt'
    }
}

# --- 4. point profiles at this checkout ------------------------------------
Write-Step 'DSH profiles that use dsh-superagent'
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { throw 'dsh is not on PATH; install DeepSeek Harness first.' }

$candidates = Get-ChildItem $profilesDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName 'package.json')
}
$candidates = @($candidates | Where-Object {
    if ($Profile) { return ($Profile -contains $_.Name) }
    return $true
})
if ($candidates.Count -eq 0) { throw "No DSH profile matched under $profilesDir" }

$touched = New-Object System.Collections.Generic.List[string]
foreach ($dir in $candidates) {
    $pkgPath = Join-Path $dir.FullName 'package.json'
    $json = Get-Content $pkgPath -Raw
    if ($json -notmatch 'dsh-superagent') { continue }

    $obj = $json | ConvertFrom-Json
    $current = $null
    if ($obj.PSObject.Properties.Name -contains 'dependencies' -and
        $obj.dependencies.PSObject.Properties.Name -contains 'dsh-superagent') {
        $current = $obj.dependencies.'dsh-superagent'
    } elseif ($obj.dsh -and $obj.dsh.profile -and ($obj.dsh.profile.bundles -contains 'dsh-superagent')) {
        $current = '(bundle only, no dependency entry)'
    } else {
        continue
    }

    Write-Sub "profile $($dir.Name): $current"
    if ($current -eq $linkValue) {
        Write-Ok 'already points at this checkout'
        $touched.Add($dir.Name) | Out-Null
        continue
    }

    if ($DryRun) {
        Write-Note "would set dependency dsh-superagent = $linkValue"
        $touched.Add($dir.Name) | Out-Null
        continue
    }

    $backup = "$pkgPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $pkgPath $backup
    if (-not ($obj.PSObject.Properties.Name -contains 'dependencies')) {
        $obj | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{}) -Force
    }
    if ($obj.dependencies.PSObject.Properties.Name -contains 'dsh-superagent') {
        $obj.dependencies.'dsh-superagent' = $linkValue
    } else {
        $obj.dependencies | Add-Member -MemberType NoteProperty -Name 'dsh-superagent' -Value $linkValue -Force
    }
    ($obj | ConvertTo-Json -Depth 32) | Set-Content -Path $pkgPath -Encoding UTF8
    Write-Ok "package.json updated (backup: $(Split-Path -Leaf $backup))"

    Write-Sub 're-linking profile node_modules ...'
    & dsh plugin --profile $dir.Name install
    if ($LASTEXITCODE -ne 0) {
        Write-Note "dsh plugin failed (exit $LASTEXITCODE); run it by hand: dsh plugin --profile $($dir.Name) install"
    }
    $junction = Join-Path $dir.FullName 'node_modules\dsh-superagent'
    if (Test-Path $junction) {
        try {
            $target = (Get-Item $junction).Target
            Write-Ok "linked -> $target"
        } catch {
            Write-Note 'linked (target not resolvable as a link)'
        }
    } else {
        Write-Note 'node_modules\dsh-superagent is missing; re-open DSH or rerun the plugin install'
    }
    $touched.Add($dir.Name) | Out-Null
}

if ($touched.Count -eq 0) { throw 'No DSH profile depends on dsh-superagent; install the bundle first (see docs/006-deployment.md).' }

# --- 5. what next -----------------------------------------------------------
Write-Step 'Done'
Write-Sub ("profiles now on this checkout: " + (($touched | Sort-Object -Unique) -join ', '))
Write-Note 'Restart the DSH process that hosts those profiles so it reloads lib/:'
Write-Sub  '  - panel/web UI: close it and start it again (or restart the profile service)'
Write-Sub  '  - superagent service: scripts\dsh-superagent.cmd restart --profile superagent'
