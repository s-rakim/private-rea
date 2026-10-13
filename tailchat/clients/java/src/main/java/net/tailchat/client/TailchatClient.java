package net.tailchat.client;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * A Tailchat device: REST calls, end-to-end encryption and the realtime WebSocket.
 * Implements PROTOCOL.md interoperably with the web app.
 */
public final class TailchatClient {
    private final String base;
    private final String devUser;
    private final State state;
    private final HttpClient http;
    private final KeyRing ring;

    private TailchatClient(String server, String devUser, State state) throws GeneralSecurityException {
        this.base = server.replaceAll("/+$", "");
        this.devUser = devUser;
        this.state = state;
        // HTTP/1.1 only: an h2c "Upgrade" header would make Node route the request to the WebSocket handler.
        this.http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        this.ring = new KeyRing(state.deviceId, state.privateKey(), this::fetchKeys);
    }

    /**
     * Loads the device state at {@code statePath}, registering a new device (fresh P-256 key
     * pair) if there is none. {@code server}/{@code devUser} may be null to use the saved values.
     */
    public static TailchatClient connect(String server, String devUser, Path statePath, String deviceName)
            throws IOException, GeneralSecurityException {
        return connect(server, devUser, statePath, deviceName, null);
    }

    /** Like {@link #connect(String, String, Path, String)}, registering {@code keyPair} (or a fresh one if null). */
    public static TailchatClient connect(String server, String devUser, Path statePath, String deviceName,
                                         java.security.KeyPair keyPair) throws IOException, GeneralSecurityException {
        State state = State.load(statePath);
        if (state != null) {
            if (server != null && state.server != null && !normalize(server).equals(normalize(state.server))) {
                throw new IOException("State file " + statePath + " belongs to " + state.server
                        + "; pass --state to use another file for " + server);
            }
            if (devUser != null && state.devUser != null && !devUser.equals(state.devUser)) {
                throw new IOException("State file " + statePath + " belongs to dev user " + state.devUser
                        + "; pass --state to use another file");
            }
            String srv = server != null ? server : state.server;
            String user = devUser != null ? devUser : state.devUser;
            if (srv == null) throw new IOException("No server: pass --server URL");
            return new TailchatClient(srv, user, state);
        }
        if (server == null) throw new IOException("No device registered yet: pass --server URL");
        state = new State();
        state.server = normalize(server);
        state.devUser = devUser;
        state.deviceName = deviceName != null ? deviceName : defaultDeviceName();
        state.setKeyPair(keyPair != null ? keyPair : Crypto.generateKeyPair());
        // Register before the KeyRing exists: it needs the device id.
        Map<String, Object> reg = rawRegister(state);
        state.token = Json.str(reg, "token");
        Map<String, Object> device = Json.obj(reg, "device");
        state.deviceId = Json.str(device, "id");
        state.userId = Json.str(device, "userId");
        state.save(statePath);
        return new TailchatClient(state.server, devUser, state);
    }

    private static String normalize(String server) {
        return server.replaceAll("/+$", "");
    }

    private static String defaultDeviceName() {
        String host = System.getenv("HOSTNAME");
        if (host == null || host.isEmpty()) {
            try {
                host = java.net.InetAddress.getLocalHost().getHostName();
            } catch (IOException e) {
                host = "this machine";
            }
        }
        String name = "Java client on " + host;
        return name.length() > 80 ? name.substring(0, 80) : name;
    }

    private static Map<String, Object> rawRegister(State state) throws IOException {
        TailchatClient tmp;
        try {
            State s = new State();
            s.privateKey = state.privateKey;
            s.deviceId = "unregistered";
            tmp = new TailchatClient(state.server, state.devUser, s);
        } catch (GeneralSecurityException e) {
            throw new IOException(e);
        }
        return tmp.call("POST", "/api/devices", Json.map("name", state.deviceName, "publicKey", state.publicKey));
    }

    public State state() {
        return state;
    }

    public KeyRing ring() {
        return ring;
    }

    public String deviceId() {
        return state.deviceId;
    }

    public String userId() {
        return state.userId;
    }

    // ---------------- HTTP ----------------

