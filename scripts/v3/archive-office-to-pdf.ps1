param(
    [string]$SourcePath,
    [string]$OutputDirectory,
    [ValidateSet('docx','xlsx')][string]$Format,
    [datetime]$DeadlineUtc,
    [int]$TimeoutSeconds = 90,
    [switch]$Worker,
    [switch]$FunctionsOnly
)

$ErrorActionPreference = 'Stop'

function ConvertTo-OfficeErrorDiagnostic {
    param([System.Management.Automation.ErrorRecord]$Record, [string]$Phase)
    $exception = $Record.Exception
    $inner = $exception.InnerException
    return @{
        message=$exception.Message; exception_type=$exception.GetType().FullName; hresult=$exception.HResult; phase=$Phase
        error_record=@{ fully_qualified_error_id=$Record.FullyQualifiedErrorId; category=[string]$Record.CategoryInfo; script_stack_trace=$Record.ScriptStackTrace; position_message=$Record.InvocationInfo.PositionMessage }
        inner_exception=$(if($inner){@{message=$inner.Message;exception_type=$inner.GetType().FullName;hresult=$inner.HResult}}else{$null})
    }
}

function Get-OwnedOfficeIdentity {
    param($Application, [int[]]$ExistingIds, [datetime]$StartedAfter, [scriptblock]$ResolveIdentity)
    try { $identity = & $ResolveIdentity $Application } catch { throw [InvalidOperationException]::new('OFFICE_INSTANCE_OWNERSHIP_UNKNOWN', $_.Exception) }
    if (!$identity -or $identity.Pid -le 0 -or $ExistingIds -contains $identity.Pid -or $identity.StartUtc -lt $StartedAfter) {
        throw 'OFFICE_INSTANCE_OWNERSHIP_UNKNOWN'
    }
    return $identity
}

function Save-OwnedOfficeSettings {
    param($Application, $Format, $Identity, [scriptblock]$CurrentIdentity)
    if (!$Identity) { throw 'OFFICE_SETTINGS_OWNERSHIP_UNKNOWN' }
    $current = & $CurrentIdentity $Identity.Pid
    if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { throw 'OFFICE_SETTINGS_IDENTITY_CHANGED' }
    $values = [ordered]@{ Visible=$Application.Visible; DisplayAlerts=$Application.DisplayAlerts; AutomationSecurity=$Application.AutomationSecurity }
    if ($Format -eq 'docx') {
        foreach ($name in @('UpdateLinksAtOpen','UpdateLinksAtPrint','UpdateFieldsAtPrint')) { $values['Options.'+$name]=$Application.Options.$name }
    } else {
        foreach ($name in @('AskToUpdateLinks','CalculateBeforeSave','Calculation')) { $values[$name]=$Application.$name }
    }
    return @{ values=$values }
}

function Restore-OwnedOfficeSettings {
    param($Application, $Snapshot, $Identity, [scriptblock]$CurrentIdentity, [switch]$DeferCalculation)
    if (!$Identity) { return 'ownership_unknown' }
    try {
        $current = & $CurrentIdentity $Identity.Pid
        if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { return 'identity_changed' }
        if (!$Snapshot -or !$Snapshot.values) { return 'restore_unknown' }
        foreach ($name in $Snapshot.values.Keys) {
            if ($DeferCalculation -and $name -eq 'Calculation') { continue }
            $current = & $CurrentIdentity $Identity.Pid
            if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { return 'identity_changed' }
            if ($name.StartsWith('Options.')) { $property=$name.Substring(8); $Application.Options.$property=$Snapshot.values[$name] }
            else { $Application.$name=$Snapshot.values[$name] }
        }
        foreach ($name in $Snapshot.values.Keys) {
            if ($DeferCalculation -and $name -eq 'Calculation') { continue }
            $value=if ($name.StartsWith('Options.')) { $Application.Options.($name.Substring(8)) } else { $Application.$name }
            if ($value -ne $Snapshot.values[$name]) { return 'restore_unknown' }
        }
        $current = & $CurrentIdentity $Identity.Pid
        if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { return 'identity_changed' }
        if ($DeferCalculation) { return 'restored_except_calculation_verified' }
        return 'restored_verified'
    } catch { return 'restore_unknown' }
}

