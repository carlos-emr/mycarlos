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
    Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM},
    System::{
        DataExchange::COPYDATASTRUCT,
        LibraryLoader::GetModuleHandleW,
        Threading::{CreateMutexW, ReleaseMutex},
    },
    UI::WindowsAndMessaging::{
        self as w32wm, CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowW, IsWindow,
        RegisterClassExW, SendMessageTimeoutW, CREATESTRUCTW, GWLP_USERDATA, GWL_STYLE,
        SMTO_ABORTIFHUNG, SMTO_BLOCK, WINDOW_LONG_PTR_INDEX, WM_COPYDATA, WM_CREATE, WM_DESTROY,
        WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        WS_OVERLAPPED, WS_POPUP, WS_VISIBLE,
    },
};

#[path = "windows_wire.rs"]
mod wire;

const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
struct MutexHandle(Mutex<Option<isize>>);
struct TargetWindowHandle(Mutex<Option<isize>>);

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
    owned_by_window: bool,
}

impl<R: Runtime> UserData<R> {
    unsafe fn from_hwnd_raw(hwnd: HWND) -> *mut Self {
        GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Self
    }
}

pub fn init<R: Runtime>(callback: Box<SingleInstanceCallback<R>>) -> TauriPlugin<R> {
    plugin::Builder::new("single-instance")
        .setup(|app, _api| {
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
                }
                app.cleanup_before_exit();
                std::process::exit(if result.is_ok() { 0 } else { 2 });
            }
            let mutex = MutexHandle(Mutex::new(Some(hmutex as _)));
            let mut userdata = Box::new(UserData {
                app: app.clone(),
                callback: Arc::new(Mutex::new(callback)),
                owned_by_window: false,
            });
            // Hold the Box until creation succeeds. A failed creation's WM_DESTROY cannot
            // free it too: this function still owns it until the explicit transfer below.
            let hwnd = create_event_target_window::<R>(
                &class_name,
                &window_name,
                &mut *userdata as *mut _,
            )?;
            userdata.owned_by_window = true;
            let _ = Box::into_raw(userdata);
            app.manage(mutex);
            app.manage(TargetWindowHandle(Mutex::new(Some(hwnd as _))));
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
    let cwd = std::env::current_dir().map_err(|_| invalid())?;
    let bytes = wire::encode(cwd.as_os_str(), std::env::args_os()).ok_or_else(invalid)?;
    let started = Instant::now();
    let hwnd = loop {
        let hwnd = unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
        if !hwnd.is_null() {
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

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Some(target) = manager.try_state::<TargetWindowHandle>() {
        let hwnd = target
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(hwnd) = hwnd {
            unsafe { DestroyWindow(hwnd as _) };
        }
    }
    // Close once after destroying the window, without removing live managed state.
    if let Some(mutex) = manager.try_state::<MutexHandle>() {
        mutex.close();
    }
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
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, userdata as _);
            0
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
            let userdata = UserData::<R>::from_hwnd_raw(hwnd);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if let Some(data) = userdata.as_ref() {
                if data.owned_by_window {
                    drop(Box::from_raw(userdata));
                }
            }
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
