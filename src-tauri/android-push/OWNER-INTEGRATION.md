Native owner cohesive version 2 — review candidate, no runtime release

Parent scaffold 8761d65 and owner-source01 frozen worktree are preserved. This version adds Lifecycle, a native
state machine behind the android-push feature, plus AndroidKeyStore-backed scoped
credential storage. It returns enrollment/revocation work; it performs no network.
There is still no renderer command/UI path that enables FCM. Do not expose raw
AndroidPush::enable_transport to IPC. The native host integration below is required.

The persisted state contains only installation UUID, per-vault/link/device-key
native ownership, subscription ID, epoch and bounded generation cursors. No bearer,
provider token or content is saved in Lifecycle. Its initial active set is empty.
Only opt_in on an explicit remote-consent gesture reserves a new destination.
The caller MUST first check an unlocked current vault and active native link.
NativeLink::from_verified_native validates shape, not ownership; it is not a proof.
An existing Windows/local notification preference is not remote consent.

All lifecycle calls are serialized by the native host. The persistence callback
must atomically replace an app-private file, flush it and report failure. Lifecycle
commits its in-memory state and returns external work only after that callback
succeeds. Root should wire this to existing native atomic state storage; these
seams deliberately do not pick an app data path or silently create live state.

Host ordering:
1. Refresh OS permission; on Denied call permission_changed, persist queued
   revocations, and disable transport if no active destination remains. Unknown
   permission cannot enable transport. Fresh granting does not restore retired
   consent. UI remains OFF until native consent is explicitly persisted.
2. opt_in verifies current native ownership before persisting an ID/epoch reservation.
   If permission unknown, request it separately. Destination metadata is passed to
   the Portal reservation/credential minting boundary using existing authenticated
   native linking proof while unlocked. No renderer-supplied owner identity.
3. Provision a scoped credential limited to this subscription/epoch/device for
   notification enroll/replace/revoke. Android ScopedCredentialStore encrypts it
   using AES-GCM and an AndroidKeyStore key; subscription UUID is authenticated AAD,
   epoch/installation/expiry are checked on read. Server expiry and scope checks
   remain authoritative; device clock observations never grant server rights. It uses credential-encrypted
   private preferences and the existing backup exclusions. It is unavailable before
   first device unlock. Keystore invalidation/tamper/expiry returns unavailable.
   There is no fallback to vault keys, document pickup credentials or device signing
   keys. The Keystore key intentionally needs no biometric prompt so rotation/revoke
   can work while the vault is locked. Native linking proof is needed for renewal.
4. transport_action requires active consent, granted permission and at least one
   available scoped credential. Only then call enable_transport; read snapshot.
   token_changed receives only the current Kotlin snapshot token/generation, checks
   permission and per-destination credential availability, persists desired cursors,
   then emits sensitive Enrollment work (not Debug/Serialize; token zeroizes on drop).
   Read again after failures/resume. Retain the latest generation while retries exist.
5. Portal must atomically reject stale token generations, revoked destinations and
   superseded epochs. A receipt is accepted by enrolled only for the still-active
   exact ID/epoch/installation and current desired generation. A late receipt cannot
   resurrect consent or acknowledge a newer token. Same-generation requests are
   idempotent; server must reject conflicting tokens at the same generation.
6. opt_out, revoke_link, revoke_vault or revoke_all durably move reservations into
   pending revocations BEFORE local transport shutdown. Revocation work survives
   restart/offline and even an enrollment that never completed. Server unknown-ID
   tombstones must beat late enrollment. Keep scoped credentials until server
   revocation acknowledgment; only then call revoked and remove_credential. If a
   crash leaves an obsolete credential after state removal it has no live owner;
   server tombstone prevents reuse. Handle cleanup failure as retryable maintenance.
7. serialize disable/deleteToken completion before re-enable; snapshot generation
   and fetch-session fences prevent older callbacks overwriting a newer session.
   Deleting an FCM token affects the whole installation: disable only after all
   active per-owner destinations are retired. Revoke one owner independently while
   other destinations continue. Device logout/reset must queue all relevant revokes.