function Close-OwnedOfficeSession {
    param($Application, $Document, $Identity, [scriptblock]$CurrentIdentity, [scriptblock]$CloseDocument, [scriptblock]$QuitApplication, $Snapshot, $Format, [scriptblock]$VerifyDocumentClosed)
    if (!$Identity) { return 'ownership_unknown_no_quit' }
    $current = & $CurrentIdentity $Identity.Pid
    if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { return 'identity_changed_no_quit' }
    if ($Snapshot) {
        # Restoring automatic Calculation with the temporary workbook open can
        # recalculate it. Restore the other settings first, then close without
        # saving and confirm that this owned instance has no open workbooks.
        $defer = $Format -eq 'xlsx'
        $restored = Restore-OwnedOfficeSettings -Application $Application -Snapshot $Snapshot -Identity $Identity -CurrentIdentity $CurrentIdentity -DeferCalculation:$defer
        $expected = if ($defer) { 'restored_except_calculation_verified' } else { 'restored_verified' }
        if ($restored -ne $expected) { throw ('OFFICE_SETTINGS_RESTORATION_UNCONFIRMED:'+$restored) }
        $current = & $CurrentIdentity $Identity.Pid
        if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { throw 'OFFICE_CLEANUP_IDENTITY_CHANGED' }
        if ($Document) { & $CloseDocument $Document }
        $current = & $CurrentIdentity $Identity.Pid
        if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { throw 'OFFICE_CLEANUP_IDENTITY_CHANGED' }
        if ($defer) {
            if (!$VerifyDocumentClosed -or !(& $VerifyDocumentClosed $Application $Document)) { throw 'OFFICE_WORKBOOK_CLOSE_UNCONFIRMED' }
            $restored = Restore-OwnedOfficeSettings -Application $Application -Snapshot $Snapshot -Identity $Identity -CurrentIdentity $CurrentIdentity
            if ($restored -ne 'restored_verified') { throw ('OFFICE_SETTINGS_RESTORATION_UNCONFIRMED:'+$restored) }
        }
        $current = & $CurrentIdentity $Identity.Pid
        if (!$current -or $current.Pid -ne $Identity.Pid -or $current.StartUtc -ne $Identity.StartUtc) { throw 'OFFICE_CLEANUP_IDENTITY_CHANGED' }
        & $QuitApplication $Application
        return 'owned_instance_closed'
    }
    try { if ($Document) { & $CloseDocument $Document } }
    finally { & $QuitApplication $Application }
    return 'owned_instance_closed'
}

function Stop-OwnedOfficeProcess {
    param($Identity, [scriptblock]$CurrentIdentity, [scriptblock]$StopProcess)
    if (!$Identity -or $Identity.Confirmed -ne $true) { return 'ownership_unknown_no_stop' }
    $current = & $CurrentIdentity $Identity.Pid
    if (!$current -or $current.Pid -ne $Identity.Pid -or [datetime]$current.StartUtc -ne [datetime]$Identity.StartUtc) { return 'identity_changed_no_stop' }
    & $StopProcess $Identity.Pid
    return 'owned_timeout_process_stopped'
}

