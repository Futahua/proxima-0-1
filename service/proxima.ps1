# proxima.ps1 — the way proximad is meant to be running on this machine.
#
# Not "a lane starts it". The daemon is the thing that owns the board, and the
# cockpit is served BY it, so the honest arrangement is:
#
#   * proximad runs detached, under this user, from a home on disk;
#   * a logon task calls this script with -Action ensure -NoOpen so it is already
#     there when Papers or a browser opens;
#   * the shortcut the creator actually clicks calls it with -Action ensure, which
#     starts it if it is not running and then opens the cockpit.
#
# So "the service is not running" is not a state the creator has to diagnose: the
# thing they click repairs it. And if they do open a stale bookmark and get a
# refusal, the page now says which refusal it is.
#
#   pwsh -File service/proxima.ps1 -Action ensure      # start if needed, open it
#   pwsh -File service/proxima.ps1 -Action ensure -NoOpen
#   pwsh -File service/proxima.ps1 -Action status
#   pwsh -File service/proxima.ps1 -Action stop

[CmdletBinding()]
param(
  [ValidateSet('ensure', 'status', 'stop')]
  [string]$Action = 'ensure',
  [int]$Port = 4181,
  [string]$DataHome,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot, not $MyInvocation.MyCommand.Path: under `pwsh -File` the latter can be
# empty, and an empty base turns the daemon's path into a relative one that resolves
# against whatever the caller's directory happened to be.
$here = $PSScriptRoot
$service = Join-Path $here 'proximad.mjs'
$url = "http://127.0.0.1:$Port/"
$health = "${url}v1/health"

function Get-Home($running) {
  # Which data home, decided by what is actually on disk rather than by a guess. The
  # board the creator has been using is the one that must be opened, so:
  #   1. an explicit -DataHome or PROXIMA_HOME;
  #   2. the home the running daemon reports — it is holding that board right now;
  #   3. the nearest "Proxima Data Home" above this script that already holds a
  #      proxima.db, so the workspace home is found without hard-coding a path;
  #   4. the documented per-user default.
  if ($DataHome) { return $DataHome }
  if ($env:PROXIMA_HOME) { return $env:PROXIMA_HOME }
  if ($running -and $running.dataHome) { return $running.dataHome }
  $dir = $here
  for ($i = 0; $i -lt 8 -and $dir; $i++) {
    $candidate = Join-Path $dir 'Proxima Data Home'
    if (Test-Path (Join-Path $candidate 'proxima.db')) { return $candidate }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  return (Join-Path $env:USERPROFILE 'Proxima Data Home')
}

function Test-Health {
  try {
    $response = Invoke-WebRequest -Uri $health -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) { return ($response.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Show-Status($state) {
  if ($state) {
    Write-Host "proximad is up on $url"
    Write-Host ("  instance  {0}" -f $state.instanceId)
    Write-Host ("  head seq  {0}" -f $state.headSeq)
    Write-Host ("  home      {0}" -f $state.dataHome)
  } else {
    Write-Host "proximad is NOT answering on $url"
  }
}

$state = Test-Health
$home_ = Get-Home $state

switch ($Action) {
  'status' {
    Show-Status $state
    Write-Host ("  home it would use  {0}" -f $home_)
  }
  'stop' {
    if (-not $state) { Write-Host "proximad is not running on $url — nothing to stop."; break }
    # Ask the process that owns the port; never guess at a pid by name, because
    # "node" is every other script on this machine too.
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { Write-Host "Nothing is listening on $Port any more."; break }
    foreach ($c in $conn) {
      try { Stop-Process -Id $c.OwningProcess -Force; Write-Host "Stopped process $($c.OwningProcess) on port $Port." }
      catch { Write-Host "Could not stop process $($c.OwningProcess): $($_.Exception.Message)" }
    }
  }
  'ensure' {
    if ($state) {
      Write-Host "proximad was already up on $url (head seq $($state.headSeq))."
    } else {
      $log = Join-Path $home_ 'proximad.log'
      New-Item -ItemType Directory -Force -Path $home_ | Out-Null
      Write-Host "Starting proximad from $home_ (log: $log)"
      # Detached and windowless: this is a service, not a terminal somebody has to
      # keep open. Its lifetime must not be tied to whatever started it.
      #
      # Quoted by hand: -ArgumentList joins its array with spaces and quotes nothing,
      # so a path with a space in it ("...\Backpack projects\...") arrives at node
      # truncated and the daemon dies with MODULE_NOT_FOUND.
      $argLine = '"{0}" --home "{1}" --port {2} --quiet' -f $service, $home_, $Port
      Start-Process -FilePath 'node' -ArgumentList $argLine `
        -WorkingDirectory $here -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null

      $waited = 0
      while ($waited -lt 20) {
        Start-Sleep -Milliseconds 500
        $waited++
        $state = Test-Health
        if ($state) { break }
      }
      if (-not $state) {
        Write-Host "proximad did not answer within 10 seconds. Last lines of $log.err:"
        if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 12 | ForEach-Object { "  $_" } }
        exit 3
      }
      Write-Host "proximad is up on $url (head seq $($state.headSeq))."
    }
    if (-not $NoOpen) { Start-Process $url }
  }
}
