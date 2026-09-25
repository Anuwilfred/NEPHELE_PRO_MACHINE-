# Run this ONCE, from a normal PowerShell window (no admin rights needed --
# it only registers a task for your own user account). After this, the
# vessel dashboard starts automatically every time you log into Windows,
# so you never need to open PowerShell to start it by hand again.
#
# What it does: registers a Windows Task Scheduler task that quietly runs
# start-all.ps1 (no visible window) whenever you log in.

$root = $PSScriptRoot
$scriptPath = Join-Path $root "start-all.ps1"
$taskName = "VesselDashboardAutoStart"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
# No -User filter on the trigger -- this is a single-user machine, so it
# just fires on login regardless of exactly how Windows reports the
# account name (domain-joined vs. local vs. Microsoft account all format
# it differently, and getting that string wrong is the single most common
# reason this kind of task silently never fires).
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Starts the vessel dashboard (Postgres, backend-api, ingestion-service) at login." | Out-Null

Write-Output "Installed. The stack will now start automatically the next time you log into Windows."
Write-Output ""
Write-Output "One thing to check by hand, once: open Docker Desktop -> Settings -> General ->"
Write-Output "turn on 'Start Docker Desktop when you log in'. Without that, Docker itself won't"
Write-Output "be running yet when this task fires at login, so Postgres won't be able to start."
Write-Output ""
Write-Output "Want to test it right now without logging out? Run: .\start-all.ps1"
