package net.tailchat.client;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** The {@code tailchat} command line. */
public final class Main {
    private static final String USAGE = """
            usage: tailchat [--server URL] [--dev-user NAME] [--state FILE] [--name DEVICE] [--json] COMMAND

            commands:
              register                       register this device (done automatically on first use)
              whoami                         your user and device
              users                          people on the tailnet
              chats                          your chats
              send CHAT_OR_USER TEXT...      send a text message (a user id opens the direct chat;
                                             TEXT "-" reads UTF-8 text from stdin)
              send-file CHAT_OR_USER PATH [--caption TEXT]
                                             encrypt, upload and send a file
              history CHAT [--limit N]       decrypt and print recent messages
              download MESSAGE_ID OUTDIR     decrypt and verify a message's file into OUTDIR
              listen [--count N]             print incoming messages live and send delivery receipts
              code USER                      a contact's security code, to compare in person

            options:
              --server URL      e.g. https://chat.tailnet-name.ts.net (or $TAILCHAT_SERVER); saved in the state file
              --dev-user NAME   send X-Dev-User: NAME (dev-mode servers only; or $TAILCHAT_DEV_USER)
              --state FILE      device key and token (default $TAILCHAT_STATE or ~/.config/tailchat/java-client.json)
              --name DEVICE     device name used when registering
              --json            print machine-readable JSON lines
            """;

    private final PrintStream out;
    private final PrintStream err;
    private boolean json;

    private Main(PrintStream out, PrintStream err) {
        this.out = out;
        this.err = err;
    }

