//! The key test (design 4.5): one `GET /v1/models` with the patient's key, sent only when they ask
//! for it. It carries no document and no text; the provider sees the key and nothing else. The
//! answer is one of a few plain outcomes, never the body.

use std::sync::atomic::{AtomicBool, Ordering};

use uuid::Uuid;

use super::request::build_key_test_request;
use super::send::{SendVault, Transport, TransportFailure};
use crate::vault::VaultError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeyTest {
    /// 200: the account accepts the key.
    Accepted,
    /// 401 or 403: the key was not accepted.
    Rejected,
    /// 429, 500 or 529: try again later.
    Busy,
    /// Any other status, or an answer that is not one.
    Unexpected,
    /// No response at all.
    Unreachable,
    Cancelled,
}

pub(crate) fn test_key(
    vault: &impl SendVault,
    transport: &impl Transport,
    key: Uuid,
    cancel: &AtomicBool,
) -> Result<KeyTest, VaultError> {
    if cancel.load(Ordering::Acquire) {
        return Ok(KeyTest::Cancelled);
    }
    let secret = vault.key_secret(key)?;
    let request = match build_key_test_request(&secret) {
        Ok(request) => request,
        Err(_) => return Ok(KeyTest::Unexpected),
    };
    drop(secret);
    Ok(match transport.send(&request, cancel) {
        Ok(response) => match response.status {
            200 => KeyTest::Accepted,
            401 | 403 => KeyTest::Rejected,
            429 | 500 | 529 => KeyTest::Busy,
            _ => KeyTest::Unexpected,
        },
        Err(TransportFailure::Cancelled) => KeyTest::Cancelled,
        Err(TransportFailure::Unreachable { .. }) => KeyTest::Unreachable,
    })
}

#[cfg(test)]
mod tests {
    use super::super::request::{Method, ProviderRequest};
    use super::super::response::ProviderResponse;
    use super::*;
    use crate::history::HistoryEntry;
    use crate::vault::KnownIdentifiers;
    use std::cell::RefCell;
    use zeroize::Zeroizing;

    struct Vault;
    impl SendVault for Vault {
        fn known_identifiers(&self, _: Uuid) -> Result<KnownIdentifiers, VaultError> {
            unreachable!("a key test reads no document")
        }
        fn key_label(&self, _: Uuid) -> Result<String, VaultError> {
            unreachable!()
        }
        fn key_secret(&self, _: Uuid) -> Result<Zeroizing<String>, VaultError> {
            Ok(Zeroizing::new(
                "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2".into(),
            ))
        }
        fn document_title(&self, _: Uuid) -> Result<String, VaultError> {
            unreachable!()
        }
        fn record(&self, _: HistoryEntry) -> Result<(), VaultError> {
            unreachable!("a key test records nothing about a document")
        }
    }

    struct Fake {
        reply: Result<u16, TransportFailure>,
        seen: RefCell<Vec<(Method, &'static str, usize)>>,
    }
    impl Transport for Fake {
        fn send(
            &self,
            request: &ProviderRequest,
            _: &AtomicBool,
        ) -> Result<ProviderResponse, TransportFailure> {
            self.seen
                .borrow_mut()
                .push((request.method, request.url, request.body.len()));
            match &self.reply {
                Ok(status) => Ok(ProviderResponse {
                    status: *status,
                    request_id: None,
                    retry_after_secs: None,
                    body: b"{\"data\":[]}".to_vec(),
                }),
                Err(TransportFailure::Cancelled) => Err(TransportFailure::Cancelled),
                Err(TransportFailure::Unreachable { maybe_arrived }) => {
                    Err(TransportFailure::Unreachable {
                        maybe_arrived: *maybe_arrived,
                    })
                }
            }
        }
    }

    fn run(reply: Result<u16, TransportFailure>) -> (KeyTest, Vec<(Method, &'static str, usize)>) {
        let fake = Fake {
            reply,
            seen: RefCell::new(Vec::new()),
        };
        let outcome = test_key(&Vault, &fake, Uuid::nil(), &AtomicBool::new(false)).unwrap();
        (outcome, fake.seen.into_inner())
    }

    #[test]
    fn each_status_has_one_plain_outcome_and_the_request_is_the_bodiless_model_list() {
        for (status, want) in [
            (200, KeyTest::Accepted),
            (401, KeyTest::Rejected),
            (403, KeyTest::Rejected),
            (429, KeyTest::Busy),
            (529, KeyTest::Busy),
            (404, KeyTest::Unexpected),
            (302, KeyTest::Unexpected),
        ] {
            let (outcome, seen) = run(Ok(status));
            assert_eq!(outcome, want, "{status}");
            assert_eq!(
                seen,
                [(Method::Get, "https://api.anthropic.com/v1/models", 0)]
            );
        }
        assert_eq!(
            run(Err(TransportFailure::Unreachable {
                maybe_arrived: false
            }))
            .0,
            KeyTest::Unreachable
        );
        assert_eq!(run(Err(TransportFailure::Cancelled)).0, KeyTest::Cancelled);
    }

    #[test]
    fn a_cancel_before_the_test_sends_nothing() {
        let fake = Fake {
            reply: Ok(200),
            seen: RefCell::new(Vec::new()),
        };
        let cancel = AtomicBool::new(true);
        assert_eq!(
            test_key(&Vault, &fake, Uuid::nil(), &cancel).unwrap(),
            KeyTest::Cancelled
        );
        assert!(fake.seen.borrow().is_empty());
    }
}
