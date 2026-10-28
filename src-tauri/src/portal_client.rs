//! The production HTTP boundary for the gated native portal flow. Destinations
//! come only from saved consented links; renderer input cannot select API routes.

use crate::portal_link::{LinkError, LinkRequest, LinkedClinic};

pub const fn available() -> bool {
    cfg!(all(feature = "portal-linking", not(target_os = "android")))
}

#[cfg(feature = "portal-linking")]
pub fn link(
    request: LinkRequest,
    expected_device: &str,
    cancelled: impl Fn() -> bool,
) -> Result<LinkedClinic, LinkError> {
    use crate::portal_link::{parse_response, MAX_RESPONSE_BYTES};

    if cancelled() {
        return Err(LinkError::Cancelled);
    }
    // Android needs the verifier's Kotlin component and initialized JVM context.
    // Fail closed until that reviewed platform integration exists.
    #[cfg(target_os = "android")]
    return Err(LinkError::Network);

    #[cfg(not(target_os = "android"))]
    {
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

#[cfg(not(feature = "portal-linking"))]
pub fn link(
    request: LinkRequest,
    _: &str,
    _: impl Fn() -> bool,
) -> Result<LinkedClinic, LinkError> {
    // Disabled builds discard prepared material locally; no transport exists.
    let LinkRequest {
        endpoint,
        body,
        assertion,
    } = request;
    drop((endpoint, body, assertion));
    Err(LinkError::Disabled)
}

#[cfg(all(feature = "portal-linking", not(target_os = "android")))]
fn client() -> Result<reqwest::Client, LinkError> {
    use std::{sync::Arc, time::Duration};
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|_| LinkError::Network)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            rustls_platform_verifier::Verifier::new(provider).map_err(|_| LinkError::Network)?,
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
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| LinkError::Network)
}

#[cfg(feature = "portal-linking")]
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
#[cfg(feature = "portal-linking")]
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
#[cfg(feature = "portal-linking")]
pub(crate) fn retry_after_seconds(text: &str) -> Option<u64> {
    let text = text.trim();
    (!text.is_empty() && text.len() <= 9 && text.bytes().all(|c| c.is_ascii_digit()))
        .then(|| text.parse().ok())?
}

#[cfg(feature = "portal-linking")]
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
    #[cfg(target_os = "android")]
    {
        let _ = (link, method, suffix, body, anchor, max);
        return Err(LinkError::Unavailable);
    }
    #[cfg(not(target_os = "android"))]
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
        let client = client()?;
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| LinkError::InvalidResponse)?;
        let exchange = async {
            let mut response = client
                .request(method, endpoint)
                .header("Content-Type", "application/json")
                .header("X-MyCarlos-Device-Assertion", assertion)
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

#[cfg(all(test, feature = "portal-linking"))]
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
