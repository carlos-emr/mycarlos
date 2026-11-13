# Manual actual-wrapper extraction characterization

These three tiny PDFs contain invented card records only. They are a separate
extraction fixture set, not additions to the frozen 30 model-evaluation documents
or any held-out corpus. `fixture-manifest.json` records their exact hashes.

- `fake-image-only-scan.pdf`: one raster-only page, no OCR/text layer. Visible
  invented instructions currently yield empty text.
- `fake-widget-form.pdf`: static page text plus an AcroForm text value and checked
  checkbox. Current extraction retains the labels/record, but omits the widget-only
  `BLUE WIDGET ONLY` value and `/Yes` state. The first two PDFs are byte-identical
  to the earlier isolated synthetic helper probe.
- `fake-flattened-form.pdf`: the value and checkbox description are ordinary page
  text. This is the control for text extraction, not an editable widget.

The ignored Linux lib test
`extraction_acceptance_tests::actual_document_text_preserves_scan_and_form_extraction_limits`
calls the real `vault_document_text` command using Tauri's mock OS runtime and an
actual disposable encrypted vault/import. It does not replace the command, vault,
page loop, helper exchange, PNG validation, parser, metadata or ticket logic.
A Linux `cfg(test)` hook selects a real helper for one uniquely registered read
ID only; all other reads and every non-test build retain `current_exe` behavior.
The hook is cleared by a scoped guard, including during unwinding.

The test checks actual page text/index/joined text/UTF-16 starts, empty/cut/failed
metadata, record/session ticket binding and an independently framed page digest.
Hidden records and a locked vault must be refused before helper selection. It
keeps the original PDFs, exact extracted pages and provenance in a new private
external evidence directory. No model is requested. Direct command calls do not
claim coverage of frontend rendering or the IPC capability dispatch layer.

This is characterization of current limitations, not OCR support, form-field
support, clinical scoring or a waiver of PR 307's draft work. See issues
[72](https://github.com/carlos-emr/mycarlos/issues/72),
[73](https://github.com/carlos-emr/mycarlos/issues/73) and
[300](https://github.com/carlos-emr/mycarlos/issues/300). An intentional extractor
improvement needs its own review and updated expectations.

## Future execution, after explicit authorization

**Not executed when this harness was authored.** Source review does not authorize
Cargo, native linking or a run. Keep it ignored in ordinary CI. A dedicated native
build/run window must be model-free, serial, CPU 0/nice 19, with at least 8 GiB
available and an agreed hard timeout/owned-child cleanup. Full native builds are
not covered by the prior 30-second standalone evidence-test allowance.

1. Freeze a reviewed clean candidate. Build its actual app/helper and lib-test
   executable offline/locked in an isolated target under the separately approved
   native window; match their `ai-helper-stub` feature setting. Do not reuse or
   rebuild the coordinator's active shared target. No model/browser is needed.
2. From that completed build, create an owned private bundle directory (0700).
   Copy, never hardlink, the exact app executable into it; verify its approved
   SHA-256 before/after copying and set it read-only/executable (0500). Retain the
   completed build receipt and approved binary/source hash lineage. The test
   makes a second private, read-only copy and verifies it around each exchange.
3. Set `MYCARLOS_EXTRACTION_ACCEPTANCE_MANIFEST` to a reviewed JSON manifest with
   schema 1, `source_revision` equal to the clean candidate HEAD,
   `source_files` as an array of `{path, sha256}`, `build_features` equal to `[]`
   or `["ai-helper-stub"]` as built, `helper_path`, `helper_sha256`,
   `build_receipt_path` and `build_receipt_sha256`. Unknown top-level fields and
   duplicate source paths are rejected. The complete source set is:
   `src-tauri/src/{main,lib,vault,pdf_view,pdf_unlock,extraction_acceptance_tests}.rs`,
   `src-tauri/{Cargo.toml,Cargo.lock,build.rs}` and the three PDFs in this folder.
   Hashes must match the bytes compiled into the test. This binds a reviewed
   build manifest; it is not independent reproducible-build attestation.
4. Set `MYCARLOS_EXTRACTION_ACCEPTANCE_OUTPUT` to a new, non-existing external
   directory whose parent exists. The test creates it mode 0700, refuses a path
   inside the source checkout, and never overwrites evidence files.
5. Run only the exact ignored test, one thread, within the external resource
   guard. A prospective command after building is:

   ```sh
   cargo test --offline --locked --manifest-path src-tauri/Cargo.toml \
     --features ai-helper-stub --lib \
     extraction_acceptance_tests::actual_document_text_preserves_scan_and_form_extraction_limits \
     -- --ignored --exact --test-threads=1
   ```

   Omit the feature flag if both reviewed binaries were built without it. This
   command can still compile/link; it is not permission to run during inference.
6. Retain `helper-provenance.json`, each PDF and `.pages.json`, and the completed
   `acceptance-result.json`. A missing final result is not a pass. Verify source
   and input hashes and that all owned helper processes ended before releasing
   the window. No current-head acceptance is claimed until this actual run and
   independent evidence review pass.

The test's empty scan and partially extracted widget form must never be entered
as successful model-fact cases. Owner disposition of unsupported inputs and
current-head baseline/variant model evidence remain separate decisions.
