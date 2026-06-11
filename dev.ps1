# dev.ps1 — Start all tradebot services (DB, runner, API, dashboard)
# Usage: .\dev.ps1
#   Ctrl+C to stop all services

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host ""
Write-Host "  tradebot dev" -ForegroundColor Cyan
Write-Host "  ────────────────────────────────" -ForegroundColor DarkGray

# ── Pre-flight ─────────────────────────────────────────────────────────────────

if (-not (Test-Path "$root\.env")) {
    Write-Host ""
    Write-Host "  ERROR: .env not found." -ForegroundColor Red
    Write-Host "  Copy .env.example and fill in ALCHEMY_API_KEY, DATABASE_URL, etc." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Check Docker is accessible
Write-Host ""
Write-Host "  [1/3] Checking Docker..." -ForegroundColor Yellow
$dockerCheck = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: Docker is not running." -ForegroundColor Red
    Write-Host "  Start Docker Desktop, then re-run .\dev.ps1" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
Write-Host "        Docker OK" -ForegroundColor Green

# ── Start Postgres ─────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  [2/3] Starting Postgres..." -ForegroundColor Yellow
Set-Location $root
docker compose up -d db
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: docker compose up failed." -ForegroundColor Red
    exit 1
}

# Wait until pg_isready
$attempts = 0
$ready = $false
while ($attempts -lt 20 -and -not $ready) {
    Start-Sleep -Seconds 1
    $attempts++
    docker compose exec db pg_isready -U tradebot -q 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true }
}

if (-not $ready) {
    Write-Host ""
    Write-Host "  ERROR: Postgres did not become ready after 20s." -ForegroundColor Red
    exit 1
}
Write-Host "        Postgres ready (port 5433)" -ForegroundColor Green

# ── Migrate ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  [3/3] Running migrations..." -ForegroundColor Yellow
pnpm db:migrate
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: Migration failed." -ForegroundColor Red
    exit 1
}
Write-Host "        Migrations OK" -ForegroundColor Green

# ── Start services ─────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  Dashboard  http://localhost:3000" -ForegroundColor Cyan
Write-Host "  API        http://localhost:3001" -ForegroundColor Cyan
Write-Host "  ────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Starting runner + API + dashboard via turbo..." -ForegroundColor Yellow
Write-Host "  Press Ctrl+C to stop all services." -ForegroundColor DarkGray
Write-Host ""

pnpm dev
