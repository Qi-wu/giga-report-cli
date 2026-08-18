[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ScriptArgs
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) {
    throw 'Node.js was not found in PATH. Install Node.js LTS, then reopen PowerShell.'
}
$node = $nodeCommand.Source
$nodeModules = Join-Path $PSScriptRoot 'node_modules'
$playwrightPackage = Join-Path $nodeModules 'playwright\package.json'
$script = Join-Path $PSScriptRoot 'giga-us-basic-report.mjs'
$loginScript = Join-Path $PSScriptRoot 'giga-login.mjs'
$openLoginScript = Join-Path $PSScriptRoot 'open-giga-login.ps1'
$cdpUrl = 'http://127.0.0.1:9223'

if (-not (Test-Path -LiteralPath $playwrightPackage)) {
    throw 'Dependencies are not installed. Run .\install-dependencies.ps1 first.'
}
if (-not (Test-Path -LiteralPath $script)) {
    throw "Report script not found: $script"
}
if (-not (Test-Path -LiteralPath $loginScript)) {
    throw "Login script not found: $loginScript"
}

try {
    Invoke-RestMethod "$cdpUrl/json/version" -TimeoutSec 3 | Out-Null
} catch {
    & $openLoginScript
    $connected = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            Invoke-RestMethod "$cdpUrl/json/version" -TimeoutSec 2 | Out-Null
            $connected = $true
            break
        } catch {}
    }
    if (-not $connected) {
        throw 'GIGA Chrome debugging port did not start.'
    }
}

$env:NODE_PATH = $nodeModules
& $node $loginScript $cdpUrl
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
& $node $script --cdp-url $cdpUrl @ScriptArgs
exit $LASTEXITCODE
