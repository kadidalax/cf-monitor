[CmdletBinding()]
param(
  [string]$Server,

  [string]$Token,

  [string]$Name = $env:COMPUTERNAME,
  [int]$Interval = 3,
  [int]$PingInterval = 30,
  [ValidateSet("websocket", "http")]
  [string]$Mode = "websocket",
  [string]$InstallDir = "C:\Program Files\CF Monitor",
  [string]$ServiceName = "CFMonitorAgent",
  [string]$SourceUrl = "",
  [string]$BinaryPath = "",
  [string]$BinaryUrl = "",
  [string]$Proxy = "",
  [string]$MountInclude = "",
  [string]$MountExclude = "",
  [string]$NicInclude = "",
  [string]$NicExclude = "",
  [switch]$DisableWebSsh,
  [switch]$DisableAutoUpdate,
  [switch]$IgnoreUnsafeCert,
  [string]$InstallGhproxy = "",
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$KeepFiles
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Description,
    [scriptblock]$Action
  )

  if ($DryRun) {
    Write-Host "[dry-run] $Description"
    return
  }

  & $Action
}

if (-not $DryRun -and -not (Test-Admin)) {
  throw "Please run this script from an elevated PowerShell session."
}

if ([string]::IsNullOrWhiteSpace($ServiceName)) {
  throw "-ServiceName cannot be empty."
}

if ([string]::IsNullOrWhiteSpace($InstallDir) -or [System.IO.Path]::GetPathRoot($InstallDir) -eq $InstallDir) {
  throw "-InstallDir cannot be empty or a drive root."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$targetExe = Join-Path $InstallDir "cf-monitor-agent.exe"
$runnerPath = Join-Path $InstallDir "run-agent.ps1"
$repository = "kadidalax/cf-monitor"
$branch = "main"

function ConvertTo-PowerShellLiteral {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Join-GitHubProxy {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($InstallGhproxy)) {
    return $Url
  }
  return $InstallGhproxy.TrimEnd("/") + "/" + $Url
}

function Invoke-DownloadFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [string]$OutFile
  )

  if ($DryRun) {
    $proxyText = if ([string]::IsNullOrWhiteSpace($Proxy)) { "" } else { " -Proxy `"$Proxy`"" }
    Write-Host "[dry-run] Invoke-WebRequest $Url$proxyText -OutFile `"$OutFile`""
    return
  }

  $downloadParams = @{
    Uri = $Url
    UseBasicParsing = $true
    OutFile = $OutFile
  }
  if (-not [string]::IsNullOrWhiteSpace($Proxy)) {
    $downloadParams.Proxy = $Proxy
  }
  Invoke-WebRequest @downloadParams
}

