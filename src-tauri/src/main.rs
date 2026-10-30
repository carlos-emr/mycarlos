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
    // The Windows handoff transports strict Unicode. Refuse unsupported argv before
    // either GUI intake path; a helper invocation above still uses only its protocol.
    #[cfg(windows)]
    if std::env::args_os().any(|arg| arg.to_str().is_none()) {
        eprintln!("myCarlos could not open the supplied arguments");
        std::process::exit(2);
    }
    mycarlos_tauri_poc_lib::run();
}
