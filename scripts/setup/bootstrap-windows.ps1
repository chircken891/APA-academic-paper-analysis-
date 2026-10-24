param(
  [string]$RepoRoot,
  [string]$BasePython,
  [string]$GlobalSkillRoot,
  [string]$GlobalBinRoot,
  [string]$CompanionSkillRoot,
  [switch]$InstallMineru,
  [switch]$InstallGlobalIntegration,
  [string[]]$CompanionSkills,
  [switch]$CheckOnly,
  [switch]$RepairGlobalIntegration
)

$ErrorActionPreference = 'Stop'
if ($RepairGlobalIntegration -and -not $InstallGlobalIntegration) {
  throw '-RepairGlobalIntegration requires explicit -InstallGlobalIntegration.'
}
$CompanionSkills = @($CompanionSkills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
$knownCompanionSkills = @('nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss')
foreach ($name in $CompanionSkills) {
  if ($name -notin $knownCompanionSkills) { throw "Unknown companion skill: $name. No installation was started." }
}
$repoRoot = if ($RepoRoot) {
  [System.IO.Path]::GetFullPath($RepoRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$environmentPath = Join-Path $repoRoot 'config\environment.json'
$packagePath = Join-Path $repoRoot 'package.json'
$lockPath = Join-Path $repoRoot 'package-lock.json'
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  throw "Repository root is incomplete: $repoRoot"
}
$environmentJson = [System.IO.File]::ReadAllText($environmentPath, [System.Text.Encoding]::UTF8)
$environment = $environmentJson | ConvertFrom-Json
$script:ResolvedBasePython = $null
$script:NodeCommand = $null
$script:NpmCommand = $null
$script:ProbeDiagnostics = @()

function Invoke-ReadOnlyProbe([string]$Command, [string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $Command @Arguments 2>&1)
    $code = $LASTEXITCODE
  } catch {
    $output = @($_)
    $code = -1
  } finally { $ErrorActionPreference = $previousPreference }
  $stdout = @($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
  $stderr = @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ }) -join "`n"
  if ($code -ne 0 -or $stderr) { $script:ProbeDiagnostics += @{ command = $Command; exit_code = $code; stderr = $stderr } }
  return @{ stdout = $stdout; exit_code = $code }
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

function Resolve-BasePython {
  if ($BasePython) {
    $candidate = [System.IO.Path]::GetFullPath($BasePython)
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return $null
  }
  $required = "$($environment.python.major).$($environment.python.minor)"
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    $probe = Invoke-ReadOnlyProbe 'py.exe' @("-$required", '-c', 'import sys; print(sys.executable)')
    $candidate = $probe.stdout | Select-Object -Last 1
    if ($probe.exit_code -eq 0 -and $candidate -and (Test-Path -LiteralPath $candidate.Trim() -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidate.Trim())
    }
  }
  foreach ($command in @('python.exe', 'python')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { continue }
    $probe = Invoke-ReadOnlyProbe $command @('-c', 'import sys; print(sys.executable)')
    $candidate = $probe.stdout | Select-Object -Last 1
    if ($probe.exit_code -eq 0 -and $candidate -and (Test-Path -LiteralPath $candidate.Trim() -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidate.Trim())
    }
  }
  return $null
}

