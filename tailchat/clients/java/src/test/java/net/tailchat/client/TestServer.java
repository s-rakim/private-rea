package net.tailchat.client;

import java.io.File;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Starts a real Tailchat server in dev mode on a free loopback port. The one place that decides
 * how to launch it:
 * <ol>
 *   <li>{@code $TAILCHAT_SERVER_CMD} (run with {@code sh -c} in tailchat/), if set;</li>
 *   <li>{@code python3 -m tailchat_server} if tailchat/tailchat_server/__main__.py exists;</li>
 *   <li>otherwise {@code node --no-warnings=ExperimentalWarning server/index.js}.</li>
 * </ol>
 * TAILCHAT_AUTH/HOST/PORT/DATA are passed in the environment in every case.
 */
final class TestServer implements AutoCloseable {
    final String base;
    final String description;
    private final Process process;
    private final Path dataDir;
    private final Path log;

    private TestServer(String base, String description, Process process, Path dataDir, Path log) {
        this.base = base;
        this.description = description;
        this.process = process;
        this.dataDir = dataDir;
        this.log = log;
    }

    static List<String> command(Path tailchatDir) {
        String override = System.getenv("TAILCHAT_SERVER_CMD");
        if (override != null && !override.isBlank()) return List.of("sh", "-c", override);
        if (Files.exists(tailchatDir.resolve("tailchat_server").resolve("__main__.py"))) {
            return List.of("python3", "-m", "tailchat_server");
        }
        return List.of("node", "--no-warnings=ExperimentalWarning", "server/index.js");
    }

    static TestServer start(Path tailchatDir) throws IOException, InterruptedException {
        int port;
        try (ServerSocket s = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            port = s.getLocalPort();
        }
        Path dataDir = Files.createTempDirectory("tailchat-java-test-");
        Path log = dataDir.resolveSibling(dataDir.getFileName() + ".log");
        List<String> cmd = new ArrayList<>(command(tailchatDir));
        ProcessBuilder pb = new ProcessBuilder(cmd)
                .directory(tailchatDir.toFile())
                .redirectErrorStream(true)
                .redirectOutput(log.toFile());
        pb.environment().put("TAILCHAT_AUTH", "dev");
        pb.environment().put("TAILCHAT_HOST", "127.0.0.1");
        pb.environment().put("TAILCHAT_PORT", String.valueOf(port));
        pb.environment().put("TAILCHAT_DATA", dataDir.toString());
        Process p = pb.start();
        String base = "http://127.0.0.1:" + port;
        TestServer server = new TestServer(base, String.join(" ", cmd), p, dataDir, log);
        HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(2)).build();
        long deadline = System.currentTimeMillis() + 30_000;
        while (true) {
            if (!p.isAlive()) {
                String out = Files.readString(log);
                server.close();
                throw new IOException("server exited (" + p.exitValue() + "): " + out);
            }
            try {
                HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(base + "/api/me"))
                        .header("X-Dev-User", "probe").GET().build(), HttpResponse.BodyHandlers.ofString());
                if (r.statusCode() == 200 || r.statusCode() == 401) return server;
            } catch (IOException e) {
                // not up yet
            }
            if (System.currentTimeMillis() > deadline) {
                server.close();
                throw new IOException("server did not start: " + Files.readString(log));
            }
            Thread.sleep(100);
        }
    }

    String log() {
        try {
            return Files.readString(log);
        } catch (IOException e) {
            return "";
        }
    }

    @Override
    public void close() {
        process.descendants().forEach(ProcessHandle::destroy);
        process.destroy();
        try {
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (InterruptedException e) {
            process.destroyForcibly();
        }
        try (Stream<Path> files = Files.walk(dataDir)) {
            files.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
        } catch (IOException ignored) {
            // best effort
        }
        try {
            Files.deleteIfExists(log);
        } catch (IOException ignored) {
            // best effort
        }
    }
}
