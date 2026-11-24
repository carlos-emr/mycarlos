// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Which window a second launch may hand its arguments to: only one owned by
//! this user's own copy of the same executable, at no lower integrity level.
//! This module uses only std so the comparison can also be tested on a host.

/// What is compared about a process.
pub(super) struct Process {
    /// The executable's full path, as Windows reports it (UTF-16, no NUL).
    pub(super) image: Vec<u16>,
    /// The bytes of its user's SID.
    pub(super) user: Vec<u8>,
    /// Its mandatory integrity level (the label's last sub-authority).
    pub(super) integrity: u32,
}

/// Whether `owner`, the process that owns the window found, may be handed
/// this launch's arguments: the same executable, the same user, and an
/// integrity level no lower than this launch's. Anything not read is refused.
pub(super) fn may_receive(ours: &Process, owner: &Process) -> bool {
    same_image(&ours.image, &owner.image)
        && !ours.user.is_empty()
        && ours.user == owner.user
        && owner.integrity >= ours.integrity
}

/// The same path. Windows compares paths without regard to case; only ASCII
/// letters are folded here, and a `\\?\` prefix is ignored. Any other
/// difference counts as another executable.
pub(super) fn same_image(a: &[u16], b: &[u16]) -> bool {
    let (a, b) = (without_prefix(a), without_prefix(b));
    !a.is_empty() && a.len() == b.len() && a.iter().zip(b).all(|(x, y)| fold(*x) == fold(*y))
}

fn without_prefix(path: &[u16]) -> &[u16] {
    const PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    path.strip_prefix(&PREFIX[..]).unwrap_or(path)
}

fn fold(unit: u16) -> u16 {
    if (u16::from(b'a')..=u16::from(b'z')).contains(&unit) {
        unit - 32
    } else {
        unit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOW: u32 = 0x1000;
    const MEDIUM: u32 = 0x2000;
    const HIGH: u32 = 0x3000;
    const APP: &str = "C:\\Program Files\\myCarlos\\myCarlos.exe";

    fn wide(path: &str) -> Vec<u16> {
        path.encode_utf16().collect()
    }
    // FAKE SIDs: revision 1, two sub-authorities, small numbers only.
    fn user(last: u8) -> Vec<u8> {
        vec![1, 2, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, last, 0, 0, 0]
    }
    fn process(image: &str, user: Vec<u8>, integrity: u32) -> Process {
        Process {
            image: wide(image),
            user,
            integrity,
        }
    }

    #[test]
    fn hands_over_only_to_the_same_users_same_executable_at_no_lower_integrity() {
        let ours = process(APP, user(7), MEDIUM);
        assert!(may_receive(&ours, &process(APP, user(7), MEDIUM)));
        assert!(may_receive(&ours, &process(APP, user(7), HIGH)));
        // Another user, a lower integrity level, or another executable.
        assert!(!may_receive(&ours, &process(APP, user(8), MEDIUM)));
        assert!(!may_receive(&ours, &process(APP, user(7), LOW)));
        assert!(!may_receive(
            &ours,
            &process(
                "C:\\Users\\FAKE\\AppData\\Local\\Temp\\myCarlos.exe",
                user(7),
                MEDIUM
            )
        ));
        assert!(!may_receive(
            &ours,
            &process(
                "C:\\Program Files\\myCarlos\\myCarlos.exe.old",
                user(7),
                MEDIUM
            )
        ));
    }

    #[test]
    fn refuses_when_something_could_not_be_read() {
        let ours = process(APP, user(7), MEDIUM);
        assert!(!may_receive(&ours, &process("", user(7), MEDIUM)));
        assert!(!may_receive(&ours, &process(APP, Vec::new(), MEDIUM)));
        let unread = process("", Vec::new(), MEDIUM);
        assert!(!may_receive(&unread, &unread));
    }

    #[test]
    fn compares_paths_as_windows_does_for_case_and_the_long_path_prefix() {
        assert!(same_image(&wide(APP), &wide(&APP.to_uppercase())));
        assert!(same_image(&wide(APP), &wide(&format!("\\\\?\\{APP}"))));
        assert!(!same_image(
            &wide(APP),
            &wide("C:\\Program Files\\myCarlos\\myCarIos.exe")
        ));
        assert!(!same_image(&wide(""), &wide("")));
    }
}
