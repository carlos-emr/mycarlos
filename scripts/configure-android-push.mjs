import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/android-push');
const packageName = 'ca.carlos.mycarlos';
const block = `<!-- MYCARLOS_PUSH_BEGIN -->
        <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />
        <meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="mycarlos-ready-v1" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/mycarlos_push" />
        <service android:name="ca.carlos.mycarlos.push.ReadyMessagingService" android:exported="false">
            <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT" /></intent-filter>
        </service>
        <!-- MYCARLOS_PUSH_END -->`;
const escapeXml = value => value.replace(/[<>&"']/g, c => ({'<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;'}[c]));
export function firebaseResources(config) {
  const client = config.client?.filter(c => c.client_info?.android_client_info?.package_name === packageName);
  if (client?.length !== 1) throw new Error('Firebase config must contain exactly one matching Android client');
  const values = { google_app_id: client[0].client_info.mobilesdk_app_id,
    gcm_defaultSenderId: config.project_info?.project_number,
    google_api_key: client[0].api_key?.[0]?.current_key,
    project_id: config.project_info?.project_id };
  if (Object.values(values).some(v => typeof v !== 'string' || !v || v.length > 512))
    throw new Error('Firebase public client configuration is incomplete');
  return '<resources>\n' + Object.entries(values).map(([name,value]) =>
    `    <string name="${name}" translatable="false">${escapeXml(value)}</string>`).join('\n') + '\n</resources>\n';
}
export function patchManifest(manifest) {
  if (!/<application\b[^>]*>/.test(manifest) || !manifest.includes('</application>'))
    throw new Error('Generated Android application manifest missing');
  manifest = manifest.replace(/\s*<!-- MYCARLOS_PUSH_BEGIN -->[\s\S]*?<!-- MYCARLOS_PUSH_END -->/g, '')
    .replace(/\s*<uses-permission android:name="android.permission.POST_NOTIFICATIONS"\s*\/>/g, '');
  if (manifest.includes('com.google.firebase.MESSAGING_EVENT') || manifest.includes('firebase_messaging_auto_init_enabled'))
    throw new Error('Unmanaged Firebase manifest configuration; review before replacing');
  return manifest.replace(/<manifest\b[^>]*>/, x => `${x}\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`)
    .replace('</application>', `    ${block}\n    </application>`);
}
export async function configureAndroidPush(appDir, firebaseConfig) {
  // Validate all inputs before touching generated output. No network or account setup.
  const resources = firebaseResources(JSON.parse(await readFile(firebaseConfig, 'utf8')));
  const manifestPath = join(appDir, 'src/main/AndroidManifest.xml');
  const manifest = patchManifest(await readFile(manifestPath, 'utf8'));
  const gradlePath = join(appDir, 'build.gradle.kts');
  const gradle = (await readFile(gradlePath, 'utf8')).replace(/\n\/\/ MYCARLOS_PUSH_BEGIN[\s\S]*?\/\/ MYCARLOS_PUSH_END\n/g, '') +
    '\n// MYCARLOS_PUSH_BEGIN\ndependencies.add("implementation", "com.google.firebase:firebase-messaging:26.0.1")\n// MYCARLOS_PUSH_END\n';
  const kotlin = join(appDir, 'src/main/java/ca/carlos/mycarlos/push');
  await mkdir(kotlin, { recursive: true });
  for (const file of ['PushState.kt', 'PushPlugin.kt', 'ReadyMessagingService.kt'])
    await copyFile(join(source, 'kotlin', file), join(kotlin, file));
  const res = join(appDir, 'src/main/res');
  await mkdir(join(res, 'values'), { recursive: true });
  await mkdir(join(res, 'drawable'), { recursive: true });
  await writeFile(join(res, 'values/mycarlos_firebase.xml'), resources);
  await writeFile(join(res, 'drawable/mycarlos_push.xml'), '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"><path android:fillColor="#FFFFFFFF" android:pathData="M4,3h12l4,4v14H4zM7,10v2h10v-2zM7,15v2h10v-2z" /></vector>\n');
  await writeFile(gradlePath, gradle);
  await writeFile(manifestPath, manifest);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Supply a reviewed Firebase Android client config JSON path');
  await configureAndroidPush(process.argv[3] ?? 'src-tauri/gen/android/app', process.argv[2]);
}