if ($FunctionsOnly) { return }
if (!$SourcePath -or !$OutputDirectory -or !$Format -or $DeadlineUtc -eq [datetime]::MinValue) { throw 'OFFICE_FIXED_INPUT_AND_DEADLINE_REQUIRED' }
if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 300) { throw 'OFFICE_TIMEOUT_INVALID' }
$source = [IO.Path]::GetFullPath($SourcePath)
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (![IO.File]::Exists($source) -or [IO.Path]::GetExtension($source).TrimStart('.').ToLowerInvariant() -ne $Format) { throw 'OFFICE_SOURCE_FORMAT_MISMATCH' }
if ([datetime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { throw 'OFFICE_DEADLINE_EXPIRED' }

if (!$Worker) {
    if ([IO.Directory]::Exists($output) -or [IO.File]::Exists($output)) { throw 'OFFICE_OUTPUT_MUST_BE_NEW' }
    $null = New-Item -ItemType Directory -Path $output
    # Only this newly created task directory contains the temporary source copy.
    Copy-Item -LiteralPath $source -Destination (Join-Path $output ('input.' + $Format))
    $workerSource = Join-Path $output ('input.' + $Format)
    $shellPath = (Get-Process -Id $PID).Path
    $args = @('-NoProfile','-NonInteractive','-File', ('"' + $PSCommandPath + '"'), '-Worker', '-SourcePath', ('"' + $workerSource + '"'), '-OutputDirectory', ('"' + $output + '"'), '-Format', $Format, '-DeadlineUtc', $DeadlineUtc.ToUniversalTime().ToString('o'), '-TimeoutSeconds', $TimeoutSeconds)
    $helper = Start-Process -FilePath $shellPath -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output 'worker.stdout.log') -RedirectStandardError (Join-Path $output 'worker.stderr.log')
    try {
    # Acquire and retain the process handle before StartTime/WaitForExit. PS5.1
    # redirected Start-Process can otherwise lose a fast worker's exit code.
    $null = $helper.Handle
    $helperIdentity = $helper.StartTime.ToUniversalTime()
    $remaining = [Math]::Max(0, ($DeadlineUtc.ToUniversalTime() - [datetime]::UtcNow).TotalMilliseconds)
    # Reserve time for the supervisor to reclaim confirmed owned processes.
    $limit = [int][Math]::Min($TimeoutSeconds * 1000, [Math]::Max(0, $remaining - 5000))
    if (!$helper.WaitForExit($limit)) {
        $ownedFile = Join-Path $output 'owned-instance.json'
        if (Test-Path -LiteralPath $ownedFile) {
            $owned = Get-Content -LiteralPath $ownedFile -Raw | ConvertFrom-Json
            $null = Stop-OwnedOfficeProcess -Identity $owned -CurrentIdentity { param($id) $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){@{Pid=$p.Id;StartUtc=$p.StartTime.ToUniversalTime()}} } -StopProcess {param($id) Stop-Process -Id $id}
        }
        $observedHelper = Get-Process -Id $helper.Id -ErrorAction SilentlyContinue
        if ($observedHelper -and $observedHelper.StartTime.ToUniversalTime() -eq $helperIdentity) { Stop-Process -Id $helper.Id }
        @{status='blocked';reason='OFFICE_OWNED_CONVERSION_TIMEOUT';settings_restoration='unknown'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'conversion.json') -Encoding utf8
        throw 'OFFICE_OWNED_CONVERSION_TIMEOUT'
    }
    $exitCode = $helper.ExitCode
    if ($null -eq $exitCode) { throw 'OFFICE_WORKER_EXIT_CODE_UNKNOWN' }
    if ($exitCode -ne 0) { throw ('OFFICE_CONVERSION_FAILED:' + $exitCode) }
    Get-Content -LiteralPath (Join-Path $output 'conversion.json') -Raw
    return
    } finally { $helper.Dispose() }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ArchiveOfficeWindow {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$processName = if ($Format -eq 'docx') { 'WINWORD' } else { 'EXCEL' }
$existing = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$startedAfter = [datetime]::UtcNow
$application = $null; $document = $null; $identity = $null; $settings = $null; $result = $null; $conversionError = $null; $originalError = $null
$currentIdentity = { param($id) $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){@{Pid=$p.Id;StartUtc=$p.StartTime.ToUniversalTime()}} }
$beforeHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
try {
    $failurePhase = 'construct'
    $application = New-Object -ComObject $(if ($Format -eq 'docx') { 'Word.Application' } else { 'Excel.Application' })
    $failurePhase = 'identify'
    $identity = Get-OwnedOfficeIdentity -Application $application -ExistingIds $existing -StartedAfter $startedAfter -ResolveIdentity {
        param($app)
        [uint32]$officeId = 0
        $null = [ArchiveOfficeWindow]::GetWindowThreadProcessId([IntPtr]$app.Hwnd, [ref]$officeId)
        $process = Get-Process -Id $officeId -ErrorAction Stop
        if ($process.ProcessName -ne $processName) { throw 'OFFICE_INSTANCE_PROCESS_MISMATCH' }
        @{ Pid = $process.Id; StartUtc = $process.StartTime.ToUniversalTime() }
    }
    # Ownership has been established before settings or material access.
    @{ Pid = $identity.Pid; StartUtc = $identity.StartUtc.ToString('o'); Confirmed = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'owned-instance.json') -Encoding utf8
    $failurePhase = 'snapshot'
    $settings = Save-OwnedOfficeSettings -Application $application -Format $Format -Identity $identity -CurrentIdentity $currentIdentity
    $failurePhase = 'configure'
    $application.Visible = $false
    $application.DisplayAlerts = if ($Format -eq 'docx') { 0 } else { $false }
    $application.AutomationSecurity = 3
    if ($application.AutomationSecurity -ne 3) { throw 'OFFICE_MACRO_DISABLE_UNCONFIRMED' }
    $pdf = Join-Path $output 'representation.pdf'
    if ($Format -eq 'docx') {
        $application.Options.UpdateLinksAtOpen = $false
        $application.Options.UpdateLinksAtPrint = $false
        $application.Options.UpdateFieldsAtPrint = $false
        if ($application.Options.UpdateLinksAtOpen -or $application.Options.UpdateLinksAtPrint -or $application.Options.UpdateFieldsAtPrint) { throw 'OFFICE_LINK_DISABLE_UNCONFIRMED' }
        $failurePhase = 'open'
        $document = $application.Documents.Open($source, $false, $true, $false)
        $failurePhase = 'export'
        $document.ExportAsFixedFormat($pdf, 17)
    } else {
        $application.AskToUpdateLinks = $false
        $application.CalculateBeforeSave = $false
        $application.Calculation = -4135
        if ($application.AskToUpdateLinks -or $application.CalculateBeforeSave -or $application.Calculation -ne -4135) { throw 'OFFICE_NO_RECALC_UNCONFIRMED' }
        $failurePhase = 'open'
        $document = $application.Workbooks.Open($source, 0, $true)
        if ($application.Calculation -ne -4135) { throw 'OFFICE_NO_RECALC_UNCONFIRMED' }
        $failurePhase = 'export'
        $document.ExportAsFixedFormat(0, $pdf)
    }
    $failurePhase = 'verify'
    if ([datetime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { throw 'OFFICE_DEADLINE_EXPIRED' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $beforeHash) { throw 'OFFICE_TEMP_SOURCE_CHANGED' }
    $result = @{ status = 'converted'; source_sha256 = ('sha256:' + $beforeHash.ToLowerInvariant()); representation_sha256 = ('sha256:' + (Get-FileHash -LiteralPath $pdf -Algorithm SHA256).Hash.ToLowerInvariant()); output_path = $pdf; converter = @{ identity = $processName; version = [string]$application.Version; macros = 'disabled'; links = 'not_updated'; source_saved = $false; source_recalculated = $false }; fidelity = 'unverified'; original_workbook_obligations = 'held'; owned_pid = $identity.Pid; owned_start_utc = $identity.StartUtc.ToString('o') }
} catch {
    $conversionError = $_.Exception.Message
    $originalError = ConvertTo-OfficeErrorDiagnostic -Record $_ -Phase $failurePhase
    throw
} finally {
    $cleanupError = $null; $cleanupSecondaryError = $null; $releaseFailure = $null
    $restoration = 'unknown'; $closed = 'unconfirmed'
    try {
        if (!$settings) { throw 'OFFICE_SETTINGS_SNAPSHOT_UNCONFIRMED' }
        $closed = Close-OwnedOfficeSession -Application $application -Document $document -Identity $identity -CurrentIdentity $currentIdentity -CloseDocument { param($doc) $doc.Close($false) } -QuitApplication { param($app) $app.Quit() } -Snapshot $settings -Format $Format -VerifyDocumentClosed { param($app,$doc) $app.Workbooks.Count -eq 0 }
        if ($closed -ne 'owned_instance_closed') { throw ('OFFICE_CLEANUP_UNCONFIRMED:'+$closed) }
        $restoration = 'restored_verified'
    } catch {
        $cleanupError = ConvertTo-OfficeErrorDiagnostic -Record $_ -Phase 'cleanup'
        try {
            if ($identity) { $null=Stop-OwnedOfficeProcess -Identity @{Pid=$identity.Pid;StartUtc=$identity.StartUtc;Confirmed=$true} -CurrentIdentity $currentIdentity -StopProcess {param($id) Stop-Process -Id $id} }
        } catch { $cleanupSecondaryError = ConvertTo-OfficeErrorDiagnostic -Record $_ -Phase 'cleanup_reclaim'; throw }
        throw
    } finally {
        try {
            if ($document) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
            if ($application) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) }
        } catch {
            $releaseFailure = $_
            $releaseDiagnostic = ConvertTo-OfficeErrorDiagnostic -Record $_ -Phase 'cleanup_release'
            if (!$cleanupError) { $cleanupError=$releaseDiagnostic } else { $cleanupSecondaryError=$releaseDiagnostic }
        }
        if ($originalError -or $cleanupError) {
            $reason = if ($cleanupError) { $cleanupError.message } else { $conversionError }
            @{status='blocked';reason=$reason;original_error=$originalError;cleanup_error=$cleanupError;cleanup_secondary_error=$cleanupSecondaryError;settings_restoration=$restoration;cleanup=$(if($cleanupError){'unconfirmed'}else{$closed})} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'conversion.json') -Encoding utf8
        } elseif ($result) {
            $result.settings_restoration=$restoration; $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'conversion.json') -Encoding utf8
        }
        if ($releaseFailure) { throw $releaseFailure }
    }
}
