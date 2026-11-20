//! Getting the default AI model from its pinned address, on the patient's
//! click (#72). Native code only: the page never makes this request, and
//! nothing about the patient or their documents is sent (a plain GET with no
//! cookies, no referrer, no proxy, no identifiers).
//!
//! The address and the hosts it may lead to are fixed here and in the
//! catalog entry: HTTPS only, TLS 1.2 or newer, the platform's certificate
//! verifier, no automatic redirects. Each redirect is checked by hand
//! against [`redirect_allowed`]; any other host ends the download. The bytes
//! then go through the same size check, SHA-256 stream, `.part` file and
//! rename-on-match as a picked file (`local_model::Store::download`).

#[cfg(not(target_os = "android"))]
use std::io::Read;
#[cfg(not(target_os = "android"))]
use std::time::{Duration, Instant};

use crate::local_model::{Accepted, Opened, Opener, OpenerError};

/// Hosts a pinned Hugging Face address may redirect to for the file's
/// bytes: its CDN (checked against what it really answers, 5 Nov 2026:
/// `us.aws.cdn.hf.co`; the older `cdn-lfs*` names are kept).
const REDIRECT_HOST_SUFFIXES: &[&str] = &[".cdn.hf.co"];
const REDIRECT_HOSTS: &[&str] = &["cdn-lfs.huggingface.co", "cdn-lfs.hf.co"];
const MAX_REDIRECTS: usize = 3;

/// Whether a redirect from the pinned address may go to `target`: parsed by
/// the same URL parser the HTTP client uses, then HTTPS on the default port,
/// no credentials, and the pinned host or its CDN.
pub(crate) fn redirect_allowed(pinned: &str, target: &str) -> bool {
    // A real CDN address never has a backslash; the URL standard reads one as
    // a path separator, which would hide what follows it. Refused before parsing.
    if target.contains('\\') || target.to_ascii_lowercase().contains("%5c") {
        return false;
    }
    let (Ok(pinned), Ok(target)) = (reqwest::Url::parse(pinned), reqwest::Url::parse(target))
    else {
        return false;
    };
    let (Some(pinned_host), Some(host)) = (pinned.host_str(), target.host_str()) else {
        return false;
    };
    pinned.scheme() == "https"
        && target.scheme() == "https"
        && target.port_or_known_default() == Some(443)
        && target.username().is_empty()
        && target.password().is_none()
        && (host == pinned_host
            || REDIRECT_HOSTS.contains(&host)
            || REDIRECT_HOST_SUFFIXES
                .iter()
                .any(|suffix| host.ends_with(suffix) && host.len() > suffix.len()))
}

/// The real network opener.
pub(crate) struct Https;

#[cfg(not(target_os = "android"))]
impl Opener for Https {
    fn open<'a>(
        &self,
        model: &Accepted,
        from: u64,
        cancelled: &'a dyn Fn() -> bool,
    ) -> Result<Opened<'a>, OpenerError> {
        let client = client().ok_or(OpenerError::Network)?;
        let pinned = model.source_url;
        let mut url = pinned.to_owned();
        let mut from = from;
        let handle = tauri::async_runtime::handle();
        for _ in 0..=MAX_REDIRECTS + 1 {
            let mut request = client.get(&url);
            if from > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
            }
            let response = handle
                .block_on(request.send())
                .map_err(|_| OpenerError::Network)?;
            let status = response.status();
            if status.is_redirection() {
                let next = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(OpenerError::BadRedirect)?
                    .to_owned();
                if !redirect_allowed(pinned, &next) {
                    return Err(OpenerError::BadRedirect);
                }
                url = next;
                continue;
            }
            let content_range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            match answer(
                status.as_u16(),
                from,
                response.content_length(),
                content_range.as_deref(),
            ) {
                Answer::FromStart => {
                    from = 0;
                    continue;
                }
                Answer::Body { size, start } => {
                    return Ok(Opened {
                        size,
                        start,
                        reader: Box::new(Body::new(response, cancelled)),
                    })
                }
                Answer::Failed(error) => return Err(error),
            }
        }
        Err(OpenerError::BadRedirect)
    }
}

/// What a server's answer (not a redirect) to a request from byte `from` means.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(target_os = "android", allow(dead_code))]
enum Answer {
    /// The file's bytes from `start`; `size` is the whole file's length, when said.
    Body {
        size: Option<u64>,
        start: u64,
    },
    /// It will not resume there: ask again for the whole file.
    FromStart,
    Failed(OpenerError),
}

