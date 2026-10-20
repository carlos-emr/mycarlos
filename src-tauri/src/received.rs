//! Files handed to the app by the operating system: the Share menu on Android, "Open with" on
//! the Mac and iPhone, and file paths on the command line on Windows and Linux.
//!
//! A received file is never written to the vault on arrival. It waits here, known to the page
//! only by an opaque id and a cleaned name, until the patient unlocks and confirms it (#49).
//! Paths and URIs never leave Rust.

use std::ffi::OsString;
use std::io::{self, Cursor, Read};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::Url;
use uuid::Uuid;

use crate::vault::{sanitize_basename, MANUAL_IMPORT_LABEL, MAX_IMPORT_FILES};

/// How far into a file "%PDF-" may start. PDF readers accept a short preamble before the header.
pub(crate) const PDF_HEADER_WINDOW: usize = 1024;

/// Where a received file can be read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReceivedSource {
    /// A local file, opened later with the no-follow and reparse-point checks.
    Path(PathBuf),
    /// An Android content URI, read through the file-system plugin.
    ContentUri(Url),
}

/// Which platform's rules apply to an opened URL. Passed in, so both can be tested anywhere.
// Each platform builds one variant; the tests build both.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug)]
pub(crate) enum OpenedPlatform<'a> {
    /// Only another app's content provider is accepted; `own_authority` is this app's own.
    Android { own_authority: &'a str },
    /// The Mac and iPhone hand over `file:` URLs.
    Apple,
}

/// The URL as a source, or `None` when it must be dropped: shared text arrives as a `data:` or
/// web URL, and on Android a `file:` URL or our own provider could point at this app's private
/// files.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub(crate) fn accept_opened_url(url: &Url, platform: OpenedPlatform<'_>) -> Option<ReceivedSource> {
    match (platform, url.scheme()) {
        (OpenedPlatform::Android { own_authority }, "content") => {
            let authority = url.host_str().filter(|host| !host.is_empty())?;
            (!authority.eq_ignore_ascii_case(own_authority))
                .then(|| ReceivedSource::ContentUri(url.clone()))
        }
        (OpenedPlatform::Apple, "file") => url.to_file_path().ok().map(ReceivedSource::Path),
        _ => None,
    }
}

/// File paths given on the command line ("Open with" and "Send to" on Windows, a desktop
/// entry's file code on Linux): how many were offered, and those kept. The first argument is
/// the program, and options are not offers. Relative paths are dropped: the app's working
/// directory is not one the user chose.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub(crate) fn accept_command_line(
    args: impl IntoIterator<Item = OsString>,
) -> (usize, Vec<ReceivedSource>) {
    let offered: Vec<PathBuf> = args
        .into_iter()
        .skip(1)
        .filter(|arg| !arg.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .collect();
    let kept = offered
        .iter()
        .filter(|path| path.is_absolute())
        .cloned()
        .map(ReceivedSource::Path)
        .collect();
    (offered.len(), kept)
}

/// The name shown for a received file before it is cleaned by the vault's own naming rules.
pub(crate) fn received_name(source: &ReceivedSource) -> String {
    let raw = match source {
        ReceivedSource::Path(path) => path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        ReceivedSource::ContentUri(url) => url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .map(|segment| {
                percent_encoding::percent_decode_str(segment)
                    .decode_utf8_lossy()
                    .into_owned()
            }),
    };
    match raw {
        // A provider's last segment is often an opaque id ("msf:31"), not a file name. The
        // vault's own cleaning is applied now, so the list shows the name the record will get.
        Some(name) if has_pdf_extension(&name) => sanitize_basename(&name),
        _ => "Shared document.pdf".to_owned(),
    }
}

fn has_pdf_extension(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(stem, extension)| !stem.is_empty() && extension.eq_ignore_ascii_case("pdf"))
}

/// Marks an `io::Error` as "this file is not a PDF", so the caller can say so plainly.
#[derive(Debug)]
pub(crate) struct NotPdf;

impl std::fmt::Display for NotPdf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the file is not a PDF")
    }
}

impl std::error::Error for NotPdf {}

pub(crate) fn is_not_pdf(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|source| source.is::<NotPdf>())
}

/// Reads the start of `reader` and refuses it unless "%PDF-" begins within the first
/// `PDF_HEADER_WINDOW` bytes. The bytes read are put back in front, so the whole file still
/// streams into the vault.
pub(crate) fn require_pdf_header(
    mut reader: Box<dyn Read + Send>,
) -> io::Result<Box<dyn Read + Send>> {
    let mut head = Vec::with_capacity(PDF_HEADER_WINDOW);
    let mut chunk = [0_u8; PDF_HEADER_WINDOW];
    while head.len() < PDF_HEADER_WINDOW {
        let read = reader.read(&mut chunk[..PDF_HEADER_WINDOW - head.len()])?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
    }
    if !head.windows(5).any(|window| window == b"%PDF-") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, NotPdf));
    }
    Ok(Box::new(Cursor::new(head).chain(reader)))
}

