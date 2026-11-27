//! The `mycarlos-video` address a `<video>` element reads a stored video from
//! (#359 PR 2).
//!
//! The page asks for `mycarlos-video://localhost/<token>` (on Windows and
//! Android the webview shows it as `http://mycarlos-video.localhost/<token>`).
//! The token is made by `VaultStore::playback_open` for one video at one unlock
//! and is the whole path: nothing else is served, and nothing is looked up by a
//! name, an id or a file. A token that never existed, has been closed, or was
//! made before the last lock gets the same bare 404 as any other path.
//!
//! Only `GET` and `HEAD`. A response is one range, never the whole file, and
//! never more than 2 MiB (`MAX_RANGE_RESPONSE`), with the range it carries in
//! `Content-Range`: a request with no `Range` header is answered as `bytes=0-`.
//! A range that cannot be satisfied, or a header that cannot be trusted, gets
//! 416 and the file's size, and nothing is read. Responses are never cached and
//! never sniffed. There are no CORS headers: a `<video>` loads the address
//! without them, and a script's `fetch` of it is refused by the browser.
//!
//! The handler decrypts nothing itself: it parses the request and hands the
//! range to the vault, which reads only the frames the range touches.

use crate::vault::{looks_like_token, PlaybackRefusal, VaultStore};
use tauri::http::{Request, Response};

/// The URI scheme the webview is allowed to load media from (see the CSP).
pub const SCHEME: &str = "mycarlos-video";

/// A reply before it becomes an HTTP response, so that it can be tested
/// without a webview.
#[cfg_attr(test, derive(Debug))]
#[derive(PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}
redact_debug!(Reply);

fn bare(status: u16) -> Reply {
    Reply {
        status,
        headers: vec![
            ("Cache-Control", "no-store".to_owned()),
            ("X-Content-Type-Options", "nosniff".to_owned()),
            ("Content-Length", "0".to_owned()),
        ],
        body: Vec::new(),
    }
}

/// Answers one request. `path` is the URI's path (`/<token>`).
pub fn answer(store: &VaultStore, method: &str, path: &str, range: Option<&str>) -> Reply {
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => {
            let mut reply = bare(405);
            reply.headers.push(("Allow", "GET, HEAD".to_owned()));
            return reply;
        }
    };
    let Some(token) = path
        .strip_prefix('/')
        .filter(|token| looks_like_token(token))
    else {
        return bare(404);
    };
    match store.playback_serve(token, range, !head_only) {
        Err(PlaybackRefusal::UnknownToken) => bare(404),
        Err(PlaybackRefusal::Unreadable) => bare(500),
        Ok(reply) => {
            let mut headers = vec![
                ("Cache-Control", "no-store".to_owned()),
                ("X-Content-Type-Options", "nosniff".to_owned()),
                ("Accept-Ranges", "bytes".to_owned()),
            ];
            match reply.range {
                Some((start, end)) => {
                    headers.push(("Content-Type", "video/mp4".to_owned()));
                    headers.push((
                        "Content-Range",
                        format!("bytes {start}-{end}/{}", reply.total),
                    ));
                    // The length of the range, also for HEAD (which has no body).
                    headers.push(("Content-Length", (end - start + 1).to_string()));
                }
                None => {
                    headers.push(("Content-Range", format!("bytes */{}", reply.total)));
                    headers.push(("Content-Length", "0".to_owned()));
                }
            }
            Reply {
                status: reply.status,
                headers,
                body: reply.body,
            }
        }
    }
}

/// Only the app's own window may ask: any other webview gets the same 404.
pub fn webview_allowed(label: &str) -> bool {
    label == "main"
}

/// The bare 404 for a request that is not to be answered (a webview that may not
/// ask, or no vault yet): the same headers as every other answer.
pub fn refused() -> Response<Vec<u8>> {
    into_response(bare(404))
}

/// The webview's request, answered.
pub fn respond(store: &VaultStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    // A `Range` header that is not text is read as one that cannot be trusted.
    let range = match (request.headers().contains_key("range"), range) {
        (true, None) => Some("invalid"),
        _ => range,
    };
    into_response(answer(
        store,
        request.method().as_str(),
        request.uri().path(),
        range,
    ))
}

