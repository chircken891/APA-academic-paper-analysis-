param(
  [string]$RepoRoot,
  [string]$GlobalSkillRoot,
  [string]$GlobalBinRoot,
  [switch]$RepairGlobalIntegration
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepoRoot) {
  [System.IO.Path]::GetFullPath($RepoRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if (-not $GlobalSkillRoot) {
  $GlobalSkillRoot = Join-Path $profileRoot '.agents\skills\academic-paper-analysis'
}
if (-not $GlobalBinRoot) {
  $GlobalBinRoot = (& npm config get prefix).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $GlobalBinRoot) { throw 'Unable to resolve the user npm bin directory.' }
}
$GlobalSkillRoot = [System.IO.Path]::GetFullPath($GlobalSkillRoot)
$GlobalBinRoot = [System.IO.Path]::GetFullPath($GlobalBinRoot)
$canonicalSkillRoot = Join-Path $repoRoot '.agents\skills\academic-paper-analysis'
$globalSkillContainer = Split-Path -Parent $GlobalSkillRoot
$globalSkillBase = Split-Path -Parent $globalSkillContainer
$skillBackupRoot = Join-Path (Join-Path $globalSkillBase 'backups\skills') (Split-Path -Leaf $GlobalSkillRoot)
$cmdPath = Join-Path $GlobalBinRoot 'mineru.cmd'
$launcherPath = Join-Path $GlobalBinRoot 'mineru-local.ps1'

if (-not (Test-Path -LiteralPath $canonicalSkillRoot -PathType Container)) {
  throw "Canonical APA skill does not exist: $canonicalSkillRoot"
}

function Get-ProjectedSkillBytes([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ([System.IO.Path]::GetExtension($Path) -ine '.md') { return ,$bytes }
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  foreach ($match in [regex]::Matches($text, '\]\(((?:\.\./)+[^)]+)\)')) {
    $parts = ($match.Groups[1].Value -split '#', 2)
    $absolute = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Path) $parts[0]))
    if (-not $absolute.StartsWith($canonicalSkillRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      if (-not (Test-Path -LiteralPath $absolute)) { throw "Canonical APA reference does not exist: $absolute" }
      $suffix = if ($parts.Length -eq 2) { '#' + $parts[1] } else { '' }
      $text = $text.Replace($match.Value, '](<' + $absolute.Replace('\', '/') + $suffix + '>)')
    }
  }
  return ,([System.Text.Encoding]::UTF8.GetBytes($text))
}

function Get-DirectoryInventory([string]$Root, [switch]$ProjectReferences) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $null }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "Global APA skill root must not be a link: $Root"
  }
  $inventory = @(
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File | ForEach-Object {
      if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Global APA skill contains a link: $($_.FullName)"
      }
      [pscustomobject]@{
        path = $_.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
        sha256 = if ($ProjectReferences) { Get-BytesSha256 (Get-ProjectedSkillBytes $_.FullName) } else { Get-Sha256 $_.FullName }
      }
    } | Sort-Object path
  )
  return ($inventory | ConvertTo-Json -Compress)
}

function Get-BytesSha256([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

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

function Backup-Existing([string]$Path, [string]$BackupRoot) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
  $backup = if ($BackupRoot) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    Join-Path $BackupRoot $stamp
  } else {
    "$Path.backup-$stamp"
  }
  $counter = 0
  while (Test-Path -LiteralPath $backup) {
    $counter += 1
    $backup = if ($BackupRoot) {
      Join-Path $BackupRoot "$stamp-$counter"
    } else {
      "$Path.backup-$stamp-$counter"
    }
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

$canonicalInventory = Get-DirectoryInventory $canonicalSkillRoot -ProjectReferences
$skillState = if (-not (Test-Path -LiteralPath $GlobalSkillRoot)) {
  'missing'
} elseif (-not (Test-Path -LiteralPath $GlobalSkillRoot -PathType Container)) {
  'conflict'
} else {
  $skillInventory = Get-DirectoryInventory $GlobalSkillRoot
  if ($skillInventory -ceq $canonicalInventory) { 'current' } else { 'conflict' }
}
$cmdState = Get-FileState $cmdPath $cmdContent
$launcherState = Get-FileState $launcherPath $launcherContent -RequireUtf8Bom
$conflicts = @()
if ($skillState -eq 'conflict') { $conflicts += $GlobalSkillRoot }
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

if ($skillState -eq 'conflict') { Backup-Existing $GlobalSkillRoot $skillBackupRoot | Write-Output }
if ($cmdState -eq 'conflict') { Backup-Existing $cmdPath | Write-Output }
if ($launcherState -eq 'conflict') { Backup-Existing $launcherPath | Write-Output }

if ($skillState -ne 'current') {
  New-Item -ItemType Directory -Path (Split-Path -Parent $GlobalSkillRoot) -Force | Out-Null
  Copy-Item -LiteralPath $canonicalSkillRoot -Destination $GlobalSkillRoot -Recurse
  Get-ChildItem -LiteralPath $canonicalSkillRoot -Recurse -File -Filter '*.md' | ForEach-Object {
    $relativePath = $_.FullName.Substring($canonicalSkillRoot.TrimEnd('\').Length + 1)
    [System.IO.File]::WriteAllBytes((Join-Path $GlobalSkillRoot $relativePath), (Get-ProjectedSkillBytes $_.FullName))
  }
}
New-Item -ItemType Directory -Path $GlobalBinRoot -Force | Out-Null
if ($cmdState -ne 'current') {
  [System.IO.File]::WriteAllText($cmdPath, $cmdContent, [System.Text.UTF8Encoding]::new($false))
}
if ($launcherState -ne 'current') {
  [System.IO.File]::WriteAllText($launcherPath, $launcherContent, [System.Text.UTF8Encoding]::new($true))
}

if ($skillState -eq 'current' -and $cmdState -eq 'current' -and $launcherState -eq 'current') {
  Write-Output 'Global integration no-op: APA skill and MinerU launchers are current.'
} else {
  Write-Output "Global integration ready: $GlobalSkillRoot; $GlobalBinRoot"
}