function Resolve-BuildDirectory {
  $localMain = Join-Path $scriptDir "main.go"
  if (Test-Path -LiteralPath $localMain) {
    return $scriptDir
  }

  $archiveUrl = if ([string]::IsNullOrWhiteSpace($SourceUrl)) {
    "https://github.com/$repository/archive/refs/heads/$branch.zip"
  } else {
    $SourceUrl
  }
  $archiveUrl = Join-GitHubProxy $archiveUrl
  $archivePath = Join-Path $env:TEMP "cf-monitor-source.zip"
  $extractDir = Join-Path $env:TEMP ("cf-monitor-source-" + [Guid]::NewGuid().ToString("N"))

  Invoke-DownloadFile -Url $archiveUrl -OutFile $archivePath

  if ($DryRun) {
    Write-Host "[dry-run] Expand-Archive -LiteralPath `"$archivePath`" -DestinationPath `"$extractDir`""
    return (Join-Path $extractDir "cf-monitor-main\agent")
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
  $mainGo = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter main.go |
    Where-Object { $_.FullName -match "\\agent\\main\.go$" } |
    Select-Object -First 1
  if (-not $mainGo) {
    throw "Cannot find agent/main.go in source archive: $archiveUrl"
  }
  return $mainGo.Directory.FullName
}

if ($Uninstall) {
  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Status -ne "Stopped") {
      Invoke-Step "Stop-Service -Name `"$ServiceName`" -Force" {
        Stop-Service -Name $ServiceName -Force
      }
    }
    Invoke-Step "sc.exe delete `"$ServiceName`"" {
      sc.exe delete $ServiceName | Out-Null
    }
  } else {
    Write-Host "Service not found: $ServiceName"
  }

  if (-not $KeepFiles) {
    Invoke-Step "Remove-Item -LiteralPath `"$InstallDir`" -Recurse -Force" {
      if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
      }
    }
  }

  Write-Host "Uninstalled $ServiceName."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Server) -or [string]::IsNullOrWhiteSpace($Token)) {
  throw "-Server and -Token are required for install or upgrade."
}

if ($BinaryPath -ne "" -and $BinaryUrl -ne "") {
  throw "Use either -BinaryPath or -BinaryUrl, not both."
}

if ($BinaryPath -eq "" -and $BinaryUrl -ne "") {
  $downloadOut = Join-Path $env:TEMP "cf-monitor-agent.exe"
  Invoke-DownloadFile -Url $BinaryUrl -OutFile $downloadOut
  $BinaryPath = $downloadOut
}

if ($BinaryPath -eq "") {
  $go = Get-Command go -ErrorAction SilentlyContinue
  if (-not $go -and -not $DryRun) {
    throw "Go is required to build the agent. Install Go or pass -BinaryPath."
  }
  $buildOut = Join-Path $env:TEMP "cf-monitor-agent.exe"
  $buildDir = Resolve-BuildDirectory
  $buildCommand = "go build -trimpath -ldflags=`"-s -w`" -o `"$buildOut`" ."
  if ($DryRun) {
    Write-Host "[dry-run] cd `"$buildDir`"; $buildCommand"
  } else {
    Push-Location $buildDir
    try {
      go build -trimpath -ldflags="-s -w" -o $buildOut .
    } finally {
      Pop-Location
    }
  }
  $BinaryPath = $buildOut
}

if (-not (Test-Path $BinaryPath) -and -not $DryRun) {
  throw "Binary not found: $BinaryPath"
}

$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$binaryPathName = '"' + $powerShellPath + '" -NoProfile -ExecutionPolicy Bypass -File "' + $runnerPath + '"'

if ($DryRun) {
  Write-Host "[dry-run] New-Item -ItemType Directory -Force `"$InstallDir`""
  Write-Host "[dry-run] Copy-Item `"$BinaryPath`" `"$targetExe`""
  Write-Host "[dry-run] Write service runner `"$runnerPath`" (token hidden)"
  Write-Host "[dry-run] Lock ACL on `"$runnerPath`" to SYSTEM and Administrators"
  Write-Host "[dry-run] Stop/delete existing service if present: `"$ServiceName`""
  Write-Host "[dry-run] New-Service -Name `"$ServiceName`" -BinaryPathName $binaryPathName -StartupType Automatic"
  Write-Host "[dry-run] Start-Service -Name `"$ServiceName`""
  exit 0
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item $BinaryPath $targetExe -Force

$runnerContent = @"
`$ErrorActionPreference = "Stop"
`$env:CF_MONITOR_SERVER = $(ConvertTo-PowerShellLiteral $Server)
`$env:CF_MONITOR_TOKEN = $(ConvertTo-PowerShellLiteral $Token)
`$env:CF_MONITOR_NAME = $(ConvertTo-PowerShellLiteral $Name)
`$env:CF_MONITOR_MODE = $(ConvertTo-PowerShellLiteral $Mode)
`$env:CF_MONITOR_MOUNT_INCLUDE = $(ConvertTo-PowerShellLiteral $MountInclude)
`$env:CF_MONITOR_MOUNT_EXCLUDE = $(ConvertTo-PowerShellLiteral $MountExclude)
`$env:CF_MONITOR_NIC_INCLUDE = $(ConvertTo-PowerShellLiteral $NicInclude)
`$env:CF_MONITOR_NIC_EXCLUDE = $(ConvertTo-PowerShellLiteral $NicExclude)

& "`$PSScriptRoot\cf-monitor-agent.exe" --interval $Interval --ping-interval $PingInterval
exit `$LASTEXITCODE
"@
Set-Content -LiteralPath $runnerPath -Value $runnerContent -Encoding UTF8
icacls $runnerPath /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
  }
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

New-Service `
  -Name $ServiceName `
  -DisplayName "CF Monitor Agent" `
  -StartupType Automatic `
  -BinaryPathName $binaryPathName | Out-Null

Start-Service -Name $ServiceName
Get-Service -Name $ServiceName
