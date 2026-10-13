using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Tailchat.Tests;

/// <summary>Locates the tailchat/ app directory (override with TAILCHAT_ROOT).</summary>
public static class Paths
{
    public static string TailchatRoot { get; } = FindRoot();

    public static string CryptoJs => Path.Combine(TailchatRoot, "public", "crypto.js");

    public static string PeerScript => Path.Combine(AppContext.BaseDirectory, "interop", "peer.mjs");

    private static string FindRoot()
    {
        var env = Environment.GetEnvironmentVariable("TAILCHAT_ROOT");
        if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "PROTOCOL.md")) && File.Exists(Path.Combine(dir.FullName, "public", "crypto.js")))
                return dir.FullName;
        }
        throw new InvalidOperationException("Cannot find the tailchat/ directory; set TAILCHAT_ROOT");
    }
}

/// <summary>
/// How to start the server under test. One place decides:
/// TAILCHAT_SERVER_CMD (run with /bin/sh -c in tailchat/) wins; otherwise the Python port
/// (`python3 -m tailchat_server`) when tailchat/tailchat_server/__main__.py exists; otherwise the
/// Node server (`node server/index.js`, after `npm install` if node_modules is missing).
/// </summary>
public static class ServerCommand
{
    public static (string FileName, string[] Args, string Description) Resolve(string root)
    {
        var custom = Environment.GetEnvironmentVariable("TAILCHAT_SERVER_CMD");
        if (!string.IsNullOrWhiteSpace(custom)) return ("/bin/sh", new[] { "-c", custom }, $"TAILCHAT_SERVER_CMD={custom}");
        if (File.Exists(Path.Combine(root, "tailchat_server", "__main__.py")))
            return ("python3", new[] { "-m", "tailchat_server" }, "python3 -m tailchat_server");
        EnsureNodeModules(root);
        return ("node", new[] { "--no-warnings=ExperimentalWarning", "server/index.js" }, "node server/index.js");
    }

    private static readonly object NpmLock = new();

    public static void EnsureNodeModules(string root)
    {
        lock (NpmLock)
        {
            if (Directory.Exists(Path.Combine(root, "node_modules"))) return;
            var psi = new ProcessStartInfo("npm", "install --no-audit --no-fund") { WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var stderr = p.StandardError.ReadToEndAsync();
            p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            if (p.ExitCode != 0) throw new InvalidOperationException($"npm install failed: {stderr.Result}");
        }
    }
}

/// <summary>A real Tailchat server in dev mode on a free loopback port with a throwaway data directory.</summary>
public sealed class ServerFixture : IAsyncLifetime
{
    private Process? _process;
    private readonly StringBuilder _log = new();

    public string BaseUrl { get; private set; } = "";
    public string DataDir { get; } = Directory.CreateTempSubdirectory("tailchat-csharp-test-").FullName;
    public string Description { get; private set; } = "";

    public string Log
    {
        get
        {
            lock (_log) return _log.ToString();
        }
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    public async Task InitializeAsync()
    {
        var root = Paths.TailchatRoot;
        var (file, args, description) = ServerCommand.Resolve(root);
        Description = description;
        var port = FreePort();
        var psi = new ProcessStartInfo(file)
        {
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["TAILCHAT_AUTH"] = "dev";
        psi.Environment["TAILCHAT_HOST"] = "127.0.0.1";
        psi.Environment["TAILCHAT_PORT"] = port.ToString();
        psi.Environment["TAILCHAT_DATA"] = DataDir;
        _process = Process.Start(psi)!;
        _process.OutputDataReceived += (_, e) => { if (e.Data != null) lock (_log) _log.AppendLine(e.Data); };
        _process.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (_log) _log.AppendLine(e.Data); };
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();
        BaseUrl = $"http://127.0.0.1:{port}";

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (_process.HasExited) throw new InvalidOperationException($"Server ({description}) exited with {_process.ExitCode}:\n{Log}");
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, BaseUrl + "/api/me");
                req.Headers.Add("X-Dev-User", "probe");
                using var res = await http.SendAsync(req);
                if (res.IsSuccessStatusCode) return;
            }
            catch (HttpRequestException)
            {
            }
            catch (TaskCanceledException)
            {
            }
            await Task.Delay(100);
        }
        throw new TimeoutException($"Server ({description}) did not start:\n{Log}");
    }

    public Task DisposeAsync()
    {
        try
        {
            if (_process is { HasExited: false })
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(5000);
            }
        }
        catch (InvalidOperationException)
        {
        }
        _process?.Dispose();
        try
        {
            Directory.Delete(DataDir, recursive: true);
        }
        catch (IOException)
        {
        }
        return Task.CompletedTask;
    }
}

[CollectionDefinition("server")]
public sealed class ServerCollection : ICollectionFixture<ServerFixture>
{
}

/// <summary>Runs interop/peer.mjs: a device built on the web app's public/crypto.js.</summary>
public sealed class JsPeer
{
    public string StateFile { get; }
    public string UserId { get; private set; } = "";
    public string DeviceId { get; private set; } = "";

    private JsPeer(string stateFile) => StateFile = stateFile;

    public static async Task<JsPeer> CreateAsync(string baseUrl, string name, string dir)
    {
        var peer = new JsPeer(Path.Combine(dir, $"js-{name}.json"));
        var res = await RunAsync("init", baseUrl, name, peer.StateFile);
        peer.UserId = res["userId"]!.GetValue<string>();
        peer.DeviceId = res["deviceId"]!.GetValue<string>();
        return peer;
    }

    public Task<JsonObject> Run(string command, params string[] args) => RunAsync(new[] { command, StateFile }.Concat(args).ToArray());

    public static async Task<JsonObject> RunAsync(params string[] args)
    {
        var psi = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("--no-warnings");
        psi.ArgumentList.Add(Paths.PeerScript);
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["TAILCHAT_CRYPTO_JS"] = Paths.CryptoJs;
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        await p.WaitForExitAsync(cts.Token);
        if (p.ExitCode != 0) throw new InvalidOperationException($"peer.mjs {string.Join(' ', args.Take(1))} failed ({p.ExitCode}):\n{await stderr}\n{await stdout}");
        return JsonNode.Parse(await stdout) as JsonObject ?? throw new InvalidOperationException("peer.mjs printed no JSON");
    }
}
