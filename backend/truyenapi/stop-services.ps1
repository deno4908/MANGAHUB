$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$RuntimePath = Join-Path $PSScriptRoot '.runtime.json'
if (-not (Test-Path -LiteralPath $RuntimePath)) { Write-Output 'No background API recorded.'; return }
$RuntimeState = Get-Content -Raw -Encoding utf8 -LiteralPath $RuntimePath | ConvertFrom-Json
$ExpectedPythonPaths = @(
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.venv\Scripts\python.exe')),
    [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'venv\Scripts\python.exe'))
)
$TargetProcessId = $RuntimeState.api_pid
if (-not $TargetProcessId) { return }
$TargetProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId"
if (-not $TargetProcess) { Write-Output 'API is already stopped.'; return }
if ($TargetProcess.ExecutablePath -notin $ExpectedPythonPaths -or $TargetProcess.CommandLine -notmatch '-m\s+truyenapi\s+serve\b') {
    throw "PID $TargetProcessId does not match this API. Nothing was stopped."
}
Stop-Process -Id $TargetProcessId
Write-Output "Stopped API PID $TargetProcessId."
