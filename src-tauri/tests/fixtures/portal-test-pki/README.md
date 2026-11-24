# Loopback test certificates (FAKE; never trust them)

Used only by the `portal_client` network tests (`src-tauri/src/portal_client.rs`, module `network_tests`) to run
a local HTTPS server. They are throwaway keys made for this purpose, valid from 23 Nov 2026 for 100 years, and
are never added to any trust store: the tests hand the root to the client only through a `cfg(test)` seam.

| File | What it is |
| --- | --- |
| `ca.der.b64` | the test root (ECDSA P-256, CA:TRUE, pathlen 0), DER in base64 |
| `leaf.der.b64`, `leaf.pkcs8.b64` | the server certificate for `127.0.0.1` and `localhost`, and its key (PKCS#8 DER in base64) |
| `other.der.b64`, `other.pkcs8.b64` | a certificate for `other.example` only, for the hostname-mismatch test |

Made with `openssl ecparam`/`req`/`x509`; base64 of DER (no PEM armour) so that secret scanners do not mistake
a test key for a real one.
