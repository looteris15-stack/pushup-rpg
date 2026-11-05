# Makes the home-screen app icons from one monster picture.
# Usage: .\make-icons.ps1 -Src "<path to picture>.png"
# Writes app\icons\icon-192.png, icon-512.png (zoomed in a bit so the monster reads when tiny),
# maskable-512.png (whole picture; Android cuts it into its own shape) and apple-touch-icon.png.
param([Parameter(Mandatory)] [string]$Src)
Add-Type -AssemblyName System.Drawing
$dst = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\app\icons'
New-Item -ItemType Directory -Force $dst | Out-Null
$img = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Src))

function Save-Icon([int]$size, [double]$zoom, [string]$name) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    # zoom > 1 crops the empty dark edge around the monster
    $w = $img.Width / $zoom; $h = $img.Height / $zoom
    $srcRect = New-Object System.Drawing.RectangleF ((($img.Width - $w) / 2), (($img.Height - $h) / 2), $w, $h)
    $g.DrawImage($img, (New-Object System.Drawing.RectangleF 0, 0, $size, $size), $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $path = Join-Path $dst $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    "{0,-22} {1,5} KB" -f $name, [math]::Round((Get-Item $path).Length / 1KB)
}

Save-Icon 192 1.25 'icon-192.png'
Save-Icon 512 1.25 'icon-512.png'
Save-Icon 512 1.0 'maskable-512.png'
Save-Icon 180 1.25 'apple-touch-icon.png'
$img.Dispose()
