# Starts the whole vessel-dashboard stack quietly: Postgres (via Docker),
# backend-api, and ingestion-service -- all in the background, no visible
# windows. Meant to be run automatically at Windows login (see
# install-autostart.ps1), but you can also run it by hand any time
# (right-click -> Run with PowerShell, or `.\start-all.ps1` in a terminal)
# if the stack isn't already up.
#
# Safe to run more than once -- it checks what's already running/listening
# before starting anything again, so it won't create duplicate processes.

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "start-all.log"

function Write-Log($message) {
    $line = "[$(Get-Date -Format o)] $message"
    Write-Output $line
    Add-Content -Path $logFile -Value $line
}

function Test-PortOpen($port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Wait-ForPort($port, $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortOpen $port) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

Set-Location $root

# --- 1. Postgres (Docker) --------------------------------------------------
Write-Log "Starting Postgres (docker compose up -d db)..."
docker compose up -d db *>> (Join-Path $logDir "docker.log")

Write-Log "Waiting for Postgres to accept connections..."
if (Wait-ForPort 5432 60) {
    Write-Log "Postgres is up."
} else {
    Write-Log "WARNING: Postgres did not come up within 60s. Is Docker Desktop running? See logs\docker.log."
}

# --- 2. backend-api ----------------------------------------------------------
# Runs through nodemon, not plain node -- nodemon watches this folder's .js
# files and restarts the process on its own the moment one changes, so an
# updated file (however it gets here) takes effect without anyone needing to
# find the window and press Ctrl+C.
if (Test-PortOpen 3000) {
    Write-Log "backend-api already running on port 3000 -- skipping."
} else {
    Write-Log "Starting backend-api (auto-restarts itself on file changes)..."
    Start-Process -FilePath "npx.cmd" -ArgumentList "nodemon", "src/index.js" `
        -WorkingDirectory (Join-Path $root "backend-api") `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "backend-api.log") `
        -RedirectStandardError (Join-Path $logDir "backend-api-error.log")
}

# --- 3. ingestion-service -----------------------------------------------------
# Passing nodemon an ABSOLUTE path to index.js (rather than the relative
# "src/index.js" the previous version used) means the full path -- including
# "ingestion-service" -- actually shows up in the process's command line, so
# the duplicate check below can actually find it. The relative-path version
# looked like it worked but the -like match below could never succeed, since
# a relative argument never contains the folder name Windows reports.
$ingestionEntry = Join-Path $root "ingestion-service\src\index.js"
$ingestionRunning = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*ingestion-service*index.js*" }

if ($ingestionRunning) {
    Write-Log "ingestion-service already running -- skipping."
} else {
    Write-Log "Starting ingestion-service (auto-restarts itself on file changes)..."
    Start-Process -FilePath "npx.cmd" -ArgumentList "nodemon", "`"$ingestionEntry`"" `
        -WorkingDirectory (Join-Path $root "ingestion-service") `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "ingestion-service.log") `
        -RedirectStandardError (Join-Path $logDir "ingestion-service-error.log")
}

Write-Log "Done. Dashboard: http://localhost:3000  (check the 'logs' folder if anything looks wrong)"
