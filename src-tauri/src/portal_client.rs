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
pub fn link(_: LinkRequest, _: &str, _: impl Fn() -> bool) -> Result<LinkedClinic, LinkError> {
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
            Ok(ApiResponse { status, body })
        };
        tauri::async_runtime::block_on(async {
            tokio::select! { biased;
                _=async {loop {if cancelled(){break;} tokio::time::sleep(std::time::Duration::from_millis(50)).await;}}=>Err(LinkError::Cancelled),
                result=exchange=>result,
            }
        })
    }
}
