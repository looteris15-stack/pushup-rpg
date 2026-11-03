# Tiny static file server for the test page, only reachable from this PC (127.0.0.1).
# No admin rights and no firewall changes needed.
param(
    [int]$Port = 8000,
    [string]$Root = $PSScriptRoot
)

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$types = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json'
    '.png'  = 'image/png'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

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
            while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') { }

            $path = '/'
            if ($requestLine -match '^(GET|HEAD) (\S+)') {
                $path = [Uri]::UnescapeDataString(($Matches[2] -split '\?')[0])
            }
            if ($path -eq '/') { $path = '/index.html' }
            $file = [IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('/')))

            if ($file.StartsWith($Root) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
                $status = '200 OK'
                $body = [IO.File]::ReadAllBytes($file)
                $type = $types[[IO.Path]::GetExtension($file).ToLower()]
                if (-not $type) { $type = 'application/octet-stream' }
            } else {
                $status = '404 Not Found'
                $body = [Text.Encoding]::UTF8.GetBytes('Not found')
                $type = 'text/plain'
            }

            $header = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
            $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($requestLine -notmatch '^HEAD') { $stream.Write($body, 0, $body.Length) }
            $stream.Flush()
            Write-Host "$status $path"
        } catch {
            # timed-out or dropped connection, ignore
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
