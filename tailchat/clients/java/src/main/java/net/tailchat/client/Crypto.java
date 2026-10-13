package net.tailchat.client;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** The cryptographic primitives of PROTOCOL.md §2-5, mirroring public/crypto.js. */
public final class Crypto {
    private Crypto() {}

    public static final int CHUNK = 1024 * 1024;
    public static final int TAG = 16;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final byte[] WRAP_SALT = utf8("tailchat/v1/wrap");

    // ---------------- encoding ----------------

    public static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** base64url without padding. */
    public static String b64u(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** Decodes base64url, with or without padding. */
    public static byte[] unb64u(String text) {
        String t = text.replace('+', '-').replace('/', '_');
        int eq = t.indexOf('=');
        if (eq >= 0) t = t.substring(0, eq);
        return Base64.getUrlDecoder().decode(t);
    }

    public static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        RANDOM.nextBytes(b);
        return b;
    }

    /** A message id: 16 random bytes, base64url (22 characters). */
    public static String newMessageId() {
        return b64u(randomBytes(16));
    }

    public static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------------- AAD strings ----------------

    public static String chatAad(String chatId, String messageId) {
        return "tailchat/v1|chat:" + chatId + "|msg:" + messageId;
    }

    public static String statusAad(String userId) {
        return "tailchat/v1|status:" + userId;
    }

    static byte[] chunkAad(long i, boolean last) {
        return utf8("tailchat/v1|file|" + i + "|" + (last ? "1" : "0"));
    }

    static byte[] chunkIv(byte[] prefix, long i) {
        if (prefix.length != 8) throw new IllegalArgumentException("file prefix must be 8 bytes");
        byte[] iv = new byte[12];
        System.arraycopy(prefix, 0, iv, 0, 8);
        iv[8] = (byte) (i >>> 24);
        iv[9] = (byte) (i >>> 16);
        iv[10] = (byte) (i >>> 8);
        iv[11] = (byte) i;
        return iv;
    }

    // ---------------- HKDF, AES-KW, AES-GCM ----------------

