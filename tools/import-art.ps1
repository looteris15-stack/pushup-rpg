# Turns big monster pictures into phone-sized files for the game.
# Usage: .\import-art.ps1 -Src <folder with pictures> -Ids cave-rat,field-mouse
# Reads <id>.png or <id>.png.png from Src, writes app\img\monsters\<id>.jpg (512 px) and <id>-s.jpg (160 px).
param(
    [Parameter(Mandatory)] [string]$Src,
    [Parameter(Mandatory)] [string[]]$Ids,
    [string]$Dst = ''
)
if (-not $Dst) { $Dst = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\app\img\monsters' }
# "-File" passes "a,b,c" as one string
$Ids = @($Ids | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Dst | Out-Null
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]84)

function Save-Square($img, [int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $bmp.Save($path, $jpeg, $params)
    $g.Dispose(); $bmp.Dispose()
}

foreach ($id in $Ids) {
    $file = @("$id.png.png", "$id.png", "$id.jpg") | ForEach-Object { Join-Path $Src $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $file) { Write-Warning "No picture found for $id"; continue }
    $img = [System.Drawing.Image]::FromFile($file)
    Save-Square $img 512 (Join-Path $Dst "$id.jpg")
    Save-Square $img 160 (Join-Path $Dst "$id-s.jpg")
    $img.Dispose()
    $big = (Get-Item (Join-Path $Dst "$id.jpg")).Length
    $small = (Get-Item (Join-Path $Dst "$id-s.jpg")).Length
    "{0,-14} 512px {1,6} KB   160px {2,5} KB" -f $id, [math]::Round($big / 1KB), [math]::Round($small / 1KB)
}
