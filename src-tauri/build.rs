// Every storage domain, excluded from both cloud backup and device-to-device
// transfer. Keep in step with DOMAINS in scripts/configure-android-security.mjs.
const EXCLUDED_DOMAINS: &[&str] = &[
    "root",
    "file",
    "database",
    "sharedpref",
    "external",
    "device_root",
    "device_file",
    "device_database",
    "device_sharedpref",
];

/// Whether the data extraction rules exclude every domain from both sections
/// and include nothing back.
fn extraction_rules_exclude_everything(rules: &str) -> bool {
    !rules.contains("<include")
        && ["cloud-backup", "device-transfer"].iter().all(|section| {
            let open = format!("<{section}>");
            let close = format!("</{section}>");
            rules.matches(&open).count() == 1
                && rules
                    .split_once(&open)
                    .and_then(|(_, rest)| rest.split_once(&close))
                    .is_some_and(|(body, _)| {
                        EXCLUDED_DOMAINS.iter().all(|domain| {
                            body.contains(&format!("<exclude domain=\"{domain}\" path=\".\" />"))
                        })
                    })
        })
}

fn main() {
    if std::env::var("TARGET").is_ok_and(|target| target.contains("android")) {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("gen/android/app/src/main/AndroidManifest.xml");
        let rules = manifest
            .with_file_name("res")
            .join("xml/mycarlos_data_extraction_rules.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rerun-if-changed={}", rules.display());
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
                && std::fs::read_to_string(&rules)
                    .is_ok_and(|rules| extraction_rules_exclude_everything(&rules)),
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
            "vault_remove_unavailable_records",
            "vault_reset",
        ]),
    ))
    .expect("failed to run tauri-build");
}
