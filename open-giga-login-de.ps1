[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$chromeCommand = Get-Command chrome.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$chromeCandidates = @(
    if ($chromeCommand) { $chromeCommand.Source }
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$profile = Join-Path $PSScriptRoot 'work\giga-de-cdp-profile'
$url = 'https://www.gigab2b.com/index.php?route=account/wishlist'

if (-not $chrome) {
    throw 'Google Chrome was not found. Install Chrome and try again.'
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process -FilePath $chrome -ArgumentList @(
    '--remote-debugging-port=9224',
    "--user-data-dir=$profile",
    '--no-first-run',
    '--no-default-browser-check',
    $url
)

Write-Host 'GIGA Germany Chrome opened. Complete any CAPTCHA in this window.'
Write-Host 'Keep this window open while giga-report.ps1 continues.'
