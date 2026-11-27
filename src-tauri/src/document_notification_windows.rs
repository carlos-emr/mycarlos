//! Existing locked windows bindings; no plugin, click routing or push registration.
use crate::document_notification_runtime::{
    active::{may_show, permission_for, Backend, OsSetting},
    Error, Permission,
};
use windows::{
    core::HSTRING,
    Data::Xml::Dom::XmlDocument,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
};

pub struct WindowsBackend {
    app_id: String,
}

/// The catalogue sentence as XML character data: only the three markup characters change.
fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
impl WindowsBackend {
    pub fn new(app_id: String) -> Self {
        Self { app_id }
    }
}
/// A COM apartment this call may have entered. A thread that is already initialised in another mode
/// (`RPC_E_CHANGED_MODE`, for instance a UI thread) is usable as it is, and is not ours to undo.
struct Apartment {
    entered: bool,
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.entered {
            unsafe { RoUninitialize() };
        }
    }
}

/// `RPC_E_CHANGED_MODE`: the thread was initialised before, in another threading mode.
const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;

impl WindowsBackend {
    fn notifier(&self) -> Result<(Apartment, ToastNotifier), ()> {
        // This may be invoked from the native blocking pool or a plain thread. Success (including
        // S_FALSE, an earlier init in the same mode) is balanced on this same thread; a thread already
        // in another mode is used as it is and left alone.
        let apartment = match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Apartment { entered: true },
            Err(error) if error.code().0 == RPC_E_CHANGED_MODE => Apartment { entered: false },
            Err(_) => return Err(()),
        };
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
            self.app_id.as_str(),
        ))
        .map_err(|_| ())?;
        Ok((apartment, notifier))
    }

    /// What the system says about this app. An app with no setting yet (an unpackaged one that has
    /// never shown a notice) makes this call fail; that is `Failed`, not a refusal.
    fn setting(notifier: &ToastNotifier) -> OsSetting {
        match notifier.Setting() {
            Ok(NotificationSetting::Enabled) => OsSetting::Enabled,
            Ok(_) => OsSetting::Disabled,
            Err(_) => OsSetting::Failed,
        }
    }
}
impl Backend for WindowsBackend {
    fn permission(&self) -> Permission {
        match self.notifier() {
            Ok((_apartment, notifier)) => permission_for(Self::setting(&notifier)),
            Err(()) => Permission::Unknown,
        }
    }
    fn accept(&self, body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error> {
        let (_apartment, notifier) = self.notifier().map_err(|_| Error::OsRejected)?;
        // Only a definite "disabled" stops it. With no setting yet the first Show() is what makes
        // one, so a failed question is not a reason to skip it.
        if !may_show(Self::setting(&notifier)) {
            return Err(Error::OsRejected);
        }
        let xml = XmlDocument::new().map_err(|_| Error::OsRejected)?;
        // Fixed catalogue text in the language the app last reported (the runtime resolves it;
        // English when none was reported). No document/patient/clinic identifiers, no data
        // interpolation, command, URI, launch arguments, provider token or OS replacement guarantee.
        let source = format!(
            "<toast><visual><binding template=\"ToastGeneric\"><text>myCarlos</text><text>{}</text></binding></visual></toast>",
            xml_text(body)
        );
        xml.LoadXml(&HSTRING::from(source.as_str()))
            .map_err(|_| Error::OsRejected)?;
        let toast =
            ToastNotification::CreateToastNotification(&xml).map_err(|_| Error::OsRejected)?;
        if !still_current() {
            return Err(Error::Cancelled);
        }
        notifier.Show(&toast).map_err(|_| Error::OsRejected)
    }
}
