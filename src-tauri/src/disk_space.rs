//! Free space on a volume, one copy for everything that asks: the model download
//! (`local_model.rs`) and recording a video (#359). `statvfs` on Unix and
//! Android, `GetDiskFreeSpaceExW` on Windows; `None` where it cannot be known.

use std::path::Path;

/// Bytes a normal user can still write on the volume holding `dir`, or `None`
/// when unknown. `dir` need not exist yet: the nearest folder that does is asked.
pub(crate) fn free_bytes(dir: &Path) -> Option<u64> {
    free_disk(dir)
}

#[cfg(unix)]
fn free_disk(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    // The folder may not exist yet: ask about the nearest one that does.
    let mut probe = dir;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let path = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a valid out-pointer.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    (stat.f_bavail as u64).checked_mul(stat.f_frsize as u64)
}

#[cfg(windows)]
fn free_disk(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut probe = dir;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let wide: Vec<u16> = probe.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and `free` is a valid out-pointer.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

#[cfg(not(any(unix, windows)))]
fn free_disk(_dir: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_that_exists_has_free_space_and_one_that_does_not_asks_its_parent() {
        let temp = tempfile::tempdir().unwrap();
        let here = free_bytes(temp.path());
        let later = free_bytes(&temp.path().join("not").join("yet").join("made"));
        // Where the volume can be asked, both ask the same one.
        #[cfg(any(unix, windows))]
        {
            assert!(here.is_some());
            assert!(later.is_some());
        }
        #[cfg(not(any(unix, windows)))]
        assert!(here.is_none() && later.is_none());
    }
}
