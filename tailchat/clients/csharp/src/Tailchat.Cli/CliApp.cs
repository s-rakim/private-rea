using System.Globalization;
using System.Text.Json.Nodes;
using Tailchat.Client;

namespace Tailchat.Cli;

/// <summary>The command-line interface; <see cref="RunAsync"/> is also called in-process by the tests.</summary>
public static class CliApp
{
    public const string Usage = """
        Usage: tailchat [global options] <command> [args]

        Commands:
          whoami                         show this user and device (registers the device on first use)
          users                          list people on the tailnet
          chats                          list chats with unread counts
          send CHAT_OR_USER TEXT         send an encrypted text message
          send-file CHAT_OR_USER PATH    encrypt, upload and send a file
                [--kind image|video|audio|voice|document|sticker|gif] [--caption TEXT] [--mime TYPE]
          history CHAT [--limit N]       show and decrypt recent messages (default 50)
          download MESSAGE_ID OUTDIR [--chat CHAT]
                                         download, decrypt and verify a message's file
          listen [--count N]             print incoming messages live and send delivered receipts
          security-code USER             the code to compare with USER in person

        CHAT_OR_USER is a chat id, a group name, or a user id / display name (a direct chat is
        created if needed).

        Global options:
          --server URL          the Tailchat server (needed the first time, e.g. https://box.tailnet.ts.net)
          --dev-user NAME       send X-Dev-User: NAME (only for a server running with TAILCHAT_AUTH=dev)
          --state PATH          state file with this device's private key and token
                                (default: $TAILCHAT_STATE or ~/.config/tailchat-csharp/state.json)
          --device-name NAME    name to register this device under
        """;

    private static readonly HashSet<string> ValueOptions = new()
    {
        "--server", "--dev-user", "--state", "--device-name", "--limit", "--chat", "--kind", "--caption", "--mime", "--count",
    };

    private static readonly string[] Kinds = { "image", "video", "audio", "voice", "document", "sticker", "gif" };