    private HttpRequest.Builder request(String path) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofMinutes(30));
        if (devUser != null) b.header("X-Dev-User", devUser);
        if (state.token != null) b.header("Authorization", "Bearer " + state.token);
        return b;
    }

    /** A JSON API call. {@code body} may be null. */
    public Map<String, Object> call(String method, String path, Object body) throws IOException {
        HttpRequest.Builder b = request(path);
        if (body != null) {
            b.header("Content-Type", "application/json");
            b.method(method, HttpRequest.BodyPublishers.ofString(Json.write(body), StandardCharsets.UTF_8));
        } else {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        }
        HttpResponse<String> res = send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        Map<String, Object> data;
        try {
            data = res.body().isEmpty() ? Map.of() : Json.parseObject(res.body());
        } catch (IllegalArgumentException e) {
            data = Map.of("error", res.body());
        }
        if (res.statusCode() / 100 != 2) {
            throw new ApiException(res.statusCode(), method + " " + path + " -> " + res.statusCode() + " " + Json.str(data, "error"));
        }
        return data;
    }

    public Map<String, Object> get(String path) throws IOException {
        return call("GET", path, null);
    }

    private <T> HttpResponse<T> send(HttpRequest req, HttpResponse.BodyHandler<T> handler) throws IOException {
        try {
            return http.send(req, handler);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted", e);
        }
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static List<Map<String, Object>> objects(List<Object> list) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : list) out.add(Json.obj(o));
        return out;
    }

    // ---------------- REST wrappers ----------------

    public Map<String, Object> me() throws IOException {
        return get("/api/me");
    }

    public List<Map<String, Object>> users() throws IOException {
        return objects(Json.arr(get("/api/users"), "users"));
    }

    public List<Map<String, Object>> chats() throws IOException {
        return objects(Json.arr(get("/api/chats"), "chats"));
    }

    public Map<String, Object> chat(String chatId) throws IOException {
        return Json.obj(get("/api/chats/" + enc(chatId)), "chat");
    }

    public List<Map<String, Object>> fetchKeys(Collection<String> ids) throws IOException {
        if (ids.isEmpty()) return List.of();
        List<String> encoded = new ArrayList<>();
        for (String id : ids) encoded.add(enc(id));
        return objects(Json.arr(get("/api/keys?ids=" + String.join(",", encoded)), "devices"));
    }

    public List<Map<String, Object>> chatDevices(String chatId) throws IOException {
        return objects(Json.arr(get("/api/chats/" + enc(chatId) + "/devices"), "devices"));
    }

    public List<Map<String, Object>> userDevices(String userId) throws IOException {
        return objects(Json.arr(get("/api/users/" + enc(userId) + "/devices"), "devices"));
    }

    public Map<String, Object> openDirectChat(String userId) throws IOException {
        return Json.obj(call("POST", "/api/chats/direct", Json.map("userId", userId)), "chat");
    }

    /** One page of history, oldest first. {@code before}/{@code after} are seq numbers or 0. */
    public Map<String, Object> messagesPage(String chatId, long before, long after, int limit) throws IOException {
        StringBuilder q = new StringBuilder("/api/chats/" + enc(chatId) + "/messages?limit=" + limit);
        if (before > 0) q.append("&before=").append(before);
        if (after > 0) q.append("&after=").append(after);
        return get(q.toString());
    }

    public List<Map<String, Object>> messages(String chatId, int limit) throws IOException {
        return objects(Json.arr(messagesPage(chatId, 0, 0, limit), "messages"));
    }

    public void receipts(String chatId, long delivered, long read) throws IOException {
        Map<String, Object> body = Json.map();
        if (delivered > 0) body.put("delivered", delivered);
        if (read > 0) body.put("read", read);
        call("POST", "/api/chats/" + enc(chatId) + "/receipts", body);
    }

    /**
     * Resolves a CLI target: a chat id, or a user id (opens/creates the direct chat).
     * Returns the chat id.
     */
    public String resolveChat(String target) throws IOException {
        for (Map<String, Object> c : chats()) {
            if (target.equals(Json.str(c, "id"))) return target;
        }
        for (Map<String, Object> u : users()) {
            if (target.equals(Json.str(u, "id"))) return Json.str(openDirectChat(target), "id");
        }
        if (target.contains("@")) return Json.str(openDirectChat(target), "id");
        // Maybe a chat we were removed from but can still read.
        try {
            return Json.str(chat(target), "id");
        } catch (ApiException e) {
            throw new IOException("No chat or user called " + target);
        }
    }

    // ---------------- messages ----------------

    /** Encrypts {@code content} for every device in the chat and posts it. Returns the message. */
    public Map<String, Object> sendContent(String chatId, Map<String, Object> content, List<String> files) throws IOException {
        String id = Crypto.newMessageId();
        String payload;
        try {
            payload = ring.seal(content, Crypto.chatAad(chatId, id), chatDevices(chatId));
        } catch (GeneralSecurityException e) {
            throw new IOException("Encryption failed: " + e.getMessage(), e);
        }
        Map<String, Object> body = Json.map("id", id, "payload", payload);
        if (files != null && !files.isEmpty()) body.put("files", files);
        return Json.obj(call("POST", "/api/chats/" + enc(chatId) + "/messages", body), "message");
    }

    public Map<String, Object> sendText(String chatId, String text) throws IOException {
        return sendContent(chatId, Json.map("type", "text", "text", text), null);
    }

    /** Encrypts and uploads a file (§5), returning the content's {@code file} object. */
    public Map<String, Object> uploadEncrypted(Path path, String name, String mime) throws IOException {
        long size = Files.size(path);
        Path tmp = Files.createTempFile("tailchat-upload-", ".bin");
        try {
            Crypto.FileSecrets secrets;
            try (InputStream in = Files.newInputStream(path);
                 OutputStream out = new java.io.BufferedOutputStream(Files.newOutputStream(tmp), 1 << 16)) {
                secrets = Crypto.encryptFile(in, size, out);
            } catch (GeneralSecurityException e) {
                throw new IOException("Encryption failed: " + e.getMessage(), e);
            }
            HttpRequest req = request("/api/files")
                    .header("Content-Type", "application/octet-stream")
                    .POST(HttpRequest.BodyPublishers.ofFile(tmp))
                    .build();
            HttpResponse<String> res = send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() / 100 != 2) {
                throw new ApiException(res.statusCode(), "POST /api/files -> " + res.statusCode() + " " + res.body());
            }
            String id = Json.str(Json.parseObject(res.body()), "id");
            Map<String, Object> file = Json.map("id", id);
            file.putAll(secrets.toJson());
            file.put("name", name);
            file.put("mime", mime);
            return file;
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    public static String guessMime(Path path) {
        try {
            String t = Files.probeContentType(path);
            if (t != null) return t;
        } catch (IOException ignored) {
            // fall through
        }
        return "application/octet-stream";
    }

    public static String kindForMime(String mime) {
        if (mime.equals("image/gif")) return "gif";
        if (mime.startsWith("image/")) return "image";
        if (mime.startsWith("video/")) return "video";
        if (mime.startsWith("audio/")) return "audio";
        return "document";
    }

    /** Sends a file as a {@code media} message. */
    public Map<String, Object> sendFile(String chatId, Path path, String caption) throws IOException {
        String mime = guessMime(path);
        Map<String, Object> file = uploadEncrypted(path, path.getFileName().toString(), mime);
        Map<String, Object> content = Json.map("type", "media", "kind", kindForMime(mime), "file", file);
        if (caption != null && !caption.isEmpty()) content.put("caption", caption);
        return sendContent(chatId, content, List.of(Json.str(file, "id")));
    }

    /**
     * Decrypts a chat message. Returns the content, or null for a deleted message.
     * System messages (kind "system") are not encrypted; their event object is returned as is.
     */
    public Map<String, Object> openMessage(Map<String, Object> message) throws GeneralSecurityException {
        Object payload = message.get("payload");
        if (payload == null) return null;
        if (!"msg".equals(Json.str(message, "kind"))) {
            return payload instanceof String s ? Json.parseObject(s) : Json.obj(payload);
        }
        String sender = Json.str(message, "senderId");
        return ring.open(payload, Crypto.chatAad(Json.str(message, "chatId"), Json.str(message, "id")), sender == null ? "" : sender);
    }

    /** Finds a message by id in any chat this user can read. */
    public Map<String, Object> findMessage(String messageId) throws IOException {
        for (Map<String, Object> c : chats()) {
            String chatId = Json.str(c, "id");
            long before = 0;
            while (true) {
                Map<String, Object> page = messagesPage(chatId, before, 0, 200);
                List<Map<String, Object>> msgs = objects(Json.arr(page, "messages"));
                for (Map<String, Object> m : msgs) {
                    if (messageId.equals(Json.str(m, "id"))) return m;
                }
                if (msgs.isEmpty() || !Boolean.TRUE.equals(page.get("hasMore"))) break;
                before = Json.num(msgs.get(0), "seq", 0);
            }
        }
        return null;
    }

    /** Downloads the encrypted blob for a content {@code file} object, decrypts and verifies it into {@code out}. */
    public void downloadFile(Map<String, Object> file, OutputStream out) throws IOException, GeneralSecurityException {
        Path tmp = Files.createTempFile("tailchat-download-", ".bin");
        try {
            HttpResponse<Path> res = send(request("/api/files/" + enc(Json.str(file, "id"))).GET().build(),
                    HttpResponse.BodyHandlers.ofFile(tmp));
            if (res.statusCode() / 100 != 2) {
                throw new ApiException(res.statusCode(), "GET /api/files -> " + res.statusCode() + " " + Files.readString(tmp));
            }
            try (InputStream in = new java.io.BufferedInputStream(Files.newInputStream(tmp), 1 << 16)) {
                Crypto.decryptFile(in, Files.size(tmp), file, out);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    /**
     * Decrypts and verifies a file into {@code dir}, named after the file's name (made safe, never
     * overwriting). Nothing is left behind if verification fails. Returns the written path.
     */
    public Path downloadFileTo(Map<String, Object> file, Path dir) throws IOException, GeneralSecurityException {
        Files.createDirectories(dir);
        String name = Json.str(file, "name");
        name = name == null ? "" : name.replaceAll("[/\\\\\\x00-\\x1f]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "download-" + Json.str(file, "id");
        Path target = dir.resolve(name);
        for (int i = 1; Files.exists(target); i++) {
            int dot = name.lastIndexOf('.');
            target = dir.resolve(dot > 0 ? name.substring(0, dot) + " (" + i + ")" + name.substring(dot) : name + " (" + i + ")");
        }
        Path part = dir.resolve("." + target.getFileName() + ".part");
        try {
            try (OutputStream out = new java.io.BufferedOutputStream(Files.newOutputStream(part), 1 << 16)) {
                downloadFile(file, out);
            }
            Files.move(part, target);
            return target;
        } finally {
            Files.deleteIfExists(part);
        }
    }

    // ---------------- realtime ----------------

    /** A live WebSocket connection. */
    public static final class Connection implements AutoCloseable {
        private final CompletableFuture<Void> ready = new CompletableFuture<>();
        private final CompletableFuture<String> closed = new CompletableFuture<>();
        private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "tailchat-events");
            t.setDaemon(true);
            return t;
        });
        private volatile WebSocket ws;

        public CompletableFuture<Void> ready() {
            return ready;
        }

        /** Completes with the close reason when the socket closes or fails. */
        public CompletableFuture<String> closed() {
            return closed;
        }

        public void send(Map<String, Object> frame) {
            ws.sendText(Json.write(frame), true).join();
        }

        @Override
        public void close() {
            WebSocket w = ws;
            if (w != null && !w.isOutputClosed()) {
                try {
                    w.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(2, java.util.concurrent.TimeUnit.SECONDS);
                } catch (Exception ignored) {
                    // abort below
                }
                w.abort();
            }
            worker.shutdown();
            closed.complete("closed by client");
        }
    }

    /**
     * Opens the realtime socket, authenticates and delivers each server event to {@code handler}
     * on a single background thread (in order; the handler may make blocking API calls).
     */
    public Connection listen(Consumer<Map<String, Object>> handler) {
        Connection conn = new Connection();
        String wsUrl = base.replaceFirst("^http", "ws") + "/ws";
        WebSocket.Builder b = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(15));
        if (devUser != null) b.header("X-Dev-User", devUser);
        b.buildAsync(URI.create(wsUrl), new WebSocket.Listener() {
            private final StringBuilder buf = new StringBuilder();

            @Override
            public void onOpen(WebSocket webSocket) {
                conn.ws = webSocket;
                webSocket.sendText(Json.write(Json.map("type", "auth", "token", state.token)), true);
                webSocket.request(1);
            }

            @Override
            public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                buf.append(data);
                if (last) {
                    String text = buf.toString();
                    buf.setLength(0);
                    Map<String, Object> event;
                    try {
                        event = Json.parseObject(text);
                    } catch (IllegalArgumentException e) {
                        event = null;
                    }
                    if (event != null) {
                        if ("ready".equals(event.get("type"))) conn.ready.complete(null);
                        Map<String, Object> ev = event;
                        conn.worker.execute(() -> {
                            try {
                                handler.accept(ev);
                            } catch (RuntimeException e) {
                                System.err.println("event handler failed: " + e);
                            }
                        });
                    }
                }
                webSocket.request(1);
                return null;
            }

            @Override
            public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                String why = statusCode + " " + reason;
                conn.ready.completeExceptionally(new IOException("WebSocket closed: " + why));
                conn.closed.complete(why);
                return null;
            }

            @Override
            public void onError(WebSocket webSocket, Throwable error) {
                conn.ready.completeExceptionally(error);
                conn.closed.complete("error: " + error);
            }
        }).whenComplete((ws, err) -> {
            if (err != null) {
                conn.ready.completeExceptionally(err);
                conn.closed.complete("connect failed: " + err);
            }
        });
        return conn;
    }
}
