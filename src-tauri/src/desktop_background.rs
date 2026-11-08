//! Desktop background mode: two separate choices, both off by default.
//!
//! - **Keep myCarlos running in the background.** Closing the window locks the vault and hides
//!   the window instead of exiting; a tray icon (menu: Open, Quit) stays. Quit really exits.
//! - **Start myCarlos at login.** A per-user login entry starts myCarlos with `--background`: it
//!   starts hidden in the tray when the first choice is on, and shows its window when it is off.
//!
//! The vault is locked whenever myCarlos is in the tray, so every check that needs the vault
//! (the automatic document checks and the Windows arrival notice) pauses until the patient opens
//! myCarlos and unlocks it. Nothing here reads a vault, a key or a credential. Checking while
//! locked needs a separately scoped, revocable notification credential from the Portal
//! (docs/notifications, step 4 of the background-notification plan); until that exists this mode
//! only keeps the process and its icon, and the Preferences screen says so.
//!
//! The decisions (what a close does, whether a start is hidden, what the login entry says, how a
//! choice is saved) are plain functions and a `Controller` over a `Backend`, so they are tested
//! without a window system. The Tauri tray and window code is `TauriBackend`.
use crate::ui_text::UiLocale;
use crate::ui_text_ids::MessageId;
use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

/// The argument the login entry passes so a start at login can be quiet.
pub(crate) const BACKGROUND_ARG: &str = "--background";
/// Whether closing the window to the tray locks the vault. True: the vault is locked as the window
/// closes, so nothing that needs it (the document checks, the arrival notice) runs from the tray.
/// False is the maintainer's option A: the vault is left as it was and the normal auto-lock timer
/// still applies, so checks and notices run in the tray until auto-lock, with the same exposure as
/// a minimized window. Not chosen yet; the decision is the maintainer's.
pub(crate) const LOCK_ON_CLOSE: bool = true;
// Changing the line above is a decision about what stays exposed in the tray, not a refactor:
// this fails the build until whoever changes it also changes this line and the PR says why.
const _: () = assert!(LOCK_ON_CLOSE);
/// The name of the login entry (a value name, a file stem, a label).
#[cfg_attr(not(windows), allow(dead_code))] // the Windows value name; the text is tested everywhere
const LOGIN_NAME: &str = "myCarlos";
const LOGIN_LABEL: &str = "ca.carlos.mycarlos";
const FILE_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 4096;

/// What the patient chose. Both off until they say otherwise.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Choices {
    pub keep_running: bool,
    pub start_at_login: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    /// This build or computer has no background mode (a phone, or no tray).
    Unsupported,
    /// The tray icon could not be made.
    Tray,
    /// The login entry could not be written or removed.
    LoginItem,
    /// The choice could not be saved.
    Storage,
}

impl Status {
    /// What a phone reports: no background mode at all (the phone build's command uses it).
    #[cfg_attr(desktop, allow(dead_code))]
    pub(crate) fn unsupported() -> Self {
        Self {
            supported: false,
            keep_running: false,
            start_at_login: false,
            tray_ready: false,
            paused_while_locked: false,
        }
    }
}

/// What the screen shows. `paused_while_locked` is true whenever the background mode is on:
/// checks that need the vault wait for the patient to unlock it.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub supported: bool,
    pub keep_running: bool,
    pub start_at_login: bool,
    /// The tray icon exists right now (the choice is on and the icon could be made).
    pub tray_ready: bool,
    pub paused_while_locked: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseAction {
    /// Close as before: the app exits.
    Exit,
    /// Lock the vault and hide the window; the tray icon keeps the app running.
    LockAndHide,
}

/// A close hides the window only when the patient chose to keep running and the icon is there to
/// get back in. With no icon, hiding would strand the app, so it exits as before.
pub(crate) fn close_action(choices: &Choices, tray_ready: bool) -> CloseAction {
    if choices.keep_running && tray_ready {
        CloseAction::LockAndHide
    } else {
        CloseAction::Exit
    }
}

