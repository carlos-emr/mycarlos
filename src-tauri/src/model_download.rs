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
        cancelled: &'a dyn Fn() -> bool,
    ) -> Result<Opened<'a>, OpenerError> {
        let client = client().ok_or(OpenerError::Network)?;
        let pinned = model.source_url;
        let mut url = pinned.to_owned();
        let handle = tauri::async_runtime::handle();
        for _ in 0..=MAX_REDIRECTS {
            let response = handle
                .block_on(client.get(&url).send())
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
            return match status.as_u16() {
                200 => {
                    let size = response.content_length();
                    Ok(Opened {
                        size,
                        reader: Box::new(Body::new(response, cancelled)),
                    })
                }
                401 | 403 => Err(OpenerError::Denied),
                404 | 410 => Err(OpenerError::Gone),
                _ => Err(OpenerError::Network),
            };
        }
        Err(OpenerError::BadRedirect)
    }
}

#[cfg(target_os = "android")]
impl Opener for Https {
    fn open<'a>(&self, _: &Accepted, _: &'a dyn Fn() -> bool) -> Result<Opened<'a>, OpenerError> {
        Err(OpenerError::Network)
    }
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
                match handle.block_on(tokio::time::timeout(
                    Duration::from_millis(500),
                    self.response.chunk(),
                )) {
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
        let mut opened = Https.open(&CATALOG[0], &cancelled).unwrap();
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
