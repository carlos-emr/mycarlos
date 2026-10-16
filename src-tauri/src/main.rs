// Evaluation installers use debug builds, but should still launch as a GUI app.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Started again by myCarlos itself to open one password-protected PDF, away from the vault
    // keys: no window, no vault, one request on stdin, then exit.
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(mycarlos_tauri_poc_lib::PDF_HELPER_ARG))
    {
        std::process::exit(mycarlos_tauri_poc_lib::pdf_helper_main());
    }
    mycarlos_tauri_poc_lib::run();
}
