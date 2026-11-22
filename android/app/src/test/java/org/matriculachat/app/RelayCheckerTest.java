package org.matriculachat.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assume.assumeTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;

import okhttp3.OkHttpClient;

/**
 * Test de integración contra el relay local (test/relay.mjs).
 * Se salta si no existe la variable BG_FIXTURE (generada por test/bg-fixture.mjs).
 */
public class RelayCheckerTest {

    @Test
    public void leadingZeroBits() {
        assertEquals(16, RelayChecker.leadingZeroBits("0000ff"));
        assertEquals(3, RelayChecker.leadingZeroBits("1f"));
        assertEquals(0, RelayChecker.leadingZeroBits("8"));
    }

    @Test
    public void detectaMensajesYReclamacionesAjenas() throws Exception {
        String path = System.getenv("BG_FIXTURE");
        assumeTrue("sin relay de pruebas", path != null);
        JSONObject f = new JSONObject(new String(Files.readAllBytes(Paths.get(path)), "UTF-8"));

        RelayChecker.Result r = RelayChecker.check(new OkHttpClient(), Arrays.asList(f.getString("relay")),
                toList(f.getJSONArray("pubkeys")), toList(f.getJSONArray("blocked")),
                Arrays.asList(f.getString("tag")), Arrays.asList(f.getString("myPub")), f.getLong("since"), 10_000);

        assertEquals(1, r.relaysAnswered.get());
        assertEquals(new HashSet<>(toList(f.getJSONArray("expectedMessageIds"))), r.messages.keySet());
        // En el cubo hay 2 reclamaciones ajenas: la de mi matrícula y otra más reciente de
        // una matrícula vecina. Solo la primera supera la verificación scrypt.
        assertEquals(2, r.foreignCandidates.size());
        String plate = f.getString("plate");
        RelayChecker.ClaimCandidate c = RelayChecker.newestForeignClaim(r.foreignCandidates,
                x -> RelayChecker.verifyProof(plate, x), 5);
        assertEquals(f.getString("expectedForeignClaim"), c.id);
        assertEquals(null, RelayChecker.newestForeignClaim(r.foreignCandidates,
                x -> RelayChecker.verifyProof("9999ZZZ", x), 5));
    }

    @Test
    public void relayCaidoNoBloquea() {
        long t0 = System.currentTimeMillis();
        RelayChecker.Result r = RelayChecker.check(new OkHttpClient(), Arrays.asList("ws://127.0.0.1:1"),
                Arrays.asList("a".repeat(64)), Arrays.asList(), Arrays.asList(), Arrays.asList(), 0, 5_000);
        assertEquals(0, r.relaysAnswered.get());
        assertEquals(true, System.currentTimeMillis() - t0 < 5_000);
    }

    private static List<String> toList(JSONArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }
}
