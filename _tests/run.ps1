# Runs the automated game tests (_tests\tests.js) in a hidden Microsoft Edge and prints the results.
# Usage: powershell -File _tests\run.ps1        Exit code = number of failed tests.
# It copies the game to a temporary folder and serves it on its own port, so your real save
# (save\save.json and the phone) is never touched. Outside sites (body tracking, fonts) are
# blocked inside the test browser, so tests don't depend on the internet.
#        -CpuThrottle 4 slows the test page's CPU down 4x (like a cheap phone), for timing checks.
#        -Only "Item 2" runs only the tests whose name contains that text.
param([int]$Port = 8002, [int]$DevPort = 9334, [int]$TimeoutSec = 600, [int]$CpuThrottle = 1, [string]$Only = "")
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = Join-Path $env:TEMP ("pushup-rpg-tests\run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force "$root\app", "$root\_tests" | Out-Null
Get-ChildItem "$repo\app" -File | Copy-Item -Destination "$root\app"
Copy-Item "$repo\_tests\*" "$root\_tests" -Recurse   # test page, tests and recorded-fight fixtures
# The offline helper's (service worker's) own copy for its tests: the whole game with its icons in swapp\, so
# the helper can install there (app\ has no icons, so it never installs for the other tests). Release "a" or
# "b": every shell file carries its release mark, and a newer release's sw.js has its shell version raised.
$script:release = ''
function WriteRelease([string]$rel, [bool]$bump = $true) {
    New-Item -ItemType Directory -Force "$root\swapp\icons" | Out-Null
    Get-ChildItem "$repo\app" -File | Copy-Item -Destination "$root\swapp" -Force
    Copy-Item "$repo\app\icons\*" "$root\swapp\icons" -Force
    $utf8 = New-Object Text.UTF8Encoding $false
    $f = "$root\swapp\index.html"
    [IO.File]::WriteAllText($f, ([IO.File]::ReadAllText($f) -replace '<head>', "<head>`n<meta name=`"release`" content=`"$rel`">"), $utf8)
    foreach ($n in 'game.js', 'core.js', 'data.js') { [IO.File]::AppendAllText("$root\swapp\$n", "`n;(globalThis.__release ||= {})[`"$n`"] = `"$rel`";`n", $utf8) }
    [IO.File]::AppendAllText("$root\swapp\style.css", "`n:root { --release: `"$rel`"; }`n", $utf8)
    if ($rel -ne 'a' -and $bump) { # bump=0: the files change but sw.js doesn't (the release rule broken)
        $f = "$root\swapp\sw.js"
        $t = [regex]::Replace([IO.File]::ReadAllText($f), 'const (SHELL_V|V) = (\d+);', { param($m) "const $($m.Groups[1].Value) = $([int]$m.Groups[2].Value + 1);" })
        [IO.File]::WriteAllText($f, $t, $utf8)
    }
    $script:release = $rel
}
WriteRelease 'a'

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
    function Send($method, $params, $sid = $null) {
        $script:id++
        $msg = @{ id = $script:id; method = $method; params = $params }
        if ($sid) { $msg.sessionId = $sid } # a command for an attached target (the offline helper)
        $bytes = [Text.Encoding]::UTF8.GetBytes(($msg | ConvertTo-Json -Compress -Depth 8))
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
    function Fulfill($rid, $type, $body, $sid = $null, [int]$code = 200) {
        [void](Send 'Fetch.fulfillRequest' @{ requestId = $rid; responseCode = $code
            responseHeaders = @(@{ name = 'Content-Type'; value = $type }, @{ name = 'Access-Control-Allow-Origin'; value = '*' })
            body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($body)) } $sid)
    }
    function FailReq($rid, $why, $sid = $null) { [void](Send 'Fetch.failRequest' @{ requestId = $rid; errorReason = $why } $sid) }
    function Query($u) {
        $q = @{}
        foreach ($kv in ([Uri]$u).Query.TrimStart('?').Split('&')) { $k, $v = $kv.Split('=', 2); if ($k) { $q[$k] = [Uri]::UnescapeDataString("$v") } }
        return $q
    }
    # ---- the offline helper's own requests for its test copy (swapp\): run.ps1 attaches to each helper
    # (service worker) and answers them as the test page sets with /__shell/set?mode=..&only=..&release=..&clear=1:
    # mode pass (the server), hold (no answer until the mode changes), 503, or fail (as if offline); only = one
    # file (e.g. core.js) or all; release = a or b (rewrites swapp\; with bump=0 b keeps a's sw.js).
    # /__shell/status lists the files asked for.
    $script:shell = @{ mode = 'pass'; only = '' }
    $script:shellSeen = New-Object System.Collections.ArrayList
    $script:shellHeld = New-Object System.Collections.ArrayList
    function OnShell($p, $sid) {
        $u = $p.request.url
        $file = ([Uri]$u).AbsolutePath -replace '^.*?/swapp/', ''
        if (-not $file) { $file = './' }
        [void]$script:shellSeen.Add($file)
        $hit = $script:shell.mode -ne 'pass' -and (-not $script:shell.only -or $file -eq $script:shell.only)
        if (-not $hit) { [void](Send 'Fetch.continueRequest' @{ requestId = $p.requestId } $sid) }
        elseif ($script:shell.mode -eq 'hold') { [void]$script:shellHeld.Add(@{ rid = $p.requestId; sid = $sid }) }
        elseif ($script:shell.mode -eq '503') { Fulfill $p.requestId 'text/plain' 'Service Unavailable (test)' $sid 503 }
        else { FailReq $p.requestId 'InternetDisconnected' $sid }
    }
    function OnShellControl($p) {
        $u = $p.request.url
        if ($u -like '*/__shell/set*') {
            $q = Query $u
            if ($q.release -and $q.release -ne $script:release) { WriteRelease $q.release ($q.bump -ne '0') }
            if ($q.mode) { $script:shell = @{ mode = "$($q.mode)"; only = "$($q.only)" } }
            if ($q.clear -eq '1') { $script:shellSeen.Clear() }
            if ($script:shell.mode -ne 'hold') {
                foreach ($h in @($script:shellHeld)) { [void](Send 'Fetch.continueRequest' @{ requestId = $h.rid } $h.sid) }
                $script:shellHeld.Clear()
            }
        }
        $status = @{ mode = $script:shell.mode; only = $script:shell.only; release = $script:release; seen = @($script:shellSeen); held = $script:shellHeld.Count }
        Fulfill $p.requestId 'application/json' ($status | ConvertTo-Json -Compress -Depth 4)
    }
    function AddLog($line) { if ($script:log.Count -lt 300) { [void]$script:log.Add($line) } }
    # ---- the body-tracking library link: blocked like the rest of the internet, unless a test asks for
    # the stand-in (/__lib/set?mode=fake answers it with fixtures\fake-vision.mjs; mode=block switches back)
    $script:libMode = 'block'
    $fakeLib = Get-Content -Raw "$root\_tests\fixtures\fake-vision.mjs"
    function OnPaused($p, $sid) {
        $u = $p.request.url
        if ($sid) { OnShell $p $sid; return } # only the helper's swapp\ requests are watched there
        if ($u -like '*/__shell/*') { OnShellControl $p; return }
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
                $q = Query $u
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
            'Fetch.requestPaused' { OnPaused $m.params $m.sessionId }
            # a new target (an offline helper, a worker) waits until it's let go: for a helper, its requests
            # for the test copy are watched first
            'Target.attachedToTarget' {
                $sid = $m.params.sessionId
                if ($m.params.targetInfo.type -eq 'service_worker') { [void](Send 'Fetch.enable' @{ patterns = @(@{ urlPattern = '*/swapp/*' }) } $sid) }
                [void](Send 'Runtime.runIfWaitingForDebugger' @{} $sid)
            }
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
        @{ urlPattern = '*://cdn.jsdelivr.net/*' }, @{ urlPattern = '*/__lib/*' }, @{ urlPattern = '*/__shell/*' }) })
    [void](Call 'Target.setAutoAttach' @{ autoAttach = $true; waitForDebuggerOnStart = $true; flatten = $true })
    [void](Call 'Runtime.enable' @{})
    [void](Call 'Log.enable' @{})
    if ($CpuThrottle -gt 1) { [void](Call 'Emulation.setCPUThrottlingRate' @{ rate = $CpuThrottle }); Write-Output "CPU slowed down ${CpuThrottle}x" }

    $end = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $end -and (Eval 'window.__done === true') -ne $true) { Pump 1000 }
    $done = (Eval 'window.__done === true') -eq $true
    $results = Eval 'JSON.stringify(window.__results || [])' | ConvertFrom-Json
    $ws.Dispose()
    if (-not $results) { Write-Output "No results (did the test page load?)"; exit 99 }
    $failed = 0
    # out of time: the tests that ran are listed, but the run counts as failed (the rest never ran)
    if (-not $done) { $failed++; Write-Output "FAIL  TIMED OUT after $TimeoutSec s: only $(@($results).Count) tests ran (use -TimeoutSec)" }
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
