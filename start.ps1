# Starts the pushup RPG and makes a temporary https link for your phone.
# The link comes from localhost.run (free, no account). It changes every time, and when the connection drops.
# Your progress is kept on this PC in save\save.json, so a new link doesn't lose it.
# Stop everything with Ctrl+C.
param([int]$Port = 8000)

$server = Start-Job -FilePath (Join-Path $PSScriptRoot 'serve.ps1') -ArgumentList $Port, $PSScriptRoot
Start-Sleep -Seconds 1
Write-Host "Game on this PC: http://localhost:$Port/app/"
Write-Host "Phone: open the https://....lhr.life address shown below (it goes straight to the game)."
Write-Host ""

try {
    ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R "80:127.0.0.1:$Port" nokey@localhost.run
} finally {
    Stop-Job $server
    Remove-Job $server -Force
    Write-Host "Stopped."
}
