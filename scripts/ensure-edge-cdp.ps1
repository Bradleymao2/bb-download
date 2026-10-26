<#
.SYNOPSIS
  Ensure an Edge instance exposes a CDP endpoint on 127.0.0.1:9222.

.DESCRIPTION
  If the endpoint already answers, this script only reports the state.
  Otherwise it gracefully closes Edge, relaunches it with the SAME profile
  (so cookies and logins survive) plus --remote-debugging-port, and waits
  for CDP to come up.

  Ask the user before letting this restart their browser. Tabs usually do
  not auto-restore; mention Ctrl+Shift+T.

.PARAMETER Port
  Debug port, default 9222.

.PARAMETER NoRestart
  Never restart Edge; fail if CDP is not already available.

.PARAMETER NoRestore
  Do not pass --restore-last-session when relaunching.
#>
param(
  [int]$Port = 9222,
  [switch]$NoRestart,
  [switch]$NoRestore
)

$ErrorActionPreference = 'Stop'

function Test-Cdp {
  param([int]$P, [int]$TimeoutSec = 2)
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec $TimeoutSec
    return $true
  } catch { return $false }
}

function Get-EdgeExe {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  try {
    $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction Stop
    if ($reg.'(default)' -and (Test-Path $reg.'(default)')) { return $reg.'(default)' }
  } catch { }
  throw 'Microsoft Edge not found.'
}

function Get-EdgeUserData {
  $p = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
  if (Test-Path $p) { return $p }
  throw "Edge user data dir not found: $p"
}

if (Test-Cdp -P $Port -TimeoutSec 3) {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  Write-Host "[ok] CDP already available on port $Port ($($v.Browser))"
  exit 0
}

if ($NoRestart) {
  Write-Error "CDP is not available on port $Port and -NoRestart was set."
  exit 2
}

$exe = Get-EdgeExe
$userData = Get-EdgeUserData
$running = (Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "[info] Edge exe   : $exe"
Write-Host "[info] profile    : $userData"
Write-Host "[info] Edge procs : $running"

if ($running -gt 0) {
  Write-Host '[info] closing Edge gracefully (profile and logins are kept)...'
  $null = taskkill /IM msedge.exe 2>&1
  Start-Sleep -Seconds 6
  if ((Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) {
    Write-Host '[warn] some processes ignored the close request; forcing.'
    $null = taskkill /F /IM msedge.exe 2>&1
    Start-Sleep -Seconds 4
  }
}

$args = @(
  "--remote-debugging-port=$Port",
  '--remote-allow-origins=*',   # lets non-edge origins open the CDP websocket
  "--user-data-dir=$userData"
)
if (-not $NoRestore) { $args += '--restore-last-session' }

Write-Host '[info] relaunching Edge with CDP...'
Start-Process -FilePath $exe -ArgumentList $args | Out-Null

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if (Test-Cdp -P $Port -TimeoutSec 2) {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    Write-Host "[ok] CDP up on port $Port ($($v.Browser))"
    Write-Host '[note] Edge keeps the debug port until it is closed; closing Edge returns it to normal.'
    exit 0
  }
  Start-Sleep -Seconds 3
}

Write-Error "CDP did not come up on port $Port within 90s."
exit 1
