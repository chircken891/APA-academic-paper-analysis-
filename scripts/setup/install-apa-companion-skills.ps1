param(
  [string]$BasePython,
  [string[]]$Skills,
  [string]$CompanionSkillRoot,
  [string]$InstallerPath,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else {
  Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.codex'
}
if (-not $CompanionSkillRoot) { $CompanionSkillRoot = Join-Path $codexRoot 'skills' }
if (-not $InstallerPath) {
  $InstallerPath = Join-Path $codexRoot 'skills\.system\skill-installer\scripts\install-skill-from-github.py'
}
$CompanionSkillRoot = [System.IO.Path]::GetFullPath($CompanionSkillRoot)
$skillCatalog = @(
  @{ Name = 'nature-writing'; Repo = 'Yuan1z0825/nature-skills'; Path = 'skills/nature-writing' },
  @{ Name = 'nature-polishing'; Repo = 'Yuan1z0825/nature-skills'; Path = 'skills/nature-polishing' },
  @{ Name = 'nature-shared'; Repo = 'Yuan1z0825/nature-skills'; Path = 'skills/nature-shared' },
  @{ Name = 'humanizer'; Repo = 'blader/humanizer'; Path = '.' },
  @{ Name = 'humanizer-zh'; Repo = 'op7418/Humanizer-zh'; Path = '.' },
  @{ Name = 'stss'; Repo = 'lennney/stop-that-shit'; Path = 'skills/stss' }
)
$selectedNames = @($Skills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($selectedNames.Count -eq 0) { throw 'Select companion skills explicitly with -Skills name1,name2. No skills were installed.' }
foreach ($name in $selectedNames) {
  if ($name -notin $skillCatalog.Name) { throw "Unknown companion skill: $name. No skills were installed." }
}
if ('nature-writing' -in $selectedNames -or 'nature-polishing' -in $selectedNames) {
  $selectedNames = @($selectedNames + 'nature-shared' | Select-Object -Unique)
}
$selectedSkills = @($skillCatalog | Where-Object { $_.Name -in $selectedNames })
$missing = @()
$blocked = @()
$targets = @()
foreach ($skill in $selectedSkills) {
  $target = Join-Path $CompanionSkillRoot $skill.Name
  if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $target -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $target 'SKILL.md') -PathType Leaf)) {
      $blocked += "Existing companion skill is incomplete: $target. Inspect or repair it before retrying; it was not overwritten."
      $targets += @{ name = $skill.Name; path = $target; status = 'incomplete'; impact = 'Preserve existing entry; manual repair required' }
      continue
    }
    $targets += @{ name = $skill.Name; path = $target; status = 'satisfied'; impact = 'Preserve installed skill and local edits' }
  } else {
    $missing += $skill
    $targets += @{ name = $skill.Name; path = $target; status = 'missing'; impact = 'Download this complete skill directory' }
  }
}
$pythonReady = $BasePython -and (Test-Path -LiteralPath $BasePython -PathType Leaf)
$installerReady = Test-Path -LiteralPath $InstallerPath -PathType Leaf
$checks = @(
  @{ id = 'python'; path = $BasePython; status = if ($pythonReady) { 'satisfied' } else { 'missing' } },
  @{ id = 'installer'; path = $InstallerPath; status = if ($installerReady) { 'satisfied' } else { 'missing' } }
)
$nextCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -BasePython "' + $BasePython + '" -Skills "' + ($selectedNames -join ',') + '" -CompanionSkillRoot "' + $CompanionSkillRoot + '" -InstallerPath "' + $InstallerPath + '"'
Write-Output (@{ check_only = [bool]$CheckOnly; checks = $checks; targets = $targets; blocked = @($blocked); next_commands = @($nextCommand) } | ConvertTo-Json -Depth 6 -Compress)
if ($CheckOnly) { return }
if ($blocked.Count -gt 0) { throw ($blocked -join "`n") }
if ($missing.Count -eq 0) { return }
if (-not $pythonReady) { throw 'BasePython is missing; provide an existing Python executable with -BasePython. No skills were installed.' }
if (-not $installerReady) {
  throw "Codex skill-installer helper is missing: $InstallerPath. Install Codex skill-installer or pass -InstallerPath, then rerun."
}
foreach ($skill in $missing) {
  & $BasePython $InstallerPath --repo $skill.Repo --path $skill.Path --name $skill.Name --dest $CompanionSkillRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Companion skill installation failed for $($skill.Name) (exit $LASTEXITCODE). Completed skills are retained; resolve the reported error and rerun."
  }
  if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $CompanionSkillRoot $skill.Name) 'SKILL.md') -PathType Leaf)) {
    throw "Installer reported success without SKILL.md for $($skill.Name). Inspect the destination before retrying."
  }
  Write-Output "Companion skill installed: $($skill.Name)"
}
