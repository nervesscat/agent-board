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

.PARAMETER Wsl
  Run the board inside this WSL distro (e.g. kali-linux); -WslPath is the checkout there.

.EXAMPLE
  scripts\install-task.ps1 -Wsl kali-linux -WslPath /home/emadrid/agent-board
#>
param(
  [switch]$Interactive,
  # The account the board runs as: yours, so the task sees your gh/claude logins. Carried into the
  # elevated re-launch, which otherwise runs as whichever administrator approved the UAC prompt.
  [string]$RunAs = "$env:USERDOMAIN\$env:USERNAME",
  # Run the board inside a WSL distro instead of Windows: the projects, git, gh and claude live there.
  # The task then starts `wsl.exe -d <distro> --cd <WslPath> -- bash -lc "npm start"`, which also keeps
  # the WSL VM alive from boot. WslPath is the board checkout inside the distro.
  [string]$Wsl = '',
  [string]$WslPath = '',
  # Set by the non-elevated pass after it has already built inside WSL; not for manual use.
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'AgentBoard'
if ($Wsl -and -not $WslPath) { throw 'give -WslPath, the board checkout inside the distro (e.g. /home/me/agent-board)' }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

# WSL distros are registered per Windows user, so the WSL build has to run as you, here, before any
# elevation: the elevated window may belong to a different (administrator) account with its own WSL.
# The task itself runs as you too, so it sees the same distro.
if ($Wsl -and -not $SkipBuild) {
  # The WSL checkout tracks this one as its origin: pull, install for Linux, build, all inside the distro.
  # bash -l so ~/.local/bin (gh, claude) is on PATH, exactly as it will be for the task.
  Write-Host "Building inside WSL ($Wsl : $WslPath)..."
  wsl.exe -d $Wsl --cd $WslPath -- bash -lc "git pull -q && npm install --silent && npm run build > data/logs/build.log 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "build inside WSL failed, see $WslPath/data/logs/build.log" }
}

# Storing a password with the task ("run whether user is logged on or not") needs an elevated shell.
if (-not $Interactive -and -not $isAdmin) {
  Write-Host 'Registering a task that runs without a logged-on user needs Administrator rights. Re-launching elevated...'
  $args = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-RunAs', "`"$RunAs`"")
  if ($Wsl) { $args += @('-Wsl', $Wsl, '-WslPath', $WslPath, '-SkipBuild') }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $args
  exit
}

$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$buildLog = Join-Path $logDir 'build.log'
$logOut = Join-Path $logDir 'board.out.log'
$logErr = Join-Path $logDir 'board.err.log'

if ($Wsl) {
  $cmdLine = "/c `"`"wsl.exe`" -d $Wsl --cd $WslPath -- bash -lc `"npm start`" >> `"$logOut`" 2>> `"$logErr`"`""
} else {
  $node = (Get-Command node).Source
  Push-Location $root
  try {
    if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
    Write-Host 'Building the production bundle...'
    # cmd.exe swallows the bundler's stderr chatter; in PowerShell 5.1 a native stderr line under
    # $ErrorActionPreference = 'Stop' would abort the script even though the build succeeded.
    cmd.exe /c "npm run build > `"$buildLog`" 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed, see $buildLog" }
  } finally { Pop-Location }
  $cmdLine = "/c `"`"$node`" --env-file-if-exists=.env .output\server\index.mjs >> `"$logOut`" 2>> `"$logErr`"`""
}

# cmd.exe does the log redirection; the server process itself is what the task tracks.
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
  # A stored-password task logs on as a batch job. Windows grants that right only to Administrators,
  # Backup Operators and Performance Log Users, and registering the task does not add you: without it
  # every run fails in LogonUserExEx with 0x80070569 and the task stays "has not yet run".
  $sid = (New-Object Security.Principal.NTAccount $user).Translate([Security.Principal.SecurityIdentifier]).Value
  $rights = Join-Path $env:TEMP 'agentboard-rights.inf'
  secedit.exe /export /cfg $rights /areas USER_RIGHTS | Out-Null
  $batch = Get-Content $rights | Where-Object { $_ -match '^SeBatchLogonRight\s*=' }
  $deny = Get-Content $rights | Where-Object { $_ -match '^SeDenyBatchLogonRight\s*=' }
  if ($deny -match "\*$sid\b") { throw "$user is listed under 'Deny log on as a batch job' (secpol.msc); remove it there first" }
  if ($batch -notmatch "\*$sid\b") {
    Write-Host "Granting $user 'Log on as a batch job'..."
    $line = if ($batch) { "$batch,*$sid" } else { "SeBatchLogonRight = *$sid" }
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', $line) |
      Set-Content $rights -Encoding Unicode
    secedit.exe /configure /db (Join-Path $env:TEMP 'agentboard-rights.sdb') /cfg $rights /areas USER_RIGHTS | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not grant 'Log on as a batch job' to $user, see $env:windir\security\logs\scesrv.log" }
  }
  Remove-Item $rights -ErrorAction SilentlyContinue

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
# Start-ScheduledTask returns fine even when the logon fails; only the run record tells.
$info = Get-ScheduledTaskInfo -TaskName $taskName
if ($info.LastTaskResult -eq 267011) {
  throw "Task '$taskName' was registered but did not start (logon failed). Enable Task Scheduler history (wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true) and run Start-ScheduledTask $taskName to see why."
}
Write-Host "Task '$taskName' registered ($($task.Principal.LogonType)) and started: $($task.State)"
Write-Host "Board: http://localhost:47100   Logs: $logOut"
Write-Host "Later: Start-ScheduledTask $taskName / Stop-ScheduledTask $taskName / scripts\uninstall-task.ps1"
