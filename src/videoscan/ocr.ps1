# Text recognizer for the video importer (src/videoscan), Windows side.
#
# The Windows counterpart of scan.swift's Vision pass, run as a persistent
# child by src/videoscan/probe-win.js. It is deliberately DUMB: it knows
# nothing about Pokemon or frames. It reads one image per stdin line, runs
# the OS's built-in Windows.Media.Ocr engine on it, and prints one JSON line
# of text boxes back -- which is why this feature needs no OCR install.
#
# Protocol (one round-trip per frame, strictly in order):
#   stdin:   <width> <height> <base64 of Gray8 pixels>
#   stdout:  {"lines":[{"s":"CP 1498","x":12.0,"y":34.0,"w":56.0,"h":7.0}]}
#            coordinates in pixels of the given image, top-left origin
#            (probe-win.js normalizes them); a per-frame failure is
#            {"error":"..."} on stdout so the stream stays in lockstep.
#
# On startup it prints {"ready":true} once the OCR engine exists, or exits
# nonzero with the reason on stderr. Runs under Windows PowerShell 5.1
# (always present on Windows 10/11); WinRT projection is not available in
# PowerShell 7 without extra packages, so probe-win.js launches powershell.exe
# specifically.

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
} catch {
  [Console]::Error.WriteLine("could not load WinRT OCR types: $($_.Exception.Message)")
  exit 3
}

# WinRT IAsyncOperation -> .NET Task, the standard PowerShell 5.1 bridge.
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1

function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $null = $task.Wait(30000)
  $task.Result
}

# The screen text is English ("CP", "was caught on..."); fall back to
# whatever OCR language the profile has rather than refuse outright.
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) {
  [Console]::Error.WriteLine('no OCR language available -- install the English (United States) language pack (Settings > Time & Language > Language)')
  exit 4
}

# A UTF-8 writer over raw stdout: [Console]::Out would use the OEM code page
# when redirected and garble any non-ASCII glyph OCR happens to read.
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding $false))
$stdout.AutoFlush = $true
$stdout.WriteLine('{"ready":true}')

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    $parts = $line.Split(' ', 3)
    $w = [int]$parts[0]
    $h = [int]$parts[1]
    $bytes = [Convert]::FromBase64String($parts[2])
    $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer(
      $buffer, [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8, $w, $h)
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    # One box per OCR line, as the union of its word rects (OcrLine itself
    # carries no rect). Matches Vision's line-level granularity.
    $lines = @()
    foreach ($l in $result.Lines) {
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue
      $x1 = [double]::MinValue; $y1 = [double]::MinValue
      foreach ($word in $l.Words) {
        $r = $word.BoundingRect
        if ($r.X -lt $x0) { $x0 = $r.X }
        if ($r.Y -lt $y0) { $y0 = $r.Y }
        if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }
        if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height }
      }
      if ($x1 -le $x0) { continue }
      $lines += @{
        s = $l.Text
        x = [math]::Round($x0, 2); y = [math]::Round($y0, 2)
        w = [math]::Round($x1 - $x0, 2); h = [math]::Round($y1 - $y0, 2)
      }
    }
    $bitmap.Dispose()
    $stdout.WriteLine((ConvertTo-Json -Compress -Depth 4 @{ lines = $lines }))
  } catch {
    $stdout.WriteLine((ConvertTo-Json -Compress @{ error = "$($_.Exception.Message)" }))
  }
}
