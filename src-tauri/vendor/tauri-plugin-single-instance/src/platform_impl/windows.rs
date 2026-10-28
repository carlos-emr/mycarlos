// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#[cfg(feature = "semver")]
use crate::semver_compat::semver_compat_string;

use crate::SingleInstanceCallback;
use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    plugin::{self, TauriPlugin},
    AppHandle, Manager, RunEvent, Runtime,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM,
        LRESULT, WPARAM,
    },
    Security::{
        GetLengthSid, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
        TokenIntegrityLevel, TokenUser, PSID, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL,
        TOKEN_QUERY, TOKEN_USER,
    },
    System::{
        DataExchange::COPYDATASTRUCT,
        LibraryLoader::GetModuleHandleW,
        Threading::{
            CreateMutexW, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
            QueryFullProcessImageNameW, ReleaseMutex, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
    UI::WindowsAndMessaging::{
        self as w32wm, CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowExW,
        GetWindowThreadProcessId, IsWindow, MessageBoxW, RegisterClassExW, SendMessageTimeoutW,
        CREATESTRUCTW, GWLP_USERDATA, GWL_STYLE, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND,
        SMTO_ABORTIFHUNG, SMTO_BLOCK, WINDOW_LONG_PTR_INDEX, WM_COPYDATA, WM_CREATE, WM_DESTROY,
        WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        WS_OVERLAPPED, WS_POPUP, WS_VISIBLE,
    },
};

#[path = "windows_lifecycle.rs"]
mod lifecycle;
#[path = "windows_owner.rs"]
mod owner;
#[path = "windows_wire.rs"]
mod wire;

const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
struct MutexHandle(Mutex<Option<isize>>);
struct TargetWindowHandle<R: Runtime> {
    lifecycle: Mutex<lifecycle::Target>,
    userdata: Mutex<Option<Box<UserData<R>>>>,
}

// Only a newly created mutex is wrapped: a secondary instance never owns it.
impl MutexHandle {
    fn close(&self) {
        let handle = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(handle) = handle {
            unsafe {
                ReleaseMutex(handle as _);
                CloseHandle(handle as _);
            }
        }
    }
}

impl Drop for MutexHandle {
    fn drop(&mut self) {
        self.close();
    }
}

struct UserData<R: Runtime> {
    app: AppHandle<R>,
    callback: Arc<Mutex<Box<SingleInstanceCallback<R>>>>,
}

impl<R: Runtime> UserData<R> {
    unsafe fn from_hwnd_raw(hwnd: HWND) -> *mut Self {
        GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Self
    }
}

/// The title and text shown when a second launch cannot hand its arguments
/// to the running app. Fixed text: never a path or file name.
pub type HandoffFailedMessage = (String, String);

pub fn init<R: Runtime>(
    callback: Box<SingleInstanceCallback<R>>,
    handoff_failed: Option<HandoffFailedMessage>,
) -> TauriPlugin<R> {
    plugin::Builder::new("single-instance")
        .setup(move |app, _api| {
            #[allow(unused_mut)]
            let mut id = app.config().identifier.clone();
            #[cfg(feature = "semver")]
            {
                id.push('_');
                id.push_str(semver_compat_string(&app.package_info().version).as_str());
            }
            let class_name = encode_wide(format!("{id}-sic"));
            let window_name = encode_wide(format!("{id}-siw"));
            let mutex_name = encode_wide(format!("{id}-sim"));
            let hmutex =
                unsafe { CreateMutexW(std::ptr::null(), true.into(), mutex_name.as_ptr()) };
            let error = unsafe { GetLastError() };
            if hmutex.is_null() {
                return Err(io::Error::other("single-instance reservation failed").into());
            }
            if error == ERROR_ALREADY_EXISTS {
                // Never fall through to GUI setup, even before the first IPC window exists.
                unsafe { CloseHandle(hmutex) };
                let result = forward(&class_name, &window_name);
                if result.is_err() {
                    eprintln!("single-instance handoff failed");
                    // Not silent: the patient's file did not reach the app.
                    if let Some((title, text)) = &handoff_failed {
                        let (title, text) = (encode_wide(title), encode_wide(text));
                        unsafe {
                            MessageBoxW(
                                std::ptr::null_mut(),
                                text.as_ptr(),
                                title.as_ptr(),
                                MB_OK | MB_ICONWARNING | MB_SETFOREGROUND,
                            )
                        };
                    }
                }
                app.cleanup_before_exit();
                std::process::exit(if result.is_ok() { 0 } else { 2 });
            }
            let mutex = MutexHandle(Mutex::new(Some(hmutex as _)));
            let userdata = Box::new(UserData {
                app: app.clone(),
                callback: Arc::new(Mutex::new(callback)),
            });
            // Native creation borrows the allocation; Rust owns it on every error path.
            // Move the same Box into managed state only after creation succeeds.
            let (hwnd, userdata) = lifecycle::create_with_userdata(userdata, |data| {
                create_event_target_window::<R>(&class_name, &window_name, data as *mut _)
            })?;
            app.manage(mutex);
            app.manage(TargetWindowHandle {
                lifecycle: Mutex::new(lifecycle::Target::new(hwnd as _, unsafe {
                    GetCurrentThreadId()
                })),
                userdata: Mutex::new(Some(userdata)),
            });
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                destroy(app);
            }
        })
        .build()
}

