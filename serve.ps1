# Small web server for the pushup RPG, only reachable from this PC (127.0.0.1).
# It also keeps the game save in save\save.json, so progress survives a new phone link.
# No admin rights and no firewall changes needed.
param(
    [int]$Port = 8000,
    [string]$Root = $PSScriptRoot
)

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$saveFile = Join-Path $Root 'save\save.json'
$types = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json'
    '.webmanifest' = 'application/manifest+json'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.webp' = 'image/webp'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

function Send($stream, [string]$status, [string]$type, [byte[]]$body, [string]$extraHeaders = '', [bool]$headOnly = $false) {
    $header = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`n$extraHeaders" + "Connection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $headOnly) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}
function Text([string]$s) { [Text.Encoding]::UTF8.GetBytes($s) }

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Serving $Root at http://localhost:$Port/"

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        # browsers open spare connections that never send anything; don't let them block the server
        $client.ReceiveTimeout = 2000
        try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream)
            $requestLine = $reader.ReadLine()
            $method = ''
            $path = '/'
            if ($requestLine -match '^(GET|HEAD|POST) (\S+)') {
                $method = $Matches[1]
                $path = [Uri]::UnescapeDataString(($Matches[2] -split '\?')[0])
            }
            $length = 0
            while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') {
                if ($line -match '^Content-Length:\s*(\d+)') { $length = [int]$Matches[1] }
            }
            $head = $method -eq 'HEAD'

            if ($path -eq '/api/save') {
                if ($method -eq 'POST') {
                    if ($length -le 0 -or $length -gt 500000) {
                        Send $stream '413 Payload Too Large' 'text/plain' (Text 'Save too big')
                    } else {
                        # the game sends plain ASCII JSON, so characters = bytes
                        $buf = New-Object char[] $length
                        $read = 0
                        while ($read -lt $length) {
                            $n = $reader.Read($buf, $read, $length - $read)
                            if ($n -le 0) { break }
                            $read += $n
                        }
                        $json = [string]::new($buf, 0, $read)
                        if ($json.TrimStart().StartsWith('{')) {
                            [IO.Directory]::CreateDirectory((Split-Path $saveFile)) | Out-Null
                            [IO.File]::WriteAllText($saveFile, $json, [Text.UTF8Encoding]::new($false))
                            Send $stream '200 OK' 'application/json' (Text '{"ok":true}')
                        } else {
                            Send $stream '400 Bad Request' 'text/plain' (Text 'Not a save')
                        }
                    }
                } elseif (Test-Path -LiteralPath $saveFile) {
                    Send $stream '200 OK' 'application/json' ([IO.File]::ReadAllBytes($saveFile)) '' $head
                } else {
                    Send $stream '404 Not Found' 'application/json' (Text '{"error":"no save yet"}') '' $head
                }
            } elseif ($path -eq '/') {
                Send $stream '302 Found' 'text/plain' (Text 'Go to /app/') "Location: /app/`r`n" $head
            } else {
                $file = [IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('/')))
                if ((Test-Path -LiteralPath $file -PathType Container) -and -not $path.EndsWith('/')) {
                    Send $stream '302 Found' 'text/plain' (Text 'Moved') "Location: $path/`r`n" $head
                } else {
                    if ($path.EndsWith('/')) { $file = Join-Path $file 'index.html' }
                    $type = $types[[IO.Path]::GetExtension($file).ToLower()]
                    $blocked = $file.StartsWith((Join-Path $Root 'save'))
                    if ($file.StartsWith($Root) -and -not $blocked -and $type -and (Test-Path -LiteralPath $file -PathType Leaf)) {
                        Send $stream '200 OK' $type ([IO.File]::ReadAllBytes($file)) '' $head
                    } else {
                        Send $stream '404 Not Found' 'text/plain' (Text 'Not found') '' $head
                    }
                }
            }
            Write-Host "$method $path"
        } catch {
            # timed-out or dropped connection, ignore
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
