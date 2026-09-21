# Stops and removes the AgentBoard scheduled task. Data in data\ is untouched.
$ErrorActionPreference = 'Stop'
$taskName = 'AgentBoard'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Task '$taskName' removed."
} else {
  Write-Host "Task '$taskName' is not registered."
}