/// A start is quiet only when it came from the login entry (`--background`), the patient chose to
/// keep running, and the icon is there. Otherwise the window opens as always.
pub(crate) fn starts_in_background<S: AsRef<OsStr>>(
    args: impl IntoIterator<Item = S>,
    choices: &Choices,
    tray_ready: bool,
) -> bool {
    choices.keep_running
        && tray_ready
        && args
            .into_iter()
            .any(|arg| arg.as_ref() == OsStr::new(BACKGROUND_ARG))
}

// --- Saving the choices -----------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedFile {
    version: u32,
    keep_running: bool,
    start_at_login: bool,
    /// The language the interface last reported, for the tray's words.
    #[serde(default)]
    locale: Option<UiLocale>,
}

struct Saved {
    choices: Choices,
    locale: Option<UiLocale>,
}

/// The choices on disk, beside the vault's other machine-local files. A missing, oversized,
/// unreadable or newer-than-known file means both off; it is only replaced by a deliberate
/// change, never by reading it.
pub(crate) struct Settings {
    path: PathBuf,
    saved: Mutex<Saved>,
}

impl Settings {
    pub(crate) fn load(path: PathBuf) -> Self {
        let saved = Self::read(&path).unwrap_or(Saved {
            choices: Choices::default(),
            locale: None,
        });
        Self {
            path,
            saved: Mutex::new(saved),
        }
    }

    fn read(path: &Path) -> Option<Saved> {
        let mut file = fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > MAX_FILE_BYTES {
            return None;
        }
        let mut text = String::new();
        Read::take(&mut file, MAX_FILE_BYTES)
            .read_to_string(&mut text)
            .ok()?;
        let saved: SavedFile = serde_json::from_str(&text).ok()?;
        (saved.version == FILE_VERSION).then_some(Saved {
            choices: Choices {
                keep_running: saved.keep_running,
                start_at_login: saved.start_at_login,
            },
            locale: saved.locale,
        })
    }

    pub(crate) fn choices(&self) -> Choices {
        self.saved
            .lock()
            .expect("background settings poisoned")
            .choices
    }

    pub(crate) fn locale(&self) -> Option<UiLocale> {
        self.saved
            .lock()
            .expect("background settings poisoned")
            .locale
    }

    /// Saves, then remembers. Nothing changes in memory if the file cannot be written.
    fn save(&self, choices: Choices, locale: Option<UiLocale>) -> Result<(), Error> {
        let mut saved = self.saved.lock().expect("background settings poisoned");
        let text = serde_json::to_vec(&SavedFile {
            version: FILE_VERSION,
            keep_running: choices.keep_running,
            start_at_login: choices.start_at_login,
            locale,
        })
        .map_err(|_| Error::Storage)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| Error::Storage)?;
        }
        AtomicFile::new(&self.path, AllowOverwrite)
            .write(|file| file.write_all(&text))
            .map_err(|_| Error::Storage)?;
        *saved = Saved { choices, locale };
        Ok(())
    }
}

// --- The login entry ----------------------------------------------------------------------

/// A path that could break out of a quoted login entry is refused, not escaped: the install
/// folder is never one of these. A Windows path keeps its backslashes.
fn login_path_ok(exe: &Path) -> bool {
    let Some(text) = exe.to_str() else {
        return false;
    };
    if text.is_empty() || text.chars().any(char::is_control) {
        return false;
    }
    if cfg!(windows) {
        !text.contains(['"', '%'])
    } else {
        !text.contains(['"', '\\', '`', '$', '%'])
    }
}

/// The `Run` value: the quoted program and the quiet-start argument.
#[cfg_attr(not(windows), allow(dead_code))] // written on Windows only; tested everywhere
pub(crate) fn windows_run_value(exe: &Path) -> String {
    format!("\"{}\" {BACKGROUND_ARG}", exe.display())
}

/// Arguments to reg.exe that set or remove the current user's `Run` value.
#[cfg_attr(not(windows), allow(dead_code))] // run on Windows only; tested everywhere
pub(crate) fn windows_reg_args(enabled: bool, exe: &Path) -> Vec<String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".to_owned();
    if enabled {
        vec![
            "add".into(),
            key,
            "/v".into(),
            LOGIN_NAME.into(),
            "/t".into(),
            "REG_SZ".into(),
            "/d".into(),
            windows_run_value(exe),
            "/f".into(),
        ]
    } else {
        vec![
            "delete".into(),
            key,
            "/v".into(),
            LOGIN_NAME.into(),
            "/f".into(),
        ]
    }
}