function Assert-Prerequisites {
  $failures = @()
  $isWindows = $env:OS -eq 'Windows_NT'
  $script:NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $script:NodeCommand) { $script:NodeCommand = Get-Command node -ErrorAction SilentlyContinue }
  $script:NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $script:NpmCommand) { $script:NpmCommand = Get-Command npm -ErrorAction SilentlyContinue }
  $architecture = if ($script:NodeCommand) { (Invoke-ReadOnlyProbe $script:NodeCommand.Source @('-p', 'process.arch')).stdout | Select-Object -Last 1 } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'x64' } else { $env:PROCESSOR_ARCHITECTURE }
  if (-not $isWindows -or $architecture -ne $environment.platform.arch) {
    $failures += "platform: expected Windows $($environment.platform.arch), found $env:OS/$architecture"
  }

  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
  if (-not $git) { $failures += 'git: install Git for Windows and reopen the terminal' }

  $nodeVersion = if ($script:NodeCommand) { (Invoke-ReadOnlyProbe $script:NodeCommand.Source @('--version')).stdout | Select-Object -Last 1 } else { $null }
  $nodeMajor = if ($nodeVersion -match '^v?(\d+)\.') { [int]$Matches[1] } else { -1 }
  if ($nodeMajor -ne [int]$environment.node.major) {
    $failures += "node: expected $($environment.node.major).x $($environment.node.channel), found $nodeVersion"
  }

  $npmVersion = if ($script:NpmCommand) { (Invoke-ReadOnlyProbe $script:NpmCommand.Source @('--version')).stdout | Select-Object -Last 1 } else { $null }
  $npmMajor = if ($npmVersion -match '^(\d+)\.') { [int]$Matches[1] } else { -1 }
  if ($npmMajor -ne [int]$environment.npm.major) {
    $failures += "npm: expected $($environment.npm.major).x, found $npmVersion"
  }

  $script:ResolvedBasePython = Resolve-BasePython
  if (-not $script:ResolvedBasePython) {
    $failures += "python: install $($environment.python.major).$($environment.python.minor).x and reopen the terminal"
  } else {
    $pythonVersion = (Invoke-ReadOnlyProbe $script:ResolvedBasePython @('-c', 'import sys; print(*sys.version_info[:3], sep=chr(46))')).stdout | Select-Object -Last 1
    $requiredPrefix = "$($environment.python.major).$($environment.python.minor)."
    if (-not $pythonVersion -or -not ([string]$pythonVersion).StartsWith($requiredPrefix)) {
      $failures += "python: expected $requiredPrefix`x, found $pythonVersion"
    }
  }

  $driveRoot = [System.IO.Path]::GetPathRoot($repoRoot)
  $freeBytes = ([System.IO.DriveInfo]::new($driveRoot)).AvailableFreeSpace
  $minimumBytes = [int64]$environment.disk.minimum_free_gib * 1GB
  if ($freeBytes -lt $minimumBytes) {
    $failures += "disk_space: at least $($environment.disk.minimum_free_gib) GiB is required on $driveRoot"
  }

  $checks = @(
    @{ id = 'platform'; actual = "$env:OS/$architecture" },
    @{ id = 'git'; actual = if ($git) { $git.Source } else { $null } },
    @{ id = 'node'; actual = $nodeVersion },
    @{ id = 'npm'; actual = $npmVersion },
    @{ id = 'python'; actual = $pythonVersion; path = $script:ResolvedBasePython; required = [bool]($InstallMineru -or $CompanionSkills.Count -gt 0) },
    @{ id = 'disk_space'; actual = $freeBytes; required = [bool]$InstallMineru }
  )
  foreach ($check in $checks) {
    if (-not $check.ContainsKey('required')) { $check.required = $true }
    $check.status = if (@($failures | Where-Object { $_.StartsWith($check.id + ':') }).Count) { 'missing' } else { 'satisfied' }
    $check.details = @($failures | Where-Object { $_.StartsWith($check.id + ':') })
  }
  $blockingFailures = @($checks | Where-Object { $_.required -and $_.status -eq 'missing' } | ForEach-Object { $_.details })
  $dependenciesReady = Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container
  if ($dependenciesReady -and $script:NpmCommand) {
    Push-Location $repoRoot
    try { $dependenciesReady = (Invoke-ReadOnlyProbe $script:NpmCommand.Source @('ls', '--depth=0', '--ignore-scripts')).exit_code -eq 0 } finally { Pop-Location }
  }
  $checks += @{ id = 'node_dependencies'; required = $false; status = if ($dependenciesReady) { 'satisfied' } else { 'missing' }; actual = (Join-Path $repoRoot 'node_modules'); details = @('Installed by the selected base step; not an installer prerequisite') }
  $profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $skillTarget = if ($GlobalSkillRoot) { [System.IO.Path]::GetFullPath($GlobalSkillRoot) } else { Join-Path $profileRoot '.agents\skills\academic-paper-analysis' }
  $companionTarget = if ($CompanionSkillRoot) { [System.IO.Path]::GetFullPath($CompanionSkillRoot) } elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $profileRoot '.codex\skills' }
  $selectedSkillNames = @($CompanionSkills)
  if ('nature-writing' -in $selectedSkillNames -or 'nature-polishing' -in $selectedSkillNames) { $selectedSkillNames = @($selectedSkillNames + 'nature-shared' | Select-Object -Unique) }
  $skillChecks = @($selectedSkillNames | ForEach-Object {
    $target = Join-Path $companionTarget $_
    @{ name = $_; path = $target; status = if (Test-Path -LiteralPath (Join-Path $target 'SKILL.md') -PathType Leaf) { 'satisfied' } elseif (Test-Path -LiteralPath $target) { 'incomplete' } else { 'missing' } }
  })
  if ($InstallGlobalIntegration -and -not $GlobalBinRoot -and $script:NpmCommand) {
    $prefixProbe = Invoke-ReadOnlyProbe $script:NpmCommand.Source @('config', 'get', 'prefix')
    $prefix = $prefixProbe.stdout | Select-Object -Last 1
    if ($prefixProbe.exit_code -eq 0 -and $prefix) { $script:GlobalBinRoot = [System.IO.Path]::GetFullPath(([string]$prefix).Trim()) }
  }
  $targets = @(
    @{ id = 'base'; selected = $true; path = (Join-Path $repoRoot 'node_modules'); status = if ($dependenciesReady) { 'satisfied' } else { 'missing' }; impact = 'npm ci restores package-lock dependencies and writes .runtime/setup stamp' },
    @{ id = 'mineru'; selected = [bool]$InstallMineru; path = (Join-Path $repoRoot '.runtime\mineru'); status = if (Test-Path -LiteralPath (Join-Path $repoRoot '.runtime\mineru\venv\Scripts\python.exe') -PathType Leaf) { 'present-unverified' } else { 'missing' }; impact = 'Creates local Python environment and downloads MinerU and models' },
    @{ id = 'global_integration'; selected = [bool]$InstallGlobalIntegration; path = $skillTarget; status = if (Test-Path -LiteralPath (Join-Path $skillTarget 'SKILL.md') -PathType Leaf) { 'present-unverified' } else { 'missing' }; bin_path = $GlobalBinRoot; impact = 'Installs global APA skill and MinerU command launcher; explicit repair backs up conflicts' },
    @{ id = 'companion_skills'; selected = $CompanionSkills.Count -gt 0; path = $companionTarget; skills = $skillChecks; impact = 'Downloads only selected skill directories; Nature includes nature-shared' }
  )
  $nextCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -RepoRoot "' + $repoRoot + '"'
  if ($BasePython) { $nextCommand += ' -BasePython "' + $BasePython + '"' }
  if ($InstallMineru) { $nextCommand += ' -InstallMineru' }
  if ($InstallGlobalIntegration) { $nextCommand += ' -InstallGlobalIntegration' }
  if ($CompanionSkills.Count) { $nextCommand += ' -CompanionSkills "' + ($CompanionSkills -join ',') + '"' }
  if ($InstallGlobalIntegration -and $RepairGlobalIntegration) { $nextCommand += ' -RepairGlobalIntegration' }
  foreach ($option in @(@{ Name = 'GlobalSkillRoot'; Value = $GlobalSkillRoot }, @{ Name = 'GlobalBinRoot'; Value = $GlobalBinRoot }, @{ Name = 'CompanionSkillRoot'; Value = $CompanionSkillRoot })) {
    if ($option.Value) { $nextCommand += ' -' + $option.Name + ' "' + $option.Value + '"' }
  }
  $report = @{ check_only = [bool]$CheckOnly; prerequisites_ready = $blockingFailures.Count -eq 0; checks = $checks; targets = $targets; next_commands = @($nextCommand); prerequisite_actions = @($blockingFailures); diagnostics = @($script:ProbeDiagnostics) }
  Write-Output ($report | ConvertTo-Json -Depth 8 -Compress)
  if ($CheckOnly) { return }
  if ($blockingFailures.Count -gt 0) {
    throw "Bootstrap prerequisites failed:`n- $($blockingFailures -join "`n- ")"
  }
  Write-Output "1/6 prerequisites ready: Git; Node $nodeVersion; npm $npmVersion; Python $pythonVersion"
}

Assert-Prerequisites
if ($CheckOnly) { return }
if ($InstallGlobalIntegration -and -not $GlobalBinRoot) {
  $resolvedPrefix = (& $script:NpmCommand.Source config get prefix 2>$null | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or -not $resolvedPrefix) { throw 'Unable to resolve the user npm bin directory.' }
  $GlobalBinRoot = [System.IO.Path]::GetFullPath(([string]$resolvedPrefix).Trim())
} elseif ($InstallGlobalIntegration) {
  $GlobalBinRoot = [System.IO.Path]::GetFullPath($GlobalBinRoot)
}
Push-Location $repoRoot
try {
  $setupStateRoot = Join-Path $repoRoot '.runtime\setup'
  $lockStamp = Join-Path $setupStateRoot 'package-lock.sha256'
  $lockHash = Get-Sha256 $lockPath
  $nodeModulesReady = Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container
  $stampMatches = $nodeModulesReady -and (Test-Path -LiteralPath $lockStamp -PathType Leaf) -and
    ([System.IO.File]::ReadAllText($lockStamp, [System.Text.Encoding]::UTF8).Trim() -eq $lockHash)
  if ($stampMatches) {
    & $script:NpmCommand.Source ls --depth=0 --ignore-scripts 1>$null 2>$null
    $nodeModulesReady = $LASTEXITCODE -eq 0
  } else {
    $nodeModulesReady = $false
  }
  if (-not $nodeModulesReady) {
    & $script:NpmCommand.Source ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed; rerun bootstrap after resolving the reported npm error.' }
    New-Item -ItemType Directory -Path $setupStateRoot -Force | Out-Null
    [System.IO.File]::WriteAllText($lockStamp, $lockHash + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output '2/6 Node dependencies restored from package-lock.json.'
  } else {
    Write-Output '2/6 Node dependencies no-op: package lock and installed tree are current.'
  }

  if ($InstallMineru) {
    & (Join-Path $repoRoot 'scripts\setup\setup-mineru.ps1') `
      -BasePython $script:ResolvedBasePython `
      -VaultRoot $repoRoot `
      -ModelSource ([string]$environment.mineru.model_source)
    if ($LASTEXITCODE -ne 0) { throw 'MinerU setup failed; the retained .runtime can be reused by the next run.' }
    Write-Output '3/6 local MinerU runtime ready.'
  } else { Write-Output 'MinerU installation skipped; use -InstallMineru to select it.' }

  if ($InstallGlobalIntegration) {
    & (Join-Path $repoRoot 'scripts\setup\install-global-integrations.ps1') `
      -RepoRoot $repoRoot `
      -GlobalSkillRoot $GlobalSkillRoot `
      -GlobalBinRoot $GlobalBinRoot `
      -RepairGlobalIntegration:$RepairGlobalIntegration
    if ($LASTEXITCODE -ne 0) { throw 'Global integration failed.' }
    Write-Output '4-5/6 APA skill and MinerU command integration ready.'
  } else { Write-Output 'Global integration skipped; use -InstallGlobalIntegration to select it.' }

  if ($CompanionSkills.Count -gt 0) {
    & (Join-Path $repoRoot 'scripts\setup\install-apa-companion-skills.ps1') `
      -BasePython $script:ResolvedBasePython `
      -CompanionSkillRoot $CompanionSkillRoot `
      -Skills $CompanionSkills
    if ($LASTEXITCODE -ne 0) { throw 'APA companion skill installation failed; rerun after resolving the reported error.' }
    Write-Output 'Selected APA writing companion skills ready.'
  } else { Write-Output 'Companion skill installation skipped; use -CompanionSkills to select named skills.' }

  $previousBasePython = $env:APA_BASE_PYTHON
  $previousGlobalSkill = $env:APA_GLOBAL_SKILL
  $previousGlobalBin = $env:APA_GLOBAL_BIN
  try {
    $env:APA_BASE_PYTHON = $script:ResolvedBasePython
    if ($GlobalSkillRoot) { $env:APA_GLOBAL_SKILL = [System.IO.Path]::GetFullPath($GlobalSkillRoot) }
    if ($InstallGlobalIntegration) { $env:APA_GLOBAL_BIN = $GlobalBinRoot }
    & $script:NpmCommand.Source run setup:check
    if ($LASTEXITCODE -ne 0) { throw 'Core environment verification failed.' }
  } finally {
    $env:APA_BASE_PYTHON = $previousBasePython
    $env:APA_GLOBAL_SKILL = $previousGlobalSkill
    $env:APA_GLOBAL_BIN = $previousGlobalBin
  }
  Write-Output '6/6 core environment verification passed.'
} finally {
  Pop-Location
}
