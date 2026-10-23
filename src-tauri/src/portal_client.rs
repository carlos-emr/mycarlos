//! The only production HTTP client. Its sole current operation is a typed v1
//! link request; callers cannot supply arbitrary routes, headers or destinations.

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
    use std::{sync::Arc, time::Duration};

    if cancelled() {
        return Err(LinkError::Cancelled);
    }
    // Android needs the verifier's Kotlin component and initialized JVM context.
    // Fail closed until that reviewed platform integration exists.
    #[cfg(target_os = "android")]
    return Err(LinkError::Network);

    #[cfg(not(target_os = "android"))]
    {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(|_| LinkError::Network)?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(
                rustls_platform_verifier::Verifier::new(provider)
                    .map_err(|_| LinkError::Network)?,
            ))
            .with_no_client_auth();
        let client = reqwest::Client::builder()
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
            .map_err(|_| LinkError::Network)?;
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
                        tokio::time::sleep(Duration::from_millis(50)).await;
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
