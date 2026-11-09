# Starts MediaMint CDP: builds the UI if needed, then serves UI + API on http://localhost:8100
$root = $PSScriptRoot
if (-not (Test-Path "$root\frontend\dist\index.html")) {
    Push-Location "$root\frontend"
    if (-not (Test-Path node_modules)) { npm install }
    npm run build
    Pop-Location
}
Push-Location "$root\backend"
python -m pip install -q -r requirements.txt
Write-Host "MediaMint CDP running at http://localhost:8100" -ForegroundColor Green
python -m uvicorn app.main:app --port 8100
Pop-Location
