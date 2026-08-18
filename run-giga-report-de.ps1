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
$openLoginScript = Join-Path $PSScriptRoot 'open-giga-login-de.ps1'
$cdpUrl = 'http://127.0.0.1:9224'
$baseDirName = -join @(
    [char]0x0044, [char]0x0075, [char]0x0078, [char]0x0028,
    [char]0x5FB7, [char]0x56FD, [char]0x0029,
    [char]0x5728, [char]0x552E, [char]0x5E93, [char]0x5B58,
    [char]0x62A5, [char]0x8868, [char]0x4E0B, [char]0x8F7D
)
$baseDir = Join-Path 'E:\' $baseDirName
$timeZone = 'Europe/Berlin'

if (-not (Test-Path -LiteralPath $playwrightPackage)) {
    throw 'Dependencies are not installed. Run .\install-dependencies.ps1 first.'
}

$username = [Environment]::GetEnvironmentVariable('giga_usernamede', 'User')
$password = [Environment]::GetEnvironmentVariable('giga_pwdde', 'User')
if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($password)) {
    throw 'Missing User environment variables giga_usernamede or giga_pwdde.'
}

$env:giga_username = $username
$env:giga_pwd = $password
$env:NODE_PATH = $nodeModules

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
        throw 'GIGA Germany Chrome debugging port did not start.'
    }
}

& $node $loginScript $cdpUrl
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
& $node $script --cdp-url $cdpUrl --base-dir $baseDir --time-zone $timeZone @ScriptArgs
exit $LASTEXITCODE
