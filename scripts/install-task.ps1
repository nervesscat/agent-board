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

  You will be prompted for your Windows password once: that is what lets the task run without
  an interactive session. If your account has no password, use -Interactive instead (then the
  task only runs while you are logged on).

.PARAMETER Interactive
  Register as "run only when user is logged on" (no password needed).
#>
param([switch]$Interactive)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'AgentBoard'
$node = (Get-Command node).Source

Push-Location $root
try {
  if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
  Write-Host 'Building the production bundle…'
  npm run build | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\logs') | Out-Null
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

$user = "$env:USERDOMAIN\$env:USERNAME"
if ($Interactive) {
  # An interactive task cannot start at boot (no session yet), so it starts the moment you log on.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
} else {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $cred = Get-Credential -UserName $user -Message 'Windows password, so the task can run whether you are logged on or not'
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited | Out-Null
}

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $taskName
Write-Host "Task '$taskName' registered ($($task.Principal.LogonType)) and started: $($task.State)"
Write-Host "Board: http://localhost:47100   Logs: $logOut"
Write-Host "Later: Start-ScheduledTask $taskName / Stop-ScheduledTask $taskName / scripts\uninstall-task.ps1"