fn into_response(reply: Reply) -> Response<Vec<u8>> {
    let mut response = Response::builder().status(reply.status);
    for (name, value) in &reply.headers {
        response = response.header(*name, value);
    }
    response
        .body(reply.body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp4_stream::fake::{fragment, ftyp, moov};
    use crate::vault::MAX_RANGE_RESPONSE;
    use std::path::Path;
    use uuid::Uuid;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    fn video(root: &Path) -> (VaultStore, Uuid) {
        let store = VaultStore::new(root.join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let id = store
            .recording_start(profile, vec![], "FAKE clip.mp4", 5)
            .unwrap();
        let mut movie = [ftyp(), moov()].concat();
        for n in 0..6_u64 {
            movie.extend(fragment(n as u32 + 1, n * 30000, n * 48128, 900_000));
        }
        for part in movie.chunks(300_000) {
            store.recording_append(id, part).unwrap();
        }
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        (store, record)
    }

    #[test]
    fn only_the_main_window_may_ask_and_a_refusal_is_as_bare_as_any_404() {
        assert!(webview_allowed("main"));
        for label in ["", "Main", "main ", "other", "main-2", "popup"] {
            assert!(!webview_allowed(label), "{label:?}");
        }
        let refusal = refused();
        assert_eq!(refusal.status(), 404);
        assert!(refusal.body().is_empty());
        assert_eq!(refusal.headers()["cache-control"], "no-store");
        assert_eq!(refusal.headers()["x-content-type-options"], "nosniff");
        // The scheme's registration asks both questions, off the UI thread.
        let library = include_str!("lib.rs");
        let registration = library
            .split("register_asynchronous_uri_scheme_protocol(")
            .nth(1)
            .expect("the scheme is registered asynchronously");
        let registration = &registration[..registration.find(".setup(").unwrap()];
        assert!(registration.contains("webview_allowed(context.webview_label())"));
        assert!(registration.contains("spawn_blocking("));
        assert!(registration.contains("video_scheme::refused()"));
    }

    #[test]
    fn only_get_and_head_are_answered() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        let path = format!("/{}", opened.token);
        for method in ["POST", "PUT", "DELETE", "OPTIONS", "PATCH", "get"] {
            let reply = answer(&store, method, &path, None);
            assert_eq!(reply.status, 405, "{method}");
            assert!(reply.body.is_empty());
        }
        assert_eq!(answer(&store, "GET", &path, Some("bytes=0-9")).status, 206);
        let head = answer(&store, "HEAD", &path, Some("bytes=0-9"));
        assert_eq!(head.status, 206);
        assert!(head.body.is_empty());
        assert!(head.headers.contains(&("Content-Length", "10".to_owned())));
    }

    #[test]
    fn nothing_but_a_live_token_is_served() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        let live = format!("/{}", opened.token);
        for path in [
            "/",
            "",
            "/..",
            "/../x",
            "/index.html",
            &format!("{live}/"),
            &format!("{live}/extra"),
            &format!("{live}?x=1"),
            &format!("/{}", opened.token.to_uppercase()),
            &format!("/{}", &opened.token[..63]),
            &format!("/{}0", opened.token),
            &format!("//{}", opened.token),
            &format!("/{record}"),
            &format!("/{}", "0".repeat(64)),
            &format!("/%{}", &opened.token[1..]),
        ] {
            let reply = answer(&store, "GET", path, Some("bytes=0-9"));
            assert_eq!(reply.status, 404, "{path}");
            assert!(reply.body.is_empty(), "{path}");
        }
        assert_eq!(answer(&store, "GET", &live, Some("bytes=0-9")).status, 206);
    }

    #[test]
    fn a_reply_says_what_it_carries_and_is_never_cached_or_sniffed() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        let path = format!("/{}", opened.token);
        let reply = answer(&store, "GET", &path, Some("bytes=10-19"));
        assert_eq!(reply.status, 206);
        assert_eq!(reply.body.len(), 10);
        let header = |name: &str| {
            reply
                .headers
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            header("Content-Range"),
            Some(format!("bytes 10-19/{}", opened.total_bytes))
        );
        assert_eq!(header("Content-Length").as_deref(), Some("10"));
        assert_eq!(header("Content-Type").as_deref(), Some("video/mp4"));
        assert_eq!(header("Accept-Ranges").as_deref(), Some("bytes"));
        assert_eq!(header("Cache-Control").as_deref(), Some("no-store"));
        assert_eq!(header("X-Content-Type-Options").as_deref(), Some("nosniff"));
        assert!(header("Access-Control-Allow-Origin").is_none());
        // The served file starts with the stored head: a movie that begins ftyp.
        let start = answer(&store, "GET", &path, Some("bytes=0-19"));
        assert_eq!(&start.body[4..8], b"ftyp");
        assert_eq!(&start.body[10..], &reply.body[..]);
    }

    #[test]
    fn a_request_without_a_range_gets_the_start_and_never_the_whole_file() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        assert!(opened.total_bytes > 2 * MAX_RANGE_RESPONSE);
        let reply = answer(&store, "GET", &format!("/{}", opened.token), None);
        assert_eq!(reply.status, 206);
        assert_eq!(reply.body.len() as u64, MAX_RANGE_RESPONSE);
    }

    #[test]
    fn a_range_that_cannot_be_met_is_416_with_the_size_and_reads_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        let path = format!("/{}", opened.token);
        let past = format!("bytes={}-", opened.total_bytes);
        for range in [
            past.as_str(),
            "bytes=-0",
            "bytes=9-3",
            "bytes=0-1,5-9",
            "items=0-9",
            "bytes=0-9 ",
            "bytes= 0-9",
            "bytes=+1-9",
            "bytes=0x10-20",
            "bytes=99999999999999999999-",
            "bytes=0-99999999999999999999",
            "bytes=--5",
            "bytes=",
            "",
            "garbage",
            &format!("bytes=0-{}", "9".repeat(200)),
        ] {
            let reply = answer(&store, "GET", &path, Some(range));
            assert_eq!(reply.status, 416, "{range:?}");
            assert!(reply.body.is_empty(), "{range:?}");
            assert!(
                reply
                    .headers
                    .contains(&("Content-Range", format!("bytes */{}", opened.total_bytes))),
                "{range:?}"
            );
        }
    }

    #[test]
    fn the_unreadable_range_header_a_webview_cannot_send_is_refused_too() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        let request = Request::builder()
            .method("GET")
            .uri(format!("{SCHEME}://localhost/{}", opened.token))
            .header("range", &[0xFF_u8, 0xFE][..])
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&store, &request).status(), 416);
        let fine = Request::builder()
            .method("GET")
            .uri(format!("http://{SCHEME}.localhost/{}", opened.token))
            .header("range", "bytes=0-3")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &fine);
        assert_eq!(response.status(), 206);
        assert_eq!(response.body().len(), 4);
        assert_eq!(response.headers()["content-type"], "video/mp4");
    }

    #[test]
    fn a_token_does_not_survive_a_lock_even_when_the_vault_is_opened_again() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record) = video(temp.path());
        let opened = store.playback_open(record).unwrap();
        let path = format!("/{}", opened.token);
        assert_eq!(answer(&store, "GET", &path, Some("bytes=0-3")).status, 206);
        store.lock();
        assert_eq!(answer(&store, "GET", &path, Some("bytes=0-3")).status, 404);
        store.unlock(PASSWORD).unwrap();
        assert_eq!(answer(&store, "GET", &path, Some("bytes=0-3")).status, 404);
        // A new unlock makes a new token, and not the old one.
        let again = store.playback_open(record).unwrap();
        assert_ne!(again.token, opened.token);
        assert_eq!(
            answer(
                &store,
                "GET",
                &format!("/{}", again.token),
                Some("bytes=0-3")
            )
            .status,
            206
        );
        // Locked: nothing can be opened.
        store.lock();
        assert!(store.playback_open(record).is_err());
    }
}
