# Starts the test page and makes a temporary public https link for your phone.
# The link comes from localhost.run (free, no account). It changes every time.
# Stop everything with Ctrl+C.
param([int]$Port = 8000)

$server = Start-Job -FilePath (Join-Path $PSScriptRoot 'serve.ps1') -ArgumentList $Port, $PSScriptRoot
Start-Sleep -Seconds 1
Write-Host "Test page on this PC: http://localhost:$Port/"
Write-Host "Making a phone link... open the https://....lhr.life address shown below on your phone."
Write-Host ""

try {
    ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R "80:127.0.0.1:$Port" nokey@localhost.run
} finally {
    Stop-Job $server
    Remove-Job $server -Force
    Write-Host "Stopped."
}
