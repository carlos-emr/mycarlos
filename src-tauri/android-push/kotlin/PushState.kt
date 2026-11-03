package ca.carlos.mycarlos.push

import android.content.Context
import org.json.JSONObject

/** Bounded native transport inbox. Contains no vault key, content or enrollment credential. */
internal object PushState {
    private fun prefs(c: Context) = c.getSharedPreferences("mycarlos-push-v1", Context.MODE_PRIVATE)
    @Synchronized fun enabled(c: Context) = prefs(c).getBoolean("enabled", false)
    @Synchronized fun enable(c: Context, value: Boolean) {
        val p = prefs(c)
        val session = p.getLong("session", 0)
        check(session < Long.MAX_VALUE)
        val e = p.edit().putLong("session", session + 1).putBoolean("enabled", value).putBoolean("reconcile", true)
        if (!value) e.remove("token").remove("hint")
        check(e.commit())
    }
    @Synchronized fun ticket(c: Context) = Pair(prefs(c).getLong("session", 0), prefs(c).getLong("generation", 0))
    @Synchronized fun fetchedToken(c: Context, value: String, expected: Pair<Long, Long>) {
        if (ticket(c) == expected) token(c, value)
    }
    @Synchronized fun token(c: Context, value: String) {
        if (!enabled(c) || value.isEmpty() || value.length > 4096) return
        val p = prefs(c)
        if (p.getString("token", null) == value) return
        val generation = p.getLong("generation", 0)
        check(generation < Long.MAX_VALUE)
        check(p.edit().putString("token", value).putLong("generation", generation + 1)
            .putBoolean("reconcile", true).commit())
    }
    @Synchronized fun hint(c: Context, value: String?) {
        if (!enabled(c)) return
        val e = prefs(c).edit().putBoolean("reconcile", true)
        // Raw hints are untrusted. Rust ReadyHint::decode and Policy::activate are authoritative.
        if (value != null && value.toByteArray(Charsets.UTF_8).size <= 256) e.putString("hint", value)
        check(e.commit())
    }
    @Synchronized fun snapshot(c: Context): JSONObject {
        val p = prefs(c)
        return JSONObject().put("enabled", enabled(c)).put("generation", p.getLong("generation", 0))
            .put("token", p.getString("token", null) ?: JSONObject.NULL)
            .put("hint", p.getString("hint", null) ?: JSONObject.NULL)
            .put("reconcile", p.getBoolean("reconcile", false))
    }
    // No destructive drain: enrollment/rotation retries read the latest token on next resume.
}
