param([switch]$BuildInstaller)
$ErrorActionPreference = "Stop"
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    function Invoke-Checked {
        param([string]$Program, [string[]]$Arguments)
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
    }
    # Prerequisites: supported Windows Tauri toolchain and existing npm install.
    # Default builds stay OFF; selecting a feature is explicit in every step.
    Invoke-Checked -Program cargo -Arguments @("test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--lib", "--no-default-features", "vault::tests::portal_link_default_off_refuses_before_creating_files_or_keys", "--", "--exact", "--test-threads=1")
    foreach ($Filter in @("portal_link_", "portal_delivery::tests", "portal_approval::native::tests", "original_pdf", "should_retain_both_pdf_objects", "should_import_original_and_history_when_windows_staging_exceeds_max_path", "identity_survives_migration_of_all_older_formats_without_record_loss")) {
        Invoke-Checked -Program cargo -Arguments @("test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--lib", "--features", "portal-linking", $Filter, "--", "--test-threads=1")
    }
    Invoke-Checked -Program npm.cmd -Arguments @("run", "check")
    if ($BuildInstaller) { Invoke-Checked -Program npm.cmd -Arguments @("run", "tauri", "--", "build", "--features", "portal-linking") }
} finally { Pop-Location }