/// A 200 is the whole file, whatever was asked. A 206 is accepted only for a resume, and
/// only when its `Content-Range` starts where asked and names the whole file's size. A 416
/// to a resume means asking again for the whole file.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn answer(status: u16, from: u64, length: Option<u64>, content_range: Option<&str>) -> Answer {
    match status {
        200 => Answer::Body {
            size: length,
            start: 0,
        },
        206 if from > 0 => match content_range.and_then(parse_content_range) {
            Some((start, total)) if start == from => Answer::Body {
                size: Some(total),
                start,
            },
            _ => Answer::Failed(OpenerError::Network),
        },
        416 if from > 0 => Answer::FromStart,
        401 | 403 => Answer::Failed(OpenerError::Denied),
        404 | 410 => Answer::Failed(OpenerError::Gone),
        _ => Answer::Failed(OpenerError::Network),
    }
}

#[cfg(target_os = "android")]
impl Opener for Https {
    fn open<'a>(
        &self,
        _: &Accepted,
        _: u64,
        _: &'a dyn Fn() -> bool,
    ) -> Result<Opened<'a>, OpenerError> {
        Err(OpenerError::Network)
    }
}

/// `bytes 100-199/200` → (start, total). `None` for anything else, including
/// an unknown total (`/*`).
#[cfg_attr(target_os = "android", allow(dead_code))]
fn parse_content_range(value: &str) -> Option<(u64, u64)> {
    let rest = value.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    Some((start.parse().ok()?, total.parse().ok()?))
}

#[cfg(not(target_os = "android"))]
fn client() -> Option<reqwest::Client> {
    use std::sync::Arc;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .ok()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            rustls_platform_verifier::Verifier::new(provider).ok()?,
        ))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .referer(false)
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(15))
        // No overall timeout: the file is 2 GB or more. A body that stops
        // arriving ends the download at `STALL` (see `Body`).
        .build()
        .ok()
}

/// A body that stops for this long ends the download.
#[cfg(not(target_os = "android"))]
const STALL: Duration = Duration::from_secs(30);

/// The response body as a blocking reader, which looks at the cancel flag
/// twice a second.
#[cfg(not(target_os = "android"))]
struct Body<'a> {
    response: reqwest::Response,
    chunk: Vec<u8>,
    taken: usize,
    cancelled: &'a (dyn Fn() -> bool + 'a),
}

#[cfg(not(target_os = "android"))]
impl<'a> Body<'a> {
    fn new(response: reqwest::Response, cancelled: &'a (dyn Fn() -> bool + 'a)) -> Self {
        Self {
            response,
            chunk: Vec::new(),
            taken: 0,
            cancelled,
        }
    }
}

