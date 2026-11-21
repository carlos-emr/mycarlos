//! The real `Transport`: HTTPS to the one host, `api.anthropic.com`, built like the portal client
//! (`portal_client::client`): rustls with the platform certificate verifier, HTTPS only, no
//! redirects (a redirect is an error, not followed), no proxy, no cookies, no referrer, no retry.
//! Compiled only with the `cloud-ai` Cargo feature (off by default, not in release builds). No
//! test opens a socket with it: the tests use a fake `Transport`.
//!
//! The request body is copied into the HTTP client, which does not zero it: the same residual the
//! threat model states for what a client library keeps (AI-11).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::request::{ProviderRequest, CONNECT_SECONDS, HOST, TOTAL_SECONDS};
use super::response::{ProviderResponse, MAX_ANSWER_BYTES};
use super::send::{Transport, TransportFailure};

pub(crate) struct HttpsTransport;

fn client() -> Result<reqwest::Client, ()> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|_| ())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            rustls_platform_verifier::Verifier::new(provider).map_err(|_| ())?,
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
        .connect_timeout(Duration::from_secs(CONNECT_SECONDS))
        .timeout(Duration::from_secs(TOTAL_SECONDS))
        .build()
        .map_err(|_| ())
}

impl Transport for HttpsTransport {
    fn send(
        &self,
        request: &ProviderRequest,
        cancel: &AtomicBool,
    ) -> Result<ProviderResponse, TransportFailure> {
        // Only the one host, whatever built the request.
        if !request.url.starts_with(&format!("https://{HOST}/")) {
            return Err(TransportFailure::Unreachable {
                maybe_arrived: false,
            });
        }
        tauri::async_runtime::block_on(async {
            let client = client().map_err(|_| TransportFailure::Unreachable {
                maybe_arrived: false,
            })?;
            let mut builder = client.post(request.url).body(request.body.clone());
            for (name, value) in &request.headers {
                builder = builder.header(*name, value.as_str());
            }
            let pending = builder.send();
            tokio::pin!(pending);
            // Cancel is looked at every 100 ms while waiting: the request is dropped, which ends it.
            let mut response = loop {
                tokio::select! {
                    done = &mut pending => {
                        break done.map_err(|error| TransportFailure::Unreachable {
                            maybe_arrived: !error.is_connect(),
                        })?;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if cancel.load(Ordering::Acquire) {
                            return Err(TransportFailure::Cancelled);
                        }
                    }
                }
            };
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            };
            let request_id = header("request-id");
            let retry_after_secs =
                header("retry-after").and_then(|value| value.trim().parse().ok());
            let mut body = Vec::new();
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(TransportFailure::Cancelled);
                }
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        body.extend_from_slice(&chunk);
                        if body.len() > 4 * MAX_ANSWER_BYTES {
                            // Far more than any answer: not one. Status 0 reads as unexpected.
                            return Ok(ProviderResponse {
                                status: 0,
                                request_id,
                                retry_after_secs,
                                body: Vec::new(),
                            });
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        return Err(TransportFailure::Unreachable {
                            maybe_arrived: true,
                        })
                    }
                }
            }
            Ok(ProviderResponse {
                status,
                request_id,
                retry_after_secs,
                body,
            })
        })
    }
}
