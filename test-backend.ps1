# Starts the backend API in its own new PowerShell window (so it keeps
# running), waits a few seconds for it to boot, then tests it from THIS
# window. Run this from the vessel-dashboard folder.

$backendPath = Join-Path $PSScriptRoot "backend-api"

Write-Host "Starting backend-api in a new window..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$backendPath'; node src/index.js"

Write-Host "Waiting 4 seconds for it to start..."
Start-Sleep -Seconds 4

Write-Host ""
Write-Host "Testing http://localhost:3000/health ..."
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/health" -UseBasicParsing
    Write-Host "SUCCESS:"
    Write-Host $response.Content
} catch {
    Write-Host "FAILED:"
    Write-Host $_.Exception.Message
}
