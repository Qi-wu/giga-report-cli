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
$notifyScript = Join-Path $PSScriptRoot 'giga-feishu.mjs'
$openLoginScript = Join-Path $PSScriptRoot 'open-giga-login-de.ps1'
$cdpUrl = 'http://127.0.0.1:9224'
$configPath = Join-Path $PSScriptRoot 'giga-report.json'

if (-not (Test-Path -LiteralPath $playwrightPackage)) {
    throw 'Dependencies are not installed. Run .\install-dependencies.ps1 first.'
}
$config = $null
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Configuration file not found: $configPath"
}
try {
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "Configuration file is not valid JSON: $configPath"
}
if (-not $config -or [string]::IsNullOrWhiteSpace([string]$config.username)) {
    throw "Configuration item 'username' must be a non-empty string."
}
if (-not $config.PSObject.Properties['password'] -or [string]::IsNullOrEmpty([string]$config.password)) {
    throw "Configuration item 'password' must be a non-empty string."
}
if (-not $config.feishu -or
    [string]::IsNullOrWhiteSpace([string]$config.feishu.appId) -or
    [string]::IsNullOrWhiteSpace([string]$config.feishu.appSecret) -or
    [string]::IsNullOrWhiteSpace([string]$config.feishu.openId)) {
    throw "Configuration item 'feishu' must contain appId, appSecret, and openId."
}

$env:NODE_PATH = $nodeModules
$runSucceeded = $false
$failureMessage = $null
try {
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

    & $node $loginScript --config-path $configPath $cdpUrl
    if ($LASTEXITCODE -ne 0) {
        throw "GIGA login failed with exit code $LASTEXITCODE."
    }
    & $node $script --config-path $configPath --cdp-url $cdpUrl @ScriptArgs
    if ($LASTEXITCODE -ne 0) {
        throw "GIGA report failed with exit code $LASTEXITCODE."
    }
    $runSucceeded = $true
} catch {
    $failureMessage = $_.Exception.Message
} finally {
    $status = if ($runSucceeded) { 'success' } else { 'failure' }
    if ($runSucceeded) {
        & $node $notifyScript --config-path $configPath --status $status
    } else {
        & $node $notifyScript --config-path $configPath --status $status --error $failureMessage
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "飞书通知发送失败，原始报表任务结果: $status"
    }
}
if (-not $runSucceeded) {
    throw $failureMessage
}
exit 0
