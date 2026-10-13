package net.tailchat.client;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Seals and opens message envelopes (PROTOCOL.md §2-3), like KeyRing in public/crypto.js. */
public final class KeyRing {
    /** Looks up public JWKs for device ids: returns [{id, publicKey, userId}] as the server does. */
    public interface KeyFetcher {
        List<Map<String, Object>> fetch(Collection<String> ids) throws Exception;
    }

    /** Thrown by {@link #open} when the envelope carries no key for this device. */
    public static final class NoKeyException extends GeneralSecurityException {
        public NoKeyException() {
            super("Not encrypted for this device");
        }
    }

    private final String deviceId;
    private final PrivateKey privateKey;
    private final KeyFetcher fetcher;
    private final Map<String, PublicKey> publicKeys = new ConcurrentHashMap<>();
    private final Map<String, String> owners = new ConcurrentHashMap<>(); // device id -> tailnet user
    private final Map<String, byte[]> wrapKeys = new ConcurrentHashMap<>();

    public KeyRing(String deviceId, PrivateKey privateKey, KeyFetcher fetcher) {
        this.deviceId = deviceId;
        this.privateKey = privateKey;
        this.fetcher = fetcher;
    }

    public String deviceId() {
        return deviceId;
    }

    public void addPublicKey(String id, Map<String, Object> jwk) throws GeneralSecurityException {
        addPublicKey(id, jwk, null);
    }

    /** userId: the tailnet user the server says owns the device. It can't change later. */
    public void addPublicKey(String id, Map<String, Object> jwk, String userId) throws GeneralSecurityException {
        if (userId != null) {
            String known = owners.putIfAbsent(id, userId);
            if (known != null && !known.equals(userId)) {
                throw new GeneralSecurityException("The server now says device " + id + " belongs to " + userId + ", not " + known);
            }
        }
        if (!publicKeys.containsKey(id)) publicKeys.put(id, Crypto.publicKeyFromJwk(jwk));
    }

    private PublicKey publicKey(String id) throws GeneralSecurityException {
        PublicKey key = publicKeys.get(id);
        if ((key == null || !owners.containsKey(id)) && fetcher != null) {
            try {
                for (Map<String, Object> d : fetcher.fetch(List.of(id))) {
                    addPublicKey(Json.str(d, "id"), Json.obj(d, "publicKey"), Json.str(d, "userId"));
                }
            } catch (GeneralSecurityException e) {
                throw e;
            } catch (Exception e) {
                throw new GeneralSecurityException("Could not fetch key for " + id + ": " + e.getMessage(), e);
            }
            key = publicKeys.get(id);
        }
        if (key == null) throw new GeneralSecurityException("Unknown device " + id);
        return key;
    }

    /** senderId|recipientId always names the sender first, so both ends derive the same key. */
    public byte[] wrapKey(String senderId, String recipientId) throws GeneralSecurityException {
        String cacheKey = senderId + "|" + recipientId;
        byte[] key = wrapKeys.get(cacheKey);
        if (key != null) return key;
        String peer = senderId.equals(deviceId) ? recipientId : senderId;
        byte[] z = Crypto.ecdh(privateKey, publicKey(peer));
        key = Crypto.deriveWrapKey(z, senderId, recipientId);
        wrapKeys.put(cacheKey, key);
        return key;
    }

    /**
     * Encrypts {@code content} (a JSON-able map) for every device in {@code recipients}
     * ([{id, publicKey}], e.g. from GET /api/chats/:id/devices) plus this device.
     * Returns the envelope serialised as a string.
     */
    public String seal(Map<String, Object> content, String aad, List<Map<String, Object>> recipients)
            throws GeneralSecurityException {
        Set<String> ids = new LinkedHashSet<>();
        for (Map<String, Object> d : recipients) {
            String id = Json.str(d, "id");
            addPublicKey(id, Json.obj(d, "publicKey"), Json.str(d, "userId"));
            ids.add(id);
        }
        ids.add(deviceId);
        byte[] contentKey = Crypto.randomBytes(32);
        byte[] iv = Crypto.randomBytes(12);
        byte[] ct = Crypto.gcmEncrypt(contentKey, iv, Json.write(content).getBytes(StandardCharsets.UTF_8),
                aad.getBytes(StandardCharsets.UTF_8));
        Map<String, Object> keys = new LinkedHashMap<>();
        for (String id : ids) keys.put(id, Crypto.b64u(Crypto.aesKwWrap(wrapKey(deviceId, id), contentKey)));
        return Json.write(Json.map("v", 1, "from", deviceId, "iv", Crypto.b64u(iv), "ct", Crypto.b64u(ct), "keys", keys));
    }

    /** Decrypts an envelope (string or parsed map) and returns the content object. */
    public Map<String, Object> open(Object payload, String aad) throws GeneralSecurityException {
        return open(payload, aad, null);
    }

    /**
     * Like {@link #open(Object, String)}, and checks that the sealing device belongs to
     * {@code senderId}, the user the server says sent it, so the server can't relabel messages.
     */
    public Map<String, Object> open(Object payload, String aad, String senderId) throws GeneralSecurityException {
        Map<String, Object> env = payload instanceof String s ? Json.parseObject(s) : Json.obj(payload);
        if (env == null || Json.num(env, "v", -1) != 1 || Json.str(env, "from") == null) {
            throw new GeneralSecurityException("Unsupported envelope version");
        }
        if (senderId != null) {
            String from = Json.str(env, "from");
            publicKey(from);
            String owner = owners.get(from);
            if (!senderId.equals(owner)) {
                throw new GeneralSecurityException("Message was sealed by a device of " + (owner == null ? "an unknown user" : owner) + ", not " + senderId);
            }
        }
        String wrapped = Json.str(Json.obj(env, "keys"), deviceId);
        if (wrapped == null) throw new NoKeyException();
        byte[] contentKey = Crypto.aesKwUnwrap(wrapKey(Json.str(env, "from"), deviceId), Crypto.unb64u(wrapped));
        byte[] pt = Crypto.gcmDecrypt(contentKey, Crypto.unb64u(Json.str(env, "iv")), Crypto.unb64u(Json.str(env, "ct")),
                aad.getBytes(StandardCharsets.UTF_8));
        return Json.parseObject(new String(pt, StandardCharsets.UTF_8));
    }
}
