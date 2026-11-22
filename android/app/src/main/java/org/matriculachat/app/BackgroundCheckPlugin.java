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
        JSArray plates = call.getArray("plates");
        String platesJson = plates == null ? "[]" : plates.toString();

        SharedPreferences prefs = CheckWorker.prefs(getContext());
        SharedPreferences.Editor ed = prefs.edit()
                .putStringSet("pubkeys", pubkeys)
                .putStringSet("relays", relays)
                .putStringSet("blocked", blocked)
                .putString("plates", platesJson);
        // Otra lista de matrículas o claves: los veredictos guardados ya no valen.
        if (!platesJson.equals(prefs.getString("plates", ""))) ed.remove("claimOk").remove("claimBad");
        ed.apply();

        if (relays.isEmpty() || (pubkeys.isEmpty() && (plates == null || plates.length() == 0))) {
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
