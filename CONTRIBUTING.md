# Working on myCarlos

Use the pinned Node and Rust versions from the evaluation workflow. Run `npm ci`
after changing branches or dependency locks. Install Chromium with
`npx playwright install chromium` before `npm test`; component tests and end-to-end
tests share Playwright. See [README.md](README.md#checks) for
the checks and native build prerequisites.

## Frontend responsibilities

- `src/VaultApp.tsx` selects the runtime and owns the native vault session,
  background/inactivity locking, operation status, and snapshot refresh.
- `src/native/VaultAuth.tsx` owns setup and unlock forms.
- `src/native/VaultLibrary.tsx` coordinates library navigation and persistence
  actions through the injected `VaultBridge`.
- `LibrarySidebar.tsx` displays the folder tree; `LibraryItems.tsx` displays list
  and grid entries. Neither performs vault operations.
- `SecuritySettings.tsx`, `RecordDetails.tsx`, and `RenameDialog.tsx` own their
  forms/dialogs and accept only the action callbacks they need. Passphrase form
  state is discarded when leaving Security.
- `useVaultDragDrop.ts` handles browser drag state and validated transfer data.
  The library supplies the move operation; Rust still validates folder moves.
- `src/vault.ts` defines the typed native bridge and adapts it to Tauri IPC.
  Tests inject a substitute bridge through `VaultApp`.
- `src/App.tsx` is the nonpersistent browser demonstration. Shared icons live in
  `src/Icon.tsx`, independently of either app's state. Its platform bridge uses browser APIs only;
  the durable app keeps native dialogs and file handles in Rust.

Prefer one responsibility per component, narrow data/action props, and named
handlers for operations with side effects. Keep persistence behind the bridge
and use callbacks for presentation components. These are the useful SOLID
boundaries here; additional class hierarchies or generic service frameworks are
not required. Keep native path handling and cryptography in Rust.

Run `npm run format` to format frontend TypeScript, including tests. CI runs
`npm run format:check` so dense inline code does not accumulate again. Generated
bundles, dependency sources, and lockfiles are not formatting targets.

## Dependency alerts

Read [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md) for dependency removal decisions
and the remaining Socket finding. Source readability and dependency security need separate review;
reformatting application code does not resolve an alert in an upstream package.

## Native dependency patches

Read [the native patch notes](src-tauri/vendor/README.md) before touching the pinned
glib source. Every difference from its published crate must be recorded
in a reviewed patch and pass the source reconstruction check. Preserve license
notices and original versions. Run the optimized glib regression suite and the
full native tests when changing these patches.

Mobile live reload uses upstream Tauri: run `npm run tauri android dev` after Android
initialization and `npm run android:secure`, or `npm run tauri ios dev` on macOS after
iOS initialization. UI edits hot-update; Rust edits rebuild/relaunch the native app.
Vite uses `TAURI_DEV_HOST` for physical devices and WebSocket port 1421. The broader
WebSocket host allowance is confined to `devCsp`; packaged builds keep the production CSP.
`npm run test:dev-hmr` verifies a real hot update under that development policy using a
non-localhost address. CI also compiles both mobile development paths and builds the
bundled Android/iOS packages.
