# Starts the ingestion service in its own new window (so it keeps polling
# Corvina continuously), waits long enough for a couple of poll cycles,
# then checks the backend API to see if real tag values showed up.
# Run this from the vessel-dashboard folder. Requires backend-api to
# already be running (from test-backend.ps1) -- if not, start that first.

$ingestionPath = Join-Path $PSScriptRoot "ingestion-service"

Write-Host "Starting ingestion-service in a new window..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$ingestionPath'; node src/index.js"

Write-Host "Waiting 15 seconds for it to poll Corvina a couple of times..."
Start-Sleep -Seconds 15

Write-Host ""
Write-Host "Checking http://localhost:3000/api/tags/latest ..."
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/api/tags/latest" -UseBasicParsing
    Write-Host "SUCCESS:"
    Write-Host $response.Content
} catch {
    Write-Host "FAILED (is backend-api still running in its own window? run test-backend.ps1 first if not):"
    Write-Host $_.Exception.Message
}
