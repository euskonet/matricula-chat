package org.matriculachat.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assume.assumeTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Paths;

public class ScryptTest {

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    /** Vectores de prueba oficiales del RFC 7914, sección 12. */
    @Test
    public void vectoresRfc7914() throws Exception {
        assertEquals("fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
                hex(Scrypt.scrypt("password".getBytes("UTF-8"), "NaCl".getBytes("UTF-8"), 1024, 8, 16, 64)));
        assertEquals("7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887",
                hex(Scrypt.scrypt("pleaseletmein".getBytes("UTF-8"), "SodiumChloride".getBytes("UTF-8"), 16384, 8, 1, 64)));
    }

    /** La prueba de la app (JavaScript, @noble/hashes) se verifica igual en Java. */
    @Test
    public void coincideConLaApp() throws Exception {
        String path = System.getenv("BG_FIXTURE");
        assumeTrue("sin fixture", path != null);
        JSONObject v = new JSONObject(new String(Files.readAllBytes(Paths.get(path)), "UTF-8")).getJSONObject("scryptVector");
        RelayChecker.ClaimCandidate c = new RelayChecker.ClaimCandidate("x", "y", 0, v.getString("salt"), v.getString("proof"), "t");
        assertEquals(true, RelayChecker.verifyProof(v.getString("plate"), c));
        assertEquals(false, RelayChecker.verifyProof("1016BCD", c));
    }
}
