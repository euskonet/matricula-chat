package org.matriculachat.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * Tarea periódica (~15 min, el mínimo de Android) que mira si hay avisos
 * nuevos aunque la app esté cerrada. Sin servidor: es el propio móvil el
 * que pregunta a los relays.
 */
public class CheckWorker extends Worker {

    static final String PREFS = "background_check";
    static final String WORK_NAME = "matricula-check";
    static final String CHANNEL_ID = "avisos";
    private static final int NOTIF_MESSAGES = 1001;
    private static final int NOTIF_CLAIM = 1002;
    private static final int MAX_REMEMBERED = 500;

    public CheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void schedule(Context ctx) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(CheckWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    static void runOnce(Context ctx) {
        WorkManager.getInstance(ctx).enqueue(new OneTimeWorkRequest.Builder(CheckWorker.class).build());
    }

    static void cancel(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences p = prefs(ctx);

        Set<String> pubkeys = p.getStringSet("pubkeys", new HashSet<>());
        Set<String> blocked = p.getStringSet("blocked", new HashSet<>());
        List<String> relays = new ArrayList<>(p.getStringSet("relays", new HashSet<>()));
        // Mis matrículas activas: [{tag, plate, myPub}]
        List<String[]> plates = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(p.getString("plates", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                plates.add(new String[] { o.getString("tag"), o.getString("plate"), o.getString("myPub") });
            }
        } catch (Exception ignored) {
            // configuración vacía o antigua
        }
        long seenAt = p.getLong("seenAt", System.currentTimeMillis() / 1000);
        if (relays.isEmpty() || (pubkeys.isEmpty() && plates.isEmpty())) return Result.success();

        Set<String> tags = new HashSet<>(), myPubs = new HashSet<>();
        for (String[] pl : plates) { tags.add(pl[0]); myPubs.add(pl[2]); }

        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build();
        RelayChecker.Result r;
        try {
            r = RelayChecker.check(client, relays, pubkeys, blocked, tags, myPubs, seenAt + 1, 25_000);
        } finally {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
        if (r.relaysAnswered.get() == 0) return Result.retry();

        // Mensajes nuevos que todavía no se han notificado
        Set<String> notified = new HashSet<>(Arrays.asList(p.getString("notified", "").split(",")));
        int fresh = 0;
        for (Map.Entry<String, Long> e : r.messages.entrySet()) {
            if (e.getValue() > seenAt && !notified.contains(e.getKey())) fresh++;
        }
        int pending = p.getInt("pendingCount", 0) + fresh;
        if (fresh > 0) {
            notify(ctx, NOTIF_MESSAGES,
                    pending == 1 ? "Tienes un aviso nuevo" : "Tienes " + pending + " avisos nuevos",
                    "Abre Matrícula Chat para leerlo.");
            notified.addAll(r.messages.keySet());
        }

        // ¿Ha reclamado alguien una de mis matrículas? En cada cubo hay también
        // otras matrículas: solo cuenta si la prueba scrypt coincide.
        Set<String> claimNotified = new HashSet<>(p.getStringSet("claimNotifiedIds", new HashSet<>()));
        Set<String> verdictsOk = new HashSet<>(p.getStringSet("claimOk", new HashSet<>()));
        Set<String> verdictsBad = new HashSet<>(p.getStringSet("claimBad", new HashSet<>()));
        int notifId = NOTIF_CLAIM;
        for (String[] pl : plates) {
            final String tag = pl[0], plate = pl[1];
            List<RelayChecker.ClaimCandidate> mine = new ArrayList<>();
            for (RelayChecker.ClaimCandidate c : r.foreignCandidates) if (tag.equals(c.tag)) mine.add(c);
            RelayChecker.ClaimCandidate foreign = RelayChecker.newestForeignClaim(mine, c -> {
                String key = plate + ":" + c.pubkey + ":" + c.salt;
                if (verdictsOk.contains(key)) return true;
                if (verdictsBad.contains(key)) return false;
                boolean ok = RelayChecker.verifyProof(plate, c);
                (ok ? verdictsOk : verdictsBad).add(key);
                return ok;
            }, 5);
            notifId++;
            if (foreign != null && claimNotified.add(foreign.id)) {
                notify(ctx, notifId, "Otro dispositivo ha reclamado " + plate,
                        "Abre la app para comprobarlo y recuperarla si no has sido tú.");
            }
        }

        List<String> keep = new ArrayList<>(notified);
        keep.remove("");
        if (keep.size() > MAX_REMEMBERED) keep = keep.subList(keep.size() - MAX_REMEMBERED, keep.size());
        if (verdictsBad.size() > MAX_REMEMBERED) verdictsBad.clear();
        if (claimNotified.size() > MAX_REMEMBERED) claimNotified.clear();
        p.edit()
                .putString("notified", android.text.TextUtils.join(",", keep))
                .putInt("pendingCount", pending)
                .putStringSet("claimNotifiedIds", claimNotified)
                .putStringSet("claimOk", verdictsOk)
                .putStringSet("claimBad", verdictsBad)
                .apply();
        return Result.success();
    }

    private static void notify(Context ctx, int id, String title, String body) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx,
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Avisos de otros conductores",
                        NotificationManager.IMPORTANCE_HIGH));
            }
        }
        Intent open = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_plate)
                .setColor(0xFF0B3D91)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build());
        } catch (SecurityException ignored) {
            // permiso retirado entre la comprobación y el aviso
        }
    }
}
