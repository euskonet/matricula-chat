package org.matriculachat.app;

import java.security.GeneralSecurityException;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * scrypt (RFC 7914) en Java puro: Android no lo incluye. Se usa para verificar
 * las pruebas de las reclamaciones de matrícula (protocolo v2) en segundo plano.
 * Comprobado con los vectores del RFC y contra @noble/hashes (ScryptTest).
 */
final class Scrypt {

    private Scrypt() {}

    static byte[] scrypt(byte[] passwd, byte[] salt, int N, int r, int p, int dkLen) throws GeneralSecurityException {
        if (N < 2 || (N & (N - 1)) != 0) throw new IllegalArgumentException("N debe ser potencia de 2");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(passwd, "HmacSHA256"));

        byte[] dk = new byte[dkLen];
        byte[] b = new byte[128 * r * p];
        byte[] xy = new byte[256 * r];
        byte[] v = new byte[128 * r * N];

        pbkdf2(mac, salt, b, b.length);
        for (int i = 0; i < p; i++) smix(b, i * 128 * r, r, N, v, xy);
        pbkdf2(mac, b, dk, dkLen);
        return dk;
    }

    private static void smix(byte[] b, int bi, int r, int n, byte[] v, byte[] xy) {
        int blockLen = 128 * r;
        int xi = 0, yi = blockLen;
        System.arraycopy(b, bi, xy, xi, blockLen);
        for (int i = 0; i < n; i++) {
            System.arraycopy(xy, xi, v, i * blockLen, blockLen);
            blockMixSalsa8(xy, xi, yi, r);
        }
        for (int i = 0; i < n; i++) {
            int j = integerify(xy, xi, r) & (n - 1);
            blockXor(v, j * blockLen, xy, xi, blockLen);
            blockMixSalsa8(xy, xi, yi, r);
        }
        System.arraycopy(xy, xi, b, bi, blockLen);
    }

    private static void blockMixSalsa8(byte[] by, int bi, int yi, int r) {
        byte[] x = new byte[64];
        System.arraycopy(by, bi + (2 * r - 1) * 64, x, 0, 64);
        for (int i = 0; i < 2 * r; i++) {
            blockXor(by, bi + i * 64, x, 0, 64);
            salsa20_8(x);
            System.arraycopy(x, 0, by, yi + i * 64, 64);
        }
        for (int i = 0; i < r; i++) System.arraycopy(by, yi + (2 * i) * 64, by, bi + i * 64, 64);
        for (int i = 0; i < r; i++) System.arraycopy(by, yi + (2 * i + 1) * 64, by, bi + (i + r) * 64, 64);
    }

    private static int rotl(int a, int b) {
        return (a << b) | (a >>> (32 - b));
    }

    private static void salsa20_8(byte[] b) {
        int[] b32 = new int[16];
        for (int i = 0; i < 16; i++) {
            b32[i] = (b[i * 4] & 0xff) | (b[i * 4 + 1] & 0xff) << 8 | (b[i * 4 + 2] & 0xff) << 16 | (b[i * 4 + 3] & 0xff) << 24;
        }
        int[] x = b32.clone();
        for (int i = 8; i > 0; i -= 2) {
            x[4] ^= rotl(x[0] + x[12], 7);   x[8] ^= rotl(x[4] + x[0], 9);
            x[12] ^= rotl(x[8] + x[4], 13);  x[0] ^= rotl(x[12] + x[8], 18);
            x[9] ^= rotl(x[5] + x[1], 7);    x[13] ^= rotl(x[9] + x[5], 9);
            x[1] ^= rotl(x[13] + x[9], 13);  x[5] ^= rotl(x[1] + x[13], 18);
            x[14] ^= rotl(x[10] + x[6], 7);  x[2] ^= rotl(x[14] + x[10], 9);
            x[6] ^= rotl(x[2] + x[14], 13);  x[10] ^= rotl(x[6] + x[2], 18);
            x[3] ^= rotl(x[15] + x[11], 7);  x[7] ^= rotl(x[3] + x[15], 9);
            x[11] ^= rotl(x[7] + x[3], 13);  x[15] ^= rotl(x[11] + x[7], 18);
            x[1] ^= rotl(x[0] + x[3], 7);    x[2] ^= rotl(x[1] + x[0], 9);
            x[3] ^= rotl(x[2] + x[1], 13);   x[0] ^= rotl(x[3] + x[2], 18);
            x[6] ^= rotl(x[5] + x[4], 7);    x[7] ^= rotl(x[6] + x[5], 9);
            x[4] ^= rotl(x[7] + x[6], 13);   x[5] ^= rotl(x[4] + x[7], 18);
            x[11] ^= rotl(x[10] + x[9], 7);  x[8] ^= rotl(x[11] + x[10], 9);
            x[9] ^= rotl(x[8] + x[11], 13);  x[10] ^= rotl(x[9] + x[8], 18);
            x[12] ^= rotl(x[15] + x[14], 7); x[13] ^= rotl(x[12] + x[15], 9);
            x[14] ^= rotl(x[13] + x[12], 13); x[15] ^= rotl(x[14] + x[13], 18);
        }
        for (int i = 0; i < 16; i++) {
            int w = x[i] + b32[i];
            b[i * 4] = (byte) w;
            b[i * 4 + 1] = (byte) (w >>> 8);
            b[i * 4 + 2] = (byte) (w >>> 16);
            b[i * 4 + 3] = (byte) (w >>> 24);
        }
    }

    private static void blockXor(byte[] s, int si, byte[] d, int di, int len) {
        for (int i = 0; i < len; i++) d[di + i] ^= s[si + i];
    }

    private static int integerify(byte[] b, int bi, int r) {
        bi += (2 * r - 1) * 64;
        return (b[bi] & 0xff) | (b[bi + 1] & 0xff) << 8 | (b[bi + 2] & 0xff) << 16 | (b[bi + 3] & 0xff) << 24;
    }

    /** PBKDF2-HMAC-SHA256 con una iteración (lo que usa scrypt). */
    private static void pbkdf2(Mac mac, byte[] salt, byte[] out, int len) throws GeneralSecurityException {
        int hLen = mac.getMacLength();
        byte[] u = new byte[hLen];
        byte[] block = new byte[salt.length + 4];
        System.arraycopy(salt, 0, block, 0, salt.length);
        int blocks = (len + hLen - 1) / hLen;
        for (int i = 1; i <= blocks; i++) {
            block[salt.length] = (byte) (i >>> 24);
            block[salt.length + 1] = (byte) (i >>> 16);
            block[salt.length + 2] = (byte) (i >>> 8);
            block[salt.length + 3] = (byte) i;
            mac.update(block);
            mac.doFinal(u, 0);
            int n = Math.min(hLen, len - (i - 1) * hLen);
            System.arraycopy(u, 0, out, (i - 1) * hLen, n);
        }
    }
}