    public static void main(String[] args) {
        // Always print UTF-8: message text is Unicode even when the locale says ASCII.
        PrintStream out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, StandardCharsets.UTF_8);
        PrintStream err = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.err), true, StandardCharsets.UTF_8);
        int code = run(args, out, err);
        out.flush();
        err.flush();
        System.exit(code);
    }

    /** Runs the CLI; returns the exit code. */
    public static int run(String[] args, PrintStream out, PrintStream err) {
        return new Main(out, err).exec(args);
    }

    private int exec(String[] argv) {
        String server = env("TAILCHAT_SERVER");
        String devUser = env("TAILCHAT_DEV_USER");
        Path statePath = null;
        String deviceName = null;
        List<String> args = new ArrayList<>();
        try {
            for (int i = 0; i < argv.length; i++) {
                String a = argv[i];
                switch (a) {
                    case "--server" -> server = argv[++i];
                    case "--dev-user" -> devUser = argv[++i];
                    case "--state" -> statePath = Path.of(argv[++i]);
                    case "--name" -> deviceName = argv[++i];
                    case "--json" -> json = true;
                    case "-h", "--help", "help" -> {
                        out.print(USAGE);
                        return 0;
                    }
                    default -> args.add(a);
                }
            }
        } catch (ArrayIndexOutOfBoundsException e) {
            err.println("missing value for " + argv[argv.length - 1]);
            return 2;
        }
        if (args.isEmpty()) {
            err.print(USAGE);
            return 2;
        }
        if (statePath == null) statePath = State.defaultPath();
        String cmd = args.remove(0);
        try {
            TailchatClient client = TailchatClient.connect(server, devUser, statePath, deviceName);
            return switch (cmd) {
                case "register", "whoami" -> whoami(client);
                case "users" -> users(client);
                case "chats" -> chats(client);
                case "send" -> send(client, args);
                case "send-file" -> sendFile(client, args);
                case "history" -> history(client, args);
                case "download" -> download(client, args);
                case "listen" -> listen(client, args);
                case "code" -> code(client, args);
                default -> {
                    err.println("unknown command: " + cmd);
                    err.print(USAGE);
                    yield 2;
                }
            };
        } catch (UsageException e) {
            err.println(e.getMessage());
            return 2;
        } catch (java.util.concurrent.ExecutionException e) {
            err.println("error: " + e.getCause());
            return 1;
        } catch (Exception e) {
            err.println("error: " + e.getMessage());
            return 1;
        }
    }

    private static String env(String name) {
        String v = System.getenv(name);
        return v == null || v.isEmpty() ? null : v;
    }

    private static final class UsageException extends RuntimeException {
        UsageException(String msg) {
            super(msg);
        }
    }

    private static String option(List<String> args, String name) {
        int i = args.indexOf(name);
        if (i < 0) return null;
        if (i + 1 >= args.size()) throw new UsageException("missing value for " + name);
        String v = args.get(i + 1);
        args.remove(i + 1);
        args.remove(i);
        return v;
    }

    private static void need(List<String> args, int n, String usage) {
        if (args.size() < n) throw new UsageException("usage: tailchat " + usage);
    }

    // ---------------- commands ----------------

    private int whoami(TailchatClient c) throws IOException {
        Map<String, Object> me = c.me();
        Map<String, Object> user = Json.obj(me, "user");
        Map<String, Object> device = Json.obj(me, "device");
        if (json) {
            out.println(Json.write(Json.map("user", user, "device", device, "authMode", me.get("authMode"))));
        } else {
            out.println("user:   " + Json.str(user, "id") + " (" + Json.str(user, "name") + ")");
            out.println("device: " + Json.str(device, "id") + " (" + Json.str(device, "name") + ")");
            out.println("server: " + c.state().server + " (auth: " + Json.str(me, "authMode") + ")");
            out.println("code:   " + Crypto.securityCode(List.of(c.state().publicKey)));
        }
        return 0;
    }

    private int users(TailchatClient c) throws IOException {
        for (Map<String, Object> u : c.users()) {
            if (json) {
                out.println(Json.write(u));
                continue;
            }
            String presence = Boolean.TRUE.equals(u.get("online")) ? "online" : "";
            out.println(Json.str(u, "id") + "\t" + Json.str(u, "name") + (presence.isEmpty() ? "" : "\t" + presence));
        }
        return 0;
    }

    private String chatTitle(TailchatClient c, Map<String, Object> chat) {
        String name = Json.str(chat, "name");
        if (name != null && !name.isEmpty()) return name;
        List<String> others = new ArrayList<>();
        for (Object m : Json.arr(chat, "members")) {
            String uid = Json.str(Json.obj(m), "userId");
            if (!uid.equals(c.userId())) others.add(uid);
        }
        return others.isEmpty() ? "(you)" : String.join(", ", others);
    }

    private int chats(TailchatClient c) throws IOException {
        for (Map<String, Object> chat : c.chats()) {
            if (json) {
                out.println(Json.write(chat));
                continue;
            }
            String last = "";
            Map<String, Object> lm = Json.obj(chat, "lastMessage");
            if (lm != null) last = render(c, lm);
            out.println(Json.str(chat, "id") + "\t" + Json.str(chat, "type") + "\t" + chatTitle(c, chat)
                    + "\tunread=" + Json.num(chat, "unread", 0) + (last.isEmpty() ? "" : "\t" + last));
        }
        return 0;
    }

    private int send(TailchatClient c, List<String> args) throws IOException {
        need(args, 2, "send CHAT_OR_USER TEXT...   (TEXT \"-\" reads UTF-8 from stdin)");
        String text = String.join(" ", args.subList(1, args.size()));
        if (text.equals("-")) text = new String(System.in.readAllBytes(), StandardCharsets.UTF_8).stripTrailing();
        if (text.isEmpty()) throw new UsageException("refusing to send an empty message");
        String chatId = c.resolveChat(args.get(0));
        Map<String, Object> m = c.sendText(chatId, text);
        printSent(m);
        return 0;
    }

    private int sendFile(TailchatClient c, List<String> args) throws IOException {
        String caption = option(args, "--caption");
        need(args, 2, "send-file CHAT_OR_USER PATH [--caption TEXT]");
        Path path = Path.of(args.get(1));
        String chatId = c.resolveChat(args.get(0));
        Map<String, Object> m = c.sendFile(chatId, path, caption);
        printSent(m);
        return 0;
    }

    private void printSent(Map<String, Object> m) {
        if (json) out.println(Json.write(Json.map("id", m.get("id"), "chatId", m.get("chatId"), "seq", m.get("seq"))));
        else out.println("sent " + Json.str(m, "id") + " to " + Json.str(m, "chatId") + " (seq " + Json.num(m, "seq", 0) + ")");
    }

    private int history(TailchatClient c, List<String> args) throws IOException {
        String limit = option(args, "--limit");
        need(args, 1, "history CHAT [--limit N]");
        String chatId = c.resolveChat(args.get(0));
        int n = limit == null ? 50 : Integer.parseInt(limit);
        for (Map<String, Object> m : c.messages(chatId, Math.max(1, Math.min(200, n)))) printMessage(c, m, "");
        return 0;
    }

    private int download(TailchatClient c, List<String> args) throws IOException, GeneralSecurityException {
        need(args, 2, "download MESSAGE_ID OUTDIR");
        Map<String, Object> m = c.findMessage(args.get(0));
        if (m == null) throw new IOException("No message " + args.get(0));
        Map<String, Object> content = c.openMessage(m);
        Map<String, Object> file = content == null ? null : Json.obj(content, "file");
        if (file == null) throw new IOException("Message " + args.get(0) + " has no file");
        Path written = c.downloadFileTo(file, Path.of(args.get(1)));
        if (json) out.println(Json.write(Json.map("path", written.toString(), "size", file.get("size"), "sha256", file.get("sha256"))));
        else out.println("saved " + written + " (" + Json.num(file, "size", 0) + " bytes, checksum verified)");
        return 0;
    }

    private int listen(TailchatClient c, List<String> args) throws Exception {
        String countArg = option(args, "--count");
        int max = countArg == null ? -1 : Integer.parseInt(countArg);
        AtomicInteger seen = new AtomicInteger();
        CountDownLatch done = new CountDownLatch(1);
        try (TailchatClient.Connection conn = c.listen(ev -> {
            String type = Json.str(ev, "type");
            Map<String, Object> m = Json.obj(ev, "message");
            switch (type) {
                case "message" -> {
                    printMessage(c, m, "");
                    if (!c.userId().equals(Json.str(m, "senderId")) && "msg".equals(Json.str(m, "kind"))) {
                        try {
                            c.receipts(Json.str(m, "chatId"), Json.num(m, "seq", 0), 0);
                        } catch (IOException e) {
                            err.println("receipt failed: " + e.getMessage());
                        }
                    }
                    if (max > 0 && seen.incrementAndGet() >= max) done.countDown();
                }
                case "message-update" -> printMessage(c, m, "(updated) ");
                case "message-gone" -> {
                    if (json) out.println(Json.write(ev));
                    else out.println("[" + Json.str(ev, "chatId") + "] message " + Json.str(ev, "id") + " is gone");
                }
                default -> { }
            }
            out.flush();
        })) {
            conn.ready().get(15, TimeUnit.SECONDS);
            if (!json) err.println("listening as " + c.userId() + " (" + c.deviceId() + "); Ctrl-C to stop");
            conn.closed().thenRun(done::countDown);
            done.await();
            if (conn.closed().isDone() && (max < 0 || seen.get() < max)) {
                err.println("connection closed: " + conn.closed().getNow(""));
                return 1;
            }
        }
        return 0;
    }

    private int code(TailchatClient c, List<String> args) throws IOException {
        need(args, 1, "code USER");
        List<Map<String, Object>> keys = new ArrayList<>();
        for (Map<String, Object> d : c.userDevices(args.get(0))) keys.add(Json.obj(d, "publicKey"));
        if (keys.isEmpty()) throw new IOException(args.get(0) + " has no linked devices");
        out.println(Crypto.securityCode(keys));
        return 0;
    }

    // ---------------- rendering ----------------

    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault());

    private void printMessage(TailchatClient c, Map<String, Object> m, String prefix) {
        Map<String, Object> content = null;
        String error = null;
        try {
            content = c.openMessage(m);
        } catch (KeyRing.NoKeyException e) {
            error = "not encrypted for this device";
        } catch (GeneralSecurityException | RuntimeException e) {
            error = "could not decrypt: " + e.getMessage();
        }
        if (json) {
            Map<String, Object> row = Json.map("id", m.get("id"), "chatId", m.get("chatId"), "seq", m.get("seq"),
                    "senderId", m.get("senderId"), "kind", m.get("kind"), "createdAt", m.get("createdAt"),
                    "content", content);
            if (m.get("editedAt") != null) row.put("editedAt", m.get("editedAt"));
            if (m.get("deletedAt") != null) row.put("deletedAt", m.get("deletedAt"));
            if (error != null) row.put("error", error);
            out.println(Json.write(row));
            return;
        }
        String when = TIME.format(Instant.ofEpochMilli(Json.num(m, "createdAt", 0)));
        String body = error != null ? "<" + error + ">" : describe(m, content);
        out.println(prefix + "[" + Json.str(m, "chatId") + " #" + Json.num(m, "seq", 0) + " " + when + "] "
                + Json.str(m, "senderId") + ": " + body + "   (id " + Json.str(m, "id") + ")");
    }

    private String render(TailchatClient c, Map<String, Object> m) {
        try {
            return describe(m, c.openMessage(m));
        } catch (GeneralSecurityException | RuntimeException e) {
            return "<encrypted>";
        }
    }

    static String describe(Map<String, Object> m, Map<String, Object> content) {
        if (content == null) return m.get("deletedAt") != null ? "<deleted>" : "<no content>";
        if (!"msg".equals(Json.str(m, "kind"))) return "* " + Json.write(content);
        String type = Json.str(content, "type");
        String s = switch (type == null ? "" : type) {
            case "text" -> Json.str(content, "text");
            case "media" -> {
                Map<String, Object> f = Json.obj(content, "file");
                String cap = Json.str(content, "caption");
                yield "[" + Json.str(content, "kind") + "] " + Json.str(f, "name") + " (" + Json.num(f, "size", 0) + " bytes, "
                        + Json.str(f, "mime") + ")" + (cap == null ? "" : " " + cap);
            }
            case "location" -> "[location] " + content.get("lat") + "," + content.get("lon")
                    + (content.get("name") == null ? "" : " " + content.get("name"));
            case "contact" -> "[contact] " + Json.str(content, "name") + " <" + Json.str(content, "userId") + ">";
            case "poll" -> "[poll] " + Json.str(content, "question") + " " + Json.write(content.get("options"));
            case "call" -> "[" + (Boolean.TRUE.equals(content.get("video")) ? "video " : "") + "call] "
                    + Json.num(content, "duration", 0) + "s";
            default -> Json.write(content);
        };
        if (Boolean.TRUE.equals(content.get("forwarded"))) s = "(forwarded) " + s;
        Map<String, Object> reply = Json.obj(content, "replyTo");
        if (reply != null) s = "(reply to " + Json.str(reply, "id") + ") " + s;
        if (m.get("editedAt") != null) s += " (edited)";
        return s;
    }
}
