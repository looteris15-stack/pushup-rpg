# Runs the automated game tests (_tests\tests.js) in a hidden Microsoft Edge and prints the results.
# Usage: powershell -File _tests\run.ps1        Exit code = number of failed tests.
# It copies the game to a temporary folder and serves it on its own port, so your real save
# (save\save.json and the phone) is never touched. Outside sites (body tracking, fonts) are
# blocked inside the test browser, so tests don't depend on the internet.
#        -CpuThrottle 4 slows the test page's CPU down 4x (like a cheap phone), for timing checks.
#        -Only "Item 2" runs only the tests whose name contains that text.
param([int]$Port = 8002, [int]$DevPort = 9334, [int]$TimeoutSec = 300, [int]$CpuThrottle = 1, [string]$Only = "")
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = Join-Path $env:TEMP ("pushup-rpg-tests\run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force "$root\app", "$root\_tests" | Out-Null
Get-ChildItem "$repo\app" -File | Copy-Item -Destination "$root\app"
Copy-Item "$repo\_tests\*" "$root\_tests" -Recurse   # test page, tests and recorded-fight fixtures

$server = Start-Job -ScriptBlock { param($s, $r, $p) & $s -Port $p -Root $r } -ArgumentList "$repo\serve.ps1", $root, $Port
$edge = $null
try {
    for ($i = 0; $i -lt 40; $i++) { try { Invoke-WebRequest "http://127.0.0.1:$Port/_tests/" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }
    $block = "MAP cdn.jsdelivr.net 127.0.0.1, MAP storage.googleapis.com 127.0.0.1, MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1"
    $edge = Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -PassThru -ArgumentList `
        "--headless=new", "--remote-debugging-port=$DevPort", "--user-data-dir=`"$root\edge`"", "--no-first-run", `
        "--deny-permission-prompts", "--autoplay-policy=no-user-gesture-required", `
        "--host-resolver-rules=`"$block`"", "http://localhost:$Port/_tests/$(if ($Only) { '?only=' + [Uri]::EscapeDataString($Only) })"
    $target = $null
    for ($i = 0; $i -lt 40 -and -not $target; $i++) {
        try { $target = (Invoke-RestMethod "http://127.0.0.1:$DevPort/json" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' -and $_.url -like '*_tests*' } | Select-Object -First 1 } catch {}
        if (-not $target) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $target) { throw "test page did not open in Edge" }

    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
    $script:id = 0
    function Send($method, $params) {
        $script:id++
        $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 8))
        $ws.SendAsync((New-Object ArraySegment[byte] (, $bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
        return $script:id
    }

    # ---- font requests (fonts.googleapis.com / fonts.gstatic.com), so tests can make the font slow or fail.
    # The test page sets the mode with a request to /__fonts/set?mode=..&ms=..&then=..&clear=1 and reads
    # /__fonts/status. Modes: block (fail at once, like before: the default), fail (as if offline),
    # hold (wait ms, then "ok" = a stand-in Oxanium stylesheet, or "fail"). Browser errors, console
    # errors/warnings and page exceptions are collected too, for the status.
    $script:font = @{ mode = 'block'; ms = 0; then = 'fail' }
    $script:held = New-Object System.Collections.ArrayList
    $script:seen = New-Object System.Collections.ArrayList
    $script:log = New-Object System.Collections.ArrayList
    $standIn = "@font-face{font-family:'Oxanium';font-style:normal;font-weight:100 900;font-display:swap;src:local('Segoe UI');}"
    function Fulfill($rid, $type, $body) {
        [void](Send 'Fetch.fulfillRequest' @{ requestId = $rid; responseCode = 200
            responseHeaders = @(@{ name = 'Content-Type'; value = $type }, @{ name = 'Access-Control-Allow-Origin'; value = '*' })
            body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body)) })
    }
    function FailReq($rid, $why) { [void](Send 'Fetch.failRequest' @{ requestId = $rid; errorReason = $why }) }
    function AddLog($line) { if ($script:log.Count -lt 300) { [void]$script:log.Add($line) } }
    # ---- the body-tracking library link: blocked like the rest of the internet, unless a test asks for
    # the stand-in (/__lib/set?mode=fake answers it with fixtures\fake-vision.mjs; mode=block switches back)
    $script:libMode = 'block'
    $fakeLib = Get-Content -Raw "$root\_tests\fixtures\fake-vision.mjs"
    function OnPaused($p) {
        $u = $p.request.url
        if ($u -like '*/__lib/*') {
            if ($u -like '*mode=fake*') { $script:libMode = 'fake' } elseif ($u -like '*mode=block*') { $script:libMode = 'block' }
            Fulfill $p.requestId 'application/json' (@{ mode = $script:libMode } | ConvertTo-Json -Compress)
            return
        }
        if ($u -like '*://cdn.jsdelivr.net/*') {
            if ($script:libMode -eq 'fake' -and $u -like '*/vision_bundle.mjs') { Fulfill $p.requestId 'text/javascript' $fakeLib } else { FailReq $p.requestId 'ConnectionRefused' }
            return
        }
        if ($u -like '*/__fonts/*') {
            if ($u -like '*/__fonts/set*') {
                $q = @{}
                foreach ($kv in ([Uri]$u).Query.TrimStart('?').Split('&')) { $k, $v = $kv.Split('=', 2); if ($k) { $q[$k] = [Uri]::UnescapeDataString("$v") } }
                $script:font = @{ mode = "$($q.mode)"; ms = [int]("0" + $q.ms); then = "$($q.then)" }
                if ($q.clear -eq '1') { $script:seen.Clear(); $script:log.Clear() }
            }
            $status = @{ mode = $script:font.mode; seen = @($script:seen); held = $script:held.Count; log = @($script:log) }
            Fulfill $p.requestId 'application/json' ($status | ConvertTo-Json -Compress -Depth 4)
            return
        }
        [void]$script:seen.Add($u)
        switch ($script:font.mode) {
            'hold' { [void]$script:held.Add(@{ rid = $p.requestId; url = $u; at = (Get-Date).AddMilliseconds($script:font.ms); then = $script:font.then }) }
            'fail' { FailReq $p.requestId 'InternetDisconnected' }
            default { FailReq $p.requestId 'ConnectionRefused' }
        }
    }
    function ReleaseDue {
        if ($script:held.Count -eq 0) { return }
        $now = Get-Date
        foreach ($h in @($script:held | Where-Object { $_.at -le $now })) {
            $script:held.Remove($h)
            if ($h.then -eq 'ok' -and $h.url -like '*fonts.googleapis.com*') { Fulfill $h.rid 'text/css' $standIn }
            else { FailReq $h.rid 'Failed' }
        }
    }
    function Handle($m) {
        if ($null -ne $m.id) { if ($m.id -eq $script:waitFor) { $script:reply = $m }; return }
        switch ($m.method) {
            'Fetch.requestPaused' { OnPaused $m.params }
            'Runtime.exceptionThrown' { $d = $m.params.exceptionDetails; AddLog ("exception: " + $(if ($d.exception.description) { $d.exception.description } else { $d.text })) }
            'Runtime.consoleAPICalled' { if ($m.params.type -in 'error', 'warning', 'assert') { AddLog ("console.$($m.params.type): " + (($m.params.args | ForEach-Object { if ($null -ne $_.value) { $_.value } else { $_.description } }) -join ' ')) } }
            'Log.entryAdded' { $e = $m.params.entry; if ($e.level -in 'error', 'warning') { AddLog ("$($e.source) $($e.level): $($e.text) $($e.url)") } }
        }
    }
    # reads messages for about $ms, handling events (and releasing held font requests) as they come
    $script:rx = $null; $script:rxBuf = New-Object byte[] 1048576; $script:rxMem = New-Object IO.MemoryStream
    function Pump([int]$ms) {
        $until = (Get-Date).AddMilliseconds($ms)
        do {
            if (-not $script:rx) { $script:rx = $ws.ReceiveAsync((New-Object ArraySegment[byte] (, $script:rxBuf)), [Threading.CancellationToken]::None) }
            if ($script:rx.Wait(20)) {
                $r = $script:rx.Result; $script:rx = $null
                $script:rxMem.Write($script:rxBuf, 0, $r.Count)
                if ($r.EndOfMessage) {
                    $txt = [Text.Encoding]::UTF8.GetString($script:rxMem.ToArray()); $script:rxMem.SetLength(0)
                    Handle ($txt | ConvertFrom-Json)
                }
            }
            ReleaseDue
        } while ((Get-Date) -lt $until -and -not ($script:waitFor -and $script:reply))
    }
    function Call($method, $params) {
        $script:reply = $null; $script:waitFor = Send $method $params
        while (-not $script:reply) { Pump 1000 }
        $script:waitFor = $null
        return $script:reply
    }
    function Eval($code) { return (Call 'Runtime.evaluate' @{ expression = $code; returnByValue = $true }).result.result.value }
    $script:waitFor = $null
    [void](Call 'Fetch.enable' @{ patterns = @(@{ urlPattern = '*://fonts.googleapis.com/*' }, @{ urlPattern = '*://fonts.gstatic.com/*' }, @{ urlPattern = '*/__fonts/*' },
        @{ urlPattern = '*://cdn.jsdelivr.net/*' }, @{ urlPattern = '*/__lib/*' }) })
    [void](Call 'Runtime.enable' @{})
    [void](Call 'Log.enable' @{})
    if ($CpuThrottle -gt 1) { [void](Call 'Emulation.setCPUThrottlingRate' @{ rate = $CpuThrottle }); Write-Output "CPU slowed down ${CpuThrottle}x" }

    $end = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $end -and (Eval 'window.__done === true') -ne $true) { Pump 1000 }
    $results = Eval 'JSON.stringify(window.__results || [])' | ConvertFrom-Json
    $ws.Dispose()
    if (-not $results) { Write-Output "No results (did the test page load?)"; exit 99 }
    $failed = 0
    foreach ($r in $results) {
        if ($r.pass) { Write-Output ("PASS  {0}  ({1} s)" -f $r.name, $r.secs); if ($r.note) { Write-Output ("      {0}" -f $r.note) } }
        else { $failed++; Write-Output ("FAIL  {0}  ({1} s)`n      {2}" -f $r.name, $r.secs, $r.detail) }
    }
    Write-Output ("{0} passed, {1} failed" -f ($results.Count - $failed), $failed)
    exit $failed
} finally {
    Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$root*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
}
