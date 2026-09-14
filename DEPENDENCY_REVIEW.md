# Socket dependency review — PR #1

The [Socket comment on the initial import](https://github.com/carlos-emr/mycarlos/pull/1#issuecomment-5670042450)
reports three **package-level** obfuscation warnings, each with confidence 0.90.
It does not identify an application source file or an offending dependency line.
These are detection confidence scores, not measurements of how much code is
obfuscated.

| Package | Dependency path | Use in myCarlos |
| --- | --- | --- |
| `jsdom@29.0.1` | `package-lock.json` → `jsdom` | Development dependency: Vitest's simulated DOM |
| `data-urls@7.0.0` | `package-lock.json` → `jsdom` → `data-urls` | Transitive development dependency: data URL parsing |
| `hyper-util@0.1.20` | `src-tauri/Cargo.lock` → `tauri` → `hyper-util` | Native Tauri dependency |

## Inspection and limits

The installed `data-urls` `lib/parser.js` and `lib/utils.js` contain readable URL,
MIME type, percent-decoding, and base64-decoding logic. The installed jsdom
`lib/api.js` and a sample generated Web IDL callback wrapper use named functions
and ordinary JavaScript. Its package manifest explicitly lists code-generation
steps. This inspection does not establish which code triggered Socket's model,
and is not a complete audit of jsdom or its dependency tree.

The published `hyper-util-0.1.20.crate` SHA-256 matches the checksum in our
`Cargo.lock`. Its `src/lib.rs` and runtime adapter documentation in
`src/rt/tokio.rs` are readable. The crate records source revision
`b23a13e2b7ee73e15ba008cd9b19dcd2d3861957`. The upstream
[versioned entry point](https://github.com/hyperium/hyper-util/blob/v0.1.20/src/lib.rs)
also exposes named modules. A checksum match establishes consistency with the
lockfile, not package safety; this was a source spot check, not a full native
dependency audit.

The detailed organization alert view was not accessible during this review, so
there is insufficient evidence to classify these warnings as false positives.
All three remain **unresolved**. No Socket suppression, accepted-risk setting,
dependency replacement, or scanner-policy change is part of the readability
refactor. The existing dependency versions are retained; the only added package
is the pinned development formatter, Prettier 3.6.2.

To resolve the warnings, obtain Socket's offending file/range or detection
rationale from the organization dashboard, compare the published files against
their versioned upstream source, and review an upstream fix or a documented
triage decision. Development-only packages still execute in developer/CI
environments and require review.

## Other audit results

The [initial standalone supply-chain run](https://github.com/carlos-emr/mycarlos/actions/runs/34890522374)
passed, but its Rust audit log still reports `glib@0.18.5`
`RUSTSEC-2024-0429` as an **unsoundness warning**. A successful job does not mean
that finding disappeared. The Linux support/release restriction documented in
the README remains in place.
