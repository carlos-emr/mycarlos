# Try the Android document notice

The hosted **myCarlos-Android-Push-Test** artifact contains a debug APK for arm64 phones and x86_64 emulators. Its application ID is `ca.carlos.mycarlos.pushtest`, so it installs alongside the regular evaluation app. Use a test device with sample data.

1. Install `myCarlos-Android-Push-Test.apk`.
2. Open **Test document notice** from the launcher. Tap **Show test notice**. On Android 13 and later, allow notifications when prompted.
3. Open the notification shade. It should show **myCarlos** and **A new document is available in myCarlos.** Tapping the notice opens the test app. The vault uses its ordinary unlock flow.
4. Turn off notifications for the test app in Android settings and repeat. The preview reports **Notifications are off** and Android suppresses the notice.

The preview uses a fixed synthetic `data.n` and the same token parser and generic Android notification builder as the transport. It exercises device permission and local display. It does not enroll the phone, contact Firebase, receive an actual FCM message, or prove delivery while the app is closed. The debug overlay removes Firebase initialization. The two launcher entries belong to the same isolated test package.

## Transport and consent

Portal's FCM v1 message carries fixed generic text and one data field, `n`, a 22-character unpadded base64url token. Android checks the data keys and shape, and Rust checks the token again with `NoticeToken::parse`. It carries no link, subscription, epoch, sequence, document identifier or destination to open. The foreground service only signals a check through a native callback. Its native inbox accepts notices only while the transport is enabled and permission is granted.

The vault handles duplicates and defers a locked-vault check until unlock. Its existing authenticated document check uses the current vault's own links. A local foreground notice requires an actual addition from that check, current consent, an enrolled Android destination, an unchanged session, OS permission and window focus. A tap opens the normal app. Launch intent extras never authorize a check, open a URL or unlock a vault. Android/FCM may display the Portal's fixed notification when the app is in the background, outside the foreground service; Portal-side consent, revocation and a trusted sender are required.

The regular build has the Cargo feature off. A generated push build requires `android:secure`, then the `android:push` hook with public Android client resources, then `tauri android build --features android-push`. Cargo checks that the generated profile agrees with the feature selection. None of the native push plugin commands have a renderer capability. Permission and registration require a separate explicit remote consent decision. The local Windows arrival preference cannot enable remote push.

## Live integration still required

Portal signs and scopes the device's enrollment and revocation requests. Its subscription route accepts a device-generated destination UUID and consent fields. Neither route accepts an FCM registration token. The sender expects an injected destination-to-provider-handle resolver. The app's separate provider-handle reservation code has no deployed matching binding endpoint. The Android Portal client also fails closed until its native certificate verifier is integrated. The evaluation build therefore does not expose a remote enrollment switch. End-to-end delivery, rotation, opt-out, background receipt and cold taps need a coordinated deployment and device validation.

The notice text is an Android string resource (`res/values*/mycarlos_push_strings.xml`, one per portal language, equal to the Fluent message `notification-android-newDocument`; `scripts/configure-android-push.test.mjs` keeps them equal). The title stays "myCarlos".