/// A macOS LaunchAgent that starts the program at login with the quiet argument.
pub(crate) fn mac_launch_agent(exe: &Path) -> String {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n\
\t<key>Label</key>\n\t<string>{LOGIN_LABEL}</string>\n\
\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{}</string>\n\t\t<string>{BACKGROUND_ARG}</string>\n\t</array>\n\
\t<key>RunAtLoad</key>\n\t<true/>\n\
</dict>\n</plist>\n",
        escape(&exe.to_string_lossy())
    )
}

/// A freedesktop autostart entry that starts the program at login with the quiet argument.
pub(crate) fn linux_desktop_entry(exe: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=myCarlos\nExec=\"{}\" {BACKGROUND_ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        exe.display()
    )
}

/// Where the login entry file lives on macOS and Linux, from the home folder and (on Linux) the
/// configuration folder. None where the entry is not a file (Windows).
pub(crate) fn login_file(mac: bool, home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    if mac {
        home.join("Library")
            .join("LaunchAgents")
            .join(format!("{LOGIN_LABEL}.plist"))
    } else {
        xdg_config_home
            .filter(|dir| dir.is_absolute())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config"))
            .join("autostart")
            .join(format!("{LOGIN_LABEL}.desktop"))
    }
}

/// Writes the entry (`Some`) or removes it (`None`). A missing file is already removed.
// The file removed here is the login entry myCarlos itself wrote (a LaunchAgent or an autostart
// entry), never anything a vault holds, so the vault's removal rule (#71, clippy.toml) is not
// the one that applies.
#[allow(clippy::disallowed_methods)]
pub(crate) fn apply_login_file(path: &Path, contents: Option<&str>) -> io::Result<()> {
    match contents {
        Some(text) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            AtomicFile::new(path, AllowOverwrite)
                .write(|file| file.write_all(text.as_bytes()))
                .map_err(|error| match error {
                    atomicwrites::Error::Internal(e) | atomicwrites::Error::User(e) => e,
                })
        }
        None => match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        },
    }
}

/// Sets or removes this computer's login entry for the running program.
pub(crate) fn set_login_item(enabled: bool, exe: &Path) -> Result<(), Error> {
    if enabled && !login_path_ok(exe) {
        return Err(Error::LoginItem);
    }
    #[cfg(windows)]
    {
        let system = std::env::var_os("SystemRoot").ok_or(Error::LoginItem)?;
        let reg = Path::new(&system).join("System32").join("reg.exe");
        let status = std::process::Command::new(reg)
            .args(windows_reg_args(enabled, exe))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| Error::LoginItem)?;
        // Deleting a value that is not there fails with 1; the entry is gone either way.
        if status.success() || !enabled {
            Ok(())
        } else {
            Err(Error::LoginItem)
        }
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or(Error::LoginItem)?;
        if !home.is_absolute() {
            return Err(Error::LoginItem);
        }
        let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
        let mac = cfg!(target_os = "macos");
        let path = login_file(mac, &home, xdg.as_deref());
        let contents = enabled.then(|| {
            if mac {
                mac_launch_agent(exe)
            } else {
                linux_desktop_entry(exe)
            }
        });
        apply_login_file(&path, contents.as_deref()).map_err(|_| Error::LoginItem)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = exe;
        Err(Error::Unsupported)
    }
}

// --- The controller ------------------------------------------------------------------------

/// What the controller needs from the window system and the operating system.
pub(crate) trait Backend: Send + Sync {
    /// Whether this computer can have a background mode at all.
    fn supported(&self) -> bool;
    /// Makes the tray icon (or keeps it), worded in `locale`.
    fn show_tray(&self, locale: Option<UiLocale>) -> Result<(), Error>;
    fn hide_tray(&self);
    /// Rewords the icon's menu and tooltip.
    fn reword_tray(&self, locale: Option<UiLocale>);
    fn set_login_item(&self, enabled: bool) -> Result<(), Error>;
}

pub(crate) struct Controller<B: Backend> {
    settings: Settings,
    backend: B,
    tray_ready: AtomicBool,
}

