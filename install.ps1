# Installs or updates browzat (Browser MCP) on Windows. Safe to run again after every change or git pull.
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Dir <folder>] [-Pair] [-NoClaude]
# It copies the files to the install folder, installs the one dependency, builds the extension, registers the
# MCP server in Claude Code, restarts the relay and tells already-loaded extensions to reload themselves.
# Loading the extension into a browser profile for the first time stays a manual step (the script prints it).
param(
  [string]$Dir = (Join-Path $env:USERPROFILE '.mcp-servers\browser-mcp'),
  [switch]$Pair,
  [switch]$NoClaude
)
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "[browser-mcp] $m" }
function Fail($m) { Write-Host "[browser-mcp] ERROR: $m"; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 20 or newer is required (https://nodejs.org). Install it and run this again.' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Fail "Node.js 20 or newer is required; found $(node --version)." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is required (it comes with Node.js).' }

New-Item -ItemType Directory -Force $Dir | Out-Null
$src = (Resolve-Path $PSScriptRoot).Path.TrimEnd('\')
$dst = (Resolve-Path $Dir).Path.TrimEnd('\')

if ($src -ne $dst) {
  foreach ($d in 'server', 'extension', 'test') {
    $target = Join-Path $dst $d
    if (Test-Path $target) { Remove-Item -Recurse -Force $target -Confirm:$false }
    Copy-Item -Recurse -Force (Join-Path $src $d) $target
  }
  foreach ($f in 'package.json', 'package-lock.json', 'README.md') {
    if (Test-Path (Join-Path $src $f)) { Copy-Item -Force (Join-Path $src $f) (Join-Path $dst $f) }
  }
  Say "files copied to $dst"
} else {
  Say "installing in place: $dst"
}

Push-Location $dst
try {
  npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }
  node extension/build.js
  if ($LASTEXITCODE -ne 0) { Fail 'building the extension failed.' }

  if (-not $NoClaude) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
      cmd /c "claude mcp remove browser-mcp -s user >nul 2>&1"
      # The quoted '--' makes PowerShell pass it through unchanged.
      claude mcp add --scope user browser-mcp '--' node (Join-Path $dst 'server\mcp.js')
      if ($LASTEXITCODE -ne 0) { Fail 'registering the MCP server in Claude Code failed.' }
      Say 'registered in Claude Code as "browser-mcp" (restart Claude Code to see the tools)'
    } else {
      Say 'Claude Code CLI not found; register it in your MCP client yourself:'
      Say "  command: node   args: $(Join-Path $dst 'server\mcp.js')"
    }
  }

  # Restart the relay on the new code, then let already-loaded extensions pick up the new build.
  cmd /c "node server\cli.js stop >nul 2>&1"
  node server/cli.js start
  if ($LASTEXITCODE -ne 0) { Fail 'the relay did not start.' }
  Start-Sleep -Seconds 8
  node server/cli.js reload all
  Start-Sleep -Seconds 5
  node server/cli.js status
} finally {
  Pop-Location
}

Write-Host ''
Say 'Done. For each browser profile that does not have the extension yet:'
Say "  Chrome / Edge: chrome://extensions or edge://extensions -> Developer mode on -> Load unpacked -> $(Join-Path $dst 'dist\chromium')"
Say "  Firefox:       about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $(Join-Path $dst 'dist\firefox\manifest.json')"
Say "Then pair them:  node `"$(Join-Path $dst 'server\cli.js')`" pair --open firefox,edge,chrome"

if ($Pair) {
  node (Join-Path $dst 'server\cli.js') pair --open firefox,edge,chrome
}