/// Why a share was refused as a whole.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ShareRefused {
    /// More than `MAX_IMPORT_FILES` files, in this share or waiting in total.
    TooMany,
    /// Nothing in the share was a file the app accepts.
    NothingUsable,
}

/// One file waiting for the patient's decision.
#[derive(Clone, Debug)]
pub(crate) struct ReceivedFile {
    pub(crate) source: ReceivedSource,
    pub(crate) name: String,
}

/// What the app could not take since the page last asked, so the patient is told. It holds
/// counts only, never a name or address.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceiveNotice {
    /// Items that were not files the app accepts: shared text, web links, another app's
    /// private files.
    pub(crate) dropped: usize,
    /// Shares refused whole, because the files waiting would pass the import limit.
    pub(crate) refused_shares: usize,
}

/// What the page may see of a waiting file.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceivedSummary {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    /// The label the document will carry once added.
    pub(crate) source_label: &'static str,
}

/// Files received and not yet imported or discarded, in arrival order. Memory only: a file
/// received while the vault is locked is lost if the app closes first (the sealed inbox is
/// a later step of #49).
#[derive(Default)]
pub(crate) struct ReceivedFiles {
    waiting: Mutex<Waiting>,
    notice: Mutex<ReceiveNotice>,
}

#[derive(Default)]
struct Waiting {
    files: Vec<(Uuid, ReceivedFile)>,
    /// How many files an import has taken and not finished. They count against the limit:
    /// a failed import puts them back, and that must not take the total past it.
    taken: usize,
}

