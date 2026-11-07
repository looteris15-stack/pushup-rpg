# Measures fight startup with the REAL body tracking (library, WASM and model from the internet) in a
# hidden Microsoft Edge with a fake camera (Edge's built-in test picture: no person in it).
# Usage: powershell -File _tests\bench.ps1 [-Runs 3] [-CpuThrottle 4] [-DownKbps 9000 -LatencyMs 60] [-Model full]
# Each run uses a fresh browser profile and measures three Fight taps:
#   cold   = first Fight after opening (nothing downloaded yet)
#   warm   = Fight again on the same page (the ready model is reused)
#   cached = the page opened again, then Fight (files come from the browser cache)
# -Mode loop [-Fps 60]: after one start, measures the tracking loop instead: detector calls, camera frames
#   and loop run times during 15 s of a fight, then during a whole 90 s mine-room break and just after it.
#   -Fps sets the fake camera's frame rate (Edge's default is 30).
# The game's offline helper (service worker) is switched off for the bench: its own downloads would not be
# slowed down by the network setting. Like run.ps1 it copies the game to a temporary folder (save untouched).
param([int]$Runs = 3, [int]$CpuThrottle = 1, [int]$DownKbps = 0, [int]$LatencyMs = 0, [string]$Model = "full",
      [string]$Mode = "startup", [int]$Fps = 0,
      [int]$Port = 8004, [int]$DevPort = 9336, [int]$TimeoutSec = 400)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = Join-Path $env:TEMP ("pushup-rpg-tests\bench-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force "$root\app", "$root\_tests" | Out-Null
Get-ChildItem "$repo\app" -File | Copy-Item -Destination "$root\app"
Copy-Item "$repo\_tests\*" "$root\_tests" -Recurse
$server = Start-Job -ScriptBlock { param($s, $r, $p) & $s -Port $p -Root $r } -ArgumentList "$repo\serve.ps1", $root, $Port
$noSw = "if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('bench: offline helper off'));"
Write-Output ("bench: model {0}, CPU {1}x, network {2}, {3} run(s)" -f $Model, $CpuThrottle,
    $(if ($DownKbps) { "$DownKbps kbit/s down, $LatencyMs ms latency" } else { "not slowed" }), $Runs)
try {
    for ($i = 0; $i -lt 40; $i++) { try { Invoke-WebRequest "http://127.0.0.1:$Port/_tests/bench.html" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }
    for ($run = 1; $run -le $Runs; $run++) {
        $prof = "$root\edge-$run"
        $edge = Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -PassThru -ArgumentList `
            "--headless=new", "--remote-debugging-port=$DevPort", "--user-data-dir=`"$prof`"", "--no-first-run", `
            "--use-fake-device-for-media-stream$(if ($Fps -gt 0) { "=fps=$Fps" })", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", `
            "--host-resolver-rules=`"MAP fonts.googleapis.com 127.0.0.1, MAP fonts.gstatic.com 127.0.0.1`"", `
            "http://localhost:$Port/_tests/bench.html?model=$Model&mode=$Mode"
        $target = $null
        for ($i = 0; $i -lt 40 -and -not $target; $i++) {
            try { $target = (Invoke-RestMethod "http://127.0.0.1:$DevPort/json" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' -and $_.url -like '*bench*' } | Select-Object -First 1 } catch {}
            if (-not $target) { Start-Sleep -Milliseconds 250 }
        }
        if (-not $target) { throw "bench page did not open in Edge" }
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
        $script:id = 0
        $buf = New-Object byte[] 1048576
        function Call($method, $params) {
            $script:id++
            $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 8))
            $ws.SendAsync((New-Object ArraySegment[byte] (, $bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
            $mem = New-Object IO.MemoryStream
            while ($true) {
                $r = $ws.ReceiveAsync((New-Object ArraySegment[byte] (, $buf)), [Threading.CancellationToken]::None).Result
                $mem.Write($buf, 0, $r.Count)
                if ($r.EndOfMessage) {
                    $m = [Text.Encoding]::UTF8.GetString($mem.ToArray()) | ConvertFrom-Json; $mem.SetLength(0)
                    if ($m.id -eq $script:id) { return $m }
                }
            }
        }
        function Eval($code) { return (Call 'Runtime.evaluate' @{ expression = $code; returnByValue = $true }).result.result.value }
        [void](Call 'Page.addScriptToEvaluateOnNewDocument' @{ source = $noSw })
        if ($DownKbps -gt 0) {
            [void](Call 'Network.enable' @{})
            [void](Call 'Network.emulateNetworkConditions' @{ offline = $false; latency = $LatencyMs
                downloadThroughput = [int]($DownKbps * 1000 / 8); uploadThroughput = [int]($DownKbps * 1000 / 8 / 4) })
        }
        if ($CpuThrottle -gt 1) { [void](Call 'Emulation.setCPUThrottlingRate' @{ rate = $CpuThrottle }) }
        for ($i = 0; $i -lt 80 -and (Eval 'document.readyState === "complete" && location.href.includes("bench")') -ne $true; $i++) { Start-Sleep -Milliseconds 250 }
        [void](Eval 'window.__go = true')
        $end = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $end -and (Eval 'window.__benchDone === true') -ne $true) { Start-Sleep -Milliseconds 500 }
        $json = Eval ('JSON.stringify(window.__bench || { error: "no result (timed out) at: " + window.__stage, ' +
            'screen: (() => { try { const d = window.__g.d; return (d.querySelector("#banner").textContent + " | " + d.querySelector("#debug").textContent + " | " + (d.querySelector("#modal").hidden ? "" : d.querySelector("#modal").textContent)).replace(/\s+/g, " ").slice(0, 300); } catch (e) { return String(e); } })(), ' +
            'seen: (() => { try { const i = window.__g.ins; return { cam: i.cam.length, attach: i.attach.length, infer: i.infer.length, patchError: i.patchError || "", res: window.__g.w.performance.getEntriesByType("resource").filter(e => !e.name.includes("localhost")).map(e => e.name.split("/").pop() + " " + Math.round(e.responseEnd)) }; } catch (e) { return String(e); } })() })')
        Write-Output "run ${run}: $json"
        $ws.Dispose()
        Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$prof*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 800
    }
} finally {
    Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$root*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
}
