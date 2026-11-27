//! The production HTTP boundary for the gated native portal flow. Destinations
//! come only from saved consented links; renderer input cannot select API routes.

use crate::portal_link::{LinkError, LinkRequest, LinkedClinic};

/// Whether this build can reach a portal. Everywhere but Android: always. On Android only once the
/// platform certificate verifier has been given the application context (the android-trust plugin
/// does it when it loads): until then, and for good if that failed, the connection is closed and
/// Settings does not offer linking.
pub fn available() -> bool {
    connection_possible(cfg!(target_os = "android"), verifier_ready())
}

/// The rule behind `available`, free of the platform so a unit test can drive both sides of it.
const fn connection_possible(android: bool, verifier_ready: bool) -> bool {
    !android || verifier_ready
}

/// Whether the platform verifier can be asked: always, except on Android, where it needs the JVM
/// and the application context first (and panics if asked without them).
fn verifier_ready() -> bool {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_android_trust::verifier_ready()
    }
    #[cfg(not(target_os = "android"))]
    {
        true
    }
}

pub fn link(
    request: LinkRequest,
    expected_device: &str,
    cancelled: impl Fn() -> bool,
) -> Result<LinkedClinic, LinkError> {
    if cancelled() {
        return Err(LinkError::Cancelled);
    }
    {
        use crate::portal_link::{parse_response, MAX_RESPONSE_BYTES};

        let client = client()?;
        let exchange = async {
            let mut response = client
                .post(request.endpoint)
                .header("Content-Type", "application/json")
                .header("X-MyCarlos-Device-Assertion", request.assertion)
                .body(request.body.to_vec())
                .send()
                .await
                .map_err(|_| LinkError::Network)?;
            if cancelled() {
                return Err(LinkError::Cancelled);
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
            {
                return Err(LinkError::InvalidResponse);
            }
            let status = response.status();
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            while let Some(chunk) = response.chunk().await.map_err(|_| LinkError::Network)? {
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return Err(LinkError::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            if cancelled() {
                return Err(LinkError::Cancelled);
            }
            if status.as_u16() != 200 {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Rejected {
                    code: String,
                }
                let code = serde_json::from_slice::<Rejected>(&bytes).ok();
                return Err(
                    match (status.as_u16(), code.as_ref().map(|r| r.code.as_str())) {
                        (403, Some("link_code_invalid")) => LinkError::CodeRejected,
                        (409, Some("clinic_keys_missing")) => LinkError::ClinicKeysMissing,
                        (409, Some("device_exists")) => LinkError::DeviceExists,
                        _ => LinkError::Network,
                    },
                );
            }
            parse_response(&bytes, expected_device)
        };
        // Drop the in-flight send/body future on lock. The request timeout is
        // still a separate bound for an unresponsive portal or resolver.
        tauri::async_runtime::block_on(async {
            tokio::select! {
                biased;
                _ = async {
                    loop {
                        if cancelled() { break; }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                } => Err(LinkError::Cancelled),
                result = exchange => result,
            }
        })
    }
}

/// The three time limits of a client: connecting, each read of a reply, and the whole exchange.
struct Timeouts {
    connect: std::time::Duration,
    read: std::time::Duration,
    total: std::time::Duration,
}

/// What a shipped client waits.
const RELEASE_TIMEOUTS: Timeouts = Timeouts {
    connect: std::time::Duration::from_secs(10),
    // A body that stops arriving fails here, whatever its size.
    read: std::time::Duration::from_secs(30),
    total: std::time::Duration::from_secs(30),
};

/// The one place every setting of the portal client is made: TLS 1.2 and 1.3 only, HTTPS only, no
/// redirect, no retry, no proxy, no referrer, no kept-alive connection, and the time limits given.
/// The shipped `client()` calls it with the platform's verifier and `RELEASE_TIMEOUTS`; the library's
/// tests call the same function with a test root and short timeouts, so what they run is what ships.
fn build_client(
    provider: std::sync::Arc<rustls::crypto::CryptoProvider>,
    verifier: std::sync::Arc<dyn rustls::client::danger::ServerCertVerifier>,
    timeouts: Timeouts,
) -> Result<reqwest::Client, LinkError> {
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|_| LinkError::Network)?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .referer(false)
        .pool_max_idle_per_host(0)
        .connect_timeout(timeouts.connect)
        .read_timeout(timeouts.read)
        .timeout(timeouts.total)
        .build()
        .map_err(|_| LinkError::Network)
}

#[cfg(not(test))]
fn client() -> Result<reqwest::Client, LinkError> {
    use std::sync::Arc;
    // The platform verifier on Android panics if asked before the JVM and the application context
    // were given to it: no client is built until they were (fail closed, never a panic on a thread).
    if !verifier_ready() {
        return Err(LinkError::Network);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(
        rustls_platform_verifier::Verifier::new(provider.clone())
            .map_err(|_| LinkError::Network)?,
    );
    build_client(provider, verifier, RELEASE_TIMEOUTS)
}

/// The same client in the library's tests: built by the `network_tests` module with the same
/// hardening, with a test root and a short read timeout when a test asks for them. Compiled in tests
/// only; the release `client()` above has no such path.
#[cfg(test)]
fn client() -> Result<reqwest::Client, LinkError> {
    network_tests::test_client()
}

/// The total time allowed for one API request whose reply may be up to `max`
/// bytes. Small replies keep 30 s. A package download also gets the time it
/// takes at a slow but steady rate, so it isn't cut off just for being large,
/// up to an overall cap. A stalled body still fails at the read timeout.
pub(crate) fn request_timeout(max: usize) -> std::time::Duration {
    use std::time::Duration;
    const BASE: Duration = Duration::from_secs(30);
    // About 256 kbit/s.
    const SLOWEST_STEADY_BYTES_PER_SECOND: u64 = 32 * 1024;
    const CAP: Duration = Duration::from_secs(15 * 60);
    let transfer = Duration::from_secs((max as u64).div_ceil(SLOWEST_STEADY_BYTES_PER_SECOND));
    BASE.max(transfer).min(CAP)
}

pub(crate) struct ApiResponse {
    pub status: u16,
    pub body: zeroize::Zeroizing<Vec<u8>>,
    /// The portal's clock when it replied (Unix seconds), from its `Date`
    /// header. It is not signed: it may only show how long a request has
    /// left, and never decides a state (#131).
    pub date: Option<u64>,
    /// The seconds the portal asked to wait (`Retry-After`), if it said.
    pub retry_after: Option<u64>,
}

/// An HTTP date in its only current form (RFC 9110 IMF-fixdate, such as
/// `Sun, 06 Nov 1994 08:49:37 GMT`), as Unix seconds. The obsolete forms, a
/// day the month does not have, a weekday that does not match the date, and
/// anything else give `None`.
pub(crate) fn http_date(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() != 29
        || &bytes[3..5] != b", "
        || bytes[7] != b' '
        || bytes[11] != b' '
        || bytes[16] != b' '
        || bytes[19] != b':'
        || bytes[22] != b':'
        || &bytes[25..] != b" GMT"
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u64> {
        let digits = text.get(range)?;
        digits
            .bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| digits.parse().ok())?
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS.iter().position(|m| text.get(8..11) == Some(m))? as u64 + 1;
    let (day, year) = (number(5..7)?, number(12..16)?);
    let (hour, minute, second) = (number(17..19)?, number(20..22)?, number(23..25)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1970..=9999).contains(&year)
        || !(1..=month_days[month as usize - 1]).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days since 1970-01-01 in the proleptic Gregorian calendar.
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y / 400;
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    // 1970-01-01 was a Thursday.
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    if text.get(0..3) != Some(WEEKDAYS[(days % 7) as usize]) {
        return None;
    }
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// `Retry-After` as seconds to wait. Only its number form is read: its date
/// form depends on the clocks agreeing.
pub(crate) fn retry_after_seconds(text: &str) -> Option<u64> {
    let text = text.trim();
    (!text.is_empty() && text.len() <= 9 && text.bytes().all(|c| c.is_ascii_digit()))
        .then(|| text.parse().ok())?
}

pub(crate) fn api(
    link: &crate::portal_link::StoredLink,
    method: &str,
    suffix: &str,
    body: Vec<u8>,
    anchor: Option<&str>,
    max: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<ApiResponse, LinkError> {
    if cancelled() {
        return Err(LinkError::Cancelled);
    }
    {
        use crate::portal_link::frame;
        use serde::Serialize;
        use sha2::{Digest, Sha256};
        // All callers construct a fixed /api/mycarlos/ route, never a returned
        // download address. The saved portal base is the sole destination.
        if !suffix.starts_with("/api/mycarlos/") || suffix.contains('#') || body.len() > 32768 {
            return Err(LinkError::InvalidResponse);
        }
        let endpoint = tauri::Url::parse(&format!("{}{}", link.portal_base, suffix))
            .map_err(|_| LinkError::InvalidPortal)?;
        let clinic = link.clinic.as_ref().ok_or(LinkError::InvalidResponse)?;
        let request_hash: String = Sha256::digest(frame(&[
            method.as_bytes(),
            endpoint.path().as_bytes(),
            endpoint.query().unwrap_or("").as_bytes(),
            &body,
        ]))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
        #[derive(Serialize)]
        struct Claims<'a> {
            aud: &'a str,
            exp: u64,
            iat: u64,
            iss: &'a str,
            jti: uuid::Uuid,
            kid: String,
            recipient_id: &'a str,
            request_hash: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            vault_head_link: Option<&'a str>,
        }
        let now = crate::now_ms() / 1000;
        let payload = serde_json::to_vec(&Claims {
            aud: "carlos-patient-portal-device-api",
            exp: now + 60,
            iat: now,
            iss: "mycarlos",
            jti: uuid::Uuid::new_v4(),
            kid: link.keys.device_key_id(),
            recipient_id: &clinic.recipient_id,
            request_hash,
            vault_head_link: anchor,
        })
        .map_err(|_| LinkError::InvalidResponse)?;
        let assertion = link.keys.sign(&payload);
        send_signed(
            endpoint,
            method,
            "X-MyCarlos-Device-Assertion",
            assertion,
            body,
            max,
            cancelled,
        )
    }
}

/// The waiting key's request (#230): a locked myCarlos asks the Portal whether anything waits
/// for its device, or gives its key up. Signed by the notice key alone (audience
/// `carlos-patient-portal-waiting-check`, claims `aud iss kid jti iat exp request_hash`, no
/// recipient), never by the device key, which is in the vault. Only the two waiting routes are
/// reachable from here.
pub(crate) fn waiting_api(
    entry: &crate::notice_key::NoticeKeyEntry,
    method: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<ApiResponse, LinkError> {
    use crate::portal_link::frame;
    use base64::Engine as _;
    use ed25519_dalek::Signer;
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    if cancelled() {
        return Err(LinkError::Cancelled);
    }
    if method != "POST" && method != "DELETE" {
        return Err(LinkError::InvalidResponse);
    }
    let endpoint = tauri::Url::parse(&format!(
        "{}{}",
        entry.portal_origin,
        crate::tray_notices::WAITING
    ))
    .map_err(|_| LinkError::InvalidPortal)?;
    let body = serde_json::to_vec(&serde_json::json!({ "key_id": entry.key_id }))
        .map_err(|_| LinkError::InvalidResponse)?;
    let request_hash: String = Sha256::digest(frame(&[
        method.as_bytes(),
        endpoint.path().as_bytes(),
        endpoint.query().unwrap_or("").as_bytes(),
        &body,
    ]))
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect();
    #[derive(Serialize)]
    struct Claims<'a> {
        aud: &'a str,
        exp: u64,
        iat: u64,
        iss: &'a str,
        jti: uuid::Uuid,
        kid: &'a str,
        request_hash: String,
    }
    let now = crate::now_ms() / 1000;
    let payload = serde_json::to_vec(&Claims {
        aud: "carlos-patient-portal-waiting-check",
        exp: now + 60,
        iat: now,
        iss: "mycarlos",
        jti: uuid::Uuid::new_v4(),
        kid: &entry.key_id,
        request_hash,
    })
    .map_err(|_| LinkError::InvalidResponse)?;
    let key = entry.signing_key().ok_or(LinkError::InvalidResponse)?;
    let signature = key.sign(&payload);
    let assertion = format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&payload),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );
    send_signed(
        endpoint,
        method,
        "X-MyCarlos-Waiting-Assertion",
        assertion,
        body,
        MAX_WAITING_REPLY,
        cancelled,
    )
}

/// A waiting answer is 17 bytes; a refusal's body is a few more.
const MAX_WAITING_REPLY: usize = 512;

/// Sends one signed request, with the pinned-TLS client, the size and time limits and the
/// cancellation every Portal call has.
fn send_signed(
    endpoint: tauri::Url,
    method: &str,
    header: &'static str,
    assertion: String,
    body: Vec<u8>,
    max: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<ApiResponse, LinkError> {
    {
        let client = client()?;
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| LinkError::InvalidResponse)?;
        let exchange = async {
            let mut response = client
                .request(method, endpoint)
                .timeout(request_timeout(max))
                .header("Content-Type", "application/json")
                .header(header, assertion)
                .body(body)
                .send()
                .await
                .map_err(|_| LinkError::Network)?;
            if cancelled() {
                return Err(LinkError::Cancelled);
            }
            if response.content_length().is_some_and(|n| n > max as u64) {
                return Err(LinkError::InvalidResponse);
            }
            let status = response.status().as_u16();
            let header = |name| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value: &reqwest::header::HeaderValue| value.to_str().ok())
            };
            let date = header(reqwest::header::DATE).and_then(http_date);
            let retry_after = header(reqwest::header::RETRY_AFTER).and_then(retry_after_seconds);
            let mut body = zeroize::Zeroizing::new(Vec::new());
            while let Some(chunk) = response.chunk().await.map_err(|_| LinkError::Network)? {
                if cancelled() {
                    return Err(LinkError::Cancelled);
                }
                if body.len().saturating_add(chunk.len()) > max {
                    return Err(LinkError::InvalidResponse);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(ApiResponse {
                status,
                body,
                date,
                retry_after,
            })
        };
        tauri::async_runtime::block_on(async {
            tokio::select! { biased;
                _=async {loop {if cancelled(){break;} tokio::time::sleep(std::time::Duration::from_millis(50)).await;}}=>Err(LinkError::Cancelled),
                result=exchange=>result,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_current_http_dates_as_unix_seconds() {
        // RFC 9110's own example, and the start of Unix time.
        assert_eq!(
            http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777)
        );
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        // A leap day of a year divisible by 400, and the last day of a year.
        assert_eq!(
            http_date("Tue, 29 Feb 2000 00:00:00 GMT"),
            Some(951_782_400)
        );
        assert_eq!(
            http_date("Thu, 31 Dec 2026 23:59:59 GMT"),
            Some(1_798_761_599)
        );
        // A leap day and the first day after a February.
        assert_eq!(
            http_date("Thu, 29 Feb 2024 12:00:00 GMT"),
            Some(1_709_208_000)
        );
        assert_eq!(
            http_date("Fri, 01 Mar 2024 00:00:00 GMT"),
            Some(1_709_251_200)
        );
        for refused in [
            "",
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun Nov  6 08:49:37 1994",
            "Sun, 06 Nov 1994 08:49:37 UTC",
            "Sun, 06 Foo 1994 08:49:37 GMT",
            "Sun, 6  Nov 1994 08:49:37 GMT",
            "Sun, 06 Nov 1994 24:00:00 GMT",
            "Sun, 00 Nov 1994 08:49:37 GMT",
            "Sun, 06 Nov 1969 23:59:59 GMT",
            "Sun, +6 Nov 1994 08:49:37 GMT",
            // Days the month does not have, and a wrong weekday.
            "Sat, 31 Feb 2024 00:00:00 GMT",
            "Sun, 29 Feb 2026 00:00:00 GMT",
            "Mon, 29 Feb 1900 00:00:00 GMT",
            "Fri, 31 Apr 2026 00:00:00 GMT",
            "Mon, 06 Nov 1994 08:49:37 GMT",
        ] {
            assert_eq!(http_date(refused), None, "{refused}");
        }
    }

    #[test]
    fn reads_only_the_number_form_of_retry_after() {
        assert_eq!(retry_after_seconds("30"), Some(30));
        assert_eq!(retry_after_seconds(" 120 "), Some(120));
        assert_eq!(retry_after_seconds("0"), Some(0));
        for refused in [
            "",
            "-5",
            "1.5",
            "Sun, 06 Nov 1994 08:49:37 GMT",
            "9999999999",
        ] {
            assert_eq!(retry_after_seconds(refused), None, "{refused}");
        }
    }
}

#[cfg(test)]
mod timeout_tests {
    use super::request_timeout;
    use std::time::Duration;

    #[test]
    fn should_keep_30_seconds_for_listings_and_receipts() {
        assert_eq!(request_timeout(8192), Duration::from_secs(30));
        assert_eq!(request_timeout(524288), Duration::from_secs(30));
    }

    #[test]
    fn should_let_the_largest_package_arrive_over_a_slow_steady_connection() {
        let largest = crate::portal_delivery::MAX_SEALED;
        // At 1 Mbit/s (125,000 bytes a second) the largest package takes
        // about 168 s, far past the old 30 s total for the whole body.
        let at_one_megabit = Duration::from_secs_f64(largest as f64 / 125_000.0);
        assert!(request_timeout(largest) > at_one_megabit);
        // Also at the slowest steady rate allowed, about 256 kbit/s.
        let at_floor = Duration::from_secs_f64(largest as f64 / 32_768.0);
        assert!(request_timeout(largest) >= at_floor);
    }

    #[test]
    fn should_cap_the_total_time_for_any_size() {
        assert_eq!(request_timeout(usize::MAX), Duration::from_secs(15 * 60));
    }
}

/// The real network layer against a loopback HTTPS server with a test-only root: what the portal
/// client sends and how it reads, limits and refuses what comes back. The certificates are
/// throwaway fixtures (`tests/fixtures/portal-test-pki/README.md`); the test root reaches the client
/// only through the `cfg(test)` `client()` above, so no shipped build can trust it.
#[cfg(test)]
mod network_tests {
    use super::*;
    use crate::portal_link::{LinkRequest, MAX_RESPONSE_BYTES};
    use base64::Engine as _;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use std::{
        cell::RefCell,
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    const CA: &str = include_str!("../tests/fixtures/portal-test-pki/ca.der.b64");
    const LEAF: &str = include_str!("../tests/fixtures/portal-test-pki/leaf.der.b64");
    const LEAF_KEY: &str = include_str!("../tests/fixtures/portal-test-pki/leaf.pkcs8.b64");
    const OTHER: &str = include_str!("../tests/fixtures/portal-test-pki/other.der.b64");
    const OTHER_KEY: &str = include_str!("../tests/fixtures/portal-test-pki/other.pkcs8.b64");

    fn der(text: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .unwrap()
    }

    // ---- the test-only seam: which root the test client trusts, and how long it waits for a read ----

    struct Seam {
        roots: Vec<Vec<u8>>,
        read_timeout: Duration,
    }

    thread_local! {
        static TEST_NETWORK: RefCell<Option<Seam>> = const { RefCell::new(None) };
    }

    /// Holds the seam for one test; gone when the test ends.
    struct Trusting;

    impl Trusting {
        fn test_root(read_timeout: Duration) -> Trusting {
            TEST_NETWORK.with(|seam| {
                *seam.borrow_mut() = Some(Seam {
                    roots: vec![der(CA)],
                    read_timeout,
                });
            });
            Trusting
        }
    }

    impl Drop for Trusting {
        fn drop(&mut self) {
            TEST_NETWORK.with(|seam| *seam.borrow_mut() = None);
        }
    }

    /// The client the tests use: `build_client`, the function the shipped client is built by, with the
    /// platform verifier and the real timeouts unless a test installed its root and a read timeout.
    pub(super) fn test_client() -> Result<reqwest::Client, LinkError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let seam = TEST_NETWORK.with(|seam| {
            seam.borrow()
                .as_ref()
                .map(|seam| (seam.roots.clone(), seam.read_timeout))
        });
        let Some((roots, read)) = seam else {
            let verifier = Arc::new(
                rustls_platform_verifier::Verifier::new(provider.clone())
                    .map_err(|_| LinkError::Network)?,
            );
            return build_client(provider, verifier, RELEASE_TIMEOUTS);
        };
        let mut store = rustls::RootCertStore::empty();
        for root in roots {
            store.add(CertificateDer::from(root)).unwrap();
        }
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(store),
            provider.clone(),
        )
        .build()
        .unwrap();
        build_client(
            provider,
            verifier,
            Timeouts {
                connect: Duration::from_secs(10),
                read,
                total: Duration::from_secs(30),
            },
        )
    }

    // ---- a small blocking HTTPS server ----

    #[derive(Clone, Debug)]
    struct Captured {
        method: String,
        target: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Captured {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
    }

    /// What the server does with a request.
    enum Step {
        /// Writes these bytes and closes.
        Reply(Vec<u8>),
        /// Writes these bytes (a start the client cannot finish), then says nothing for this long.
        ReplyThenStall(Vec<u8>, Duration),
    }

    fn http(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n").into_bytes();
        for (name, value) in headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        out.extend_from_slice(body);
        out
    }

    fn chunked(status: u16, headers: &[(&str, &str)], chunks: &[&[u8]]) -> Vec<u8> {
        let mut out =
            format!("HTTP/1.1 {status} X\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n")
                .into_bytes();
        for (name, value) in headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        for chunk in chunks {
            out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            out.extend_from_slice(chunk);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    struct Server {
        port: u16,
        seen: Arc<Mutex<Vec<Captured>>>,
        accepted: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
        }
    }

    impl Server {
        fn base(&self) -> String {
            format!("https://127.0.0.1:{}", self.port)
        }
        fn requests(&self) -> Vec<Captured> {
            self.seen.lock().unwrap().clone()
        }
        fn accepted(&self) -> usize {
            self.accepted.load(Ordering::Acquire)
        }
    }

    fn read_request(stream: &mut impl Read) -> Option<Captured> {
        let mut raw = Vec::new();
        let mut byte = [0u8; 1];
        while !raw.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).ok()? == 0 {
                return None;
            }
            raw.push(byte[0]);
            if raw.len() > 64 * 1024 {
                return None;
            }
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        let mut lines = text.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
        let headers: Vec<(String, String)> = lines
            .filter(|line| !line.is_empty())
            .filter_map(|line| line.split_once(": "))
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect();
        let length = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        stream.read_exact(&mut body).ok()?;
        Some(Captured {
            method,
            target,
            headers,
            body,
        })
    }

    /// Serves with the certificate of `name` ("leaf" for 127.0.0.1, "other" for another host name).
    fn serve_as(name: &str, script: impl Fn(&Captured) -> Step + Send + Sync + 'static) -> Server {
        let (cert, key) = match name {
            "leaf" => (der(LEAF), der(LEAF_KEY)),
            _ => (der(OTHER), der(OTHER_KEY)),
        };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = Arc::new(
            rustls::ServerConfig::builder_with_provider(provider)
                .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(cert)],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
                )
                .unwrap(),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let accepted = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let script = Arc::new(script);
        let (seen2, accepted2, stop2) = (seen.clone(), accepted.clone(), stop.clone());
        thread::spawn(move || {
            while !stop2.load(Ordering::Acquire) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                };
                accepted2.fetch_add(1, Ordering::AcqRel);
                let (config, script, seen) = (config.clone(), script.clone(), seen2.clone());
                thread::spawn(move || {
                    stream.set_nonblocking(false).ok();
                    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
                    let connection = match rustls::ServerConnection::new(config) {
                        Ok(connection) => connection,
                        Err(_) => return,
                    };
                    let mut tls = rustls::StreamOwned::new(connection, stream);
                    let Some(request) = read_request(&mut tls) else {
                        return;
                    };
                    seen.lock().unwrap().push(request.clone());
                    match script(&request) {
                        Step::Reply(bytes) => {
                            let _ = tls.write_all(&bytes);
                            let _ = tls.flush();
                            tls.conn.send_close_notify();
                            let _ = tls.flush();
                        }
                        Step::ReplyThenStall(bytes, wait) => {
                            let _ = tls.write_all(&bytes);
                            let _ = tls.flush();
                            thread::sleep(wait);
                        }
                    }
                });
            }
        });
        Server {
            port,
            seen,
            accepted,
            stop,
        }
    }

    fn serve(script: impl Fn(&Captured) -> Step + Send + Sync + 'static) -> Server {
        serve_as("leaf", script)
    }

    // ---- fixtures ----

    fn link_to(base: &str) -> crate::portal_link::StoredLink {
        let (_, mut link, _) = crate::portal_approval::first_fixture();
        link.portal_base = base.to_owned();
        link
    }

    const ROUTE: &str = "/api/mycarlos/test-route";
    const NEVER: fn() -> bool = || false;

    fn call(
        link: &crate::portal_link::StoredLink,
        body: &[u8],
        max: usize,
    ) -> Result<ApiResponse, LinkError> {
        api(link, "POST", ROUTE, body.to_vec(), None, max, &NEVER)
    }

    fn payload_of(assertion: &str) -> serde_json::Value {
        let (payload, _) = assertion.split_once('.').unwrap();
        serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap(),
        )
        .unwrap()
    }

    // ---- api / send_signed ----

    #[test]
    fn should_return_status_body_date_and_retry_after_when_the_portal_answers() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| {
            Step::Reply(http(
                200,
                &[
                    ("Date", "Sun, 06 Nov 1994 08:49:37 GMT"),
                    ("Retry-After", "17"),
                ],
                b"{\"ok\":true}",
            ))
        });
        let reply = call(&link_to(&server.base()), b"{}", 4096).unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(&reply.body[..], b"{\"ok\":true}");
        assert_eq!(reply.date, Some(784_111_777));
        assert_eq!(reply.retry_after, Some(17));
    }

    #[test]
    fn should_ignore_an_unreadable_date_and_retry_after_and_a_missing_one() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|request| {
            let headers: &[(&str, &str)] = match request.target.as_str() {
                "/api/mycarlos/old-date" => &[
                    ("Date", "Sunday, 06-Nov-94 08:49:37 GMT"),
                    ("Retry-After", "Sun, 06 Nov 1994 08:49:37 GMT"),
                ],
                "/api/mycarlos/wrong-weekday" => &[("Date", "Mon, 06 Nov 1994 08:49:37 GMT")],
                _ => &[],
            };
            Step::Reply(http(200, headers, b"x"))
        });
        let link = link_to(&server.base());
        for route in [
            "/api/mycarlos/old-date",
            "/api/mycarlos/wrong-weekday",
            "/api/mycarlos/none",
        ] {
            let reply = api(&link, "GET", route, Vec::new(), None, 64, &NEVER).unwrap();
            assert_eq!(reply.date, None, "{route}");
            assert_eq!(reply.retry_after, None, "{route}");
        }
    }

    #[test]
    fn should_pass_every_status_through_with_its_body_for_the_callers_to_map() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|request| {
            let status: u16 = request.target.rsplit('/').next().unwrap().parse().unwrap();
            let retry = [("Retry-After", "30")];
            let headers: &[(&str, &str)] = if status == 429 || status == 503 {
                &retry
            } else {
                &[]
            };
            Step::Reply(http(status, headers, format!("code {status}").as_bytes()))
        });
        let link = link_to(&server.base());
        for status in [400u16, 401, 403, 404, 409, 410, 429, 500, 502, 503] {
            let route = format!("/api/mycarlos/status/{status}");
            let reply = api(&link, "GET", &route, Vec::new(), None, 64, &NEVER).unwrap();
            assert_eq!(reply.status, status);
            assert_eq!(&reply.body[..], format!("code {status}").as_bytes());
            assert_eq!(
                reply.retry_after,
                (status == 429 || status == 503).then_some(30),
                "{status}"
            );
        }
    }

    #[test]
    fn should_not_follow_a_redirect_and_never_contact_the_other_address() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let elsewhere = serve(|_| Step::Reply(http(200, &[], b"you should not be here")));
        let target = elsewhere.base();
        let server = serve(move |request| {
            let status: u16 = request.target.rsplit('/').next().unwrap().parse().unwrap();
            Step::Reply(http(
                status,
                &[("Location", &format!("{target}/api/mycarlos/after"))],
                b"moved",
            ))
        });
        let link = link_to(&server.base());
        for status in [301u16, 302, 303, 307, 308] {
            let route = format!("/api/mycarlos/redirect/{status}");
            let reply = api(&link, "POST", &route, b"{}".to_vec(), None, 64, &NEVER).unwrap();
            assert_eq!(reply.status, status);
            assert_eq!(&reply.body[..], b"moved");
        }
        assert_eq!(elsewhere.accepted(), 0, "a redirect was followed");
    }

    #[test]
    fn should_refuse_a_reply_larger_than_the_limit_by_its_declared_length_and_by_what_arrives() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|request| match request.target.as_str() {
            "/api/mycarlos/declared" => Step::Reply(http(200, &[], &[b'a'; 101])),
            "/api/mycarlos/chunked" => {
                Step::Reply(chunked(200, &[], &[&[b'a'; 40], &[b'b'; 40], &[b'c'; 40]]))
            }
            "/api/mycarlos/exact" => Step::Reply(http(200, &[], &[b'e'; 100])),
            _ => Step::Reply(chunked(200, &[], &[&[b'x'; 60], &[b'y'; 40]])),
        });
        let link = link_to(&server.base());
        let get = |route: &str| api(&link, "GET", route, Vec::new(), None, 100, &NEVER);
        assert!(matches!(
            get("/api/mycarlos/declared"),
            Err(LinkError::InvalidResponse)
        ));
        assert!(matches!(
            get("/api/mycarlos/chunked"),
            Err(LinkError::InvalidResponse)
        ));
        // A reply of exactly the limit is taken, declared or in pieces.
        assert_eq!(get("/api/mycarlos/exact").unwrap().body.len(), 100);
        assert_eq!(get("/api/mycarlos/pieces").unwrap().body.len(), 100);
    }

    #[test]
    fn should_send_the_signed_assertion_and_nothing_else_identifying() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], b"{}")));
        let link = link_to(&server.base());
        let body = br#"{"intent":"x"}"#;
        api(
            &link,
            "POST",
            "/api/mycarlos/device-approval-requests?after=3",
            body.to_vec(),
            Some("anchor-123"),
            64,
            &NEVER,
        )
        .unwrap();
        let request = server.requests().remove(0);
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.target,
            "/api/mycarlos/device-approval-requests?after=3"
        );
        assert_eq!(request.body, body);
        assert_eq!(request.header("content-type"), Some("application/json"));
        // No referrer, cookie, authorization or user-supplied identifier travels with it.
        for name in ["referer", "cookie", "authorization", "x-forwarded-for"] {
            assert_eq!(request.header(name), None, "{name}");
        }
        let assertion = request.header("x-mycarlos-device-assertion").unwrap();
        let claims = payload_of(assertion);
        assert_eq!(claims["aud"], "carlos-patient-portal-device-api");
        assert_eq!(claims["iss"], "mycarlos");
        assert_eq!(claims["vault_head_link"], "anchor-123");
        assert_eq!(
            claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
            60
        );
        let clinic = link.clinic.as_ref().unwrap();
        assert_eq!(claims["recipient_id"], clinic.recipient_id.as_str());
        assert_eq!(claims["kid"], link.keys.device_key_id());
        // The request hash binds the method, the path, the query and the body.
        use crate::portal_link::frame;
        use sha2::{Digest, Sha256};
        let expected: String = Sha256::digest(frame(&[
            b"POST",
            b"/api/mycarlos/device-approval-requests",
            b"after=3",
            body,
        ]))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
        assert_eq!(claims["request_hash"], expected.as_str());
        // A new assertion each time (a fresh jti).
        api(&link, "POST", ROUTE, body.to_vec(), None, 64, &NEVER).unwrap();
        let second = server.requests().remove(1);
        assert_ne!(
            payload_of(second.header("x-mycarlos-device-assertion").unwrap())["jti"],
            claims["jti"]
        );
    }

    #[test]
    fn should_refuse_the_wrong_route_method_or_base_before_anything_is_sent() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], b"{}")));
        let link = link_to(&server.base());
        let send =
            |link: &crate::portal_link::StoredLink, method: &str, suffix: &str, body: usize| {
                api(link, method, suffix, vec![0; body], None, 64, &NEVER)
            };
        // Only a fixed /api/mycarlos/ route, with no fragment and a body of at most 32 KiB.
        for suffix in [
            "/other",
            "/api/mycarlosx",
            "api/mycarlos/x",
            "/api/mycarlos/x#y",
        ] {
            assert!(
                matches!(
                    send(&link, "GET", suffix, 0),
                    Err(LinkError::InvalidResponse)
                ),
                "{suffix}"
            );
        }
        assert!(matches!(
            send(&link, "POST", ROUTE, 32 * 1024 + 1),
            Err(LinkError::InvalidResponse)
        ));
        assert!(matches!(
            send(&link, "NOT A METHOD", ROUTE, 0),
            Err(LinkError::InvalidResponse)
        ));
        // A link with no clinic yet, or a base that is not an address.
        let mut unlinked = link.clone();
        unlinked.clinic = None;
        assert!(matches!(
            send(&unlinked, "GET", ROUTE, 0),
            Err(LinkError::InvalidResponse)
        ));
        let mut broken = link.clone();
        broken.portal_base = "not an address".into();
        assert!(matches!(
            send(&broken, "GET", ROUTE, 0),
            Err(LinkError::InvalidPortal)
        ));
        assert_eq!(server.accepted(), 0, "something was sent");
    }

    #[test]
    fn should_refuse_clear_text_with_no_connection_made() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], b"{}")));
        let link = link_to(&format!("http://127.0.0.1:{}", server.port));
        assert!(matches!(call(&link, b"{}", 64), Err(LinkError::Network)));
        assert_eq!(server.accepted(), 0, "a clear-text connection was made");
    }

    /// The proxy variables are set only on a child process (`Command::env`), never with `set_var` in
    /// this multi-threaded test binary, where changing the environment races with C code reading it
    /// (`getaddrinfo`): the child is this test binary run on `proxy_child` alone.
    #[test]
    fn should_not_use_a_proxy_from_the_environment() {
        let proxy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        proxy.set_nonblocking(true).unwrap();
        let proxy_address = format!("http://127.0.0.1:{}", proxy.local_addr().unwrap().port());
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "--nocapture",
                "portal_client::network_tests::proxy_child",
            ])
            .env("MYCARLOS_TEST_PROXY_CHILD", "1")
            .env("HTTPS_PROXY", &proxy_address)
            .env("https_proxy", &proxy_address)
            .env("ALL_PROXY", &proxy_address)
            .env("all_proxy", &proxy_address)
            .env("HTTP_PROXY", &proxy_address)
            .env("http_proxy", &proxy_address)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "the request did not go direct in the child"
        );
        assert!(proxy.accept().is_err(), "the proxy was contacted");
    }

    /// Run by `should_not_use_a_proxy_from_the_environment` in a child process whose environment names
    /// a proxy; it asserts the request still goes straight to the server.
    #[test]
    #[ignore = "run only as the child of should_not_use_a_proxy_from_the_environment"]
    fn proxy_child() {
        assert_eq!(
            std::env::var("MYCARLOS_TEST_PROXY_CHILD").as_deref(),
            Ok("1"),
            "only the proxy test starts this"
        );
        assert!(
            std::env::var_os("HTTPS_PROXY").is_some(),
            "no proxy in the environment"
        );
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], b"direct")));
        let reply = call(&link_to(&server.base()), b"{}", 64);
        assert_eq!(&reply.unwrap().body[..], b"direct");
        assert_eq!(server.accepted(), 1);
    }

    #[test]
    fn should_refuse_a_server_that_the_system_does_not_trust_and_one_for_another_name() {
        // No test root: the release verifier (the platform's) sees an unknown root.
        let server = serve(|_| Step::Reply(http(200, &[], b"{}")));
        assert!(matches!(
            call(&link_to(&server.base()), b"{}", 64),
            Err(LinkError::Network)
        ));
        // With the root trusted, a certificate made for another host name is still refused.
        let _root = Trusting::test_root(Duration::from_secs(5));
        let wrong_name = serve_as("other", |_| Step::Reply(http(200, &[], b"{}")));
        assert!(matches!(
            call(&link_to(&wrong_name.base()), b"{}", 64),
            Err(LinkError::Network)
        ));
        // And the same root with the right name is accepted: the refusals above are about trust, not setup.
        let right = serve(|_| Step::Reply(http(200, &[], b"{}")));
        assert!(call(&link_to(&right.base()), b"{}", 64).is_ok());
    }

    #[test]
    fn should_fail_a_stalled_body_at_the_read_timeout_and_a_refused_connection_at_once() {
        let _root = Trusting::test_root(Duration::from_millis(300));
        // The headers promise ten bytes; two come, then silence.
        let server = serve(|_| {
            Step::ReplyThenStall(
                b"HTTP/1.1 200 X\r\nContent-Length: 10\r\n\r\nab".to_vec(),
                Duration::from_secs(5),
            )
        });
        let started = Instant::now();
        assert!(matches!(
            call(&link_to(&server.base()), b"{}", 64),
            Err(LinkError::Network)
        ));
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "it waited for the stall"
        );
        // Nothing is listening on the port: a connection error, not a hang.
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        assert!(matches!(
            call(&link_to(&format!("https://127.0.0.1:{port}")), b"{}", 64),
            Err(LinkError::Network)
        ));
    }

    #[test]
    fn should_stop_when_cancelled_before_starting_and_while_the_server_stalls() {
        let _root = Trusting::test_root(Duration::from_secs(30));
        let server = serve(|_| Step::ReplyThenStall(Vec::new(), Duration::from_secs(6)));
        let link = link_to(&server.base());
        // Before it starts: nothing is sent.
        assert!(matches!(
            api(&link, "GET", ROUTE, Vec::new(), None, 64, &|| true),
            Err(LinkError::Cancelled)
        ));
        assert_eq!(server.accepted(), 0);
        // While it waits for a reply that does not come.
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let outcome = api(&link, "GET", ROUTE, Vec::new(), None, 64, &|| {
            cancel.load(Ordering::Acquire)
        });
        assert!(matches!(outcome, Err(LinkError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    // ---- waiting_api ----

    fn waiting_entry(base: &str) -> crate::notice_key::NoticeKeyEntry {
        let seed = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        serde_json::from_value(serde_json::json!({
            "portalOrigin": base,
            "linkId": uuid::Uuid::new_v4(),
            "vaultId": uuid::Uuid::new_v4(),
            "keyId": "FAKE-waiting-key-id",
            "seed": seed,
        }))
        .unwrap()
    }

    #[test]
    fn should_ask_the_waiting_route_with_the_notice_key_alone() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], b"{\"waiting\":false}")));
        let entry = waiting_entry(&server.base());
        for method in ["POST", "DELETE"] {
            let reply = waiting_api(&entry, method, &NEVER).unwrap();
            assert_eq!(reply.status, 200);
        }
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        for (request, method) in requests.iter().zip(["POST", "DELETE"]) {
            assert_eq!(request.method, method);
            assert_eq!(request.target, crate::tray_notices::WAITING);
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                serde_json::json!({ "key_id": "FAKE-waiting-key-id" })
            );
            // The device key's header is never sent from here, only the waiting key's.
            assert_eq!(request.header("x-mycarlos-device-assertion"), None);
            let claims = payload_of(request.header("x-mycarlos-waiting-assertion").unwrap());
            assert_eq!(claims["aud"], "carlos-patient-portal-waiting-check");
            assert_eq!(claims["iss"], "mycarlos");
            assert_eq!(claims["kid"], "FAKE-waiting-key-id");
            assert!(claims.get("recipient_id").is_none());
            assert_eq!(
                claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
                60
            );
        }
    }

    #[test]
    fn should_refuse_any_other_method_and_a_bad_key_or_base_and_a_reply_over_its_small_limit() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], &[b'z'; 513])));
        let entry = waiting_entry(&server.base());
        for method in ["GET", "PUT", "PATCH", ""] {
            assert!(
                matches!(
                    waiting_api(&entry, method, &NEVER),
                    Err(LinkError::InvalidResponse)
                ),
                "{method:?}"
            );
        }
        assert_eq!(server.accepted(), 0);
        // The waiting reply is a few bytes: 513 is refused.
        assert!(matches!(
            waiting_api(&entry, "POST", &NEVER),
            Err(LinkError::InvalidResponse)
        ));
        let mut bad_base = waiting_entry("not an address");
        assert!(matches!(
            waiting_api(&bad_base, "POST", &NEVER),
            Err(LinkError::InvalidPortal)
        ));
        bad_base = serde_json::from_value(serde_json::json!({
            "portalOrigin": server.base(),
            "linkId": uuid::Uuid::new_v4(),
            "vaultId": uuid::Uuid::new_v4(),
            "keyId": "k",
            "seed": "not base64 of 32 bytes",
        }))
        .unwrap();
        assert!(matches!(
            waiting_api(&bad_base, "POST", &NEVER),
            Err(LinkError::InvalidResponse)
        ));
        assert!(matches!(
            waiting_api(&entry, "POST", &|| true),
            Err(LinkError::Cancelled)
        ));
    }

    // ---- link ----

    fn link_request(endpoint: &str) -> LinkRequest {
        LinkRequest {
            endpoint: tauri::Url::parse(endpoint).unwrap(),
            body: zeroize::Zeroizing::new(br#"{"code":"x"}"#.to_vec()),
            assertion: "FAKE.assertion".into(),
        }
    }

    #[test]
    fn should_map_the_link_refusals_and_every_other_failure_to_the_right_error() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|request| {
            let (status, body): (u16, &[u8]) = match request.target.as_str() {
                "/link/code" => (403, br#"{"code":"link_code_invalid"}"#),
                "/link/keys" => (409, br#"{"code":"clinic_keys_missing"}"#),
                "/link/exists" => (409, br#"{"code":"device_exists"}"#),
                "/link/other-code" => (403, br#"{"code":"something_else"}"#),
                "/link/wrong-status" => (400, br#"{"code":"link_code_invalid"}"#),
                "/link/unknown-field" => (403, br#"{"code":"link_code_invalid","extra":1}"#),
                "/link/not-json" => (403, b"<html>no</html>"),
                "/link/error" => (500, br#"{"code":"link_code_invalid"}"#),
                "/link/limit" => (429, br#"{"code":"rate"}"#),
                "/link/redirect" => (302, b""),
                _ => (200, b"{}"),
            };
            Step::Reply(http(
                status,
                if status == 302 {
                    &[("Location", "https://127.0.0.1:9/x")]
                } else {
                    &[]
                },
                body,
            ))
        });
        let ask = |route: &str| {
            link(
                link_request(&format!("{}{route}", server.base())),
                "device",
                NEVER,
            )
        };
        assert!(matches!(ask("/link/code"), Err(LinkError::CodeRejected)));
        assert!(matches!(
            ask("/link/keys"),
            Err(LinkError::ClinicKeysMissing)
        ));
        assert!(matches!(ask("/link/exists"), Err(LinkError::DeviceExists)));
        for route in [
            "/link/other-code",
            "/link/wrong-status",
            "/link/unknown-field",
            "/link/not-json",
            "/link/error",
            "/link/limit",
            "/link/redirect",
        ] {
            assert!(matches!(ask(route), Err(LinkError::Network)), "{route}");
        }
        // A 200 that is not a link reply is refused by the reader, not taken.
        assert!(ask("/link/anything").is_err());
    }

    #[test]
    fn should_send_the_link_request_as_given_and_nothing_else() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(409, &[], br#"{"code":"device_exists"}"#)));
        let _ = link(
            link_request(&format!("{}/api/mycarlos/links", server.base())),
            "device",
            NEVER,
        );
        let request = server.requests().remove(0);
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/api/mycarlos/links");
        assert_eq!(request.body, br#"{"code":"x"}"#);
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(
            request.header("x-mycarlos-device-assertion"),
            Some("FAKE.assertion")
        );
        for name in ["referer", "cookie", "authorization"] {
            assert_eq!(request.header(name), None, "{name}");
        }
    }

    #[test]
    fn should_refuse_a_link_reply_larger_than_the_limit_declared_or_in_pieces() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let big = vec![b'a'; MAX_RESPONSE_BYTES + 1];
        let big2 = big.clone();
        let server = serve(move |request| match request.target.as_str() {
            "/declared" => Step::Reply(http(200, &[], &big2)),
            _ => Step::Reply(chunked(
                200,
                &[],
                &[
                    &big2[..MAX_RESPONSE_BYTES / 2],
                    &big2[MAX_RESPONSE_BYTES / 2..],
                ],
            )),
        });
        for route in ["/declared", "/pieces"] {
            let outcome = link(
                link_request(&format!("{}{route}", server.base())),
                "device",
                NEVER,
            );
            assert!(
                matches!(outcome, Err(LinkError::InvalidResponse)),
                "{route}"
            );
        }
        assert_eq!(big.len(), MAX_RESPONSE_BYTES + 1);
    }

    #[test]
    fn should_refuse_clear_text_and_stop_when_cancelled_on_the_link_route() {
        let _root = Trusting::test_root(Duration::from_secs(5));
        let server = serve(|_| Step::Reply(http(200, &[], b"{}")));
        assert!(matches!(
            link(
                link_request(&format!("http://127.0.0.1:{}/x", server.port)),
                "device",
                NEVER
            ),
            Err(LinkError::Network)
        ));
        assert!(matches!(
            link(
                link_request(&format!("{}/x", server.base())),
                "device",
                || true
            ),
            Err(LinkError::Cancelled)
        ));
        assert_eq!(server.accepted(), 0);
        // Stalled: cancelled while it waits.
        let stalling = serve(|_| Step::ReplyThenStall(Vec::new(), Duration::from_secs(6)));
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let outcome = link(
            link_request(&format!("{}/x", stalling.base())),
            "device",
            || cancel.load(Ordering::Acquire),
        );
        assert!(matches!(outcome, Err(LinkError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    // ---- the seam stays in the tests ----

    /// Every policy setting of the portal client is made in `build_client`, once; the shipped `client()`
    /// and the tests' `test_client()` both call it, so the tests run the settings that ship. The test
    /// root, the short read timeout and the seam's names exist only in `cfg(test)` code: a shipped build
    /// has no way to trust another root or to shorten a timeout, and no cargo feature, environment
    /// variable or runtime flag adds one.
    #[test]
    fn should_make_every_policy_setting_in_the_one_shared_build_client_and_keep_the_seam_in_tests()
    {
        let source = include_str!("portal_client.rs");
        let marker = "#[cfg(test)]\nmod network_tests";
        let (production, tests) = source.split_at(source.find(marker).unwrap());
        let item = |text: &str, head: &str, close: &str| -> String {
            let start = text
                .find(head)
                .unwrap_or_else(|| panic!("{head} not found"));
            let end = text[start..].find(close).unwrap() + start;
            text[start..end].to_owned()
        };
        let build = item(production, "fn build_client(", "\n}\n");
        let release = item(production, "#[cfg(not(test))]\nfn client()", "\n}\n");
        let test_client = item(tests, "pub(super) fn test_client()", "\n    }\n");
        // The settings are in build_client, and in neither caller.
        for setting in [
            "rustls::version::TLS13",
            "rustls::version::TLS12",
            ".https_only(true)",
            ".redirect(reqwest::redirect::Policy::none())",
            ".retry(reqwest::retry::never())",
            ".no_proxy()",
            ".referer(false)",
            ".pool_max_idle_per_host(0)",
            ".connect_timeout(timeouts.connect)",
            ".read_timeout(timeouts.read)",
            ".timeout(timeouts.total)",
            "reqwest::Client::builder()",
        ] {
            assert_eq!(
                production.matches(setting).count(),
                1,
                "{setting} is not made exactly once in production code"
            );
            assert!(build.contains(setting), "{setting} is not in build_client");
            assert!(
                !release.contains(setting),
                "{setting} is made again in client()"
            );
            assert!(
                !test_client.contains(setting),
                "{setting} is made again in test_client()"
            );
        }
        // Both callers go through it, and the shipped one with the platform verifier and the real limits.
        assert!(release.contains("build_client(provider, verifier, RELEASE_TIMEOUTS)"));
        assert!(release.contains("rustls_platform_verifier::Verifier::new(provider.clone())"));
        assert!(test_client.contains("build_client("));
        assert!(production.contains("connect: std::time::Duration::from_secs(10)"));
        assert!(production.contains("read: std::time::Duration::from_secs(30)"));
        assert!(production.contains("total: std::time::Duration::from_secs(30)"));
        // Nothing of the seam is in production code: no test root, no verifier of our own, no environment.
        for symbol in [
            "TEST_NETWORK",
            "Trusting",
            "RootCertStore",
            "WebPkiServerVerifier",
            "add_root",
            "danger_accept",
            "std::env",
            "cfg(feature",
        ] {
            assert!(
                !production.contains(symbol),
                "{symbol} appears in production code"
            );
        }
        // No short time limit in production code: the only millisecond wait is the 50 ms poll for a cancel.
        assert_eq!(
            production.matches("from_millis(").count(),
            production.matches("from_millis(50)").count(),
            "a millisecond timeout other than the cancel poll is in production code"
        );
        // The one way into the test module from production code is the twin of client(), gated to tests.
        let code_lines: Vec<&str> = production
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect();
        let uses: Vec<usize> = code_lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.contains("network_tests::"))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(
            uses.len(),
            1,
            "network_tests is reached from more than one place"
        );
        assert_eq!(code_lines[uses[0]].trim(), "network_tests::test_client()");
        assert_eq!(
            code_lines[uses[0] - 1].trim(),
            "fn client() -> Result<reqwest::Client, LinkError> {"
        );
        assert_eq!(code_lines[uses[0] - 2].trim(), "#[cfg(test)]");
        // The release client names nothing of tests.
        for forbidden in ["cfg(test)", "env::", "TEST", "RootCertStore"] {
            assert!(
                !release.contains(forbidden),
                "the release client has {forbidden}"
            );
        }
    }
    // ---- the Android connection opens only where the verifier was given its context ----

    #[test]
    fn should_open_the_connection_everywhere_but_on_android_where_it_waits_for_the_verifier() {
        assert!(connection_possible(false, false));
        assert!(connection_possible(false, true));
        assert!(!connection_possible(true, false));
        assert!(connection_possible(true, true));
        // This (host) build is not Android.
        assert!(available());
        assert!(verifier_ready());
    }

    /// The shipped client is never built before the verifier is ready (on Android the platform
    /// verifier panics when asked without the JVM context), and Android's readiness is the plugin's
    /// own flag, which only a successful initialisation sets.
    #[test]
    fn should_check_the_verifier_is_ready_before_the_shipped_client_builds_one() {
        let source = include_str!("portal_client.rs");
        let production = &source[..source.find("#[cfg(test)]\nmod network_tests").unwrap()];
        let release_start = production.find("#[cfg(not(test))]\nfn client()").unwrap();
        let release = &production[release_start..];
        let ready = release.find("if !verifier_ready()").unwrap();
        let verifier = release
            .find("rustls_platform_verifier::Verifier::new")
            .unwrap();
        assert!(
            ready < verifier,
            "the readiness check comes after the verifier is made"
        );
        let body = &production[production.find("fn verifier_ready()").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("tauri_plugin_android_trust::verifier_ready()"));
        // Nothing else in this client says an Android build may connect (the model download keeps
        // its own gate, in model_download.rs).
        assert_eq!(production.matches("target_os = \"android\"").count(), 3);
    }
}
