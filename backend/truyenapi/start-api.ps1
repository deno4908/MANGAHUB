param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PYTHONIOENCODING = 'utf-8'
$PythonPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $PythonPath)) {
    $PythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $PythonPath)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python environment.' }
    & $PythonPath -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies.' }
}
& $PythonPath -m truyenapi serve --port $Port
