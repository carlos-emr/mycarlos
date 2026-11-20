package ca.carlos.mycarlos.push

import android.content.Context
import org.json.JSONObject

/** Bounded native transport inbox. Contains no vault key, content or enrollment credential. */
internal object PushState {
    private fun prefs(c: Context) = c.getSharedPreferences("mycarlos-push-v2", Context.MODE_PRIVATE)
    @Synchronized fun enabled(c: Context) = prefs(c).getBoolean("enabled", false)
    @Synchronized fun enable(c: Context, value: Boolean) {
        val p = prefs(c)
        val session = p.getLong("session", 0)
        check(session < Long.MAX_VALUE)
        val e = p.edit().putLong("session", session + 1).putBoolean("enabled", value).putBoolean("reconcile", true)
        if (!value) e.remove("token").remove("notice")
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
    private var listener: ((String) -> Unit)? = null

    @Synchronized fun listen(c: Context, notify: (String) -> Unit) {
        listener = notify
        if (enabled(c) && ReadyMessagingService.permitted(c))
            prefs(c).getString("notice", null)?.let(notify)
    }

    @Synchronized fun receive(c: Context, notice: String) {
        if (!enabled(c)) return
        check(prefs(c).edit().putString("notice", notice).commit())
        listener?.invoke(notice)
    }
    @Synchronized fun snapshot(c: Context): JSONObject {
        val p = prefs(c)
        return JSONObject().put("enabled", enabled(c)).put("generation", p.getLong("generation", 0))
            .put("token", p.getString("token", null) ?: JSONObject.NULL)
            .put("reconcile", p.getBoolean("reconcile", false))
    }
    // No destructive drain: enrollment/rotation retries read the latest token on next resume.
}
