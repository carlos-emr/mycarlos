# myCarlos repository handoff

This repository imports the synthetic-data Tauri evaluation from
[carlos-emr/carlos PR #3544](https://github.com/carlos-emr/carlos/pull/3544).
The original discussion, reviews, and commit history remain available there.

- Source repository: https://github.com/carlos-emr/carlos
- Source revision: `5fddcdd6cd624f74221e2d664f9e0634a3942bb2`
- Source application directory: `mycarlos-tauri-poc/`
- Source workflow: `.github/workflows/mycarlos-tauri-poc.yml`
- Product proposal: [CARLOS issue #3474](https://github.com/carlos-emr/carlos/issues/3474)
- Visual direction: [CARLOS PR #3479](https://github.com/carlos-emr/carlos/pull/3479)

The application is now at the repository root, with its evaluation workflow at
`.github/workflows/mycarlos.yml`. Application code, dependencies, vault format, app identifier,
and sample files are unchanged by the move. All previously implemented fixes are included:
vault ownership/reset recovery, Windows installers, internal drag and drop, folder/document
renaming, and Windows GUI startup without an extra terminal.

The import is one DCO-signed snapshot commit on top of this repository's initial commit.
The linked source history preserves original authorship and sign-offs; this does not pretend to
transfer GitHub review comments or original commit IDs into the new PR.

## Changes needed for the standalone repository

- Build, cache, and artifact paths now resolve from the repository root.
- Git attributes preserve LF text and binary PDF/image handling on Windows checkouts.
- Download and developer documentation point to this repository.
- The original draft-only Rust audit exception is removed. The known Linux `glib` advisory remains
  a failing security gate; it is not waived for this import.
- Security reporting retains the existing private CARLOS intake while dedicated private reporting
  is not enabled here. See [SECURITY.md](SECURITY.md).
- The destination's existing AGPL license and upstream GPL notices are preserved; see
  [LICENSE_NOTES.md](LICENSE_NOTES.md) for the licensing review item.

This remains an unsigned synthetic-data evaluation. Moving repositories does not approve patient
use, signing, publication of a supported release, or any of the outstanding gates in
[MVP_STATUS.md](MVP_STATUS.md).
