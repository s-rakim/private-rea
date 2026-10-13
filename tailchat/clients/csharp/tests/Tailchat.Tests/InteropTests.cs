using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Tailchat.Cli;
using Tailchat.Client;
using Xunit;
using Xunit.Abstractions;

namespace Tailchat.Tests;

/// <summary>
/// End-to-end against a real dev-mode server, with a JavaScript peer that uses the web app's
/// public/crypto.js: everything C# seals must open in JS and vice versa.
/// </summary>
[Collection("server")]
public sealed class InteropTests : IDisposable
{
    private static int _counter;
    private readonly ServerFixture _server;
    private readonly ITestOutputHelper _output;
    private readonly string _dir = Directory.CreateTempSubdirectory("tailchat-csharp-interop-").FullName;
    private readonly List<TailchatClient> _clients = new();

    // Text that exercises UTF-8, JSON escaping and characters JSON.stringify leaves raw.
    private static readonly string TrickyText =
        "héllo 👋 from C# — \"quotes\", back\\slash, <tags> & " + (char)0x2028 + " tab\t newline\n end";

    public InteropTests(ServerFixture server, ITestOutputHelper output)
    {
        _server = server;
        _output = output;
        _output.WriteLine($"server: {server.Description} at {server.BaseUrl}");
    }

    private static string Unique(string name) => $"{name}{Interlocked.Increment(ref _counter)}-{Random.Shared.Next(100000)}";

    private async Task<TailchatClient> CSharpUser(string devUser, string? stateName = null)
    {
        var client = await TailchatClient.OpenAsync(new ClientOptions
        {
            Server = _server.BaseUrl,
            DevUser = devUser,
            StatePath = Path.Combine(_dir, $"cs-{stateName ?? devUser}.json"),
            DeviceName = $"{devUser} C# test",
        });
        _clients.Add(client);
        return client;
    }

    private Task<JsPeer> JsUser(string devUser) => JsPeer.CreateAsync(_server.BaseUrl, devUser, _dir);

    [Fact]
    public async Task TextFromCSharpOpensInJs()
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var chat = await alice.ResolveChatAsync(bob.UserId);
        var sent = await alice.SendTextAsync(chat.Id, TrickyText);

        var opened = await bob.Run("open", chat.Id, sent.Id);
        Assert.Equal("text", opened["content"]!["type"]!.GetValue<string>());
        Assert.Equal(TrickyText, opened["content"]!["text"]!.GetValue<string>());
        Assert.Equal(alice.DeviceId, opened["senderDevice"]!.GetValue<string>());
        Assert.Equal(alice.UserId, opened["senderId"]!.GetValue<string>());