fn forward(class_name: &[u16], window_name: &[u16]) -> io::Result<()> {
    let invalid = || io::Error::other("single-instance handoff failed");
    // The running app does not use the working directory, so none is sent.
    let bytes = wire::encode(std::ffi::OsStr::new(""), std::env::args_os()).ok_or_else(invalid)?;
    let ours = unsafe { process_identity(GetCurrentProcess()) }.ok_or_else(invalid)?;
    let started = Instant::now();
    let hwnd = loop {
        if let Some(hwnd) = own_window(class_name, window_name, &ours) {
            break hwnd;
        }
        if started.elapsed() >= FORWARD_TIMEOUT {
            return Err(invalid());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let remaining = FORWARD_TIMEOUT
        .checked_sub(started.elapsed())
        .ok_or_else(invalid)?;
    let timeout = remaining.as_millis().min(u32::MAX as u128) as u32;
    if timeout == 0 {
        return Err(invalid());
    }
    let cds = COPYDATASTRUCT {
        dwData: wire::MESSAGE,
        cbData: bytes.len() as u32,
        lpData: bytes.as_ptr() as _,
    };
    let mut acknowledgement = 0;
    let sent = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_COPYDATA,
            0,
            &cds as *const _ as _,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            timeout,
            &mut acknowledgement,
        )
    };
    // A timeout can mean the callback ran but its ack was lost. Never report success,
    // start a second GUI, or retry automatically in that case.
    if !wire::acknowledged(sent != 0, acknowledgement) {
        return Err(invalid());
    }
    Ok(())
}

/// The first window with this class and title that this user's own copy of
/// this executable owns, at no lower integrity level. Files go only there.
fn own_window(class_name: &[u16], window_name: &[u16], ours: &owner::Process) -> Option<HWND> {
    let mut after = std::ptr::null_mut();
    loop {
        let hwnd = unsafe {
            FindWindowExW(
                std::ptr::null_mut(),
                after,
                class_name.as_ptr(),
                window_name.as_ptr(),
            )
        };
        if hwnd.is_null() {
            return None;
        }
        if window_owner(hwnd).is_some_and(|owner| owner::may_receive(ours, &owner)) {
            return Some(hwnd);
        }
        after = hwnd;
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn window_owner(hwnd: HWND) -> Option<owner::Process> {
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
    if process_id == 0 {
        return None;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return None;
    }
    let process = OwnedHandle(process);
    unsafe { process_identity(process.0) }
}

/// The executable path, user and integrity level of a process that this
/// process may query. `None` if any of them cannot be read.
unsafe fn process_identity(process: HANDLE) -> Option<owner::Process> {
    let mut image = vec![0u16; 32_768];
    let mut length = image.len() as u32;
    if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, image.as_mut_ptr(), &mut length) == 0
    {
        return None;
    }
    image.truncate(length as usize);
    let mut token = std::ptr::null_mut();
    if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 || token.is_null() {
        return None;
    }
    let token = OwnedHandle(token);
    let user = token_information(token.0, TokenUser)?;
    let user = sid_bytes((*(user.as_ptr() as *const TOKEN_USER)).User.Sid)?;
    let label = token_information(token.0, TokenIntegrityLevel)?;
    let integrity = last_sub_authority(
        (*(label.as_ptr() as *const TOKEN_MANDATORY_LABEL))
            .Label
            .Sid,
    )?;
    Some(owner::Process {
        image,
        user,
        integrity,
    })
}

/// A token information structure, in a buffer aligned for its pointers.
unsafe fn token_information(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<Vec<u64>> {
    let mut needed = 0u32;
    GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut needed);
    if needed == 0 || needed > 64 * 1024 {
        return None;
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    if GetTokenInformation(token, class, buffer.as_mut_ptr() as _, needed, &mut needed) == 0 {
        return None;
    }
    Some(buffer)
}

unsafe fn sid_bytes(sid: PSID) -> Option<Vec<u8>> {
    if sid.is_null() {
        return None;
    }
    let length = GetLengthSid(sid) as usize;
    if length == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(sid as *const u8, length).to_vec())
}

unsafe fn last_sub_authority(sid: PSID) -> Option<u32> {
    if sid.is_null() {
        return None;
    }
    let count = GetSidSubAuthorityCount(sid);
    if count.is_null() || *count == 0 {
        return None;
    }
    let authority = GetSidSubAuthority(sid, u32::from(*count - 1));
    if authority.is_null() {
        None
    } else {
        Some(*authority)
    }
}

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    let Some(target) = manager.try_state::<TargetWindowHandle<R>>() else {
        return;
    };
    lifecycle::destroy(
        &target.lifecycle,
        unsafe { GetCurrentThreadId() },
        |hwnd| {
            let expected = target
                .userdata
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_deref()
                .map(|data| data as *const UserData<R> as isize);
            // Do not destroy another window if the original HWND was destroyed and reused.
            if expected != Some(unsafe { GetWindowLongPtrW(hwnd as _, GWLP_USERDATA) }) {
                return false;
            }
            unsafe { DestroyWindow(hwnd as _) != 0 }
        },
        || {
            // DestroyWindow has returned successfully, including all native callbacks.
            // The callback procedure owns clones before it calls application code.
            let userdata = target
                .userdata
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            drop(userdata);
            if let Some(mutex) = manager.try_state::<MutexHandle>() {
                mutex.close();
            }
        },
    );
}

