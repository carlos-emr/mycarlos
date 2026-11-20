package ca.carlos.mycarlos.push

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only expiring per-destination notification credentials. Never vault/pickup/decryption keys.
 * Android credential-encrypted storage: unavailable before first device unlock. The master key
 * intentionally has no biometric requirement so rotation/revocation can work while vault locked.
 */
internal object ScopedCredentialStore {
    private const val ALIAS = "mycarlos-notification-scope-v1"
    private fun prefs(c: Context) = c.getSharedPreferences("mycarlos-push-credentials-v1", Context.MODE_PRIVATE)
    private fun id(s: String): String { check(UUID.fromString(s).toString() == s && UUID.fromString(s) != UUID(0, 0)); return s }
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        check(create)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build())
        }.generateKey()
    }
    @Synchronized fun put(c: Context, subscription: String, epoch: String, installation: String, expires: Long, credential: String) {
        val sid = id(subscription); id(epoch); id(installation)
        check(credential.isNotEmpty() && credential.length <= 4096 && credential.all { it.code in 33..126 })
        check(expires > System.currentTimeMillis() / 1000)
        val plain = JSONObject().put("subscription_id", sid).put("epoch", epoch).put("installation_id", installation)
            .put("expires_at", expires).put("credential", credential).toString().toByteArray(Charsets.UTF_8)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(true)); check(cipher.iv.size == 12); cipher.updateAAD(sid.toByteArray(Charsets.UTF_8))
            val sealed = cipher.iv + cipher.doFinal(plain)
            check(prefs(c).edit().putString(sid, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit())
        } finally { plain.fill(0) }
    }
    @Synchronized fun get(c: Context, subscription: String, epoch: String, installation: String): JSONObject? {
        val sid = id(subscription); id(epoch); id(installation)
        val sealed = prefs(c).getString(sid, null) ?: return null
        // Tamper/key invalidation is an unavailable credential, never a fallback to vault keys.
        return try {
            val bytes = Base64.decode(sealed, Base64.NO_WRAP)
            check(bytes.size in 29..8192)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(sid.toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(bytes, 12, bytes.size - 12)
            try {
                val result = JSONObject(String(plain, Charsets.UTF_8))
                if (result.getString("subscription_id") != sid || result.getString("epoch") != epoch ||
                    result.getString("installation_id") != installation || result.getLong("expires_at") <= System.currentTimeMillis() / 1000) null
                else result
            } finally { plain.fill(0) }
        } catch (_: Exception) { null }
    }
    @Synchronized fun remove(c: Context, subscription: String) { check(prefs(c).edit().remove(id(subscription)).commit()) }
}
