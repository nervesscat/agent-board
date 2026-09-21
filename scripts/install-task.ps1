<#
.SYNOPSIS
  Registers the board as a Windows Scheduled Task that starts at boot and runs whether you are
  logged on or not, so the in-app review schedules fire at 9am even with nobody at the machine.

.DESCRIPTION
  Builds the production bundle, then registers task "AgentBoard":
    - trigger: at system startup, or at your logon with -Interactive (Start-ScheduledTask AgentBoard starts it by hand)
    - action:  node --env-file-if-exists=.env .output/server/index.mjs, in this checkout
    - runs as: the current user, "run whether user is logged on or not", so `claude` and `gh`
               find this user's credentials
    - restarts itself up to 3 times if it dies; never stops for being "too long"
  Logs go to data\logs\board.out.log and board.err.log.

  Needs an elevated shell (it re-launches itself as Administrator if not). You will be prompted for
  your Windows password once: that is what lets the task run without
  an interactive session. If your account has no password, use -Interactive instead (then the
  task only runs while you are logged on).

.PARAMETER Interactive
  Register as "run only when user is logged on" (no password needed).
#>
param(
  [switch]$Interactive,
  # The account the board runs as: yours, so the task sees your gh/claude logins. Carried into the
  # elevated re-launch, which otherwise runs as whichever administrator approved the UAC prompt.
  [string]$RunAs = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'AgentBoard'
$node = (Get-Command node).Source

# Storing a password with the task ("run whether user is logged on or not") needs an elevated shell.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Interactive -and -not $isAdmin) {
  Write-Host 'Registering a task that runs without a logged-on user needs Administrator rights. Re-launching elevated...'
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-RunAs', "`"$RunAs`"")
  exit
}

Push-Location $root
try {
  if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
  Write-Host 'Building the production bundle...'
  # cmd.exe swallows the bundler's stderr chatter; in PowerShell 5.1 a native stderr line under
  # $ErrorActionPreference = 'Stop' would abort the script even though the build succeeded.
  $buildLog = Join-Path $root 'data\logs\build.log'
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\logs') | Out-Null
  cmd.exe /c "npm run build > `"$buildLog`" 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed, see $buildLog" }
} finally { Pop-Location }

# cmd.exe does the log redirection; node itself is the process the task tracks.
$logOut = Join-Path $root 'data\logs\board.out.log'
$logErr = Join-Path $root 'data\logs\board.err.log'
$cmdLine = "/c `"`"$node`" --env-file-if-exists=.env .output\server\index.mjs >> `"$logOut`" 2>> `"$logErr`"`""
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$user = $RunAs
if ($Interactive) {
  # An interactive task cannot start at boot (no session yet), so it starts the moment you log on.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
} else {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $cred = Get-Credential -UserName $user -Message "Password for $user (the account the board runs as), so the task can run whether you are logged on or not"
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -ErrorAction Stop | Out-Null
  } catch {
    throw "Register-ScheduledTask failed: $($_.Exception.Message) (wrong password, or the account lacks the 'Log on as a batch job' right)"
  }
}

Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $taskName
Write-Host "Task '$taskName' registered ($($task.Principal.LogonType)) and started: $($task.State)"
Write-Host "Board: http://localhost:47100   Logs: $logOut"
Write-Host "Later: Start-ScheduledTask $taskName / Stop-ScheduledTask $taskName / scripts\uninstall-task.ps1"