    public static async Task<int> RunAsync(string[] args, TextWriter stdout, TextWriter stderr, CancellationToken ct = default)
    {
        var options = new Dictionary<string, string>();
        var positional = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a is "-h" or "--help" or "help")
            {
                await stdout.WriteLineAsync(Usage);
                return 0;
            }
            if (a == "--")
            {
                positional.AddRange(args[(i + 1)..]);
                break;
            }
            if (a.StartsWith("--", StringComparison.Ordinal) && a.Length > 2)
            {
                var eq = a.IndexOf('=');
                var name = eq > 0 ? a[..eq] : a;
                if (!ValueOptions.Contains(name)) return await UsageError(stderr, $"Unknown option {name}");
                if (eq > 0) options[name] = a[(eq + 1)..];
                else if (i + 1 < args.Length) options[name] = args[++i];
                else return await UsageError(stderr, $"{name} needs a value");
                continue;
            }
            positional.Add(a);
        }
        if (positional.Count == 0) return await UsageError(stderr, "No command given");
        var command = positional[0];
        var rest = positional.Skip(1).ToList();

        int Expect(int n) => rest.Count == n ? 0 : -1;
        var arity = command switch
        {
            "whoami" or "users" or "chats" or "listen" => Expect(0),
            "history" or "security-code" => Expect(1),
            "send" or "send-file" or "download" => Expect(2),
            _ => -2,
        };
        if (arity == -2) return await UsageError(stderr, $"Unknown command {command}");
        if (arity == -1) return await UsageError(stderr, $"Wrong number of arguments for {command}");

        try
        {
            using var client = await TailchatClient.OpenAsync(new ClientOptions
            {
                Server = options.GetValueOrDefault("--server") ?? NullIfEmpty(Environment.GetEnvironmentVariable("TAILCHAT_SERVER")),
                DevUser = options.GetValueOrDefault("--dev-user"),
                StatePath = options.GetValueOrDefault("--state"),
                DeviceName = options.GetValueOrDefault("--device-name"),
            }, ct);
            switch (command)
            {
                case "whoami":
                    await WhoAmI(client, stdout, ct);
                    break;
                case "users":
                    foreach (var u in await client.Api.GetUsersAsync(ct))
                    {
                        var presence = u.Online == true ? "online" : u.LastSeen is { } ls ? "last seen " + Time(ls) : "";
                        await stdout.WriteLineAsync($"{u.Id}\t{u.Name}\t{presence}".TrimEnd());
                    }
                    break;
                case "chats":
                    foreach (var c in await client.Api.GetChatsAsync(ct))
                    {
                        var last = c.LastMessage == null ? "" : Describe(await client.DecryptAsync(c.LastMessage, ct));
                        await stdout.WriteLineAsync($"{c.Id}\t{c.Type}\t{client.ChatTitle(c)}\tunread={c.Unread}\t{last}".TrimEnd());
                    }
                    break;
                case "send":
                {
                    var chat = await client.ResolveChatAsync(rest[0], ct);
                    var m = await client.SendTextAsync(chat.Id, rest[1], ct);
                    await stdout.WriteLineAsync($"sent {m.Id} to {chat.Id} (seq {m.Seq})");
                    break;
                }
                case "send-file":
                {
                    var kind = options.GetValueOrDefault("--kind");
                    if (kind != null && !Kinds.Contains(kind)) return await UsageError(stderr, $"--kind must be one of {string.Join(", ", Kinds)}");
                    if (!File.Exists(rest[1])) throw new TailchatException($"No such file: {rest[1]}");
                    var chat = await client.ResolveChatAsync(rest[0], ct);
                    var m = await client.SendFileAsync(chat.Id, rest[1], kind, options.GetValueOrDefault("--caption"), options.GetValueOrDefault("--mime"), ct);
                    await stdout.WriteLineAsync($"sent {m.Id} to {chat.Id} (seq {m.Seq}, file {m.Files?.FirstOrDefault()})");
                    break;
                }
                case "history":
                {
                    var limit = ParseInt(options, "--limit", 50, 1, 200);
                    var chat = await client.ResolveChatAsync(rest[0], ct);
                    foreach (var d in await client.HistoryAsync(chat.Id, limit, ct)) await stdout.WriteLineAsync(FormatLine(d, null));
                    break;
                }
                case "download":
                {
                    string? chatId = null;
                    if (options.TryGetValue("--chat", out var chatArg)) chatId = (await client.ResolveChatAsync(chatArg, ct)).Id;
                    var path = await client.DownloadMessageFileAsync(rest[0], rest[1], chatId, ct);
                    await stdout.WriteLineAsync($"saved {path} ({new FileInfo(path).Length} bytes, checksum verified)");
                    break;
                }
                case "listen":
                    return await Listen(client, ParseInt(options, "--count", 0, 0, int.MaxValue), stdout, stderr, ct);
                case "security-code":
                {
                    var users = await client.Api.GetUsersAsync(ct);
                    var other = users.FirstOrDefault(u => u.Id == rest[0])
                        ?? users.SingleOrDefault(u => string.Equals(u.Name, rest[0], StringComparison.OrdinalIgnoreCase))
                        ?? throw new TailchatException($"No user {rest[0]}");
                    var devices = new List<DeviceInfo>(await client.Api.GetUserDevicesAsync(client.UserId, ct));
                    if (other.Id != client.UserId) devices.AddRange(await client.Api.GetUserDevicesAsync(other.Id, ct));
                    await stdout.WriteLineAsync(SecurityCode.Compute(devices));
                    break;
                }
            }
            return 0;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return 130;
        }
        catch (ApiException e) when (e.Status == 401)
        {
            var state = options.GetValueOrDefault("--state") ?? ClientState.DefaultPath(options.GetValueOrDefault("--dev-user"));
            await stderr.WriteLineAsync($"tailchat: {e.Message}\n(this device's token was rejected; delete {state} to register a new device)");
            return 1;
        }
        catch (TailchatException e)
        {
            await stderr.WriteLineAsync($"tailchat: {e.Message}");
            return 1;
        }
        catch (HttpRequestException e)
        {
            await stderr.WriteLineAsync($"tailchat: cannot reach the server: {e.Message}");
            return 1;
        }
        catch (IOException e)
        {
            await stderr.WriteLineAsync($"tailchat: {e.Message}");
            return 1;
        }
        catch (UsageException e)
        {
            return await UsageError(stderr, e.Message);
        }
    }

    private static async Task WhoAmI(TailchatClient client, TextWriter stdout, CancellationToken ct)
    {
        var (user, device) = await client.Api.GetMeAsync(ct);
        await stdout.WriteLineAsync($"user:   {user.Id} ({user.Name})");
        await stdout.WriteLineAsync($"device: {client.DeviceId} ({device?.Name ?? client.State.DeviceName})");
        await stdout.WriteLineAsync($"server: {client.Api.BaseUri.ToString().TrimEnd('/')}");
        await stdout.WriteLineAsync($"state:  {client.StatePath}");
    }

    private static async Task<int> Listen(TailchatClient client, int count, TextWriter stdout, TextWriter stderr, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        int seen = 0;
        var titles = new Dictionary<string, string>();
        try
        {
            await client.ListenAsync(async evt =>
            {
                if (evt.Type != "message" || evt.Message == null) return;
                var chatId = evt.Message.Message.ChatId;
                if (!titles.TryGetValue(chatId, out var title))
                {
                    try
                    {
                        title = client.ChatTitle(await client.Api.GetChatAsync(chatId, cts.Token));
                    }
                    catch (ApiException)
                    {
                        title = chatId;
                    }
                    titles[chatId] = title;
                }
                await stdout.WriteLineAsync(FormatLine(evt.Message, $"{title} ({chatId})"));
                await stdout.FlushAsync();
                if (count > 0 && ++seen >= count) cts.Cancel();
            }, async status =>
            {
                await stderr.WriteLineAsync($"tailchat: {status}");
                await stderr.FlushAsync();
            }, cts.Token);
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
        }
        return ct.IsCancellationRequested ? 130 : 0;
    }

    public static string FormatLine(DecryptedMessage d, string? chat)
    {
        var m = d.Message;
        var where = chat == null ? "" : $"[{chat}] ";
        var edited = m.EditedAt != null ? " (edited)" : "";
        return $"{Time(m.CreatedAt)} {where}{m.SenderId}: {Describe(d)}{edited}  [{m.Id}]";
    }

    public static string Describe(DecryptedMessage d)
    {
        if (d.Message.Kind == "system") return "* " + (d.Content?.ToJsonString() ?? d.Message.Payload);
        if (d.Error != null) return $"<{d.Error}>";
        var c = d.Content!;
        string S(string key) => c[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : c[key]?.ToJsonString() ?? "";
        var prefix = (c["forwarded"] is JsonValue f && f.TryGetValue<bool>(out var fw) && fw ? "(forwarded) " : "")
            + (c["replyTo"] is JsonObject ? "(reply) " : "");
        var body = d.Type switch
        {
            "text" => S("text"),
            "media" => DescribeMedia(c, d.File),
            "location" => $"[location] {S("lat")},{S("lon")} {S("name")}".TrimEnd(),
            "contact" => $"[contact] {S("name")} <{S("userId")}>",
            "poll" => $"[poll] {S("question")}: " + string.Join(" / ", (c["options"] as JsonArray ?? new JsonArray()).Select(o => o?.ToString())),
            "call" => $"[{(c["video"]?.GetValueKind() == System.Text.Json.JsonValueKind.True ? "video " : "")}call] {S("duration")}s",
            var t => $"[{t ?? "unknown"}] {c.ToJsonString()}",
        };
        return prefix + body;
    }

    private static string DescribeMedia(JsonObject c, FileRef? file)
    {
        var kind = c["kind"]?.ToString() ?? "file";
        var caption = c["caption"]?.ToString();
        var what = file == null ? "(no file)" : $"{file.Name ?? file.Id} ({file.Size} bytes, {file.Mime ?? "?"})";
        return $"[{kind}] {what}" + (string.IsNullOrEmpty(caption) ? "" : $" \"{caption}\"");
    }

    private static string Time(long ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);

    private static int ParseInt(Dictionary<string, string> options, string name, int fallback, int min, int max)
    {
        if (!options.TryGetValue(name, out var raw)) return fallback;
        if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < min || n > max)
            throw new UsageException($"{name} must be a number between {min} and {max}");
        return n;
    }

    private static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    private static async Task<int> UsageError(TextWriter stderr, string message)
    {
        await stderr.WriteLineAsync($"tailchat: {message}\n");
        await stderr.WriteLineAsync(Usage);
        return 2;
    }

    private sealed class UsageException : Exception
    {
        public UsageException(string message) : base(message) { }
    }
}
