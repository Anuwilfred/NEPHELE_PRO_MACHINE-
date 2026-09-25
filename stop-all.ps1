# Stops backend-api and ingestion-service (found by matching their command
# line, since they're plain 'node' processes) and stops the Postgres
# container. Doesn't delete any data -- start-all.ps1 (or the next login,
# once autostart is installed) brings everything back exactly as it was.

$root = $PSScriptRoot
Set-Location $root

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*backend-api*index.js*" -or $_.CommandLine -like "*ingestion-service*index.js*" } |
    ForEach-Object {
        Write-Output "Stopping PID $($_.ProcessId): $($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

docker compose stop db

Write-Output "Stopped. Postgres data is untouched -- run start-all.ps1 to bring everything back."
