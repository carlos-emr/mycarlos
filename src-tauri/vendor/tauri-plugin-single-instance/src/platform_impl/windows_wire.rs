// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! The reviewed Windows-only transport. No lossy conversion or legacy pipe frames.
//! This module uses only std so its actual codec can also be tested on a host.

use std::ffi::{OsStr, OsString};

pub(super) const MESSAGE: usize = 1544;
// Older receivers return 1 even for an unknown message; that is not our ack.
pub(super) const ACK: usize = 0x4d43_5301;
// Above the UTF-8 expansion of a Windows command line plus its working directory.
pub(super) const MAX_BYTES: usize = 256 * 1024;

pub(super) fn acknowledged(delivered: bool, response: usize) -> bool {
    delivered && response == ACK
}

pub(super) fn encode(cwd: &OsStr, args: impl IntoIterator<Item = OsString>) -> Option<Vec<u8>> {
    let cwd = cwd.to_str()?;
    if cwd.contains('\0') || cwd.len() > MAX_BYTES {
        return None;
    }
    let mut data = cwd.as_bytes().to_vec();
    let mut args = args.into_iter();
    let program = args.next()?;
    if program.is_empty() {
        return None;
    }
    for arg in std::iter::once(program).chain(args) {
        let arg = arg.to_str()?;
        if arg.contains('\0') || data.len().checked_add(1 + arg.len())? > MAX_BYTES {
            return None;
        }
        data.push(0);
        data.extend_from_slice(arg.as_bytes());
    }
    Some(data)
}

pub(super) fn decode(data: &[u8]) -> Option<(String, Vec<String>)> {
    if data.len() > MAX_BYTES {
        return None;
    }
    let mut fields = std::str::from_utf8(data).ok()?.split('\0');
    let cwd = fields.next()?.to_owned();
    let program = fields.next()?;
    if program.is_empty() {
        return None;
    }
    let args = std::iter::once(program)
        .chain(fields)
        .map(str::to_owned)
        .collect();
    Some((cwd, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_or_a_legacy_receivers_unknown_message_response_is_not_success() {
        assert!(acknowledged(true, ACK));
        assert!(!acknowledged(false, ACK));
        assert!(!acknowledged(true, 1));
        assert!(!acknowledged(true, 0));
    }

    #[test]
    fn round_trips_spaces_unicode_empty_arguments_and_pipe_without_splitting() {
        let args = [
            "C:\\Program Files\\myCarlos.exe",
            "C:\\FAKE José 🩺\\结果.pdf",
            "--hint=|C:\\other.pdf",
            "",
        ]
        .map(OsString::from);
        let data = encode(OsStr::new("C:\\FAKE çalışma"), args.clone()).unwrap();
        let (cwd, decoded) = decode(&data).unwrap();
        assert_eq!(cwd, "C:\\FAKE çalışma");
        assert_eq!(decoded, args.map(|s| s.into_string().unwrap()));
    }

    #[test]
    fn refuses_invalid_utf8_instead_of_selecting_a_replacement_character_path() {
        assert!(decode(b"cwd\0app\0C:\\FAKE\xff.pdf").is_none());
        // An actual replacement character is valid Unicode, not a lossy conversion.
        let args = [OsString::from("app"), OsString::from("C:\\FAKE�.pdf")];
        assert!(decode(&encode(OsStr::new(""), args).unwrap()).is_some());
    }

    #[test]
    fn refuses_missing_program_and_embedded_nuls_on_the_sender() {
        assert!(decode(b"").is_none());
        assert!(decode(b"cwd").is_none());
        assert!(decode(b"cwd\0").is_none());
        assert!(encode(OsStr::new("cwd"), []).is_none());
        assert!(encode(OsStr::new("cwd"), [OsString::new()]).is_none());
        assert!(encode(OsStr::new("cwd\0suffix"), [OsString::from("app")]).is_none());
        assert!(encode(
            OsStr::new("cwd"),
            [OsString::from("app"), OsString::from("a\0b")]
        )
        .is_none());
    }

    #[test]
    fn bounds_both_sides_including_the_separator() {
        let exact = "x".repeat(MAX_BYTES - 4);
        let frame = encode(
            OsStr::new(""),
            [
                OsString::from("app"),
                OsString::from(&exact[..exact.len() - 1]),
            ],
        )
        .unwrap();
        assert_eq!(frame.len(), MAX_BYTES);
        assert!(decode(&frame).is_some());
        assert!(encode(
            OsStr::new(""),
            [OsString::from("app"), OsString::from(exact)]
        )
        .is_none());
        assert!(decode(&vec![b'x'; MAX_BYTES + 1]).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_non_unicode_os_arguments_and_cwd() {
        use std::os::unix::ffi::OsStringExt;
        let invalid = OsString::from_vec(vec![0xff]);
        assert!(encode(OsStr::new("cwd"), [OsString::from("app"), invalid.clone()]).is_none());
        assert!(encode(&invalid, [OsString::from("app")]).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn refuses_unpaired_utf16_in_os_arguments_and_cwd() {
        use std::os::windows::ffi::OsStringExt;
        let invalid = OsString::from_wide(&[0xd800]);
        assert!(encode(OsStr::new("cwd"), [OsString::from("app"), invalid.clone()]).is_none());
        assert!(encode(&invalid, [OsString::from("app")]).is_none());
    }
}