        // The sender's own device can read it back too (it wraps for itself).
        var mine = (await alice.HistoryAsync(chat.Id)).Single(m => m.Message.Id == sent.Id);
        Assert.Null(mine.Error);
        Assert.Equal(TrickyText, mine.Content!["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task TextFromJsOpensInCSharp()
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var chatId = (await bob.Run("direct", alice.UserId))["chatId"]!.GetValue<string>();
        var sent = await bob.Run("send-text", chatId, TrickyText);
        var id = sent["id"]!.GetValue<string>();

        var history = await alice.HistoryAsync(chatId);
        var m = history.Single(x => x.Message.Id == id);
        Assert.Null(m.Error);
        Assert.Equal("text", m.Type);
        Assert.Equal(TrickyText, m.Content!["text"]!.GetValue<string>());
        Assert.Equal(bob.DeviceId, m.Message.SenderDevice);

        // The AAD binds the ciphertext to its chat and message id.
        await Assert.ThrowsAnyAsync<CryptographicException>(() => alice.Ring.OpenAsync(m.Message.Payload!, Aad.Chat(chatId, "someOtherMessageId")));
        await Assert.ThrowsAnyAsync<CryptographicException>(() => alice.Ring.OpenAsync(m.Message.Payload!, Aad.Chat("otherChat", id)));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(FileCrypto.ChunkSize)]
    [InlineData(5 * FileCrypto.ChunkSize / 2 + 123)]
    public async Task FileFromCSharpDecryptsInJs(int size)
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var chat = await alice.ResolveChatAsync(bob.UserId);
        var bytes = RandomNumberGenerator.GetBytes(size);
        var path = Path.Combine(_dir, $"report {size}.pdf");
        await File.WriteAllBytesAsync(path, bytes);

        var sent = await alice.SendFileAsync(chat.Id, path, caption: "the report");
        var output = Path.Combine(_dir, $"js-out-{size}.bin");
        var opened = await bob.Run("open", chat.Id, sent.Id, output);
        var content = opened["content"]!;
        Assert.Equal("media", content["type"]!.GetValue<string>());
        Assert.Equal("document", content["kind"]!.GetValue<string>());
        Assert.Equal("the report", content["caption"]!.GetValue<string>());
        Assert.Equal($"report {size}.pdf", content["file"]!["name"]!.GetValue<string>());
        Assert.Equal("application/pdf", content["file"]!["mime"]!.GetValue<string>());
        Assert.Equal(size, content["file"]!["size"]!.GetValue<long>());
        Assert.Equal(FileCrypto.ChunkedSha256(bytes), content["file"]!["sha256"]!.GetValue<string>());
        Assert.Equal(sent.Files!.Single(), content["file"]!["id"]!.GetValue<string>());
        Assert.Equal(bytes, await File.ReadAllBytesAsync(output));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(FileCrypto.ChunkSize)]
    [InlineData(5 * FileCrypto.ChunkSize / 2 + 123)]
    public async Task FileFromJsDecryptsInCSharp(int size)
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var chatId = (await bob.Run("direct", alice.UserId))["chatId"]!.GetValue<string>();
        var bytes = RandomNumberGenerator.GetBytes(size);
        var input = Path.Combine(_dir, $"js-in-{size}.bin");
        await File.WriteAllBytesAsync(input, bytes);
        var sent = await bob.Run("send-file", chatId, input, "../../holiday photo.bin", "application/octet-stream");
        var id = sent["id"]!.GetValue<string>();

