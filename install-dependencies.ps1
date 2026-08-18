[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $nodeCommand -or -not $npmCommand) {
    throw 'Node.js LTS was not found in PATH. Install Node.js, then reopen PowerShell.'
}

$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
Push-Location $PSScriptRoot
try {
    & $npmCommand.Source install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host 'Dependencies installed. You can now run the GIGA report scripts.'
