# iPhone notices when myCarlos is closed: Apple push service (APNs) release notes

(claude assist) What the release needs for the iPhone push, where each piece lives, and who holds the Apple
key. **Everything marked "decision" is Ben's or counsel's.** Design: `ios-push-design-20261124.md` (supervisor
folder). **None of this is built or run on a phone yet**; the plugin is draft #479, the sentence files #480.
The privacy manifest and the TestFlight draft are in `IOS_RELEASE.md` (#428).

## What is sent
An **alert push** with no content: a localization key (the phone looks the sentence up in myCarlos's own
`Localizable.strings`, in its language) and one opaque code `n` that only says "check". It is never a silent
push (iOS throttles those and does not deliver them to a force-quit app). `apns-priority 10` with
`apns-push-type alert`, an expiry, and one `apns-collapse-id` per destination so a pile of arrivals shows one
notice. Tapping it opens the app on the unlock screen; no code of ours runs when the push arrives (unless a
notification service extension is added later).

## Sandbox and production
Apple runs two push services. A token belongs to one, and a push sent to the other is refused.

| Build | Signed with | `aps-environment` | Token for | The app reports |
| --- | --- | --- | --- | --- |
| Xcode run or development install | a development profile | `development` | sandbox (`api.sandbox.push.apple.com`) | `sandbox` |
| TestFlight and App Store | a distribution profile | `production` | production (`api.push.apple.com`) | `production` |

- The app reads the value at run time from the build's own embedded provisioning profile (`PushEnvironment`
  in `ios-push/core`), not from a debug flag, and falls back to `production` where there is no profile (App
  Store builds). The portal records it with each token (`environment`) and sends to the matching host.
- A phone that moves from a development build to TestFlight gets a new token. The app asks for the token at
  every unlock, so it re-registers by itself.

## The entitlement (a later piece, with signing)
The **Push Notifications** capability must be on the App ID in the Apple Developer account, and the built app
needs the `aps-environment` entitlement (`development` or `production`, filled in by the signing profile).
The generated Xcode project does not have it today. The step that adds it, and `check-ios-privacy.mjs --app`
refusing a built app without it, come after #428 merges (the release workflow patch for Ben covers signing).
Without the entitlement `registerForRemoteNotifications` fails and the app reports "unavailable".

## Who holds the Apple key (decision made 24 Nov: the publisher, for the pilot)
- An **APNs authentication key** (a `.p8` file) is made in the publisher organization's Apple Developer account
  (Certificates, Identifiers and Profiles, Keys, enable Apple Push Notifications service). It is shown **once**.
  Keep: the `.p8` file, its **Key ID** and the **Team ID**. One key serves every app of the team and both the
  sandbox and the production service.
- The key lives **on the portal the publisher's organization runs**, as a file outside the repository with
  mode `0600` and its path in the portal's settings (`ApnsConfig`: team id, key id, key path, bundle id
  `ca.carlos.mycarlos`). It is **never in the app**, never in a repository, never in a log (the portal config
  prints no secret). The portal signs a short-lived provider token (ES256, under an hour) from it.
- A clinic that runs its own portal **cannot** push to myCarlos with a key of its own: a push only reaches an
  app whose bundle id belongs to the key's team. Handing clinics a copy of the key is not recommended (anyone
  with it can send alert text to any token they know, and revoking it breaks every clinic at once). A relay
  run by the publisher would let the publisher see tokens and push timing, which the privacy notice says it
  does not; that needs counsel (**decision, open**).
- **Rotation or loss:** in this order, so nothing fails: create the new key in the same account and **leave the
  old one active**; set the new path and key id on the portal and restart it; check that a push is accepted;
  only then revoke the old key in the Apple account. The portal treats every 4xx answer from Apple except 410
  as permanent and does not retry, so a push signed with a key Apple has already revoked is lost, not retried.
  The portal's own steps are in its `docs/apns-key-operations.md`.

## What the portal still lacks: HTTP/2
APNs accepts HTTP/2 only. **The portal has no HTTP/2 client today and refuses to start with push turned on until
one is added** (a candidate is `httpx[http2]`; adding it is Ben's dependency decision). This also blocks the
real-phone test below, so it comes before any delivery to a phone.

## What Apple and the portal see, and the label
See the new row in `PRIVACY_NOTICE_DRAFT.md`: Apple sees the push token and the app, the time of each push, the
portal's internet address, and the fixed key and opaque code while the push waits; the portal also holds the
token, **stored encrypted at rest** (deleted on opt-out, unlink, device removal, or an Apple 410). The App Privacy label keeps the device
identifier already declared (App Functionality, linked to the user, not tracking); counsel confirms the token
needs no further entry.

## Checks
- On a computer: the token and environment logic (`ios_push` tests, `PushCore` XCTests), the sentence files
  (`npm run ios-push:strings:check`), and the portal's payload and token tests.
- In CI, once written: the simulator job `xcrun simctl push booted ca.carlos.mycarlos payload.apns` with the
  portal's payload, and the tap-opens-the-unlock-screen UI test (a patch for Ben).
- By hand, once, on a real phone: a TestFlight build with the production key, a push with the app closed and
  one after a force-quit; and a development build with the sandbox host. Apple's delivery is not proven by
  any of the automated checks.
