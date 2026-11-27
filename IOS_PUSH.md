# iPhone notices when myCarlos is closed: Apple push service (APNs) release notes

(claude assist) What the release needs for the iPhone push, where each piece lives, and who holds the Apple
key. **Everything marked "decision" is Ben's or counsel's.** Design: `ios-push-design-20261124.md` (supervisor
folder). The client changes, including the sentence files from #480, are in #479 and awaiting merge.
The signing scripts from #499 landed with #428. The portal implementation is on its main branch
(carlos-portal #113 and #114) and operators must enable it. Signed builds and delivery on a real phone
still need verification. The privacy manifest and TestFlight draft are in `IOS_RELEASE.md`.

## What is sent
An **alert push** with no content: a localization key (the phone looks the sentence up in myCarlos's own
`Localizable.strings`, in its language) and one opaque code `n` that only says "check". It is never a silent
push (iOS throttles those and does not deliver them to a force-quit app). `apns-priority 10` with
`apns-push-type alert`, an expiry, and one `apns-collapse-id` per destination so a pile of arrivals shows one
notice. Tapping a notice when the app is closed is expected to open the app on the unlock screen. Confirm
this in a signed build. The system renders the alert from the bundled strings.

## Sandbox and production
Apple runs two push services. A token belongs to one, and a push sent to the other is refused.

| Build | Signed with | `aps-environment` | Token for | The app reports |
| --- | --- | --- | --- | --- |
| Xcode run or development install | a development profile | `development` | sandbox (`api.sandbox.push.apple.com`) | `sandbox` |
| TestFlight and App Store | a distribution profile | `production` | production (`api.push.apple.com`) | `production` |

- The app reads the value at run time from the build's own embedded provisioning profile (`PushEnvironment`
  in `ios-push/core`), not from a debug flag, and falls back to `production` where there is no profile (App
  Store builds). The portal records it with each token (`environment`) and sends to the matching host.
- A phone that moves from a development build to TestFlight gets a new token. After a vault opens, the app
  refreshes registrations in the background for that vault if it has opted in. It reads the iPhone's
  device-wide permission without prompting and requests the token again only when already authorized.
  If permission is denied, it queues revocation of the vault's registrations. The Keychain keeps a digest
  per destination to skip redundant sends and a separate attention flag per vault.

## The entitlement and signing
The **Push Notifications** capability must be on the App ID in the Apple Developer account, and the built app
needs the matching `aps-environment` entitlement. `npm run ios:privacy` generates and selects the Debug
(`development`) and Release (`production`) entitlements. `node scripts/check-ios-privacy.mjs --app X.app
--build debug|release` verifies the signed app's value, and the iOS release gate checks the distribution
profile. See `IOS_RELEASE.md` for the signed-build checks and remaining Apple Developer account setup.

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
  only then revoke the old key in the Apple account. A 403 ends that send and clears the cached provider
  token so the next push signs a new one. The portal clears an expired device token after a 410 and retries
  later after a 429, a server error, or a transport failure.
  The portal's own steps are in its `docs/apns-key-operations.md`.

## HTTP/2
The portal sends over HTTP/2 with its locked `httpx2[http2]` dependency. A portal built without the extra
refuses to start with push on (`apns_http2_unavailable`).

## What Apple and the portal see, and the label
See the new row in `PRIVACY_NOTICE_DRAFT.md`: Apple sees the push token and the app, the time of each push, the
portal's internet address, and the fixed key and opaque code while the push waits. The portal holds the token
**encrypted at rest** and deletes it when it processes revocation, removes the device, or receives an Apple
410. The draft App Privacy label already lists a device identifier for App Functionality as linked to the user
and unused for tracking. **[LEGAL REVIEW: DOES THE APNs TOKEN REQUIRE A SEPARATE DISCLOSURE?]**

## Checks
- On a computer: the token and environment logic (`ios_push` tests, `PushCore` XCTests), the sentence files
  (`npm run ios-push:strings:check`), and the portal's payload and token tests.
- In CI, once written: the simulator job `xcrun simctl push booted ca.carlos.mycarlos payload.apns` with the
  portal's payload, and the tap-opens-the-unlock-screen UI test (a patch for Ben).
- By hand, once, on a real phone: a TestFlight build with the production key, a push with the app closed and
  one after a force-quit; and a development build with the sandbox host. Apple's delivery is not proven by
  any of the automated checks.
