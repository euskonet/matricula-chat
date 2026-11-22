package org.matriculachat.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Pregunta a los relays si hay novedades para este dispositivo.
 *
 * Solo maneja claves PÚBLICAS: no puede descifrar los mensajes, solo
 * contarlos. Al abrir la app se descifran y validan con las reglas completas
 * (src/protocol.js). Java puro + OkHttp + org.json, para poder testearlo en la JVM.
 */
public final class RelayChecker {

    public static final int KIND_CLAIM = 7151;
    public static final int KIND_MSG = 7152;
    public static final int CLAIM_POW = 16;
    private static final long MAX_FUTURE_SKEW = 5 * 60;

    public static final class Result {
        /** id → created_at de los mensajes nuevos dirigidos a mis claves. */
        public final Map<String, Long> messages = new ConcurrentHashMap<>();
        /** id de la reclamación más reciente de mi matrícula hecha por OTRA clave, o null. */
        public volatile String foreignClaimId = null;
        public volatile long foreignClaimAt = 0;
        public final AtomicInteger relaysAnswered = new AtomicInteger();
    }

    private RelayChecker() {}

    public static Result check(OkHttpClient client, List<String> relays, Collection<String> pubkeys,
                               String plateTag, String myPub, long since, long timeoutMs) {
        return check(client, relays, pubkeys, Collections.emptySet(), plateTag, myPub, since, timeoutMs);
    }

    /** @param blocked remitentes bloqueados: sus mensajes no cuentan ni se notifican. */
    public static Result check(OkHttpClient client, List<String> relays, Collection<String> pubkeys,
                               Collection<String> blocked, String plateTag, String myPub, long since, long timeoutMs) {
        Set<String> blockedSet = new HashSet<>(blocked);
        Result result = new Result();
        Set<String> keys = new HashSet<>(pubkeys);
        boolean watchClaims = plateTag != null && !plateTag.isEmpty() && myPub != null && !myPub.isEmpty();
        if (keys.isEmpty() && !watchClaims) return result;

        String req;
        try {
            JSONArray r = new JSONArray().put("REQ").put("bg");
            if (!keys.isEmpty()) {
                r.put(new JSONObject()
                        .put("kinds", new JSONArray().put(KIND_MSG))
                        .put("#p", new JSONArray(keys))
                        .put("since", since));
            }
            if (watchClaims) {
                r.put(new JSONObject()
                        .put("kinds", new JSONArray().put(KIND_CLAIM))
                        .put("#x", new JSONArray().put(plateTag))
                        .put("since", since));
            }
            req = r.toString();
        } catch (Exception e) {
            return result;
        }

        CountDownLatch latch = new CountDownLatch(relays.size());
        long now = System.currentTimeMillis() / 1000;

        for (String url : relays) {
            AtomicBoolean done = new AtomicBoolean(false);
            Runnable finish = () -> { if (done.compareAndSet(false, true)) latch.countDown(); };
            try {
                client.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
                    @Override public void onOpen(WebSocket ws, Response response) {
                        ws.send(req);
                    }

                    @Override public void onMessage(WebSocket ws, String text) {
                        try {
                            JSONArray msg = new JSONArray(text);
                            String type = msg.optString(0);
                            if ("EOSE".equals(type) || "CLOSED".equals(type)) {
                                if ("EOSE".equals(type)) result.relaysAnswered.incrementAndGet();
                                ws.close(1000, null);
                                finish.run();
                            } else if ("EVENT".equals(type)) {
                                handleEvent(msg.getJSONObject(2), keys, blockedSet, plateTag, myPub, since, now, result);
                            }
                        } catch (Exception ignored) {
                            // mensaje malformado de un relay: se ignora
                        }
                    }

                    @Override public void onClosed(WebSocket ws, int code, String reason) { finish.run(); }

                    @Override public void onFailure(WebSocket ws, Throwable t, Response response) { finish.run(); }
                });
            } catch (Exception e) {
                finish.run();
            }
        }

        try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return result;
    }

    static void handleEvent(JSONObject ev, Set<String> keys, Set<String> blocked, String plateTag, String myPub,
                            long since, long now, Result result) {
        String id = ev.optString("id");
        long createdAt = ev.optLong("created_at");
        if (id.length() != 64 || createdAt < since || createdAt > now + MAX_FUTURE_SKEW) return;
        int kind = ev.optInt("kind");
        JSONArray tags = ev.optJSONArray("tags");

        if (kind == KIND_MSG && hasTag(tags, "p", keys)) {
            if (blocked.contains(ev.optString("pubkey"))) return;
            result.messages.put(id, createdAt);
        } else if (kind == KIND_CLAIM && plateTag != null && hasTag(tags, "x", Collections.singleton(plateTag))) {
            if (myPub.equals(ev.optString("pubkey"))) return;
            if (leadingZeroBits(id) < CLAIM_POW) return; // sin prueba de trabajo: spam
            synchronized (result) {
                if (createdAt >= result.foreignClaimAt) {
                    result.foreignClaimAt = createdAt;
                    result.foreignClaimId = id;
                }
            }
        }
    }

    private static boolean hasTag(JSONArray tags, String name, Set<String> values) {
        if (tags == null) return false;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray t = tags.optJSONArray(i);
            if (t != null && t.length() >= 2 && name.equals(t.optString(0)) && values.contains(t.optString(1))) {
                return true;
            }
        }
        return false;
    }

    static int leadingZeroBits(String hex) {
        int bits = 0;
        for (int i = 0; i < hex.length(); i++) {
            int n = Character.digit(hex.charAt(i), 16);
            if (n < 0) return bits;
            if (n == 0) { bits += 4; continue; }
            return bits + Integer.numberOfLeadingZeros(n) - 28;
        }
        return bits;
    }
}