#[cfg(not(target_os = "android"))]
impl Read for Body<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        use std::io::{Error, ErrorKind};
        if self.taken >= self.chunk.len() {
            let handle = tauri::async_runtime::handle();
            let started = Instant::now();
            loop {
                if (self.cancelled)() {
                    return Err(Error::new(ErrorKind::Interrupted, "cancelled"));
                }
                // The timer is made inside the runtime, not before it is entered.
                match handle.block_on(async {
                    tokio::time::timeout(Duration::from_millis(500), self.response.chunk()).await
                }) {
                    Ok(Ok(Some(bytes))) => {
                        self.chunk = bytes.to_vec();
                        self.taken = 0;
                        break;
                    }
                    Ok(Ok(None)) => return Ok(0),
                    Ok(Err(_)) => return Err(Error::new(ErrorKind::ConnectionReset, "network")),
                    Err(_) if started.elapsed() > STALL => {
                        return Err(Error::new(ErrorKind::TimedOut, "stalled"))
                    }
                    Err(_) => {}
                }
            }
        }
        let rest = &self.chunk[self.taken..];
        let n = rest.len().min(out.len());
        out[..n].copy_from_slice(&rest[..n]);
        self.taken += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PINNED: &str = "https://huggingface.co/org/repo/resolve/0123abcd/file.gguf";

    #[test]
    fn only_the_pinned_host_and_its_cdn_over_https_are_followed() {
        let ok = [
            "https://us.aws.cdn.hf.co/xet-bridge-us/abc?x=1",
            "https://cdn-lfs.huggingface.co/repos/ab/cd/file",
            "https://huggingface.co/other/path",
            "https://US.AWS.CDN.HF.CO:443/xet?a=b",
        ];
        for target in ok {
            assert!(redirect_allowed(PINNED, target), "{target}");
        }
        let refused = [
            "http://us.aws.cdn.hf.co/x",
            "https://evil.example/x",
            "https://cdn.hf.co.evil.example/x",
            "https://cdn.hf.co/x",
            "https://notcdn.hf.co/x",
            "https://user@us.aws.cdn.hf.co/x",
            "https://us.aws.cdn.hf.co:8443/x",
            "https://huggingface.co.evil.example/x",
            "ftp://us.aws.cdn.hf.co/x",
            "https://us.aws.cdn.hf.co\\@evil.example/x",
            "https://evil.example\\@us.aws.cdn.hf.co/x",
            "https://us.aws.cdn.hf.co:444/x",
            "https://US.AWS.CDN.HF.CO.evil.example/x",
            "/relative/path",
            "",
        ];
        for target in refused {
            assert!(!redirect_allowed(PINNED, target), "{target}");
        }
        assert!(!redirect_allowed(
            "http://huggingface.co/x",
            "https://huggingface.co/y"
        ));
    }

    /// Needs the network: `cargo test -- --ignored live_download`. Starts the
    /// real download, reads 8 MiB through the same reader the app uses and
    /// cancels. Proves the redirect hosts, TLS and the announced size.
    #[test]
    #[ignore]
    fn live_download_starts_reads_and_cancels() {
        use crate::local_model::{Opener, CATALOG};
        use std::sync::atomic::{AtomicBool, Ordering};
        let stop = AtomicBool::new(false);
        let cancelled = || stop.load(Ordering::SeqCst);
        let mut opened = Https.open(&CATALOG[0], 0, &cancelled).unwrap();
        assert_eq!(opened.size, Some(CATALOG[0].size_bytes));
        let mut buffer = vec![0u8; 1 << 20];
        let mut total = 0usize;
        while total < 8 << 20 {
            let n = std::io::Read::read(&mut opened.reader, &mut buffer).unwrap();
            assert!(n > 0);
            total += n;
        }
        stop.store(true, Ordering::SeqCst);
        let error = std::io::Read::read(&mut opened.reader, &mut buffer).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        // And a resume from 1 GiB: the server answers 206 from there, with the
        // whole file's size.
        let stop = AtomicBool::new(false);
        let cancelled = || stop.load(Ordering::SeqCst);
        let mut resumed = Https.open(&CATALOG[0], 1 << 30, &cancelled).unwrap();
        assert_eq!(resumed.start, 1 << 30);
        assert_eq!(resumed.size, Some(CATALOG[0].size_bytes));
        let n = std::io::Read::read(&mut resumed.reader, &mut buffer).unwrap();
        assert!(n > 0);
    }

    #[test]
    fn a_content_range_is_read_or_refused() {
        assert_eq!(parse_content_range("bytes 100-199/200"), Some((100, 200)));
        assert_eq!(parse_content_range("bytes 0-9/10"), Some((0, 10)));
        for bad in [
            "bytes 100-199/*",
            "items 1-2/3",
            "bytes -5/10",
            "bytes a-b/c",
            "",
        ] {
            assert_eq!(parse_content_range(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_resume_is_taken_only_from_where_it_was_asked_and_a_refused_one_starts_again() {
        use Answer::{Body, Failed, FromStart};
        // The whole file, asked from the start or not: from 0, with its announced length.
        let whole = Body {
            size: Some(10),
            start: 0,
        };
        assert_eq!(answer(200, 0, Some(10), None), whole);
        assert_eq!(answer(200, 4, Some(10), None), whole);
        // The rest, from where it was asked: the whole file's size from Content-Range.
        assert_eq!(
            answer(206, 4, Some(6), Some("bytes 4-9/10")),
            Body {
                size: Some(10),
                start: 4
            }
        );
        // From elsewhere, with no range or an unknown total, or not asked for: refused.
        for range in [
            Some("bytes 5-9/10"),
            Some("bytes 0-9/10"),
            Some("bytes 4-9/*"),
            None,
        ] {
            assert_eq!(
                answer(206, 4, Some(6), range),
                Failed(OpenerError::Network),
                "{range:?}"
            );
        }
        assert_eq!(
            answer(206, 0, Some(10), Some("bytes 0-9/10")),
            Failed(OpenerError::Network)
        );
        // 416: it will not resume there, so the whole file is asked for; to a whole-file
        // request it is a failure.
        assert_eq!(answer(416, 4, None, None), FromStart);
        assert_eq!(answer(416, 0, None, None), Failed(OpenerError::Network));
        // The refusals keep their meaning on a resume.
        assert_eq!(answer(401, 4, None, None), Failed(OpenerError::Denied));
        assert_eq!(answer(403, 0, None, None), Failed(OpenerError::Denied));
        assert_eq!(answer(404, 4, None, None), Failed(OpenerError::Gone));
        assert_eq!(answer(410, 0, None, None), Failed(OpenerError::Gone));
        assert_eq!(answer(500, 4, None, None), Failed(OpenerError::Network));
    }

    #[test]
    fn the_shipped_address_is_https_and_commit_pinned_on_huggingface() {
        for model in crate::local_model::CATALOG {
            assert!(model.source_url.starts_with("https://huggingface.co/"));
            assert!(model.source_url.contains("/resolve/"));
            let commit = model.source_url.split("/resolve/").nth(1).unwrap();
            let commit = commit.split('/').next().unwrap();
            assert_eq!(commit.len(), 40);
            assert!(commit.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }
}
