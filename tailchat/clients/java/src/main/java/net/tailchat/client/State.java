package net.tailchat.client;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.util.Map;

/**
 * The device's local state: its P-256 key pair, device id and bearer token. Saved as JSON
 * (mode 0600) because the private key and token must never leave this machine.
 */
public final class State {
    public String server;
    public String devUser;
    public String userId;
    public String deviceId;
    public String deviceName;
    public String token;
    /** PKCS#8 private key, base64url. */
    public String privateKey;
    public Map<String, Object> publicKey;

    public static Path defaultPath() {
        String env = System.getenv("TAILCHAT_STATE");
        if (env != null && !env.isEmpty()) return Path.of(env);
        return Path.of(System.getProperty("user.home"), ".config", "tailchat", "java-client.json");
    }

    public static State load(Path path) throws IOException {
        if (!Files.exists(path)) return null;
        Map<String, Object> m = Json.parseObject(Files.readString(path, StandardCharsets.UTF_8));
        State s = new State();
        s.server = Json.str(m, "server");
        s.devUser = Json.str(m, "devUser");
        s.userId = Json.str(m, "userId");
        s.deviceId = Json.str(m, "deviceId");
        s.deviceName = Json.str(m, "deviceName");
        s.token = Json.str(m, "token");
        s.privateKey = Json.str(m, "privateKey");
        s.publicKey = Json.obj(m, "publicKey");
        return s;
    }

    public void save(Path path) throws IOException {
        Path dir = path.toAbsolutePath().getParent();
        if (dir != null) Files.createDirectories(dir);
        String text = Json.write(Json.map(
                "server", server, "devUser", devUser, "userId", userId, "deviceId", deviceId,
                "deviceName", deviceName, "token", token, "privateKey", privateKey, "publicKey", publicKey)) + "\n";
        Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
        Files.deleteIfExists(tmp);
        try {
            Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException e) {
            Files.createFile(tmp);
        }
        Files.writeString(tmp, text, StandardCharsets.UTF_8);
        Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    public void setKeyPair(KeyPair pair) {
        privateKey = Crypto.b64u(pair.getPrivate().getEncoded());
        publicKey = Crypto.publicJwk(pair.getPublic());
    }

    public PrivateKey privateKey() throws GeneralSecurityException {
        return Crypto.privateKeyFromPkcs8(Crypto.unb64u(privateKey));
    }
}
