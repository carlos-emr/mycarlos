import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureAndroidPush, firebaseResources, patchManifest } from './configure-android-push.mjs';
const config = {project_info:{project_number:'123',project_id:'synthetic-only'},client:[{
  client_info:{android_client_info:{package_name:'ca.carlos.mycarlos'},mobilesdk_app_id:'synthetic-app'},
  api_key:[{current_key:'synthetic-public-client-value'}]}]};
test('configuration rejects wrong app and incomplete client values', () => {
  assert.throws(() => firebaseResources({ ...config, client: [] }));
  assert.throws(() => firebaseResources({ ...config, project_info: {} }));
});
test('manifest is idempotent, disables collection, and refuses unmanaged messaging', () => {
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:allowBackup="false"></application></manifest>';
  const result = patchManifest(manifest);
  assert.equal(patchManifest(result), result);
  assert.match(result, /android:exported="false"/);
  assert.match(result, /firebase_messaging_auto_init_enabled" android:value="false"/);
  assert.match(result, /firebase_analytics_collection_enabled" android:value="false"/);
  assert.match(result, /android:allowBackup="false"/);
  assert.throws(() => patchManifest(manifest.replace('</application>', '<service>com.google.firebase.MESSAGING_EVENT</service></application>')));
});
test('generated project receives service/resources/dependency once; invalid config leaves it unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mycarlos-push-'));
  try {
    await mkdir(join(root,'src/main'),{recursive:true});
    const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application></application></manifest>';
    await writeFile(join(root,'src/main/AndroidManifest.xml'),manifest);
    await writeFile(join(root,'build.gradle.kts'),'plugins {}\n');
    const path=join(root,'firebase.json');await writeFile(path,'{}');
    await assert.rejects(configureAndroidPush(root,path));
    assert.equal(await readFile(join(root,'src/main/AndroidManifest.xml'),'utf8'),manifest);
    await writeFile(path,JSON.stringify(config));
    await configureAndroidPush(root,path);await configureAndroidPush(root,path);
    assert.equal((await readFile(join(root,'build.gradle.kts'),'utf8')).match(/firebase-messaging:/g).length,1);
    assert.match(await readFile(join(root,'src/main/java/ca/carlos/mycarlos/push/ReadyMessagingService.kt'),'utf8'),/override fun onNewToken/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
