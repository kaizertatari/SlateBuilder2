# Registers the three NFL Scheduled Tasks (run once, from the checkout the
# tasks should execute — after feat/nfl-model is merged into the branch that
# checkout keeps checked out, or the .bat files won't exist when they fire).
#
#   NFL Daily           07:30                     scripts\nfl-daily-task.bat
#   NFL Gameday Sweep   every 30 min 07:00-23:30  scripts\nfl-gameday-task.bat
#   NFL Refresh Board   00:40 / 06:40 / 12:40 / 18:40  scripts\nfl-board-task.bat
#
# Same settings as the EPL tasks (RUNBOOK "Scheduled tasks"): conhost
# --headless action, WorkingDirectory = repo, current-user Interactive
# principal (no -Principal: PerimeterX blocks session-0), battery conditions
# cleared, StartWhenAvailable, IgnoreNew. Re-running replaces the tasks.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register-nfl-tasks.ps1 [-Remove]

param([switch]$Remove)

$repo = Split-Path -Parent $PSScriptRoot
$names = @("NFL Daily", "NFL Gameday Sweep", "NFL Refresh Board")

foreach ($n in $names) {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false
  }
}
if ($Remove) { Write-Output "Removed: $($names -join ', ')"; return }

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

function New-BatAction($bat) {
  New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument "--headless `"$repo\scripts\$bat`"" -WorkingDirectory $repo
}

$daily = New-ScheduledTaskTrigger -Daily -At "07:30"
Register-ScheduledTask -TaskName "NFL Daily" -Action (New-BatAction "nfl-daily-task.bat") `
  -Trigger $daily -Settings $settings | Out-Null

$sweep = New-ScheduledTaskTrigger -Daily -At "07:00"
$sweep.Repetition = (New-ScheduledTaskTrigger -Once -At "07:00" `
  -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 16 -Minutes 30)).Repetition
Register-ScheduledTask -TaskName "NFL Gameday Sweep" -Action (New-BatAction "nfl-gameday-task.bat") `
  -Trigger $sweep -Settings $settings | Out-Null

$board = @("00:40", "06:40", "12:40", "18:40") | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
Register-ScheduledTask -TaskName "NFL Refresh Board" -Action (New-BatAction "nfl-board-task.bat") `
  -Trigger $board -Settings $settings | Out-Null

foreach ($n in $names) {
  $t = Get-ScheduledTask -TaskName $n
  $i = $t | Get-ScheduledTaskInfo
  Write-Output ("{0,-20} {1,-6} next {2}" -f $n, $t.State, $i.NextRunTime)
}