impl<B: Backend> Controller<B> {
    pub(crate) fn new(settings: Settings, backend: B) -> Self {
        Self {
            settings,
            backend,
            tray_ready: AtomicBool::new(false),
        }
    }

    /// At launch: bring the icon back if the patient chose to keep running. Returns whether this
    /// start should be quiet.
    pub(crate) fn start<S: AsRef<OsStr>>(&self, args: impl IntoIterator<Item = S>) -> bool {
        let choices = self.settings.choices();
        if choices.keep_running && self.backend.supported() {
            let ready = self.backend.show_tray(self.settings.locale()).is_ok();
            self.tray_ready.store(ready, Ordering::SeqCst);
        }
        starts_in_background(args, &choices, self.tray_ready.load(Ordering::SeqCst))
    }

    pub(crate) fn status(&self) -> Status {
        let choices = self.settings.choices();
        let supported = self.backend.supported();
        Status {
            supported,
            keep_running: choices.keep_running,
            start_at_login: choices.start_at_login,
            tray_ready: self.tray_ready.load(Ordering::SeqCst),
            paused_while_locked: supported && choices.keep_running,
        }
    }

    /// The interface's language, for the icon's words. Saved so the next start words it right.
    pub(crate) fn report_locale(&self, locale: UiLocale) {
        if self.settings.locale() == Some(locale) {
            return;
        }
        // A language that cannot be saved is still used now.
        let _ = self.settings.save(self.settings.choices(), Some(locale));
        if self.tray_ready.load(Ordering::SeqCst) {
            self.backend.reword_tray(Some(locale));
        }
    }

    /// Turning it on makes the icon first: with no icon, closing the window would strand the
    /// app, so nothing is saved and the choice stays off.
    pub(crate) fn set_keep_running(&self, on: bool) -> Result<Status, Error> {
        if !self.backend.supported() {
            return Err(Error::Unsupported);
        }
        let choices = self.settings.choices();
        if choices.keep_running == on {
            return Ok(self.status());
        }
        if on {
            self.backend.show_tray(self.settings.locale())?;
            if let Err(error) = self.settings.save(
                Choices {
                    keep_running: true,
                    ..choices
                },
                self.settings.locale(),
            ) {
                self.backend.hide_tray();
                return Err(error);
            }
            self.tray_ready.store(true, Ordering::SeqCst);
        } else {
            self.settings.save(
                Choices {
                    keep_running: false,
                    ..choices
                },
                self.settings.locale(),
            )?;
            self.tray_ready.store(false, Ordering::SeqCst);
            self.backend.hide_tray();
        }
        Ok(self.status())
    }

    /// The login entry is written before the choice is saved, so a failure leaves both as they were.
    pub(crate) fn set_start_at_login(&self, on: bool) -> Result<Status, Error> {
        if !self.backend.supported() {
            return Err(Error::Unsupported);
        }
        let choices = self.settings.choices();
        if choices.start_at_login == on {
            return Ok(self.status());
        }
        self.backend.set_login_item(on)?;
        if let Err(error) = self.settings.save(
            Choices {
                start_at_login: on,
                ..choices
            },
            self.settings.locale(),
        ) {
            // Put the entry back as the saved choice has it.
            let _ = self.backend.set_login_item(!on);
            return Err(error);
        }
        Ok(self.status())
    }

    pub(crate) fn on_close(&self) -> CloseAction {
        close_action(
            &self.settings.choices(),
            self.tray_ready.load(Ordering::SeqCst),
        )
    }
}

/// The words on the icon's menu and tooltip, in `locale` or English.
pub(crate) fn tray_text(locale: Option<UiLocale>, id: MessageId) -> String {
    locale
        .unwrap_or_default()
        .text(id)
        .ok()
        .or_else(|| UiLocale::default().text(id).ok())
        .unwrap_or_else(|| "myCarlos".to_owned())
}

