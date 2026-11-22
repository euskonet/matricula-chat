package org.matriculachat.app;

import android.content.SharedPreferences;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashSet;
import java.util.Set;

/**
 * Puente entre la app web y la tarea en segundo plano.
 * La app le pasa solo claves públicas y la etiqueta (hash) de la matrícula.
 */
@CapacitorPlugin(name = "BackgroundCheck")
public class BackgroundCheckPlugin extends Plugin {

    @PluginMethod
    public void configure(PluginCall call) {
        Set<String> pubkeys = toSet(call.getArray("pubkeys"));
        Set<String> relays = toSet(call.getArray("relays"));
        Set<String> blocked = toSet(call.getArray("blocked"));
        String plateTag = call.getString("plateTag");
        String myPub = call.getString("myPub");
        String plate = call.getString("plate");

        SharedPreferences.Editor ed = CheckWorker.prefs(getContext()).edit()
                .putStringSet("pubkeys", pubkeys)
                .putStringSet("relays", relays)
                .putStringSet("blocked", blocked);
        if (plateTag != null && myPub != null && plate != null) {
            ed.putString("plateTag", plateTag).putString("myPub", myPub).putString("plate", plate);
        } else {
            ed.remove("plateTag").remove("myPub").remove("plate");
        }
        ed.remove("claimOk").remove("claimBad"); // otra matrícula o clave: se recalcula
        ed.apply();

        if (relays.isEmpty() || (pubkeys.isEmpty() && plateTag == null)) {
            CheckWorker.cancel(getContext());
        } else {
            CheckWorker.schedule(getContext());
        }
        call.resolve();
    }

    /** La app está en primer plano y ya ha mostrado todo hasta `at`. */
    @PluginMethod
    public void markSeen(PluginCall call) {
        Long at = call.getLong("at");
        if (at == null) { call.reject("falta 'at'"); return; }
        SharedPreferences p = CheckWorker.prefs(getContext());
        p.edit()
                .putLong("seenAt", Math.max(at, p.getLong("seenAt", 0)))
                .putInt("pendingCount", 0)
                .apply();
        NotificationManagerCompat.from(getContext()).cancelAll();
        call.resolve();
    }

    /** Lanza una comprobación inmediata (útil para probar). */
    @PluginMethod
    public void checkNow(PluginCall call) {
        CheckWorker.runOnce(getContext());
        call.resolve();
    }

    private static Set<String> toSet(JSArray arr) {
        Set<String> out = new HashSet<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            String s = arr.optString(i, null);
            if (s != null && !s.isEmpty()) out.add(s);
        }
        return out;
    }
}