    /** HKDF-SHA256 (RFC 5869). */
    public static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(salt.length == 0 ? new byte[32] : salt, "HmacSHA256"));
            byte[] prk = mac.doFinal(ikm);
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            byte[] out = new byte[length];
            byte[] t = new byte[0];
            int pos = 0;
            for (int counter = 1; pos < length; counter++) {
                mac.update(t);
                mac.update(info);
                mac.update((byte) counter);
                t = mac.doFinal();
                int n = Math.min(t.length, length - pos);
                System.arraycopy(t, 0, out, pos, n);
                pos += n;
            }
            return out;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** RFC 3394 AES key wrap with the default IV (A6A6A6A6A6A6A6A6). */
    public static byte[] aesKwWrap(byte[] kek, byte[] key) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/KW/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kek, "AES"));
        return c.doFinal(key);
    }

    public static byte[] aesKwUnwrap(byte[] kek, byte[] wrapped) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/KW/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(kek, "AES"));
        return c.doFinal(wrapped);
    }

    /** AES-256-GCM; the result is the ciphertext followed by the 16-byte tag. */
    public static byte[] gcmEncrypt(byte[] key, byte[] iv, byte[] plain, byte[] aad) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        c.updateAAD(aad);
        return c.doFinal(plain);
    }

    public static byte[] gcmDecrypt(byte[] key, byte[] iv, byte[] ct, byte[] aad) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        c.updateAAD(aad);
        return c.doFinal(ct);
    }

    // ---------------- P-256 keys ----------------

    private static ECParameterSpec p256;

    static synchronized ECParameterSpec p256() {
        if (p256 == null) {
            try {
                AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
                params.init(new ECGenParameterSpec("secp256r1"));
                p256 = params.getParameterSpec(ECParameterSpec.class);
            } catch (GeneralSecurityException e) {
                throw new IllegalStateException(e);
            }
        }
        return p256;
    }

    public static java.security.KeyPair generateKeyPair() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
            return g.generateKeyPair();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public static PrivateKey privateKeyFromPkcs8(byte[] pkcs8) throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
    }

    /** A BigInteger as exactly 32 big-endian bytes (strips the sign byte, left-pads short values). */
    static byte[] fixed32(BigInteger n) {
        byte[] raw = n.toByteArray();
        if (raw.length == 32) return raw;
        byte[] out = new byte[32];
        if (raw.length > 32) {
            // Only a leading 0x00 sign byte may be dropped.
            for (int i = 0; i < raw.length - 32; i++) {
                if (raw[i] != 0) throw new IllegalArgumentException("coordinate does not fit in 32 bytes");
            }
            System.arraycopy(raw, raw.length - 32, out, 0, 32);
        } else {
            System.arraycopy(raw, 0, out, 32 - raw.length, raw.length);
        }
        return out;
    }

    /** {"kty":"EC","crv":"P-256","x","y"} for a public key. */
    public static Map<String, Object> publicJwk(PublicKey key) {
        ECPoint w = ((ECPublicKey) key).getW();
        return Json.map("kty", "EC", "crv", "P-256",
                "x", b64u(fixed32(w.getAffineX())), "y", b64u(fixed32(w.getAffineY())));
    }

    public static PublicKey publicKeyFromJwk(Map<String, Object> jwk) throws GeneralSecurityException {
        if (!"EC".equals(jwk.get("kty")) || !"P-256".equals(jwk.get("crv"))) {
            throw new GeneralSecurityException("not a P-256 JWK");
        }
        byte[] x = unb64u(Json.str(jwk, "x"));
        byte[] y = unb64u(Json.str(jwk, "y"));
        if (x.length != 32 || y.length != 32) throw new GeneralSecurityException("JWK coordinates must be 32 bytes");
        ECPoint point = new ECPoint(new BigInteger(1, x), new BigInteger(1, y));
        // KeyFactory validates the point is on the curve.
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, p256()));
    }

    /** ECDH: the 32-byte shared x coordinate. */
    public static byte[] ecdh(PrivateKey priv, PublicKey pub) throws GeneralSecurityException {
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(priv);
        ka.doPhase(pub, true);
        byte[] z = ka.generateSecret();
        if (z.length != 32) z = fixed32(new BigInteger(1, z));
        return z;
    }

    /** wrapKey = HKDF(Z, "tailchat/v1/wrap", senderId|recipientId, 32). */
    public static byte[] deriveWrapKey(byte[] sharedZ, String senderId, String recipientId) {
        return hkdf(sharedZ, WRAP_SALT, utf8(senderId + "|" + recipientId), 32);
    }

    // ---------------- files (§5) ----------------

    /** Fields for the content's {@code file} object (without id, name, mime). */
    public record FileSecrets(byte[] key, byte[] prefix, long size, byte[] sha256) {
        public Map<String, Object> toJson() {
            return Json.map("key", b64u(key), "prefix", b64u(prefix), "size", size, "sha256", b64u(sha256));
        }
    }

    public static long chunkCount(long size) {
        return Math.max(1, (size + CHUNK - 1) / CHUNK);
    }

    public static long encryptedSize(long size) {
        return size + chunkCount(size) * TAG;
    }

    /** Encrypts exactly {@code size} bytes from {@code in} into {@code out} in 1 MiB AES-GCM chunks. */
    public static FileSecrets encryptFile(InputStream in, long size, OutputStream out) throws IOException, GeneralSecurityException {
        byte[] key = randomBytes(32);
        byte[] prefix = randomBytes(8);
        long count = chunkCount(size);
        if (count > 0xFFFFFFFFL) throw new IOException("file too large");
        MessageDigest all = sha256();
        for (long i = 0; i < count; i++) {
            int len = (int) Math.min(CHUNK, size - i * CHUNK);
            byte[] plain = in.readNBytes(len);
            if (plain.length != len) throw new EOFException("file shrank while encrypting");
            all.update(sha256(plain));
            out.write(gcmEncrypt(key, chunkIv(prefix, i), plain, chunkAad(i, i == count - 1)));
        }
        return new FileSecrets(key, prefix, size, all.digest());
    }

    public static FileSecrets encryptFile(byte[] data, ByteArrayOutputStream out) throws IOException, GeneralSecurityException {
        return encryptFile(new java.io.ByteArrayInputStream(data), data.length, out);
    }

    /**
     * Decrypts a blob of {@code encryptedLength} bytes using a content {@code file} object and
     * verifies the chunked sha256 (when present). Writes plaintext to {@code out}.
     */
    public static void decryptFile(InputStream in, long encryptedLength, Map<String, Object> file, OutputStream out)
            throws IOException, GeneralSecurityException {
        byte[] key = unb64u(Json.str(file, "key"));
        byte[] prefix = unb64u(Json.str(file, "prefix"));
        long size = Json.num(file, "size", -1);
        if (size < 0) throw new GeneralSecurityException("file size missing");
        long count = chunkCount(size);
        if (encryptedLength != size + count * TAG) throw new GeneralSecurityException("Encrypted file has the wrong size");
        MessageDigest all = sha256();
        for (long i = 0; i < count; i++) {
            int len = (int) Math.min(CHUNK, size - i * CHUNK) + TAG;
            byte[] ct = in.readNBytes(len);
            if (ct.length != len) throw new EOFException("Encrypted file was cut short");
            byte[] pt = gcmDecrypt(key, chunkIv(prefix, i), ct, chunkAad(i, i == count - 1));
            all.update(sha256(pt));
            out.write(pt);
        }
        String expected = Json.str(file, "sha256");
        if (expected != null && !b64u(all.digest()).equals(expected)) {
            throw new GeneralSecurityException("File checksum mismatch");
        }
    }

    // ---------------- security code (§3) ----------------

    /** The 12-group security code over the given device public JWKs. */
    public static String securityCode(List<Map<String, Object>> jwks) {
        List<String> digests = new ArrayList<>();
        for (Map<String, Object> jwk : jwks) {
            byte[] raw = new byte[64];
            System.arraycopy(unb64u(Json.str(jwk, "x")), 0, raw, 0, 32);
            System.arraycopy(unb64u(Json.str(jwk, "y")), 0, raw, 32, 32);
            digests.add(b64u(sha256(raw)));
        }
        // JS Array.prototype.sort compares UTF-16 code units; base64url is ASCII so String order matches.
        Collections.sort(digests);
        byte[] h = sha256(utf8(String.join("", digests)));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            int n = (((h[2 * i] & 0xff) << 16) | ((h[2 * i + 1] & 0xff) << 8) | (h[24 + (i % 8)] & 0xff)) % 100000;
            if (i > 0) sb.append(' ');
            sb.append(String.format("%05d", n));
        }
        return sb.toString();
    }

    static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = Arrays.copyOf(parts[0], n);
        int pos = parts[0].length;
        for (int i = 1; i < parts.length; i++) {
            System.arraycopy(parts[i], 0, out, pos, parts[i].length);
            pos += parts[i].length;
        }
        return out;
    }
}