// --- Tauri: the tray icon and the window ---------------------------------------------------

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) mod desktop {
    use super::*;
    use std::sync::Arc;
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
        AppHandle, Manager, Window, WindowEvent,
    };

    const TRAY_ID: &str = "myCarlos";
    const MAIN_WINDOW: &str = "main";

    struct Parts {
        tray: TrayIcon,
        open: MenuItem<tauri::Wry>,
        quit: MenuItem<tauri::Wry>,
    }

    /// Locks the vault and everything that holds its contents; given by `lib.rs`, which owns them.
    pub(crate) type LockAll = Arc<dyn Fn() + Send + Sync>;

    pub(crate) struct TauriBackend {
        app: AppHandle,
        parts: Mutex<Option<Parts>>,
        lock_all: LockAll,
    }

    pub(crate) type Background = Controller<TauriBackend>;

    /// Brings the window back. The vault stays locked: it was locked as the window closed.
    fn show_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    impl TauriBackend {
        fn words(&self, locale: Option<UiLocale>) -> (String, String, String) {
            (
                tray_text(locale, MessageId::NativeTrayOpen),
                tray_text(locale, MessageId::NativeTrayQuit),
                tray_text(locale, MessageId::NativeTrayTooltip),
            )
        }
    }

    impl Backend for TauriBackend {
        fn supported(&self) -> bool {
            true
        }

        fn show_tray(&self, locale: Option<UiLocale>) -> Result<(), Error> {
            let mut parts = self.parts.lock().expect("tray parts poisoned");
            if parts.is_some() {
                return Ok(());
            }
            let (open_text, quit_text, tooltip) = self.words(locale);
            let open = MenuItem::with_id(&self.app, "open", open_text, true, None::<&str>)
                .map_err(|_| Error::Tray)?;
            let quit = MenuItem::with_id(&self.app, "quit", quit_text, true, None::<&str>)
                .map_err(|_| Error::Tray)?;
            let menu = Menu::with_items(&self.app, &[&open, &quit]).map_err(|_| Error::Tray)?;
            let icon = self.app.default_window_icon().cloned().ok_or(Error::Tray)?;
            let lock_all = Arc::clone(&self.lock_all);
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .tooltip(tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    // Quit really exits: lock first, so nothing stays open in memory.
                    "quit" => {
                        lock_all();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(&self.app)
                .map_err(|_| Error::Tray)?;
            *parts = Some(Parts { tray, open, quit });
            Ok(())
        }

        fn hide_tray(&self) {
            let mut parts = self.parts.lock().expect("tray parts poisoned");
            if parts.take().is_some() {
                let _ = self.app.remove_tray_by_id(TRAY_ID);
            }
        }

        fn reword_tray(&self, locale: Option<UiLocale>) {
            let (open_text, quit_text, tooltip) = self.words(locale);
            if let Some(parts) = self.parts.lock().expect("tray parts poisoned").as_ref() {
                let _ = parts.open.set_text(open_text);
                let _ = parts.quit.set_text(quit_text);
                let _ = parts.tray.set_tooltip(Some(tooltip));
            }
        }

        fn set_login_item(&self, enabled: bool) -> Result<(), Error> {
            let exe = std::env::current_exe().map_err(|_| Error::LoginItem)?;
            set_login_item(enabled, &exe)
        }
    }

    /// Makes the controller, brings the icon back if it was chosen, and hides the window of a
    /// quiet start. Called once from the builder's setup, after the window exists.
    pub(crate) fn install(
        app: &tauri::App,
        settings_path: PathBuf,
        lock_all: LockAll,
    ) -> Arc<Background> {
        let controller = Arc::new(Controller::new(
            Settings::load(settings_path),
            TauriBackend {
                app: app.handle().clone(),
                parts: Mutex::new(None),
                lock_all,
            },
        ));
        if controller.start(std::env::args_os()) {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.hide();
            }
        }
        app.manage(Arc::clone(&controller));
        controller
    }

    /// The window's close: hide to the tray after locking, or exit as before.
    pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let Some(background) = window.try_state::<Arc<Background>>() else {
            return;
        };
        if background.on_close() == CloseAction::LockAndHide {
            api.prevent_close();
            if LOCK_ON_CLOSE {
                (background.backend.lock_all)();
            }
            let _ = window.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Fake {
        supported: bool,
        tray_fails: bool,
        login_fails: bool,
        tray_up: AtomicBool,
        shown: AtomicUsize,
        hidden: AtomicUsize,
        reworded: Mutex<Vec<Option<UiLocale>>>,
        login: Mutex<Vec<bool>>,
    }
    impl Fake {
        fn desktop() -> Self {
            Self {
                supported: true,
                ..Self::default()
            }
        }
    }
    impl Backend for &Fake {
        fn supported(&self) -> bool {
            self.supported
        }
        fn show_tray(&self, _locale: Option<UiLocale>) -> Result<(), Error> {
            if self.tray_fails {
                return Err(Error::Tray);
            }
            self.shown.fetch_add(1, Ordering::SeqCst);
            self.tray_up.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn hide_tray(&self) {
            self.hidden.fetch_add(1, Ordering::SeqCst);
            self.tray_up.store(false, Ordering::SeqCst);
        }
        fn reword_tray(&self, locale: Option<UiLocale>) {
            self.reworded.lock().unwrap().push(locale);
        }
        fn set_login_item(&self, enabled: bool) -> Result<(), Error> {
            if self.login_fails {
                return Err(Error::LoginItem);
            }
            self.login.lock().unwrap().push(enabled);
            Ok(())
        }
    }
    fn controller<'a>(dir: &Path, fake: &'a Fake) -> Controller<&'a Fake> {
        Controller::new(Settings::load(dir.join("background-v1.json")), fake)
    }

    #[test]
    fn both_choices_are_off_by_default_and_closing_exits() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::desktop();
        let c = controller(dir.path(), &fake);
        assert_eq!(
            c.status(),
            Status {
                supported: true,
                keep_running: false,
                start_at_login: false,
                tray_ready: false,
                paused_while_locked: false,
            }
        );
        assert_eq!(c.on_close(), CloseAction::Exit);
        assert!(!c.start(["myCarlos", BACKGROUND_ARG]));
        assert_eq!(fake.shown.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn keeping_it_running_makes_the_icon_saves_the_choice_and_hides_on_close() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::desktop();
        let c = controller(dir.path(), &fake);
        let status = c.set_keep_running(true).unwrap();
        assert!(status.keep_running && status.tray_ready && status.paused_while_locked);
        assert_eq!(c.on_close(), CloseAction::LockAndHide);
        // And it survives a restart: the icon comes back, and a quiet start is quiet.
        let fake2 = Fake::desktop();
        let again = controller(dir.path(), &fake2);
        assert!(again.start(["myCarlos", BACKGROUND_ARG]));
        assert_eq!(fake2.shown.load(Ordering::SeqCst), 1);
        assert_eq!(again.on_close(), CloseAction::LockAndHide);
        // A start without the argument opens the window even so.
        let fake3 = Fake::desktop();
        assert!(!controller(dir.path(), &fake3).start(["myCarlos"]));
    }

    #[test]
    fn without_an_icon_the_choice_is_not_saved_and_closing_still_exits() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake {
            tray_fails: true,
            ..Fake::desktop()
        };
        let c = controller(dir.path(), &fake);
        assert_eq!(c.set_keep_running(true), Err(Error::Tray));
        assert!(!c.status().keep_running);
        assert_eq!(c.on_close(), CloseAction::Exit);
        assert!(!dir.path().join("background-v1.json").exists());
        // A saved "on" with an icon that can no longer be made does not strand the app.
        fs::write(
            dir.path().join("background-v1.json"),
            r#"{"version":1,"keepRunning":true,"startAtLogin":false}"#,
        )
        .unwrap();
        let again = controller(dir.path(), &fake);
        assert!(!again.start([BACKGROUND_ARG]));
        assert_eq!(again.on_close(), CloseAction::Exit);
    }

    #[test]
    fn turning_it_off_removes_the_icon_and_closing_exits_again() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::desktop();
        let c = controller(dir.path(), &fake);
        c.set_keep_running(true).unwrap();
        let status = c.set_keep_running(false).unwrap();
        assert!(!status.keep_running && !status.tray_ready && !status.paused_while_locked);
        assert_eq!(fake.hidden.load(Ordering::SeqCst), 1);
        assert_eq!(c.on_close(), CloseAction::Exit);
        // Setting what is already set does nothing.
        c.set_keep_running(false).unwrap();
        assert_eq!(fake.hidden.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn start_at_login_is_separate_and_a_failure_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::desktop();
        let c = controller(dir.path(), &fake);
        let status = c.set_start_at_login(true).unwrap();
        assert!(status.start_at_login && !status.keep_running);
        assert_eq!(*fake.login.lock().unwrap(), vec![true]);
        assert_eq!(fake.shown.load(Ordering::SeqCst), 0);
        let broken = Fake {
            login_fails: true,
            ..Fake::desktop()
        };
        let other = tempfile::tempdir().unwrap();
        let c2 = controller(other.path(), &broken);
        assert_eq!(c2.set_start_at_login(true), Err(Error::LoginItem));
        assert!(!c2.status().start_at_login);
        assert!(!other.path().join("background-v1.json").exists());
    }

    #[test]
    fn a_choice_that_cannot_be_saved_is_undone() {
        let dir = tempfile::tempdir().unwrap();
        // The settings path is a directory, so the file cannot be written.
        let path = dir.path().join("background-v1.json");
        fs::create_dir(&path).unwrap();
        let fake = Fake::desktop();
        let c = Controller::new(Settings::load(path), &fake);
        assert_eq!(c.set_keep_running(true), Err(Error::Storage));
        assert_eq!(
            fake.hidden.load(Ordering::SeqCst),
            1,
            "the icon is taken back"
        );
        assert!(!c.status().keep_running && !c.status().tray_ready);
        assert_eq!(c.set_start_at_login(true), Err(Error::Storage));
        assert_eq!(
            *fake.login.lock().unwrap(),
            vec![true, false],
            "the entry is put back"
        );
    }

    #[test]
    fn a_phone_or_a_computer_with_no_background_mode_refuses_both_choices() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::default();
        let c = controller(dir.path(), &fake);
        assert_eq!(c.set_keep_running(true), Err(Error::Unsupported));
        assert_eq!(c.set_start_at_login(true), Err(Error::Unsupported));
        assert!(!c.status().supported && !c.status().paused_while_locked);
        assert_eq!(c.on_close(), CloseAction::Exit);
    }

    #[test]
    fn the_language_is_saved_and_rewords_the_icon_only_when_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::desktop();
        let c = controller(dir.path(), &fake);
        c.report_locale(UiLocale::Fr);
        assert!(fake.reworded.lock().unwrap().is_empty(), "no icon yet");
        c.set_keep_running(true).unwrap();
        c.report_locale(UiLocale::Fr);
        assert!(fake.reworded.lock().unwrap().is_empty(), "unchanged");
        c.report_locale(UiLocale::PtBr);
        assert_eq!(*fake.reworded.lock().unwrap(), vec![Some(UiLocale::PtBr)]);
        assert_eq!(
            Settings::load(dir.path().join("background-v1.json")).locale(),
            Some(UiLocale::PtBr)
        );
        assert!(
            Settings::load(dir.path().join("background-v1.json"))
                .choices()
                .keep_running
        );
    }

    #[test]
    fn a_damaged_oversized_or_newer_file_means_both_off_and_is_not_rewritten_by_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("background-v1.json");
        for text in [
            "not json".to_owned(),
            r#"{"version":2,"keepRunning":true,"startAtLogin":true}"#.to_owned(),
            r#"{"version":1,"keepRunning":"yes","startAtLogin":true}"#.to_owned(),
            format!(
                r#"{{"version":1,"keepRunning":true,"startAtLogin":true,"locale":"{}"}}"#,
                "x".repeat(5000)
            ),
        ] {
            fs::write(&path, &text).unwrap();
            let settings = Settings::load(path.clone());
            assert_eq!(settings.choices(), Choices::default(), "{text:.60}");
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn a_quiet_start_needs_the_argument_the_choice_and_the_icon() {
        let on = Choices {
            keep_running: true,
            start_at_login: true,
        };
        assert!(starts_in_background(["app", BACKGROUND_ARG], &on, true));
        assert!(!starts_in_background(["app"], &on, true));
        assert!(!starts_in_background(["app", BACKGROUND_ARG], &on, false));
        assert!(!starts_in_background(
            ["app", BACKGROUND_ARG],
            &Choices {
                keep_running: false,
                start_at_login: true
            },
            true
        ));
        assert!(!starts_in_background(["app", "--background-x"], &on, true));
        assert_eq!(close_action(&on, false), CloseAction::Exit);
    }

    #[test]
    fn the_quiet_argument_is_not_taken_for_a_file_to_open() {
        let (offered, kept) = crate::received::accept_command_line(
            ["myCarlos", BACKGROUND_ARG].map(std::ffi::OsString::from),
        );
        assert_eq!(offered, 0);
        assert!(kept.is_empty());
    }

    #[test]
    fn the_login_entries_start_the_program_with_the_quiet_argument() {
        let exe = Path::new("/opt/myCarlos/my carlos");
        let desktop = linux_desktop_entry(exe);
        assert!(desktop.contains("Exec=\"/opt/myCarlos/my carlos\" --background\n"));
        assert!(desktop.contains("X-GNOME-Autostart-enabled=true"));
        let plist = mac_launch_agent(Path::new(
            "/Applications/my&Carlos <1>.app/Contents/MacOS/m",
        ));
        assert!(plist.contains(
            "<string>/Applications/my&amp;Carlos &lt;1&gt;.app/Contents/MacOS/m</string>"
        ));
        assert!(plist.contains("<string>--background</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(plist.contains("<string>ca.carlos.mycarlos</string>"));
        assert_eq!(
            windows_run_value(Path::new(r"C:\Program Files\myCarlos\myCarlos.exe")),
            r#""C:\Program Files\myCarlos\myCarlos.exe" --background"#
        );
        let add = windows_reg_args(true, Path::new(r"C:\a\b.exe"));
        assert_eq!(
            add[..3],
            [
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v"
            ]
        );
        assert_eq!(add[3], "myCarlos");
        assert_eq!(add[7], r#""C:\a\b.exe" --background"#);
        assert_eq!(
            windows_reg_args(false, Path::new(r"C:\a\b.exe")),
            [
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "myCarlos",
                "/f"
            ]
        );
    }

    #[test]
    fn login_files_go_where_each_system_looks_and_are_written_and_removed() {
        let home = Path::new("/home/fake");
        assert_eq!(
            login_file(true, home, None),
            Path::new("/home/fake/Library/LaunchAgents/ca.carlos.mycarlos.plist")
        );
        assert_eq!(
            login_file(false, home, None),
            Path::new("/home/fake/.config/autostart/ca.carlos.mycarlos.desktop")
        );
        assert_eq!(
            login_file(false, home, Some(Path::new("/x/conf"))),
            Path::new("/x/conf/autostart/ca.carlos.mycarlos.desktop")
        );
        // A relative XDG_CONFIG_HOME is ignored, as the specification says.
        assert_eq!(
            login_file(false, home, Some(Path::new("rel"))),
            Path::new("/home/fake/.config/autostart/ca.carlos.mycarlos.desktop")
        );
        let dir = tempfile::tempdir().unwrap();
        let file = login_file(false, dir.path(), None);
        apply_login_file(&file, Some("entry")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "entry");
        apply_login_file(&file, Some("entry two")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "entry two");
        apply_login_file(&file, None).unwrap();
        assert!(!file.exists());
        apply_login_file(&file, None).unwrap();
    }

    #[test]
    fn a_program_path_that_could_break_out_of_a_quoted_entry_is_refused() {
        for bad in [
            "/opt/a\"b",
            "/opt/a$b",
            "/opt/a`b",
            "/opt/a%b",
            "/opt/a\nb",
            "",
        ] {
            assert!(!login_path_ok(Path::new(bad)), "{bad:?}");
        }
        assert!(login_path_ok(Path::new("/opt/myCarlos/my carlos")));
        assert!(set_login_item(true, Path::new("/opt/a\"b")).is_err());
    }

    #[test]
    fn the_icon_words_exist_in_all_seven_languages_and_name_the_vault_state() {
        for locale in UiLocale::ALL {
            for id in [
                MessageId::NativeTrayOpen,
                MessageId::NativeTrayQuit,
                MessageId::NativeTrayTooltip,
            ] {
                let text = tray_text(Some(locale), id);
                assert!(
                    !text.trim().is_empty() && text.contains("myCarlos"),
                    "{locale:?} {id:?}"
                );
            }
        }
        assert_eq!(tray_text(None, MessageId::NativeTrayQuit), "Quit myCarlos");
        assert_eq!(
            tray_text(Some(UiLocale::Fr), MessageId::NativeTrayOpen),
            "Ouvrir myCarlos"
        );
    }
}
