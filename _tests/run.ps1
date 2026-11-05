# Runs the automated game tests (_tests\tests.js) in a hidden Microsoft Edge and prints the results.
# Usage: powershell -File _tests\run.ps1        Exit code = number of failed tests.
# It copies the game to a temporary folder and serves it on its own port, so your real save
# (save\save.json and the phone) is never touched. Outside sites (body tracking, fonts) are
# blocked inside the test browser, so tests don't depend on the internet.
param([int]$Port = 8002, [int]$DevPort = 9334, [int]$TimeoutSec = 300)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = Join-Path $env:TEMP ("pushup-rpg-tests\run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force "$root\app", "$root\_tests" | Out-Null
Get-ChildItem "$repo\app" -File | Copy-Item -Destination "$root\app"
Copy-Item "$repo\_tests\index.html", "$repo\_tests\tests.js" "$root\_tests"

$server = Start-Job -ScriptBlock { param($s, $r, $p) & $s -Port $p -Root $r } -ArgumentList "$repo\serve.ps1", $root, $Port
$edge = $null
try {
    for ($i = 0; $i -lt 40; $i++) { try { Invoke-WebRequest "http://127.0.0.1:$Port/_tests/" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }
    $block = "MAP cdn.jsdelivr.net 127.0.0.1, MAP storage.googleapis.com 127.0.0.1, MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1"
    $edge = Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -PassThru -ArgumentList `
        "--headless=new", "--remote-debugging-port=$DevPort", "--user-data-dir=`"$root\edge`"", "--no-first-run", `
        "--deny-permission-prompts", `
        "--host-resolver-rules=`"$block`"", "http://localhost:$Port/_tests/"
    $target = $null
    for ($i = 0; $i -lt 40 -and -not $target; $i++) {
        try { $target = (Invoke-RestMethod "http://127.0.0.1:$DevPort/json" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' -and $_.url -like '*_tests*' } | Select-Object -First 1 } catch {}
        if (-not $target) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $target) { throw "test page did not open in Edge" }

    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
    $script:id = 0
    function Eval($code) {
        $script:id++
        $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id = $script:id; method = 'Runtime.evaluate'; params = @{ expression = $code; returnByValue = $true } } | ConvertTo-Json -Compress))
        $ws.SendAsync((New-Object ArraySegment[byte] (, $bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
        while ($true) {
            $buf = New-Object byte[] 1048576; $sb = New-Object Text.StringBuilder
            do { $t = $ws.ReceiveAsync((New-Object ArraySegment[byte] (, $buf)), [Threading.CancellationToken]::None); $t.Wait(); [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $t.Result.Count)) } while (-not $t.Result.EndOfMessage)
            $m = $sb.ToString() | ConvertFrom-Json
            if ($m.id -eq $script:id) { return $m.result.result.value }
        }
    }
    $end = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $end -and (Eval 'window.__done === true') -ne $true) { Start-Sleep -Seconds 1 }
    $results = Eval 'JSON.stringify(window.__results || [])' | ConvertFrom-Json
    $ws.Dispose()
    if (-not $results) { Write-Output "No results (did the test page load?)"; exit 99 }
    $failed = 0
    foreach ($r in $results) {
        if ($r.pass) { Write-Output ("PASS  {0}  ({1} s)" -f $r.name, $r.secs) }
        else { $failed++; Write-Output ("FAIL  {0}  ({1} s)`n      {2}" -f $r.name, $r.secs, $r.detail) }
    }
    Write-Output ("{0} passed, {1} failed" -f ($results.Count - $failed), $failed)
    exit $failed
} finally {
    Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$root*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
}