ReadyHint is data only: Rust decode rejects unexpected fields/URLs/unbounded data.
Lifecycle::activate verifies the exact current native link and subscription epoch,
then returns unlock-first or Clinic documents navigation. Recheck ownership after
unlock. It never unlocks, collects, decrypts or opens a payload URL. Reconcile on
normal resume/unlock/reconnect even without a hint. Loss/collapse/duplicates and
force-stop are expected. Background generic OS alerts require the Portal provider's
fixed template, consent/revocation fence and after-commit outbox; on-device Policy
cannot intercept an FCM/OS-displayed background message before display.

Portal coordination with Agent3 (current SQL 22b08f93 is not this complete contract):
canonical platform android_fcm; installation_id UUID; token_generation 1..i64::MAX;
stable subscription ID/epoch through token rotation; new ID/epoch after renewed
consent; opaque destination UUID remains server-owned. Proposed enrollment schema:
{version:1,platform:"android_fcm",subscription_id,epoch,installation_id,
 token_generation,provider_token}. Scoped authorization is separate. Current SQL
has unknown-ID revocation tombstones but lacks provider-token storage, scoped grant
mint/verification and generation CAS. Its older rotation-by-new-destination flow
must be changed explicitly in a separate reviewed SQL delta, with old outbox
snapshot fences; no existing interoperability or working background claim is made.

Foreground display now uses Lifecycle::display_foreground, which requires the
current native link, active consent, a successfully enrolled destination, matching
subscription epoch, fresh granted OS permission, and a sequence newer than the
durable display cursor. It calls a typed synchronous NativeNotice provider closure
while the host holds its lifecycle/current-ownership lock. Kotlin rechecks local
transport, OS permission and foreground window focus. Service callbacks only write
hints/reconcile flags; they never display. After display, cursor persistence failure
can retry the same stable OS tag; exactly-once display is not promised.

Feature-OFF artifact admission is authoritative in build.rs and shared pure Rust
android_push_profile.rs: residual ON Kotlin, icon/config, Firebase manifest entries
or SDK dependencies reject the build. Feature ON requires generated Kotlin bytes
to match reviewed source and the pinned dependency/configuration. Reinitialize the
generated Android project when changing profiles. The hook additionally rejects
unmanaged Gradle Firebase coordinates, BOM/platform declarations and recognizable catalog aliases and canonicalizes manifest whitespace; opaque arbitrary catalog aliases require
a separately reviewed resolved dependency graph before platform admission;
its repeat fixture compares all eight generated output files byte for byte.

Written checks (NOT RUN, Root release required):
- 13 Rust lifecycle fixture/negative tests: initial OFF; permission+credential gate;
  failed persistence emits no work; restart revocation; stale enrollment ack; retry
  rotation; per-destination credential; bigint bounds; revoke-before-enroll; reset
  isolation; hint owner/epoch/unlock routing; corrupt state rejection.
- Four profile-admission Rust fixtures cover fresh OFF, ON-to-OFF reuse, partial
  stale artifacts and ON prerequisites. Four Node hook fixtures cover byte
  idempotence and unmanaged Gradle declarations. Android hint test is also authored.
- Add Android instrumentation under a guarded mobile project: Keystore put/get,
  wrong ID/epoch/installation, expiry, sealed-byte tamper, key invalidation,
  out-of-order getToken/onNewToken/disable/re-enable, delete failure, cold/warm taps.

Concrete required Root gates before enabling any UI:
1. Peer source review of scaffold and this new version, including Kotlin/ACL/schema.
2. Guarded `node --test scripts/configure-android-push.test.mjs` with private tempdir;
   guarded cargo lib tests --features android-push (no portal-linking needed for
   pure Lifecycle) and Android compile with the explicit feature and private
   matching public Firebase client config. Pin outputs/dependencies; no installs
   or cloud live sends are implied by a build release.
3. Actual renderer ACL-denial probes for snapshot, all transport and credential
   commands; native calls must work. Verify merged manifest disables auto-init and
   Analytics and retains backup/camera security. Feature absent/default must still
   build normally. Static tests cannot establish this native boundary.
4. Root review of native app-host persistence/ownership/scoped-grant issuance and
   Portal generation/tombstone/outbox changes before UI integration.
5. Separately released installed-device synthetic push lifecycle tests, including
   denied permission, force-stop, device locked/first unlock, app/vault locked,
   stale/missing hints, generation races, two owners, reset and offline opt-out.
