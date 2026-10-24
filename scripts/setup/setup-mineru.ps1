param(
  [Parameter(Mandatory = $true)]
  [string]$BasePython,
  [string]$VaultRoot,
  [ValidateSet('modelscope', 'huggingface', 'auto')]
  [string]$ModelSource
)

$ErrorActionPreference = 'Stop'
$vaultRoot = if ($VaultRoot) {
  [System.IO.Path]::GetFullPath($VaultRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$runtimeRoot = Join-Path $vaultRoot '.runtime\mineru'
$venvRoot = Join-Path $runtimeRoot 'venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$modelRoot = Join-Path $runtimeRoot 'models'
$configPath = Join-Path $runtimeRoot 'config.yaml'
$stateRoot = Join-Path $runtimeRoot 'state'
$packageCompletePath = Join-Path $stateRoot 'package-complete.json'
$modelsCompletePath = Join-Path $stateRoot 'models-v4-complete.json'
$environmentPath = Join-Path $vaultRoot 'config\environment.json'

function Write-AtomicJson([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
  try {
    $json = $Value | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($temporary, $json + "`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Get-RuntimeAccessPath([string]$Root) {
  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if ($normalizedRoot -notmatch '[^\x00-\x7F]') { return $normalizedRoot }
  $localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if (-not $localData -or $localData -match '[^\x00-\x7F]') {
    throw 'llama-cpp requires an ASCII runtime path, but LocalApplicationData is not an ASCII path.'
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedRoot))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  $aliasRoot = Join-Path $localData 'MinerU\runtime-paths'
  $alias = Join-Path $aliasRoot $digest.Substring(0, 12)
  if (Test-Path -LiteralPath $alias) {
    $existing = Get-Item -LiteralPath $alias -Force
    $targets = @($existing.Target)
    if ($existing.LinkType -ne 'Junction' -or $targets.Count -ne 1 -or
        -not [string]::Equals([System.IO.Path]::GetFullPath([string]$targets[0]).TrimEnd('\', '/'), $normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "MinerU ASCII runtime path already exists with a different target: $alias"
    }
  } else {
    New-Item -ItemType Directory -Path $aliasRoot -Force | Out-Null
    New-Item -ItemType Junction -Path $alias -Target $normalizedRoot | Out-Null
  }
  return $alias
}

if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
  throw "Environment contract does not exist: $environmentPath"
}
$environment = [System.IO.File]::ReadAllText($environmentPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$mineruPackage = [string]$environment.mineru.package
if (-not $ModelSource) { $ModelSource = [string]$environment.mineru.model_source }
if ($mineruPackage -cne 'mineru' -or $environment.mineru.update_policy -cne 'latest-stable' -or -not $ModelSource) {
  throw 'Environment contract must select the unpinned stable MinerU package and model source.'
}
if (-not (Test-Path -LiteralPath $BasePython -PathType Leaf)) {
  throw "BasePython does not exist: $BasePython"
}
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
$runtimeAccessPath = Get-RuntimeAccessPath $runtimeRoot
$venvPython = Join-Path $runtimeAccessPath 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
  & $BasePython -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the MinerU virtual environment.' }
}

# Pip selects the latest stable release; the installed version is evidence, not a pin.
& $venvPython -m pip install --upgrade $mineruPackage
if ($LASTEXITCODE -ne 0) { throw 'Failed to install the latest stable official MinerU package.' }
& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'MinerU dependency verification failed.' }
$installedVersion = & $venvPython -c "import importlib.metadata; import mineru; print(importlib.metadata.version('mineru'))"
if ($LASTEXITCODE -ne 0) { throw 'MinerU import verification failed.' }
$installedVersion = ([string]$installedVersion).Trim()
$packages = @(& $venvPython -m pip freeze --all)
if ($LASTEXITCODE -ne 0) { throw 'Failed to inventory the MinerU environment.' }
Write-AtomicJson $packageCompletePath ([ordered]@{
  schema_version = 1
  package = $mineruPackage
  version = $installedVersion
  distributions = @($packages | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ } | Sort-Object)
})

$modelAccessPath = Join-Path $runtimeAccessPath 'models'
# JSON is valid YAML. Preserve existing user configuration; only migrate the original model path.
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  Write-AtomicJson $configPath ([ordered]@{
    model = [ordered]@{
      source = 'local'
      base_dir = $modelAccessPath
      small_backend = 'onnx'
      vlm = @{ engine = 'llama-cpp' }
    }
  })
} elseif ($modelAccessPath -cne $modelRoot) {
  $configMigration = @'
import os, sys, yaml
path, original, alias = sys.argv[1:]
with open(path, encoding='utf-8-sig') as source:
    config = yaml.safe_load(source)
configured = config.get('model', {}).get('base_dir')
if configured and os.path.normcase(os.path.abspath(configured)) == os.path.normcase(os.path.abspath(original)):
    config['model']['base_dir'] = alias
    with open(path, 'w', encoding='utf-8') as target:
        yaml.safe_dump(config, target, allow_unicode=True, sort_keys=False)
'@
  & $venvPython -c $configMigration $configPath $modelRoot $modelAccessPath
  if ($LASTEXITCODE -ne 0) { throw 'Failed to migrate the MinerU model path to its ASCII runtime junction.' }
}

$previousHome = $env:MINERU_HOME
try {
  $env:MINERU_HOME = $runtimeRoot
  $kit = Join-Path $runtimeAccessPath 'venv\Scripts\mineru-kit.exe'
  & $kit models download --tier standard --small-backend onnx --vlm-engine llama-cpp --source $ModelSource
  if ($LASTEXITCODE -ne 0) { throw 'Failed to download MinerU Standard models.' }
  & $kit models verify --tier standard --small-backend onnx --vlm-engine llama-cpp
  if ($LASTEXITCODE -ne 0) { throw 'MinerU Standard model verification failed.' }
  & (Join-Path $runtimeAccessPath 'venv\Scripts\mineru.exe') version --json
  if ($LASTEXITCODE -ne 0) { throw 'MinerU CLI verification failed.' }
} finally {
  $env:MINERU_HOME = $previousHome
}
Write-AtomicJson $modelsCompletePath ([ordered]@{
  schema_version = 1
  mineru_version = $installedVersion
  model_source = $ModelSource
  tier = 'standard'
  small_backend = 'onnx'
  vlm_engine = 'llama-cpp'
  model_path = $modelRoot
})
Write-Output "MinerU $installedVersion local runtime ready: $runtimeRoot"
