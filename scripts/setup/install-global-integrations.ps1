param(
  [string]$RepoRoot,
  [string]$GlobalBinRoot,
  [switch]$RepairGlobalIntegration
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepoRoot) {
  [System.IO.Path]::GetFullPath($RepoRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
if (-not $GlobalBinRoot) {
  $GlobalBinRoot = (& npm config get prefix).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $GlobalBinRoot) { throw 'Unable to resolve the user npm bin directory.' }
}
$GlobalBinRoot = [System.IO.Path]::GetFullPath($GlobalBinRoot)
$cmdPath = Join-Path $GlobalBinRoot 'mineru.cmd'
$launcherPath = Join-Path $GlobalBinRoot 'mineru-local.ps1'

function Get-FileState([string]$Path, [string]$Expected, [switch]$RequireUtf8Bom) {
  if (-not (Test-Path -LiteralPath $Path)) { return 'missing' }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'conflict' }
  if ($RequireUtf8Bom) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) { return 'conflict' }
  }
  $actual = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  if ($actual -ceq $Expected) { return 'current' }
  return 'conflict'
}

function Backup-Existing([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
  $backup = "$Path.backup-$stamp"
  $counter = 0
  while (Test-Path -LiteralPath $backup) {
    $counter += 1
    $backup = "$Path.backup-$stamp-$counter"
  }
  Move-Item -LiteralPath $Path -Destination $backup
  return $backup
}

$repoLiteral = $repoRoot.Replace("'", "''")
$cmdContent = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0mineru-local.ps1`" %*`r`n"
$launcherContent = @"
param([Parameter(ValueFromRemainingArguments = `$true)][string[]]`$MineruArgs)
`$ErrorActionPreference = 'Stop'
`$repoRoot = '$repoLiteral'
`$runtimeRoot = Join-Path `$repoRoot '.runtime\mineru'
`$runtimeAccessPath = `$runtimeRoot
if (`$runtimeRoot -match '[^\x00-\x7F]') {
  `$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if (-not `$localData -or `$localData -match '[^\x00-\x7F]') { throw 'llama-cpp requires an ASCII LocalApplicationData path.' }
  `$sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    `$digest = [BitConverter]::ToString(`$sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(`$runtimeRoot))).Replace('-', '').ToLowerInvariant()
  } finally {
    `$sha.Dispose()
  }
  `$runtimeAccessPath = Join-Path (Join-Path `$localData 'MinerU\runtime-paths') `$digest.Substring(0, 12)
  `$alias = Get-Item -LiteralPath `$runtimeAccessPath -Force
  `$targets = @(`$alias.Target)
  if (`$alias.LinkType -ne 'Junction' -or `$targets.Count -ne 1 -or
      -not [string]::Equals([System.IO.Path]::GetFullPath([string]`$targets[0]).TrimEnd('\', '/'), `$runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'MinerU ASCII runtime junction target does not match; rerun setup.'
  }
}
`$mineru = Join-Path `$runtimeAccessPath 'venv\Scripts\mineru.exe'
if (-not (Test-Path -LiteralPath `$mineru -PathType Leaf)) { throw "MinerU runtime is missing: `$mineru" }
`$previousHome = `$env:MINERU_HOME
try {
  `$env:MINERU_HOME = `$runtimeRoot
  & `$mineru @MineruArgs
  `$exitCode = `$LASTEXITCODE
} finally {
  `$env:MINERU_HOME = `$previousHome
}
exit `$exitCode
"@
$launcherContent = $launcherContent.Replace("`n", "`r`n")

$cmdState = Get-FileState $cmdPath $cmdContent
$launcherState = Get-FileState $launcherPath $launcherContent -RequireUtf8Bom
$conflicts = @()
if ($cmdState -eq 'conflict') { $conflicts += $cmdPath }
if ($launcherState -eq 'conflict') { $conflicts += $launcherPath }
if ($conflicts.Count -gt 0 -and -not $RepairGlobalIntegration) {
  throw "Global integration conflict: $($conflicts -join ', '). Re-run with -RepairGlobalIntegration to back up and replace it."
}

$pathEntries = @($env:PATH -split ';' | Where-Object { $_ } | ForEach-Object {
  try { [System.IO.Path]::GetFullPath($_.Trim().Trim('"')).TrimEnd('\') } catch { $null }
})
if (-not ($pathEntries | Where-Object { $_ -ieq $GlobalBinRoot.TrimEnd('\') })) {
  throw "User npm bin is not on PATH: $GlobalBinRoot"
}

if ($cmdState -eq 'conflict') { Backup-Existing $cmdPath | Write-Output }
if ($launcherState -eq 'conflict') { Backup-Existing $launcherPath | Write-Output }

New-Item -ItemType Directory -Path $GlobalBinRoot -Force | Out-Null
if ($cmdState -ne 'current') {
  [System.IO.File]::WriteAllText($cmdPath, $cmdContent, [System.Text.UTF8Encoding]::new($false))
}
if ($launcherState -ne 'current') {
  [System.IO.File]::WriteAllText($launcherPath, $launcherContent, [System.Text.UTF8Encoding]::new($true))
}

if ($cmdState -eq 'current' -and $launcherState -eq 'current') {
  Write-Output 'Global integration no-op: MinerU launchers are current.'
} else {
  Write-Output "Global integration ready: $GlobalBinRoot"
}