        var outDir = Path.Combine(_dir, $"downloads-{size}");
        var saved = await alice.DownloadMessageFileAsync(id, outDir);
        // The sender-controlled name can't escape the output directory.
        Assert.Equal(Path.Combine(outDir, "holiday photo.bin"), saved);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(saved));
        Assert.Single(Directory.GetFiles(outDir));

        var again = await alice.DownloadMessageFileAsync(id, outDir, chatId);
        Assert.Equal(Path.Combine(outDir, "holiday photo (1).bin"), again);

        var m = (await alice.HistoryAsync(chatId)).Single(x => x.Message.Id == id);
        Assert.Equal(sent["sha256"]!.GetValue<string>(), m.File!.Sha256);
        Assert.Equal("from js", m.Content!["caption"]!.GetValue<string>());
    }

    [Fact]
    public async Task TamperedDownloadIsRejected()
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var chatId = (await bob.Run("direct", alice.UserId))["chatId"]!.GetValue<string>();
        var input = Path.Combine(_dir, "tamper.bin");
        await File.WriteAllBytesAsync(input, RandomNumberGenerator.GetBytes(FileCrypto.ChunkSize + 10));
        var id = (await bob.Run("send-file", chatId, input, "tamper.bin", "application/octet-stream"))["id"]!.GetValue<string>();
        var file = (await alice.HistoryAsync(chatId)).Single(x => x.Message.Id == id).File!;

        using var res = await alice.Api.DownloadFileAsync(file.Id!);
        var blob = await res.Content.ReadAsByteArrayAsync();
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(blob[..^1], file));
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(blob[..(FileCrypto.ChunkSize + 16)], file with { Size = FileCrypto.ChunkSize }));
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(blob, file with { Sha256 = Base64Url.Encode(new byte[32]) }));

        // A failed download leaves nothing behind in the output directory.
        var outDir = Path.Combine(_dir, "tampered-out");
        Directory.CreateDirectory(outDir);
        await Assert.ThrowsAsync<TailchatException>(async () =>
        {
            await using var fs = File.Create(Path.Combine(outDir, "x"));
            await alice.DownloadAsync(file with { Sha256 = Base64Url.Encode(new byte[32]) }, fs);
        });
    }

    [Fact]
    public async Task SecondDeviceOfSameUserCanRead()
    {
        var name = Unique("alice");
        var phone = await CSharpUser(name, name + "-phone");
        var laptop = await CSharpUser(name, name + "-laptop");
        Assert.NotEqual(phone.DeviceId, laptop.DeviceId);
        var bob = await JsUser(Unique("bob"));
        var chat = await phone.ResolveChatAsync(bob.UserId);
        var sent = await phone.SendTextAsync(chat.Id, "synced");
        var onLaptop = (await laptop.HistoryAsync(chat.Id)).Single(m => m.Message.Id == sent.Id);
        Assert.Equal("synced", onLaptop.Content!["text"]!.GetValue<string>());
        var js = await bob.Run("send-text", chat.Id, "to both");
        var reply = (await laptop.HistoryAsync(chat.Id)).Single(m => m.Message.Id == js["id"]!.GetValue<string>());
        Assert.Equal("to both", reply.Content!["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task ListenDecryptsLiveMessagesAndSendsDeliveredReceipts()
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var chatId = (await bob.Run("direct", alice.UserId))["chatId"]!.GetValue<string>();

        var connected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var received = new TaskCompletionSource<DecryptedMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var listening = alice.ListenAsync(evt =>
        {
            if (evt.Type == "message" && evt.Message?.Message.ChatId == chatId) received.TrySetResult(evt.Message);
            return Task.CompletedTask;
        }, status =>
        {
            _output.WriteLine($"listen: {status}");
            if (status == "connected") connected.TrySetResult();
            return Task.CompletedTask;
        }, cts.Token);

        await connected.Task.WaitAsync(cts.Token);
        var sent = await bob.Run("send-text", chatId, TrickyText);
        var message = await received.Task.WaitAsync(cts.Token);
        Assert.Null(message.Error);
        Assert.Equal(TrickyText, message.Content!["text"]!.GetValue<string>());
        var seq = sent["seq"]!.GetValue<long>();

        // The delivered receipt reaches the server.
        long delivered = 0;
        for (int i = 0; i < 50 && delivered < seq; i++)
        {
            var chat = await alice.Api.GetChatAsync(chatId);
            delivered = chat.Members.Single(m => m.UserId == alice.UserId).DeliveredSeq;
            if (delivered < seq) await Task.Delay(100);
        }
        Assert.Equal(seq, delivered);
        cts.Cancel();
        await listening;
    }

    [Fact]
    public async Task SecurityCodeMatchesJs()
    {
        var alice = await CSharpUser(Unique("alice"));
        var bob = await JsUser(Unique("bob"));
        var devices = new List<DeviceInfo>(await alice.Api.GetUserDevicesAsync(alice.UserId));
        devices.AddRange(await alice.Api.GetUserDevicesAsync(bob.UserId));
        var js = await bob.Run("security-code", alice.UserId);
        Assert.Equal(js["code"]!.GetValue<string>(), SecurityCode.Compute(devices));
    }

    private async Task<(int Code, string Out, string Err)> Cli(params string[] args)
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        var code = await CliApp.RunAsync(args, stdout, stderr);
        _output.WriteLine($"$ tailchat {string.Join(' ', args)}\n{stdout}{stderr}");
        return (code, stdout.ToString(), stderr.ToString());
    }

    [Fact]
    public async Task CliEndToEnd()
    {
        var name = Unique("carol");
        var state = Path.Combine(_dir, $"cli-{name}.json");
        var bob = await JsUser(Unique("bob"));
        string[] G(params string[] rest) => new[] { "--server", _server.BaseUrl, "--dev-user", name, "--state", state }.Concat(rest).ToArray();

        var who = await Cli(G("whoami"));
        Assert.Equal(0, who.Code);
        Assert.Contains($"{name}@dev", who.Out);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(state));

        var users = await Cli(G("users"));
        Assert.Contains(bob.UserId, users.Out);

        var send = await Cli(G("send", bob.UserId, "hi from the cli"));
        Assert.Equal(0, send.Code);
        var sentId = send.Out.Split(' ')[1];
        var chatId = send.Out.Split(' ')[3];
        Assert.Equal("hi from the cli", (await bob.Run("open", chatId, sentId))["content"]!["text"]!.GetValue<string>());

        var bytes = RandomNumberGenerator.GetBytes(FileCrypto.ChunkSize + 4321);
        var path = Path.Combine(_dir, "cli-upload.png");
        await File.WriteAllBytesAsync(path, bytes);
        var sendFile = await Cli(G("send-file", chatId, path, "--caption", "pic"));
        Assert.Equal(0, sendFile.Code);
        var fileMsg = sendFile.Out.Split(' ')[1];
        var jsOut = Path.Combine(_dir, "cli-js-out.png");
        var opened = await bob.Run("open", chatId, fileMsg, jsOut);
        Assert.Equal("image", opened["content"]!["kind"]!.GetValue<string>());
        Assert.Equal(bytes, await File.ReadAllBytesAsync(jsOut));

        var jsFile = Path.Combine(_dir, "from-js.txt");
        await File.WriteAllTextAsync(jsFile, "plain text file from js");
        var jsSent = await bob.Run("send-file", chatId, jsFile, "notes.txt", "text/plain");
        var jsText = await bob.Run("send-text", chatId, "and a text");

        var history = await Cli(G("history", chatId));
        Assert.Equal(0, history.Code);
        Assert.Contains("hi from the cli", history.Out);
        Assert.Contains("[image] cli-upload.png", history.Out);
        Assert.Contains("[document] notes.txt", history.Out);
        Assert.Contains("and a text", history.Out);
        Assert.Contains(jsText["id"]!.GetValue<string>(), history.Out);

        var chats = await Cli(G("chats"));
        Assert.Contains(chatId, chats.Out);
        Assert.Contains("and a text", chats.Out);

        var outDir = Path.Combine(_dir, "cli-downloads");
        var download = await Cli(G("download", jsSent["id"]!.GetValue<string>(), outDir));
        Assert.Equal(0, download.Code);
        Assert.Equal("plain text file from js", await File.ReadAllTextAsync(Path.Combine(outDir, "notes.txt")));

        // Once registered, the state file remembers the server and user.
        var listenTask = Cli("--state", state, "listen", "--count", "1");
        using (var observer = await TailchatClient.OpenAsync(new ClientOptions { StatePath = state }))
        {
            // Wait until the listener's socket is up (the user shows as online).
            for (int i = 0; i < 100; i++)
            {
                if ((await observer.Api.GetUsersAsync()).Any(u => u.Id == $"{name}@dev" && u.Online == true)) break;
                await Task.Delay(100);
            }
        }
        await bob.Run("send-text", chatId, "live!");
        var listen = await listenTask.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(0, listen.Code);
        Assert.Contains("live!", listen.Out);
        Assert.Contains(bob.UserId, listen.Out);

        var code = await Cli(G("security-code", bob.UserId));
        Assert.Equal((await bob.Run("security-code", $"{name}@dev"))["code"]!.GetValue<string>(), code.Out.Trim());

        Assert.Equal(2, (await Cli(G("send", "only-one-arg"))).Code);
        Assert.Equal(1, (await Cli(G("send", "nobody-like-this", "x"))).Code);
        Assert.Equal(1, (await Cli("--state", state, "--server", "http://127.0.0.1:1", "whoami")).Code);
    }

    public void Dispose()
    {
        foreach (var c in _clients) c.Dispose();
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