impl ReceivedFiles {
    fn waiting(&self) -> MutexGuard<'_, Waiting> {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn notice(&self) -> MutexGuard<'_, ReceiveNotice> {
        self.notice.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes in what the operating system handed over: `offered` items, of which `sources`
    /// were accepted. What was dropped or refused is kept for the page's next notice.
    pub(crate) fn receive(&self, offered: usize, sources: Vec<ReceivedSource>) {
        let dropped = offered.saturating_sub(sources.len());
        let refused = !sources.is_empty() && self.add_share(sources).is_err();
        let mut notice = self.notice();
        notice.dropped += dropped;
        notice.refused_shares += usize::from(refused);
    }

    /// The notice since the last call, cleared.
    pub(crate) fn take_notice(&self) -> ReceiveNotice {
        std::mem::take(&mut *self.notice())
    }

    /// Adds one share. It is refused whole when it, or the total waiting (counting files an
    /// import has taken), would exceed the import limit, so a patient never sees part of what
    /// they shared silently left out.
    pub(crate) fn add_share(
        &self,
        sources: Vec<ReceivedSource>,
    ) -> Result<Vec<Uuid>, ShareRefused> {
        if sources.is_empty() {
            return Err(ShareRefused::NothingUsable);
        }
        let mut waiting = self.waiting();
        if waiting.files.len() + waiting.taken + sources.len() > MAX_IMPORT_FILES {
            return Err(ShareRefused::TooMany);
        }
        let mut ids = Vec::with_capacity(sources.len());
        for source in sources {
            let id = Uuid::new_v4();
            let name = received_name(&source);
            waiting.files.push((id, ReceivedFile { source, name }));
            ids.push(id);
        }
        Ok(ids)
    }

    pub(crate) fn list(&self) -> Vec<ReceivedSummary> {
        self.waiting()
            .files
            .iter()
            .map(|(id, file)| ReceivedSummary {
                id: *id,
                name: file.name.clone(),
                source_label: MANUAL_IMPORT_LABEL,
            })
            .collect()
    }

    /// Removes and returns exactly the files named, in arrival order, or nothing at all when
    /// any id is unknown or repeated: an import must not quietly take fewer files than confirmed.
    /// The import then calls `finish` or `restore` with them.
    pub(crate) fn take(&self, ids: &[Uuid]) -> Option<Vec<(Uuid, ReceivedFile)>> {
        let mut waiting = self.waiting();
        let wanted: std::collections::HashSet<Uuid> = ids.iter().copied().collect();
        if wanted.len() != ids.len()
            || !wanted
                .iter()
                .all(|id| waiting.files.iter().any(|(known, _)| known == id))
        {
            return None;
        }
        let (taken, kept): (Vec<_>, Vec<_>) = waiting
            .files
            .drain(..)
            .partition(|(id, _)| wanted.contains(id));
        waiting.files = kept;
        waiting.taken += taken.len();
        Some(taken)
    }

    /// Ends an import that added the files it took.
    pub(crate) fn finish(&self, taken: &[(Uuid, ReceivedFile)]) {
        let mut waiting = self.waiting();
        waiting.taken = waiting.taken.saturating_sub(taken.len());
    }

    /// Puts back files an import took and could not finish, ahead of any received since.
    pub(crate) fn restore(&self, taken: Vec<(Uuid, ReceivedFile)>) {
        let mut waiting = self.waiting();
        waiting.taken = waiting.taken.saturating_sub(taken.len());
        let later = std::mem::replace(&mut waiting.files, taken);
        waiting.files.extend(later);
    }

    /// Forgets the files named. Unknown ids are ignored: a file already imported is gone too.
    #[cfg(test)]
    pub(crate) fn discard(&self, ids: &[Uuid]) {
        self.waiting().files.retain(|(id, _)| !ids.contains(id));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.waiting().files.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    const ANDROID: OpenedPlatform<'static> = OpenedPlatform::Android {
        own_authority: "ca.carlos.mycarlos.fileprovider",
    };

    #[test]
    fn accepts_another_apps_content_uri_on_android() {
        let shared = url("content://com.google.android.gm.sapi/attachment/lab%20results.pdf");
        assert_eq!(
            accept_opened_url(&shared, ANDROID),
            Some(ReceivedSource::ContentUri(shared))
        );
    }

    #[test]
    fn drops_our_own_provider_file_urls_and_text_on_android() {
        for text in [
            "content://ca.carlos.mycarlos.fileprovider/vault/secret.pdf",
            "content://CA.CARLOS.MYCARLOS.FILEPROVIDER/x.pdf",
            "file:///data/data/ca.carlos.mycarlos/files/vault-home/vault-v1/header.json",
            "data:text/plain,hello",
            "https://example.org/report.pdf",
        ] {
            assert_eq!(accept_opened_url(&url(text), ANDROID), None, "{text}");
        }
    }

    #[test]
    fn accepts_file_urls_only_on_apple() {
        // Built from a real path, so the test also runs on the Windows CI runner.
        let path = std::env::temp_dir().join("FAKE lab.pdf");
        assert_eq!(
            accept_opened_url(&Url::from_file_path(&path).unwrap(), OpenedPlatform::Apple),
            Some(ReceivedSource::Path(path))
        );
        for text in [
            "content://com.example/x.pdf",
            "data:text/plain,hello",
            "https://example.org/x.pdf",
        ] {
            assert_eq!(
                accept_opened_url(&url(text), OpenedPlatform::Apple),
                None,
                "{text}"
            );
        }
    }

    #[test]
    fn keeps_absolute_command_line_paths_after_the_program() {
        let absolute = std::env::temp_dir().join("FAKE lab.pdf");
        let args = vec![
            OsString::from("/opt/mycarlos/mycarlos"),
            OsString::from("--some-option"),
            OsString::from("relative.pdf"),
            absolute.clone().into_os_string(),
        ];
        assert_eq!(
            accept_command_line(args),
            (2, vec![ReceivedSource::Path(absolute)])
        );
        assert_eq!(
            accept_command_line(vec![OsString::from("/opt/mycarlos/mycarlos")]),
            (0, Vec::new())
        );
    }

    #[test]
    fn names_a_received_file_from_its_path_or_uri() {
        assert_eq!(
            received_name(&ReceivedSource::Path(PathBuf::from("/tmp/FAKE lab.PDF"))),
            "FAKE lab.PDF"
        );
        assert_eq!(
            received_name(&ReceivedSource::ContentUri(url(
                "content://com.example/docs/FAKE%20blood%20tests.pdf"
            ))),
            "FAKE blood tests.pdf"
        );
        // An opaque provider id, or no PDF extension, falls back to a generic name.
        assert_eq!(
            received_name(&ReceivedSource::ContentUri(url(
                "content://com.example/document/msf%3A31"
            ))),
            "Shared document.pdf"
        );
        assert_eq!(
            received_name(&ReceivedSource::Path(PathBuf::from("/tmp/notes.txt"))),
            "Shared document.pdf"
        );
        // Cleaned as the vault cleans a record's name: no bidi override, no reserved character.
        assert_eq!(
            received_name(&ReceivedSource::ContentUri(url(
                "content://com.example/docs/FAKE%E2%80%AEfdp.txt%3F.pdf"
            ))),
            "FAKEfdp.txt_.pdf"
        );
    }

    fn sniff(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        require_pdf_header(Box::new(Cursor::new(bytes)))?.read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn passes_a_pdf_through_unchanged() {
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.extend(std::iter::repeat_n(b'x', 5000));
        assert_eq!(sniff(pdf.clone()).unwrap(), pdf);
    }

    #[test]
    fn accepts_a_header_that_starts_late_in_the_window() {
        let mut pdf = vec![b' '; PDF_HEADER_WINDOW - 5];
        pdf.extend_from_slice(b"%PDF-1.4 rest");
        assert_eq!(sniff(pdf.clone()).unwrap(), pdf);
    }

    #[test]
    fn refuses_a_file_without_a_pdf_header_in_the_window() {
        let mut late = vec![b' '; PDF_HEADER_WINDOW - 4];
        late.extend_from_slice(b"%PDF-1.4");
        for bytes in [b"plain text, not a PDF".to_vec(), Vec::new(), late] {
            let error = sniff(bytes).unwrap_err();
            assert!(is_not_pdf(&error));
        }
    }

    fn sources(count: usize) -> Vec<ReceivedSource> {
        (0..count)
            .map(|i| ReceivedSource::Path(PathBuf::from(format!("/tmp/FAKE {i}.pdf"))))
            .collect()
    }

    #[test]
    fn refuses_a_share_over_the_limit_as_a_whole() {
        let files = ReceivedFiles::default();
        assert_eq!(
            files.add_share(sources(MAX_IMPORT_FILES + 1)),
            Err(ShareRefused::TooMany)
        );
        assert_eq!(files.len(), 0);
        files.add_share(sources(MAX_IMPORT_FILES - 1)).unwrap();
        assert_eq!(files.add_share(sources(2)), Err(ShareRefused::TooMany));
        assert_eq!(files.len(), MAX_IMPORT_FILES - 1);
        assert_eq!(
            files.add_share(Vec::new()),
            Err(ShareRefused::NothingUsable)
        );
    }

    #[test]
    fn takes_exactly_the_confirmed_files_or_none() {
        let files = ReceivedFiles::default();
        let ids = files.add_share(sources(3)).unwrap();
        assert_eq!(
            files
                .list()
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            ["FAKE 0.pdf", "FAKE 1.pdf", "FAKE 2.pdf"]
        );
        assert!(files.take(&[ids[0], Uuid::new_v4()]).is_none());
        assert!(files.take(&[ids[0], ids[0]]).is_none());
        assert_eq!(files.len(), 3);
        let taken = files.take(&[ids[2], ids[0]]).unwrap();
        assert_eq!(
            taken
                .iter()
                .map(|(_, f)| f.name.as_str())
                .collect::<Vec<_>>(),
            ["FAKE 0.pdf", "FAKE 2.pdf"]
        );
        assert!(files.take(&[ids[0]]).is_none(), "an id is used once");
        files.discard(&[ids[1], Uuid::new_v4()]);
        assert_eq!(files.len(), 0);
    }

    #[test]
    fn a_failed_import_puts_its_files_back_first() {
        let files = ReceivedFiles::default();
        let first = files.add_share(sources(2)).unwrap();
        let taken = files.take(&first).unwrap();
        let later = files
            .add_share(vec![ReceivedSource::Path(PathBuf::from(
                "/tmp/FAKE later.pdf",
            ))])
            .unwrap();
        files.restore(taken);
        assert_eq!(
            files.list().iter().map(|s| s.id).collect::<Vec<_>>(),
            [first[0], first[1], later[0]]
        );
    }

    #[test]
    fn files_an_import_has_taken_still_count_against_the_limit() {
        let files = ReceivedFiles::default();
        let first = files.add_share(sources(60)).unwrap();
        let taken = files.take(&first[..50]).unwrap();
        // 10 waiting and 50 taken: a share of 41 would make 101 once they come back.
        assert_eq!(files.add_share(sources(41)), Err(ShareRefused::TooMany));
        files.add_share(sources(40)).unwrap();
        files.restore(taken);
        assert_eq!(files.len(), MAX_IMPORT_FILES);
        // Taken and added: they no longer count.
        let all: Vec<Uuid> = files.list().iter().map(|s| s.id).collect();
        let taken = files.take(&all[..30]).unwrap();
        files.finish(&taken);
        files.add_share(sources(30)).unwrap();
        assert_eq!(files.len(), MAX_IMPORT_FILES);
    }

    #[test]
    fn counts_what_was_dropped_or_refused_until_the_page_asks() {
        let files = ReceivedFiles::default();
        files.receive(0, Vec::new());
        assert_eq!(files.take_notice(), ReceiveNotice::default());
        // A share of text alone, then one of two items with one file in it.
        files.receive(1, Vec::new());
        files.receive(2, sources(1));
        files.receive(MAX_IMPORT_FILES, sources(MAX_IMPORT_FILES));
        assert_eq!(
            files.take_notice(),
            ReceiveNotice {
                dropped: 2,
                refused_shares: 1
            }
        );
        assert_eq!(files.take_notice(), ReceiveNotice::default());
        assert_eq!(files.len(), 1);
    }
}
