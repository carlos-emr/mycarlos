// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Windows resource transitions, with injected OS calls for host failure tests.

use std::sync::Mutex;

pub(super) struct Target {
    window: Option<isize>,
    owner_thread: u32,
    destroying: bool,
}

impl Target {
    pub(super) fn new(window: isize, owner_thread: u32) -> Self {
        Self {
            window: Some(window),
            owner_thread,
            destroying: false,
        }
    }
}

/// Refuse other threads and nested teardown; release resources only after confirmed destruction.
/// No state lock is held while Windows calls the window procedure.
pub(super) fn destroy(
    target: &Mutex<Target>,
    current_thread: u32,
    destroy_window: impl FnOnce(isize) -> bool,
    release: impl FnOnce(),
) -> bool {
    let window = {
        let mut state = target.lock().unwrap_or_else(|error| error.into_inner());
        if state.owner_thread != current_thread || state.destroying {
            return false;
        }
        let Some(window) = state.window else {
            return true;
        };
        state.destroying = true;
        window
    };
    let destroyed = destroy_window(window);
    {
        let mut state = target.lock().unwrap_or_else(|error| error.into_inner());
        if destroyed {
            state.window = None;
        }
        state.destroying = false;
    }
    if destroyed {
        release();
    }
    destroyed
}

/// GWLP_USERDATA's old value is normally zero: clear LastError before the ambiguous write.
pub(super) fn install_userdata(
    clear_error: impl FnOnce(),
    set_pointer: impl FnOnce() -> isize,
    last_error: impl FnOnce() -> u32,
) -> bool {
    clear_error();
    set_pointer() != 0 || last_error() == 0
}

/// The Rust Box remains the sole owner throughout native creation callbacks and errors.
/// On success its allocation stays stable when moved into the managed target.
pub(super) fn create_with_userdata<T, H, E>(
    mut data: Box<T>,
    create: impl FnOnce(&mut T) -> Result<H, E>,
) -> Result<(H, Box<T>), E> {
    let window = create(&mut data)?;
    Ok((window, data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    struct Data(Rc<Cell<usize>>);
    impl Drop for Data {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    #[test]
    fn wrong_thread_keeps_target_userdata_and_reservation_for_owner_retry() {
        let target = Mutex::new(Target::new(42, 7));
        let calls = Cell::new(0);
        let closes = Cell::new(0);
        let drops = Rc::new(Cell::new(0));
        let data = RefCell::new(Some(Box::new(Data(drops.clone()))));
        assert!(!destroy(
            &target,
            9,
            |_| {
                calls.set(calls.get() + 1);
                true
            },
            || {
                data.borrow_mut().take();
                closes.set(closes.get() + 1);
            }
        ));
        assert_eq!((calls.get(), closes.get(), drops.get()), (0, 0, 0));
        assert_eq!(target.lock().unwrap().window, Some(42));
        assert!(destroy(
            &target,
            7,
            |hwnd| {
                assert_eq!(hwnd, 42);
                calls.set(calls.get() + 1);
                true
            },
            || {
                data.borrow_mut().take();
                closes.set(closes.get() + 1);
            }
        ));
        assert_eq!((calls.get(), closes.get(), drops.get()), (1, 1, 1));
    }

    #[test]
    fn failed_destroy_retains_every_resource_then_success_and_repeated_cleanup_close_once() {
        let target = Mutex::new(Target::new(42, 7));
        let calls = Cell::new(0);
        let closes = Cell::new(0);
        let drops = Rc::new(Cell::new(0));
        let data = RefCell::new(Some(Box::new(Data(drops.clone()))));
        assert!(!destroy(
            &target,
            7,
            |_| {
                calls.set(calls.get() + 1);
                false
            },
            || {
                data.borrow_mut().take();
                closes.set(closes.get() + 1);
            }
        ));
        assert_eq!((calls.get(), closes.get(), drops.get()), (1, 0, 0));
        assert_eq!(target.lock().unwrap().window, Some(42));
        for _ in 0..2 {
            assert!(destroy(
                &target,
                7,
                |_| {
                    calls.set(calls.get() + 1);
                    true
                },
                || {
                    data.borrow_mut().take();
                    closes.set(closes.get() + 1);
                }
            ));
        }
        assert_eq!((calls.get(), closes.get(), drops.get()), (2, 1, 1));
        assert!(target.lock().unwrap().window.is_none());
    }

    #[test]
    fn inline_window_callback_teardown_is_refused_without_locking_or_early_release() {
        let target = Mutex::new(Target::new(42, 7));
        let closes = Cell::new(0);
        assert!(destroy(
            &target,
            7,
            |_| {
                assert!(!destroy(
                    &target,
                    7,
                    |_| panic!("nested OS destruction"),
                    || panic!("early release")
                ));
                assert_eq!(closes.get(), 0);
                true
            },
            || closes.set(closes.get() + 1)
        ));
        assert_eq!(closes.get(), 1);
    }

    #[test]
    fn userdata_install_clears_stale_error_and_disambiguates_zero_result() {
        let error = Cell::new(123);
        let calls = RefCell::new(Vec::new());
        assert!(install_userdata(
            || {
                calls.borrow_mut().push("clear");
                error.set(0);
            },
            || {
                calls.borrow_mut().push("set");
                assert_eq!(error.get(), 0);
                0
            },
            || {
                calls.borrow_mut().push("get");
                error.get()
            },
        ));
        assert_eq!(*calls.borrow(), ["clear", "set", "get"]);
        assert!(!install_userdata(
            || error.set(0),
            || {
                error.set(5);
                0
            },
            || error.get()
        ));
        assert!(install_userdata(
            || {},
            || 99,
            || panic!("nonzero return is success")
        ));
    }

    #[test]
    fn failed_userdata_installation_drops_creation_owner_once_without_transfer() {
        let drops = Rc::new(Cell::new(0));
        let result = create_with_userdata(Box::new(Data(drops.clone())), |_| {
            assert_eq!(drops.get(), 0, "still owned during WM_CREATE");
            if install_userdata(|| {}, || 0, || 5) {
                Ok(42)
            } else {
                Err("WM_CREATE -1")
            }
        });
        assert!(result.is_err());
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn later_creation_failure_and_success_each_retain_one_box_owner() {
        let failed_drops = Rc::new(Cell::new(0));
        let result: Result<(isize, _), ()> =
            create_with_userdata(Box::new(Data(failed_drops.clone())), |_| Err(()));
        assert!(result.is_err());
        assert_eq!(failed_drops.get(), 1);
        let drops = Rc::new(Cell::new(0));
        let (hwnd, data) = create_with_userdata(Box::new(Data(drops.clone())), |data| {
            assert_eq!(drops.get(), 0);
            assert!(install_userdata(|| {}, || 0, || 0));
            Ok::<_, ()>((42, data as *mut Data))
        })
        .unwrap();
        assert_eq!(
            hwnd.1, &*data as *const Data as *mut Data,
            "Box move preserves installed address"
        );
        assert_eq!(drops.get(), 0);
        let target = Mutex::new(Target::new(hwnd.0, 7));
        assert!(destroy(
            &target,
            7,
            |_| {
                assert_eq!(drops.get(), 0);
                true
            },
            || drop(data)
        ));
        assert_eq!(drops.get(), 1);
    }
}
