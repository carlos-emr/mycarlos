# Native Android push integration

`VaultStore` owns remote notice consent in the encrypted manifest. It reserves destinations for completed links before enrollment. Opt-out queues revocations durably. The device key for the active link signs the two existing Portal requests.

- POST `/api/mycarlos/availability/subscriptions` takes exactly `platform` (`android_fcm`), `destination_id`, `remote_enabled`, `remote_consent_version` (1) and `permission_observed`.
- POST `/api/mycarlos/availability/revocations` takes `platform` and `destination_id`. A committed tombstone fences late enrollment.
- The FCM sender resolves a destination UUID to a provider handle separately. The subscription API has no handle field and no scoped-bearer mint or rotation route. Keep the FCM registration token off both endpoints.

The separate handle-binding scaffold (`android_push_owner.rs`) is dormant pending a matching service. Its local ids and epochs fence token replacement and revocation of an installation's handle. They never travel in the notice. Its scoped credential is per binding and expires. The encrypted credential store checks installation and epoch; credentials and provider tokens stay out of the vault manifest, renderer, and logs. Provider registration requires a fresh OS permission and explicit native consent. The host must await a durable revocation before transport shutdown, retain it for retry, and serialize token deletion with re-enabling.

A valid opaque token is only a reconciliation cue. Rust routes it through the current vault's ordinary authenticated pickup. The separate handle-binding state cannot authorize a fetch or display. Foreground Android display follows an authenticated addition. Background system-rendered messages rely on the Portal sender's fixed template. No external intent extras or provider-supplied navigation paths are followed.

- [Portal enrollment and revocation routes](https://github.com/carlos-emr/carlos-portal/blob/fbcc16e1bace11f3b92719766415dc5b9398417f/carlos_patient_portal/routes/mycarlos_availability.py)
- [Portal FCM adapter and handle lookup](https://github.com/carlos-emr/carlos-portal/blob/fbcc16e1bace11f3b92719766415dc5b9398417f/carlos_patient_portal/notification_transports.py)
