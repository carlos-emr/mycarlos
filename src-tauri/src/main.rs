// Evaluation installers use debug builds, but should still launch as a GUI app.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Before anything else: no other process of the user, such as a PDF helper, can read this
    // one's memory.
    mycarlos_tauri_poc_lib::protect_process_memory();
    // Started again by myCarlos itself to open one password-protected PDF, away from the vault
    // keys: no window, no vault, one request on stdin, then exit.
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(mycarlos_tauri_poc_lib::PDF_HELPER_ARG))
    {
        std::process::exit(mycarlos_tauri_poc_lib::pdf_helper_main());
    }
    // Started again by myCarlos itself to run the AI helper's model, away from the vault: no
    // window, no vault, one request at a time on stdin until myCarlos stops it.
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(
            mycarlos_tauri_poc_lib::MODEL_HELPER_ARG,
        ))
    {
        std::process::exit(mycarlos_tauri_poc_lib::model_helper_main());
    }
    mycarlos_tauri_poc_lib::run();
}
