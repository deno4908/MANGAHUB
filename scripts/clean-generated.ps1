[CmdletBinding(SupportsShouldProcess)]
param([ValidateRange(64, 1024)][int]$ImageCacheTargetMB = 108)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$ProjectPrefix = $ProjectRoot + '\'
$RemovedBytes = 0L
$RemovedFiles = 0

function Get-CheckedPath([string]$RelativePath) {
    $Candidate = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $RelativePath))
    if (-not $Candidate.StartsWith($ProjectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target is outside this project: $Candidate"
    }
    $Ancestor = $Candidate
    while ($Ancestor -and $Ancestor -ne $ProjectRoot) {
        if (Test-Path -LiteralPath $Ancestor) {
            $Entry = Get-Item -LiteralPath $Ancestor -Force
            if ($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to clean a link or junction: $Ancestor"
            }
        }
        $Ancestor = Split-Path -Parent $Ancestor
    }
    return $Candidate
}

function Remove-Generated([string]$RelativePath) {
    $Target = Get-CheckedPath $RelativePath
    if (-not (Test-Path -LiteralPath $Target)) { return }
    $Entry = Get-Item -LiteralPath $Target -Force
    if ($Entry.PSIsContainer) {
        $Children = @(Get-ChildItem -LiteralPath $Target -Force -Recurse)
        if ($Children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
            throw "Refusing to recursively delete a tree containing links: $Target"
        }
        $Files = @($Children | Where-Object { -not $_.PSIsContainer })
    } else { $Files = @($Entry) }
    $Bytes = ($Files | Measure-Object -Property Length -Sum).Sum
    if ($PSCmdlet.ShouldProcess($Target, 'Remove generated or obsolete project files')) {
        Remove-Item -LiteralPath $Target -Recurse -Force
        $script:RemovedBytes += $Bytes
        $script:RemovedFiles += $Files.Count
        Write-Host ('Removed {0} ({1:N2} MiB)' -f $RelativePath, ($Bytes / 1MB))
    }
}

# The embedded API uses backend/venv. Its former standalone environment is a
# duplicate. The old data/ database is explicitly unused by the live API.
$GeneratedPaths = @(
    'backend/truyenapi/.venv',
    'backend/truyenapi/data',
    'backend/truyenapi/.inspection',
    'backend/truyenapi/.logs',
    'backend/truyenapi/.runtime.json',
    'backend/truyenapi/build',
    'backend/truyenapi/truyenapi.egg-info',
    'backend/truyenapi/.pytest_cache',
    'backend/.pytest_cache',
    '.pytest_cache',
    'node_modules/.vite',
    'node_modules/.cache'
)

# Never remove an environment while a Python process is using it.
$DuplicateEnvironment = Get-CheckedPath 'backend/truyenapi/.venv'
$UsingDuplicate = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($DuplicateEnvironment + '\', [StringComparison]::OrdinalIgnoreCase) }
if ($UsingDuplicate) { throw 'Stop the standalone TruyenAPI Python process before cleaning its old environment.' }

foreach ($Relative in $GeneratedPaths) { Remove-Generated $Relative }

foreach ($SourcePath in @('backend/fastapi_app', 'backend/flask_app', 'backend/tests', 'backend/truyenapi/truyenapi', 'backend/truyenapi/tests')) {
    $SourceRoot = Get-CheckedPath $SourcePath
    if (Test-Path -LiteralPath $SourceRoot) {
        $Bytecode = @(Get-ChildItem -LiteralPath $SourceRoot -Directory -Filter '__pycache__' -Recurse -Force)
        foreach ($Directory in $Bytecode) {
            Remove-Generated $Directory.FullName.Substring($ProjectPrefix.Length)
        }
    }
}
Remove-Generated 'backend/__pycache__'

$BuildArtifacts = @(Get-ChildItem -LiteralPath $ProjectRoot -File -Force |
    Where-Object { $_.Name -like '*.tsbuildinfo' -or $_.Name -like 'vite.config.*.timestamp-*.mjs' -or $_.Name -like '*.log' })
foreach ($Artifact in $BuildArtifacts) { Remove-Generated $Artifact.Name }

# Retain recent covers for fast loads, while reclaiming old disk cache entries.
$ImageRoot = Get-CheckedPath 'backend/.image_cache'
if (Test-Path -LiteralPath $ImageRoot) {
    $Images = @(Get-ChildItem -LiteralPath $ImageRoot -File -Recurse -Force | Sort-Object LastAccessTimeUtc)
    $Total = ($Images | Measure-Object -Property Length -Sum).Sum
    foreach ($Image in $Images) {
        if ($Total -le $ImageCacheTargetMB * 1MB) { break }
        Remove-Generated $Image.FullName.Substring($ProjectPrefix.Length)
        $Total -= $Image.Length
    }
}

[pscustomobject]@{ RemovedFiles = $RemovedFiles; ReclaimedBytes = $RemovedBytes; ReclaimedMiB = [Math]::Round($RemovedBytes / 1MB, 2) }
