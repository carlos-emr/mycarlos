//! The model store's refusal and bound rules that `local_model`'s own tests do not reach (coverage
//! batch 1): the words the renderer maps, and what the store does with the small files kept beside
//! its folder when another program has put something else there. FAKE files only.

use super::*;
use crate::model_limits::{ModelCard, CARDS_FILE, MAX_CARDS_FILE_BYTES, MAX_STORED_CARDS};
use crate::speed_check::{MAX_SPEED_FILE_BYTES, SPEED_FILE};

#[test]
fn every_refusal_has_its_own_word_for_the_renderer() {
    // The renderer maps these words to text: renaming one silently loses its message. They are not
    // the serde names (`notOnList` is `notListed` here, `truncated` is `incomplete`).
    let table = [
        (ModelError::Unsupported(Unsupported::Ram), "unsupported"),
        (ModelError::Unsupported(Unsupported::Cpu), "unsupported"),
        (
            ModelError::Unsupported(Unsupported::Platform),
            "unsupported",
        ),
        (ModelError::NotOnList, "notListed"),
        (ModelError::TooBig, "tooBig"),
        (ModelError::Truncated, "incomplete"),
        (ModelError::WrongHash, "wrongHash"),
        (ModelError::NotEnoughDisk, "noDisk"),
        (ModelError::Unreadable, "unreadable"),
        (ModelError::Storage, "storage"),
        (ModelError::Damaged, "damaged"),
        (ModelError::NotInstalled, "notInstalled"),
        (ModelError::Busy, "busy"),
        (ModelError::Cancelled, "cancelled"),
        (ModelError::Memory, "memory"),
        (ModelError::Network, "network"),
        (ModelError::Unavailable, "unavailable"),
    ];
    for (error, word) in table {
        assert_eq!(error.code(), word, "{error:?}");
    }
    // Different refusals never share a word (but the three unsupported reasons are one).
    let mut words: Vec<&str> = table.iter().map(|(_, word)| *word).collect();
    words.sort_unstable();
    words.dedup();
    assert_eq!(words.len(), table.len() - 2);
}

fn make_store(dir: &tempfile::TempDir) -> Store {
    // The small files sit beside the models folder, not in it.
    Store::new(dir.path().join("models"), &[])
}

fn card(parameters: u64) -> ModelCard {
    ModelCard {
        architecture: "FAKE-arch".to_owned(),
        trained_context: 4096,
        context_made: 2048,
        parameters,
        layers: 8,
        vocabulary: 1000,
        recurrent: false,
        hybrid: false,
        kv_bytes_per_token: 100,
        weights_bytes: 1_000_000,
    }
}

#[test]
fn a_saved_speed_or_card_file_that_is_missing_oversized_or_not_a_file_gives_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = make_store(&dir);
    let speeds = dir.path().join(SPEED_FILE);
    let cards = dir.path().join(CARDS_FILE);
    // Missing.
    assert!(store.saved_speeds().is_empty() && store.saved_cards().is_empty());
    // Larger than the limit by one byte: not read as a file of entries.
    fs::write(&speeds, vec![b' '; MAX_SPEED_FILE_BYTES + 1]).unwrap();
    fs::write(&cards, vec![b' '; MAX_CARDS_FILE_BYTES + 1]).unwrap();
    assert!(store.saved_speeds().is_empty() && store.saved_cards().is_empty());
    // Not JSON of the agreed shape.
    fs::write(&speeds, b"not json").unwrap();
    fs::write(&cards, b"[1,2,3]").unwrap();
    assert!(store.saved_speeds().is_empty() && store.saved_cards().is_empty());
    // A folder where the file belongs (in a store of its own: nothing is deleted here).
    let other = tempfile::tempdir().unwrap();
    let other_store = make_store(&other);
    fs::create_dir(other.path().join(SPEED_FILE)).unwrap();
    fs::create_dir(other.path().join(CARDS_FILE)).unwrap();
    assert!(other_store.saved_speeds().is_empty() && other_store.saved_cards().is_empty());
}

#[cfg(unix)]
#[test]
fn a_pipe_where_a_saved_file_belongs_is_never_opened() {
    // Opening a pipe with no writer blocks for ever: the synchronous commands that read these
    // files would hang. The check is on the entry itself, without opening it.
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    for name in [SPEED_FILE, CARDS_FILE] {
        let path = dir.path().join(name);
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid NUL-terminated path that lives through the call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    }
    let store = std::sync::Arc::new(make_store(&dir));
    let (done, finished) = std::sync::mpsc::channel();
    let reading = std::sync::Arc::clone(&store);
    std::thread::spawn(move || {
        let _ = done.send((reading.saved_speeds().len(), reading.saved_cards().len()));
    });
    let counts = finished
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("reading a pipe must not block");
    assert_eq!(counts, (0, 0));
}

#[test]
fn this_runs_cards_are_found_by_hash_and_the_oldest_goes_when_the_list_is_full() {
    let dir = tempfile::tempdir().unwrap();
    let store = make_store(&dir);
    let hash = |n: usize| format!("{n:064x}");
    assert!(store.stored_card(&hash(0)).is_none());
    for n in 0..MAX_STORED_CARDS {
        store.remember_card(&hash(n), &card(n as u64 + 1));
    }
    // All of them are there; one more pushes the oldest out.
    assert_eq!(store.stored_card(&hash(0)).unwrap().parameters, 1);
    store.remember_card(&hash(MAX_STORED_CARDS), &card(999));
    assert!(store.stored_card(&hash(0)).is_none());
    assert_eq!(store.stored_card(&hash(1)).unwrap().parameters, 2);
    assert_eq!(
        store
            .stored_card(&hash(MAX_STORED_CARDS))
            .unwrap()
            .parameters,
        999
    );
    // Remembering a hash again replaces its card and does not use up another place.
    store.remember_card(&hash(5), &card(555));
    store.remember_card(&hash(5), &card(556));
    assert_eq!(store.stored_card(&hash(5)).unwrap().parameters, 556);
    assert_eq!(
        store
            .session_cards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        MAX_STORED_CARDS
    );
}
