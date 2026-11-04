//! The AI helper's model on this computer (#72). Until a model can be
//! downloaded and checked against its published hash, there is none:
//! `status` says so. Nothing here reads a file or opens a connection.

use serde::Serialize;

/// Whether a model is installed on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum ModelStatus {
    NotInstalled,
}

pub(crate) fn status() -> ModelStatus {
    ModelStatus::NotInstalled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_model_is_installed_yet_and_the_renderer_reads_it_as_such() {
        assert_eq!(status(), ModelStatus::NotInstalled);
        assert_eq!(
            serde_json::to_value(status()).unwrap(),
            serde_json::json!({ "state": "notInstalled" })
        );
    }
}