unsafe extern "system" fn single_instance_window_proc<R: Runtime>(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            let create_struct = &*(lparam as *const CREATESTRUCTW);
            let userdata = create_struct.lpCreateParams as *const UserData<R>;
            if lifecycle::install_userdata(
                || SetLastError(0),
                || SetWindowLongPtrW(hwnd, GWLP_USERDATA, userdata as _),
                || GetLastError(),
            ) {
                0
            } else {
                -1
            }
        }
        WM_COPYDATA => {
            if lparam == 0 {
                return 0;
            }
            let cds = &*(lparam as *const COPYDATASTRUCT);
            if cds.dwData != wire::MESSAGE
                || cds.lpData.is_null()
                || cds.cbData == 0
                || cds.cbData as usize > wire::MAX_BYTES
            {
                return 0;
            }
            // Windows copies this allocation; read exactly its bounded length, without
            // relying on a terminator or ever replacing malformed UTF-8.
            let bytes = std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
            let Some((cwd, args)) = wire::decode(bytes) else {
                return 0;
            };
            let Some(userdata) = UserData::<R>::from_hwnd_raw(hwnd).as_ref() else {
                return 0;
            };
            let app = userdata.app.clone();
            let callback = Arc::clone(&userdata.callback);
            // Own these before calling: the callback may destroy the IPC window.
            // Nested sends fail instead of aliasing a running FnMut callback.
            let Ok(mut callback) = callback.try_lock() else {
                return 0;
            };
            callback(&app, args, cwd);
            wire::ACK as LRESULT
        }
        WM_DESTROY => {
            // Keep the borrowed pointer valid through every native destruction callback.
            // Rust releases its Box only after DestroyWindow confirms the window is gone.
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn create_event_target_window<R: Runtime>(
    class_name: &[u16],
    window_name: &[u16],
    userdata: *const UserData<R>,
) -> io::Result<HWND> {
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(single_instance_window_proc::<R>),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        if RegisterClassExW(&class) == 0 {
            return Err(io::Error::other(
                "single-instance window registration failed",
            ));
        }
        let hwnd = CreateWindowExW(
            // The IPC window must never appear in the taskbar, including after Explorer restarts.
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            window_name.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            userdata as _,
        );
        if hwnd.is_null() {
            return Err(io::Error::other("single-instance window creation failed"));
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_VISIBLE | WS_POPUP) as isize);
        if IsWindow(hwnd) == 0 {
            return Err(io::Error::other("single-instance window creation failed"));
        }
        Ok(hwnd)
    }
}

pub fn encode_wide(string: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    std::os::windows::prelude::OsStrExt::encode_wide(string.as_ref())
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_pointer_width = "32")]
#[allow(non_snake_case)]
unsafe fn SetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
    w32wm::SetWindowLongW(hwnd, index, value as _) as _
}
#[cfg(target_pointer_width = "64")]
#[allow(non_snake_case)]
unsafe fn SetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
    w32wm::SetWindowLongPtrW(hwnd, index, value)
}
#[cfg(target_pointer_width = "32")]
#[allow(non_snake_case)]
unsafe fn GetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> isize {
    w32wm::GetWindowLongW(hwnd, index) as _
}
#[cfg(target_pointer_width = "64")]
#[allow(non_snake_case)]
unsafe fn GetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> isize {
    w32wm::GetWindowLongPtrW(hwnd, index)
}
