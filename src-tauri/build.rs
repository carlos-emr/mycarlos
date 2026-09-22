fn main() {
    if std::env::var("TARGET").is_ok_and(|target| target.contains("android")) {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("gen/android/app/src/main/AndroidManifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        let contents = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|_| panic!("Android manifest missing at {}", manifest.display()));
        // Android 12 and later ignore the first two for device-to-device
        // transfer, which only the data extraction rules exclude.
        assert!(
            contents.contains("android:allowBackup=\"false\"")
                && contents.contains("android:fullBackupContent=\"false\"")
                && contents.contains(
                    "android:dataExtractionRules=\"@xml/mycarlos_data_extraction_rules\""
                )
                && manifest
                    .with_file_name("res")
                    .join("xml/mycarlos_data_extraction_rules.xml")
                    .is_file(),
            "Android backup exclusions must be applied with `npm run android:secure` before every Android build"
        );
    }
    // Without an app manifest Tauri allows every app command from any window and
    // origin, and capabilities/default.json would only gate plugin commands.
    // Declaring the commands makes that capability file authoritative for them.
    // Keep this list in step with `generate_handler!` in src/lib.rs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "runtime_info",
            "vault_status",
            "vault_create",
            "vault_unlock",
            "vault_lock",
            "vault_snapshot",
            "vault_change_passphrase",
            "vault_create_profile",
            "vault_create_folder",
            "vault_update_folder",
            "vault_rename_record",
            "vault_assign_folders",
            "vault_assign_folders_batch",
            "vault_import_pick",
            "vault_import_picked",
            "vault_export_pick",
            "vault_export_picked",
            "vault_delete_record",
            "vault_reset",
        ]),
    ))
    .expect("failed to run tauri-build");
}
