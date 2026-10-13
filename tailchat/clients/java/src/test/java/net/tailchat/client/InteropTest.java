package net.tailchat.client;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.TimeUnit;

/**
 * Plain main-based tests: known-answer vectors for the primitives, then interop in both
 * directions against tailchat/public/crypto.js through a real dev-mode server.
 */
public final class InteropTest {
    private static int passed;
    private static final List<String> failures = new ArrayList<>();

    interface Body {
        void run() throws Exception;
    }

    static void test(String name, Body body) {
        long t0 = System.nanoTime();
        try {
            body.run();
            passed++;
            System.out.printf("ok   %-68s %5d ms%n", name, (System.nanoTime() - t0) / 1_000_000);
        } catch (Throwable e) {
            failures.add(name);
            System.out.println("FAIL " + name);
            e.printStackTrace(System.out);
        }
    }

    static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }

    static void eq(Object expected, Object actual, String msg) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(msg + ": expected <" + expected + "> but was <" + actual + ">");
        }
    }

    static void throwsAny(Body body, String msg) {
        try {
            body.run();
        } catch (Exception e) {
            return;
        }
        throw new AssertionError(msg + ": no exception");
    }

    static final HexFormat HEX = HexFormat.of();

    static String b64(String text) {
        return Crypto.b64u(text.getBytes(StandardCharsets.UTF_8));
    }

    // ---------------- environment ----------------

    static Path tailchatDir;
    static Path javaDir;
    static Path work;
    static TestServer server;

    /** Runs the JS peer; returns its last stdout line parsed as JSON. */
    static Map<String, Object> js(String... args) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<>(List.of("node", "--no-warnings=ExperimentalWarning",
                javaDir.resolve("src/test/js/js-peer.mjs").toString()));
        cmd.addAll(List.of(args));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(false);
        pb.environment().put("TAILCHAT_CRYPTO", tailchatDir.resolve("public/crypto.js").toString());
        Process p = pb.start();
        byte[] out = p.getInputStream().readAllBytes();
        byte[] err = p.getErrorStream().readAllBytes();
        if (!p.waitFor(60, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("js-peer timed out");
        }
        String text = new String(out, StandardCharsets.UTF_8).trim();
        if (p.exitValue() != 0) {
            throw new IOException("js-peer " + String.join(" ", args) + " failed: " + new String(err, StandardCharsets.UTF_8) + text);
        }
        String[] lines = text.split("\n");
        return Json.parseObject(lines[lines.length - 1]);
    }

    record CliResult(int code, String out, String err) {
        Map<String, Object> lastJson() {
            String[] lines = out.trim().split("\n");
            return Json.parseObject(lines[lines.length - 1]);
        }

        List<Map<String, Object>> jsonLines() {
            List<Map<String, Object>> rows = new ArrayList<>();
            for (String l : out.trim().split("\n")) if (!l.isBlank()) rows.add(Json.parseObject(l));
            return rows;
        }
    }

    /** Runs the CLI in-process. */
    static CliResult cli(Path state, String user, String... args) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        List<String> all = new ArrayList<>(List.of("--server", server.base, "--dev-user", user, "--state", state.toString()));
        all.addAll(List.of(args));
        int code = Main.run(all.toArray(String[]::new), new PrintStream(out, true, StandardCharsets.UTF_8),
                new PrintStream(err, true, StandardCharsets.UTF_8));
        return new CliResult(code, out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8));
    }

    static CliResult cliOk(Path state, String user, String... args) {
        CliResult r = cli(state, user, args);
        if (r.code != 0) throw new AssertionError("tailchat " + String.join(" ", args) + " exited " + r.code + ": " + r.err + r.out);
        return r;
    }

    static byte[] randomData(int n, long seed) {
        byte[] b = new byte[n];
        new Random(seed).nextBytes(b);
        return b;
    }

    // ---------------- tests ----------------

    public static void main(String[] args) throws Exception {
        javaDir = Path.of(System.getProperty("tailchat.java.dir", ".")).toAbsolutePath().normalize();
        tailchatDir = javaDir.resolve("../..").normalize();
        work = Files.createTempDirectory("tailchat-java-work-");

        unitTests();

        System.out.println("starting server: " + String.join(" ", TestServer.command(tailchatDir)));
        server = TestServer.start(tailchatDir);
        try {
            interopTests();
        } finally {
            server.close();
            deleteTree(work);
        }

        System.out.println();
        System.out.println(passed + " passed, " + failures.size() + " failed");
        if (!failures.isEmpty()) {
            for (String f : failures) System.out.println("  failed: " + f);
            System.exit(1);
        }
    }

    static void deleteTree(Path p) throws IOException {
        if (!Files.exists(p)) return;
        try (var s = Files.walk(p)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(x -> x.toFile().delete());
        }
    }

    static void unitTests() {
        test("base64url without padding round-trips", () -> {
            for (int n = 0; n < 70; n++) {
                byte[] b = randomData(n, n);
                String s = Crypto.b64u(b);
                check(!s.contains("=") && !s.contains("+") && !s.contains("/"), "not b64url: " + s);
                check(Arrays.equals(b, Crypto.unb64u(s)), "round trip " + n);
            }
            eq("-_8", Crypto.b64u(new byte[] {(byte) 0xfb, (byte) 0xff}), "url alphabet");
        });

        test("HKDF-SHA256 matches RFC 5869 test case 1", () -> {
            byte[] okm = Crypto.hkdf(HEX.parseHex("0b".repeat(22)), HEX.parseHex("000102030405060708090a0b0c"),
                    HEX.parseHex("f0f1f2f3f4f5f6f7f8f9"), 42);
            eq("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", HEX.formatHex(okm), "OKM");
        });

        test("AES-KW matches RFC 3394 section 4.6 (256-bit KEK, 256-bit key)", () -> {
            byte[] kek = HEX.parseHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
            byte[] key = HEX.parseHex("00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f");
            byte[] wrapped = Crypto.aesKwWrap(kek, key);
            eq("28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21", HEX.formatHex(wrapped), "wrapped");
            eq(40, wrapped.length, "40 bytes");
            check(Arrays.equals(key, Crypto.aesKwUnwrap(kek, wrapped)), "unwrap");
        });

        test("a message relabelled to another sender is rejected", () -> {
            java.security.KeyPair a = Crypto.generateKeyPair();
            java.security.KeyPair b = Crypto.generateKeyPair();
            KeyRing ringA = new KeyRing("devA", a.getPrivate(), null);
            KeyRing ringB = new KeyRing("devB", b.getPrivate(), null);
            ringA.addPublicKey("devA", Crypto.publicJwk(a.getPublic()), "alice@example.com");
            ringB.addPublicKey("devA", Crypto.publicJwk(a.getPublic()), "alice@example.com");
            String payload = ringA.seal(Json.map("type", "text", "text", "x"), Crypto.chatAad("c1", "m1"),
                    List.of(Json.map("id", "devB", "publicKey", Crypto.publicJwk(b.getPublic()), "userId", "bob@example.com")));
            eq("x", Json.str(ringB.open(payload, Crypto.chatAad("c1", "m1"), "alice@example.com"), "text"), "genuine sender");
            boolean refused = false;
            try {
                ringB.open(payload, Crypto.chatAad("c1", "m1"), "mallory@example.com");
            } catch (java.security.GeneralSecurityException e) {
                refused = true;
            }
            check(refused, "relabelled sender accepted");
            refused = false;
            try {
                ringB.addPublicKey("devA", Crypto.publicJwk(a.getPublic()), "mallory@example.com");
            } catch (java.security.GeneralSecurityException e) {
                refused = true;
            }
            check(refused, "device owner changed");
        });

        test("JWK coordinates are exactly 32 bytes (sign byte stripped, short values padded)", () -> {
            BigInteger high = new BigInteger(1, HEX.parseHex("ff".repeat(32)));
            eq(33, high.toByteArray().length, "BigInteger adds a sign byte");
            check(Arrays.equals(HEX.parseHex("ff".repeat(32)), Crypto.fixed32(high)), "strip sign byte");
            byte[] small = Crypto.fixed32(BigInteger.valueOf(0x0102));
            eq(32, small.length, "padded length");
            eq("0".repeat(60) + "0102", HEX.formatHex(small), "left padded");
            for (int i = 0; i < 300; i++) {
                KeyPair kp = Crypto.generateKeyPair();
                Map<String, Object> jwk = Crypto.publicJwk(kp.getPublic());
                eq(32, Crypto.unb64u(Json.str(jwk, "x")).length, "x length");
                eq(32, Crypto.unb64u(Json.str(jwk, "y")).length, "y length");
                eq(kp.getPublic(), Crypto.publicKeyFromJwk(jwk), "JWK round trip");
            }
        });

        test("JSON reader/writer round-trips unicode, escapes and numbers", () -> {
            String text = "{\"a\":\"h\\u00e9llo \\ud83c\\udf0d \\\"q\\\" \\\\ \\n\",\"n\":-12,\"f\":1.5,\"b\":[true,false,null],\"o\":{}}";
            Map<String, Object> m = Json.parseObject(text);
            eq("héllo 🌍 \"q\" \\ \n", m.get("a"), "string");
            eq(-12L, m.get("n"), "long");
            eq(1.5, m.get("f"), "double");
            eq(m, Json.parseObject(Json.write(m)), "round trip");
            eq("{\"x\":\"\\u0001\"}", Json.write(Json.map("x", "\u0001")), "control char escaped");
        });

        test("envelope seal/open locally, and AAD binding", () -> {
            KeyPair a = Crypto.generateKeyPair();
            KeyPair b = Crypto.generateKeyPair();
            Map<String, Object> dir = Json.map("devA", Crypto.publicJwk(a.getPublic()), "devB", Crypto.publicJwk(b.getPublic()));
            KeyRing.KeyFetcher fetch = ids -> ids.stream().map(id -> Json.map("id", id, "publicKey", dir.get(id))).toList();
            KeyRing ra = new KeyRing("devA", a.getPrivate(), fetch);
            KeyRing rb = new KeyRing("devB", b.getPrivate(), fetch);
            String env = ra.seal(Json.map("type", "text", "text", "hi"), Crypto.chatAad("c", "m"),
                    List.of(Json.map("id", "devB", "publicKey", Crypto.publicJwk(b.getPublic()))));
            Map<String, Object> parsed = Json.parseObject(env);
            eq(1L, parsed.get("v"), "v");
            eq(2, Json.obj(parsed, "keys").size(), "sender + recipient");
            eq(40, Crypto.unb64u(Json.str(Json.obj(parsed, "keys"), "devB")).length, "wrapped key size");
            eq(12, Crypto.unb64u(Json.str(parsed, "iv")).length, "iv size");
            eq("hi", rb.open(env, Crypto.chatAad("c", "m")).get("text"), "recipient opens");
            eq("hi", ra.open(env, Crypto.chatAad("c", "m")).get("text"), "sender opens own message");
            throwsAny(() -> rb.open(env, Crypto.chatAad("c", "other")), "wrong AAD rejected");
            KeyRing rc = new KeyRing("devC", Crypto.generateKeyPair().getPrivate(), null);
            throwsAny(() -> rc.open(env, Crypto.chatAad("c", "m")), "no key for device");
        });

        test("file chunks: sizes, truncation and checksum are enforced", () -> {
            for (int size : new int[] {0, 1, Crypto.CHUNK - 1, Crypto.CHUNK, Crypto.CHUNK + 1, 2 * Crypto.CHUNK + 5}) {
                byte[] data = randomData(size, size);
                ByteArrayOutputStream enc = new ByteArrayOutputStream();
                Crypto.FileSecrets s = Crypto.encryptFile(data, enc);
                byte[] blob = enc.toByteArray();
                eq(Crypto.encryptedSize(size), (long) blob.length, "blob size for " + size);
                Map<String, Object> file = s.toJson();
                ByteArrayOutputStream dec = new ByteArrayOutputStream();
                Crypto.decryptFile(new java.io.ByteArrayInputStream(blob), blob.length, file, dec);
                check(Arrays.equals(data, dec.toByteArray()), "round trip " + size);
            }
            byte[] data = randomData(Crypto.CHUNK + 100, 7);
            ByteArrayOutputStream enc = new ByteArrayOutputStream();
            Map<String, Object> file = Crypto.encryptFile(data, enc).toJson();
            byte[] blob = enc.toByteArray();
            // Dropping the last chunk entirely while lying about the size fails on the "last" AAD flag.
            Map<String, Object> lie = new java.util.LinkedHashMap<>(file);
            lie.put("size", (long) Crypto.CHUNK);
            lie.remove("sha256");
            throwsAny(() -> Crypto.decryptFile(new java.io.ByteArrayInputStream(blob), Crypto.CHUNK + 16, lie, new ByteArrayOutputStream()),
                    "truncation to a whole chunk");
            throwsAny(() -> Crypto.decryptFile(new java.io.ByteArrayInputStream(blob), blob.length - 10, file, new ByteArrayOutputStream()),
                    "short blob");
            Map<String, Object> badSum = new java.util.LinkedHashMap<>(file);
            badSum.put("sha256", Crypto.b64u(new byte[32]));
            throwsAny(() -> Crypto.decryptFile(new java.io.ByteArrayInputStream(blob), blob.length, badSum, new ByteArrayOutputStream()),
                    "checksum mismatch");
            // The chunked digest is SHA-256 over the per-chunk SHA-256s.
            byte[] expected = Crypto.sha256(Crypto.concat(Crypto.sha256(Arrays.copyOfRange(data, 0, Crypto.CHUNK)),
                    Crypto.sha256(Arrays.copyOfRange(data, Crypto.CHUNK, data.length))));
            eq(Crypto.b64u(expected), file.get("sha256"), "chunked sha256");
        });
    }

    static void interopTests() throws Exception {
        Path aliceState = work.resolve("alice.json");
        Path alice2State = work.resolve("alice-2.json");
        Path bobState = work.resolve("bob-js.json");
        String[] chat = new String[1];

        test("CLI registers a device and saves key + token (whoami)", () -> {
            Map<String, Object> me = cliOk(aliceState, "alice", "--json", "whoami").lastJson();
            eq("alice@dev", Json.str(Json.obj(me, "user"), "id"), "user id");
            State s = State.load(aliceState);
            eq(Json.str(Json.obj(me, "device"), "id"), s.deviceId, "device id saved");
            check(s.token != null && s.token.startsWith(s.deviceId + "."), "token saved");
            check(s.privateKey != null, "private key saved");
            // Re-running reuses the same device.
            Map<String, Object> again = cliOk(aliceState, "alice", "--json", "whoami").lastJson();
            eq(s.deviceId, Json.str(Json.obj(again, "device"), "id"), "same device");
            if (!System.getProperty("os.name").startsWith("Windows")) {
                eq("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(aliceState)), "state file mode");
            }
        });

        test("a second Java device for alice whose public key x starts with 0x00", () -> {
            KeyPair kp;
            do {
                kp = Crypto.generateKeyPair();
            } while (((java.security.interfaces.ECPublicKey) kp.getPublic()).getW().getAffineX().bitLength() > 248);
            TailchatClient c = TailchatClient.connect(server.base, "alice", alice2State, "alice phone", kp);
            Map<String, Object> me = c.me();
            byte[] x = Crypto.unb64u(Json.str(Json.obj(Json.obj(me, "device"), "publicKey"), "x"));
            eq(32, x.length, "server stored 32-byte x");
            eq((byte) 0, x[0], "leading zero kept");
        });

        test("JS device registers (bob)", () -> {
            Map<String, Object> r = js("register", server.base, "bob", bobState.toString());
            eq("bob@dev", r.get("userId"), "bob id");
        });

        test("users lists both people", () -> {
            String out = cliOk(aliceState, "alice", "users").out;
            check(out.contains("alice@dev") && out.contains("bob@dev"), out);
        });

        String text = "héllo 🌍 from Java \"quoted\" \\ back\nslash\u2028line";
        String[] javaTextId = new String[1];
        test("Java -> JS: text message (send USER opens the direct chat)", () -> {
            Map<String, Object> sent = cliOk(aliceState, "alice", "--json", "send", "bob@dev", text).lastJson();
            chat[0] = Json.str(sent, "chatId");
            javaTextId[0] = Json.str(sent, "id");
            check(javaTextId[0].length() >= 16 && javaTextId[0].length() <= 32, "message id length");
            Map<String, Object> opened = js("open", bobState.toString(), chat[0], javaTextId[0]);
            Map<String, Object> content = Json.obj(opened, "content");
            eq("text", content.get("type"), "type");
            eq(text, content.get("text"), "JS decrypted the Java text");
            eq(3L, opened.get("keyCount"), "wrapped for bob + both alice devices");
            eq(Map.of("rejected", true), js("open-bad-aad", bobState.toString(), chat[0], javaTextId[0]), "AAD binding in JS");
        });

        test("chats lists the direct chat", () -> {
            String out = cliOk(aliceState, "alice", "chats").out;
            check(out.contains(chat[0]) && out.contains("bob@dev") && out.contains("direct"), out);
        });

        test("send CHAT_ID also works", () -> {
            Map<String, Object> sent = cliOk(aliceState, "alice", "--json", "send", chat[0], "by chat id").lastJson();
            eq(chat[0], sent.get("chatId"), "same chat");
            eq("by chat id", Json.obj(js("open", bobState.toString(), chat[0], Json.str(sent, "id")), "content").get("text"), "text");
        });

        for (int size : new int[] {2 * Crypto.CHUNK + Crypto.CHUNK / 2 + 123, 2 * Crypto.CHUNK, 0}) {
            test("Java -> JS: file of " + size + " bytes (send-file, chunked AES-GCM)", () -> {
                byte[] data = randomData(size, 1000 + size);
                Path src = work.resolve("java-" + size + ".bin");
                Files.write(src, data);
                Map<String, Object> sent = cliOk(aliceState, "alice", "--json", "send-file", "bob@dev", src.toString(),
                        "--caption", "from Java").lastJson();
                Path out = work.resolve("js-got-" + size + ".bin");
                Map<String, Object> opened = js("open", bobState.toString(), chat[0], Json.str(sent, "id"), out.toString());
                Map<String, Object> content = Json.obj(opened, "content");
                eq("media", content.get("type"), "type");
                eq("document", content.get("kind"), "kind");
                eq("from Java", content.get("caption"), "caption");
                Map<String, Object> file = Json.obj(content, "file");
                eq((long) size, file.get("size"), "size");
                eq(src.getFileName().toString(), file.get("name"), "name");
                eq(8, Crypto.unb64u(Json.str(file, "prefix")).length, "8-byte prefix");
                check(Arrays.equals(data, Files.readAllBytes(out)), "JS decrypted bytes match");
            });
        }

        String jsText = "hi from JS 👋 — ünïcödé";
        String[] jsTextId = new String[1];
        test("JS -> Java: text message (history)", () -> {
            Map<String, Object> sent = js("send-text", bobState.toString(), chat[0], b64(jsText));
            jsTextId[0] = Json.str(sent, "id");
            List<Map<String, Object>> rows = cliOk(aliceState, "alice", "--json", "history", chat[0]).jsonLines();
            Map<String, Object> row = rows.stream().filter(r -> jsTextId[0].equals(r.get("id"))).findFirst().orElseThrow();
            eq(jsText, Json.obj(row, "content").get("text"), "Java decrypted the JS text");
            eq("bob@dev", row.get("senderId"), "sender");
            for (Map<String, Object> r : rows) check(r.get("error") == null, "every message decrypts: " + r);
            // Human-readable output too.
            String plain = cliOk(aliceState, "alice", "history", chat[0], "--limit", "3").out;
            check(plain.contains(jsText), plain);
        });

        test("JS -> Java: the second Java device (leading-zero key) decrypts too", () -> {
            TailchatClient c2 = TailchatClient.connect(null, null, alice2State, null);
            Map<String, Object> m = c2.findMessage(jsTextId[0]);
            eq(jsText, c2.openMessage(m).get("text"), "alice-2 opens JS message");
            Map<String, Object> mine = c2.findMessage(javaTextId[0]);
            eq(text, c2.openMessage(mine).get("text"), "alice-2 opens alice-1's message");
            // And the other way: alice-2 sends, JS opens.
            Map<String, Object> sent = c2.sendText(chat[0], "from the leading-zero key");
            eq("from the leading-zero key", Json.obj(js("open", bobState.toString(), chat[0], Json.str(sent, "id")), "content").get("text"), "JS opens");
        });

        for (int size : new int[] {3 * Crypto.CHUNK + 7, 5}) {
            test("JS -> Java: file of " + size + " bytes (download, chunked sha256 verified)", () -> {
                byte[] data = randomData(size, 2000 + size);
                Path src = work.resolve("js-src-" + size + ".bin");
                Files.write(src, data);
                Map<String, Object> sent = js("send-file", bobState.toString(), chat[0], src.toString(), "from js " + size + ".bin");
                Path outDir = work.resolve("downloads");
                Map<String, Object> r = cliOk(aliceState, "alice", "--json", "download", Json.str(sent, "id"), outDir.toString()).lastJson();
                Path got = Path.of(Json.str(r, "path"));
                eq("from js " + size + ".bin", got.getFileName().toString(), "file name");
                check(Arrays.equals(data, Files.readAllBytes(got)), "Java decrypted bytes match");
                eq(Json.str(Json.obj(sent, "file"), "sha256"), r.get("sha256"), "sha256");
                // Downloading again never overwrites.
                Map<String, Object> r2 = cliOk(aliceState, "alice", "--json", "download", Json.str(sent, "id"), outDir.toString()).lastJson();
                check(!r2.get("path").equals(r.get("path")), "second download gets a new name");
            });
        }

        test("download rejects a tampered checksum and leaves no file behind", () -> {
            TailchatClient c = TailchatClient.connect(null, null, aliceState, null);
            Map<String, Object> m = c.messages(chat[0], 200).stream()
                    .filter(x -> "bob@dev".equals(x.get("senderId"))).reduce((a, b) -> b).orElseThrow();
            Map<String, Object> content = c.openMessage(m);
            Map<String, Object> file = new java.util.LinkedHashMap<>(Json.obj(content, "file"));
            file.put("sha256", Crypto.b64u(new byte[32]));
            Path dir = work.resolve("tampered");
            throwsAny(() -> c.downloadFileTo(file, dir), "checksum mismatch");
            try (var s = Files.list(dir)) {
                eq(0L, s.count(), "no partial files");
            }
        });

        test("listen: JS message arrives over the WebSocket, decrypted, with a delivered receipt", () -> {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            String[] args = {"--server", server.base, "--dev-user", "alice", "--state", aliceState.toString(),
                    "listen", "--count", "1"};
            int[] code = {-1};
            Thread t = new Thread(() -> code[0] = Main.run(args, new PrintStream(out, true, StandardCharsets.UTF_8),
                    new PrintStream(err, true, StandardCharsets.UTF_8)));
            t.start();
            long deadline = System.currentTimeMillis() + 15_000;
            while (!err.toString(StandardCharsets.UTF_8).contains("listening") && System.currentTimeMillis() < deadline) {
                check(t.isAlive(), "listen exited early: " + err);
                Thread.sleep(20);
            }
            check(err.toString(StandardCharsets.UTF_8).contains("listening"), "listen never became ready: " + err);
            Map<String, Object> sent = js("send-text", bobState.toString(), chat[0], b64("live over the socket ⚡"));
            t.join(15_000);
            check(!t.isAlive(), "listen did not finish; out=" + out + " err=" + err);
            eq(0, code[0], "exit code; err=" + err);
            String printed = out.toString(StandardCharsets.UTF_8);
            check(printed.contains("live over the socket ⚡") && printed.contains("bob@dev"), printed);
            TailchatClient c = TailchatClient.connect(null, null, aliceState, null);
            long seq = Json.num(sent, "seq", -1);
            long delivered = -1;
            for (int i = 0; i < 50 && delivered < seq; i++) {
                for (Object mem : Json.arr(c.chat(chat[0]), "members")) {
                    Map<String, Object> mm = Json.obj(mem);
                    if ("alice@dev".equals(mm.get("userId"))) delivered = Json.num(mm, "deliveredSeq", -1);
                }
                if (delivered < seq) Thread.sleep(50);
            }
            check(delivered >= seq, "delivered receipt posted: deliveredSeq=" + delivered + " seq=" + seq);
        });

        test("library listen: message events arrive and decrypt", () -> {
            TailchatClient c = TailchatClient.connect(null, null, aliceState, null);
            java.util.concurrent.LinkedBlockingQueue<Map<String, Object>> events = new java.util.concurrent.LinkedBlockingQueue<>();
            try (TailchatClient.Connection conn = c.listen(events::add)) {
                conn.ready().get(10, TimeUnit.SECONDS);
                Map<String, Object> sent = js("send-text", bobState.toString(), chat[0], b64("event test"));
                long deadline = System.currentTimeMillis() + 10_000;
                Map<String, Object> got = null;
                while (got == null && System.currentTimeMillis() < deadline) {
                    Map<String, Object> ev = events.poll(200, TimeUnit.MILLISECONDS);
                    if (ev != null && "message".equals(ev.get("type"))
                            && sent.get("id").equals(Json.obj(ev, "message").get("id"))) got = ev;
                }
                check(got != null, "message event received");
                eq("event test", c.openMessage(Json.obj(got, "message")).get("text"), "decrypted");
            }
        });

        test("security codes match crypto.js (code USER)", () -> {
            String javaCode = cliOk(aliceState, "alice", "code", "bob@dev").out.trim();
            eq(js("code", bobState.toString(), "bob@dev").get("code"), javaCode, "bob's code");
            check(javaCode.matches("^(\\d{5} ){11}\\d{5}$"), javaCode);
            String aliceInJs = Json.str(js("code", bobState.toString(), "alice@dev"), "code");
            eq(aliceInJs, cliOk(aliceState, "alice", "code", "alice@dev").out.trim(), "alice's code (two devices)");
        });

        test("errors: unknown chat, missing file id, bad usage", () -> {
            CliResult r = cli(aliceState, "alice", "send", "no-such-chat-xyz", "hi");
            eq(1, r.code, "unknown target fails");
            check(r.err.contains("No chat or user"), r.err);
            eq(1, cli(aliceState, "alice", "download", "nonexistent-message-id", work.toString()).code, "unknown message");
            eq(2, cli(aliceState, "alice", "send").code, "usage");
            CliResult wrongUser = cli(aliceState, "mallory", "whoami");
            eq(1, wrongUser.code, "state belongs to alice");
        });
    }
}
