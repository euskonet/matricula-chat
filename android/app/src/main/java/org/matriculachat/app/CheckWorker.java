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
        String plateTag = p.getString("plateTag", null);
        String myPub = p.getString("myPub", null);
        long seenAt = p.getLong("seenAt", System.currentTimeMillis() / 1000);
        if (relays.isEmpty() || (pubkeys.isEmpty() && plateTag == null)) return Result.success();

        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build();
        RelayChecker.Result r;
        try {
            r = RelayChecker.check(client, relays, pubkeys, blocked, plateTag, myPub, seenAt + 1, 25_000);
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

        // ¿Ha reclamado alguien mi matrícula?
        String lastClaimNotified = p.getString("claimNotified", "");
        boolean claimAlert = r.foreignClaimId != null && !r.foreignClaimId.equals(lastClaimNotified);
        if (claimAlert) {
            notify(ctx, NOTIF_CLAIM, "Otro dispositivo ha reclamado tu matrícula",
                    "Abre la app para comprobarlo y recuperarla si no has sido tú.");
        }

        List<String> keep = new ArrayList<>(notified);
        keep.remove("");
        if (keep.size() > MAX_REMEMBERED) keep = keep.subList(keep.size() - MAX_REMEMBERED, keep.size());
        SharedPreferences.Editor ed = p.edit()
                .putString("notified", android.text.TextUtils.join(",", keep))
                .putInt("pendingCount", pending);
        if (claimAlert) ed.putString("claimNotified", r.foreignClaimId);
        ed.apply();
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
