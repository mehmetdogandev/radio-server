param(
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [int]$GroupId = 1,
  [string]$Email = 'yanci@me.com',
  [string]$Name = 'yanci',
  [string[]]$ListenerArgs = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
  throw 'sqlite3 not found in PATH.'
}

$dbPath = Join-Path $repoRoot 'server\data\radio.db'
if (-not (Test-Path $dbPath)) {
  throw "Database not found: $dbPath"
}

$escapedEmail = $Email.Replace("'", "''")
$hash = (& sqlite3 $dbPath "SELECT password_hash FROM user WHERE email='$escapedEmail' LIMIT 1;").Trim()
if (-not $hash) {
  throw "No password_hash found for user: $Email"
}

$role = (& sqlite3 $dbPath "SELECT role FROM user WHERE email='$escapedEmail' LIMIT 1;").Trim()
if (-not $role) {
  $role = 'user'
}

$syncBody = @{
  name = $Name
  email = $Email
  passwordHash = $hash
  role = $role
} | ConvertTo-Json -Compress

$token = (
  Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/api/users/sync" `
    -ContentType 'application/json' `
    -Body $syncBody
).token

if (-not $token) {
  throw 'Failed to fetch auth token from /api/users/sync'
}

& npm run voice:listen -- --base-url $BaseUrl --group-id $GroupId --token $token @ListenerArgs

