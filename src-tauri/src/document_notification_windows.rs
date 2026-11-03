//! Existing locked windows bindings; no plugin, click routing or push registration.
use crate::document_notification_runtime::{active::Backend, Error, Permission};
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
impl WindowsBackend {
    pub fn new(app_id: String) -> Self {
        Self { app_id }
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

impl WindowsBackend {
    fn notifier(&self) -> Result<(Apartment, ToastNotifier), ()> {
        // This is invoked from the native blocking pool. An incompatible apartment is Unknown,
        // not a fake permission grant. Each successful init is balanced on this same thread.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| ())?;
        let apartment = Apartment;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
            self.app_id.as_str(),
        ))
        .map_err(|_| ())?;
        Ok((apartment, notifier))
    }
}
impl Backend for WindowsBackend {
    fn permission(&self) -> Permission {
        match self
            .notifier()
            .and_then(|(_apartment, notifier)| notifier.Setting().map_err(|_| ()))
        {
            Ok(value) if value == NotificationSetting::Enabled => Permission::Allowed,
            Ok(_) => Permission::Blocked,
            Err(()) => Permission::Unknown,
        }
    }
    fn accept(&self, still_current: &dyn Fn() -> bool) -> Result<(), Error> {
        let (_apartment, notifier) = self.notifier().map_err(|_| Error::OsRejected)?;
        if notifier.Setting().map_err(|_| Error::OsRejected)? != NotificationSetting::Enabled {
            return Err(Error::OsRejected);
        }
        let xml = XmlDocument::new().map_err(|_| Error::OsRejected)?;
        // Entirely fixed local text. No document/patient/clinic identifiers, XML interpolation,
        // command, URI, launch arguments, provider token or OS replacement guarantee.
        xml.LoadXml(&HSTRING::from("<toast><visual><binding template=\"ToastGeneric\"><text>myCarlos</text><text>A clinic document has arrived in myCarlos. Open myCarlos to read it.</text></binding></visual></toast>")).map_err(|_| Error::OsRejected)?;
        let toast =
            ToastNotification::CreateToastNotification(&xml).map_err(|_| Error::OsRejected)?;
        if !still_current() {
            return Err(Error::Cancelled);
        }
        notifier.Show(&toast).map_err(|_| Error::OsRejected)
    }
}
