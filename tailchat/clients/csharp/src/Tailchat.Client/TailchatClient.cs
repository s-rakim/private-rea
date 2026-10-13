using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tailchat.Client;

public sealed class ClientOptions
{
    /// <summary>Server URL; may be omitted once a state file exists.</summary>
    public string? Server { get; init; }

    /// <summary>X-Dev-User for a TAILCHAT_AUTH=dev server (local testing only).</summary>
    public string? DevUser { get; init; }

    public string? StatePath { get; init; }

    public string? DeviceName { get; init; }

    public HttpMessageHandler? Handler { get; init; }
}

/// <summary>A decrypted (or undecryptable) message.</summary>
public sealed record DecryptedMessage(MessageInfo Message, JsonObject? Content, string? Error)
{
    public string? Type => Content?["type"]?.GetValue<string>();

    public FileRef? File => Content?["file"] is JsonObject f ? f.Deserialize<FileRef>(TailchatJson.Api) : null;
}

/// <summary>A realtime event, with the message decrypted for <c>message</c>/<c>message-update</c>.</summary>
public sealed record RealtimeEvent(string Type, JsonObject Raw, DecryptedMessage? Message);

/// <summary>High-level client: one registered device talking to one server.</summary>
public sealed class TailchatClient : IDisposable
{
    public TailchatApi Api { get; }
    public KeyRing Ring { get; }
    public ClientState State { get; }
    public string StatePath { get; }
    private readonly DeviceKey _key;

    public string UserId => State.UserId;
    public string DeviceId => State.DeviceId;

    private TailchatClient(TailchatApi api, ClientState state, string statePath, DeviceKey key)
    {
        Api = api;
        State = state;
        StatePath = statePath;
        _key = key;
        Ring = new KeyRing(state.DeviceId, key, (ids, ct) => api.GetKeysAsync(ids, ct));
    }

    /// <summary>Loads the device from the state file, registering a new device (and key) the first time.</summary>
    public static async Task<TailchatClient> OpenAsync(ClientOptions options, CancellationToken ct = default)
    {
        var path = options.StatePath ?? ClientState.DefaultPath(options.DevUser);
        var state = ClientState.Load(path);
        if (state != null)
        {
            if (options.Server != null && TailchatApi.NormalizeServer(options.Server) != TailchatApi.NormalizeServer(state.Server))
                throw new TailchatException($"State file {path} belongs to {state.Server}; pass --state to use another file for {options.Server}");
            if (options.DevUser != null && options.DevUser != state.DevUser)
                throw new TailchatException($"State file {path} belongs to dev user {state.DevUser ?? "(none)"}; pass --state to use another file");
            var api = new TailchatApi(state.Server, state.DevUser, options.Handler) { Token = state.Token };
            return new TailchatClient(api, state, path, DeviceKey.FromPrivateJwk(state.PrivateKey));
        }

        var server = options.Server ?? throw new TailchatException("No device registered yet: pass --server URL");
        var newApi = new TailchatApi(server, options.DevUser, options.Handler);
        var key = DeviceKey.Generate();
        try
        {
            var name = options.DeviceName ?? $"C# CLI on {Environment.MachineName}";
            var (device, token) = await newApi.RegisterDeviceAsync(name, key.PublicJwk, ct).ConfigureAwait(false);
            if (device.PublicKey.X != key.PublicJwk.X || device.PublicKey.Y != key.PublicJwk.Y)
                throw new TailchatException("The server registered a different public key");
            newApi.Token = token;
            state = new ClientState
            {
                Server = newApi.BaseUri.ToString().TrimEnd('/'),
                DevUser = options.DevUser,
                UserId = device.UserId,
                DeviceId = device.Id,
                DeviceName = name,
                Token = token,
                PrivateKey = key.ExportPrivateJwk(),
            };
            state.Save(path);
            return new TailchatClient(newApi, state, path, key);
        }
        catch
        {
            key.Dispose();
            newApi.Dispose();
            throw;
        }
    }

    public static string NewMessageId() => Base64Url.Encode(RandomNumberGenerator.GetBytes(16));

    // ---------- chats ----------

    /// <summary>
    /// Finds a chat by id, an existing group by name, or a user (id or unique display name) whose direct chat
    /// is created if needed.
    /// </summary>
    public async Task<ChatInfo> ResolveChatAsync(string chatOrUser, CancellationToken ct = default)
    {
        var chats = await Api.GetChatsAsync(ct).ConfigureAwait(false);
        var byId = chats.FirstOrDefault(c => c.Id == chatOrUser);
        if (byId != null) return byId;
        var users = await Api.GetUsersAsync(ct).ConfigureAwait(false);
        var user = users.FirstOrDefault(u => u.Id == chatOrUser);
        if (user == null)
        {
            var groups = chats.Where(c => c.Type == "group" && string.Equals(c.Name, chatOrUser, StringComparison.OrdinalIgnoreCase)).ToList();
            if (groups.Count == 1) return groups[0];
            if (groups.Count > 1) throw new TailchatException($"Several groups are called \"{chatOrUser}\"; use the chat id");
            var named = users.Where(u => string.Equals(u.Name, chatOrUser, StringComparison.OrdinalIgnoreCase)).ToList();
            if (named.Count > 1) throw new TailchatException($"Several people are called \"{chatOrUser}\"; use their user id");
            user = named.FirstOrDefault() ?? throw new TailchatException($"No chat or user \"{chatOrUser}\"");
        }
        return await Api.CreateDirectChatAsync(user.Id, ct).ConfigureAwait(false);
    }

    /// <summary>A display name for a chat: the group name, or the other person in a direct chat.</summary>
    public string ChatTitle(ChatInfo chat)
    {
        if (chat.Type == "group") return chat.Name ?? chat.Id;
        var other = chat.Members.FirstOrDefault(m => m.UserId != UserId);
        return other?.UserId ?? UserId;
    }

    // ---------- sending ----------

    public async Task<MessageInfo> SendContentAsync(string chatId, JsonObject content, IReadOnlyList<string>? files = null, bool viewOnce = false, CancellationToken ct = default)
    {
        var id = NewMessageId();
        var devices = await Api.GetChatDevicesAsync(chatId, ct).ConfigureAwait(false);
        var payload = await Ring.SealAsync(content, Aad.Chat(chatId, id), devices, ct).ConfigureAwait(false);
        return await Api.PostMessageAsync(chatId, id, payload, files, viewOnce, ct).ConfigureAwait(false);
    }

    public Task<MessageInfo> SendTextAsync(string chatId, string text, CancellationToken ct = default) =>
        SendContentAsync(chatId, new JsonObject { ["type"] = "text", ["text"] = text }, null, false, ct);

    /// <summary>Encrypts and uploads a file (streaming, no temporary copy) and returns its <c>file</c> object.</summary>
    public async Task<FileRef> UploadFileAsync(Stream input, long size, string? name, string? mime, CancellationToken ct = default)
    {
        var content = new EncryptingContent(input, size);
        var id = await Api.UploadFileAsync(content, ct).ConfigureAwait(false);
        var info = content.Result ?? throw new TailchatException("Upload finished without encrypting the file");
        return info.ToFileRef(id, name, mime);
    }

    public async Task<MessageInfo> SendFileAsync(string chatId, string path, string? kind = null, string? caption = null, string? mime = null, CancellationToken ct = default)
    {
        var name = Path.GetFileName(path);
        mime ??= MimeTypes.FromFileName(name);
        kind ??= MimeTypes.KindFor(mime);
        FileRef file;
        await using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, useAsync: true))
        {
            file = await UploadFileAsync(fs, fs.Length, name, mime, ct).ConfigureAwait(false);
        }
        var content = new JsonObject
        {
            ["type"] = "media",
            ["kind"] = kind,
            ["file"] = JsonSerializer.SerializeToNode(file, TailchatJson.Api),
        };
        if (!string.IsNullOrEmpty(caption)) content["caption"] = caption;
        return await SendContentAsync(chatId, content, new[] { file.Id! }, false, ct).ConfigureAwait(false);
    }

    // ---------- reading ----------

    /// <summary>
    /// Decrypts a message. Errors (no key for this device, tampering) are returned in <see cref="DecryptedMessage.Error"/>
    /// rather than thrown, so one bad message doesn't hide the rest of a history.
    /// </summary>
    public async Task<DecryptedMessage> DecryptAsync(MessageInfo m, CancellationToken ct = default)
    {
        if (m.Payload == null) return new DecryptedMessage(m, null, m.DeletedAt != null ? "deleted" : "unavailable");
        if (m.Kind != "msg")
        {
            // System events (member added, etc.) are plain JSON written by the server.
            try
            {
                return new DecryptedMessage(m, JsonNode.Parse(m.Payload) as JsonObject, null);
            }
            catch (JsonException)
            {
                return new DecryptedMessage(m, null, "malformed system message");
            }
        }
        try
        {
            var opened = await Ring.OpenEnvelopeAsync(m.Payload, Aad.Chat(m.ChatId, m.Id), ct).ConfigureAwait(false);
            // The envelope must come from a device of the user the server says sent it.
            var device = await Ring.GetDeviceAsync(opened.FromDevice, ct).ConfigureAwait(false);
            if (device.UserId != m.SenderId)
                return new DecryptedMessage(m, null, $"sender mismatch: envelope from a device of {device.UserId}");
            return new DecryptedMessage(m, opened.Content, null);
        }
        catch (NoKeyException)
        {
            return new DecryptedMessage(m, null, "not encrypted for this device");
        }
        catch (Exception e) when (e is CryptographicException or TailchatException or FormatException)
        {
            return new DecryptedMessage(m, null, $"cannot decrypt: {e.Message}");
        }
    }

    public async Task<IReadOnlyList<DecryptedMessage>> HistoryAsync(string chatId, int limit = 50, CancellationToken ct = default)
    {
        var (messages, _) = await Api.GetMessagesAsync(chatId, limit: limit, ct: ct).ConfigureAwait(false);
        var result = new List<DecryptedMessage>();
        foreach (var m in messages) result.Add(await DecryptAsync(m, ct).ConfigureAwait(false));
        return result;
    }

    /// <summary>Finds a message by id, in one chat or by paging back through every chat.</summary>
    public async Task<MessageInfo> FindMessageAsync(string messageId, string? chatId = null, CancellationToken ct = default)
    {
        var chatIds = chatId != null
            ? new[] { chatId }
            : (await Api.GetChatsAsync(ct).ConfigureAwait(false)).OrderByDescending(c => c.LastMessage?.CreatedAt ?? 0).Select(c => c.Id).ToArray();
        foreach (var id in chatIds)
        {
            long? before = null;
            while (true)
            {
                var (messages, hasMore) = await Api.GetMessagesAsync(id, before, null, 200, ct).ConfigureAwait(false);
                var hit = messages.FirstOrDefault(m => m.Id == messageId);
                if (hit != null) return hit;
                if (!hasMore || messages.Count == 0) break;
                before = messages[0].Seq;
            }
        }
        throw new TailchatException($"No message {messageId}");
    }

    /// <summary>Downloads, decrypts and verifies a file into <paramref name="output"/>.</summary>
    public async Task DownloadAsync(FileRef file, Stream output, CancellationToken ct = default)
    {
        if (file.Id == null) throw new TailchatException("The file has no id");
        using var res = await Api.DownloadFileAsync(file.Id, ct).ConfigureAwait(false);
        await using var body = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await FileCrypto.DecryptAsync(body, file, output, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Downloads a media message's file into <paramref name="outDir"/> under its (sanitised) name, never
    /// overwriting. The plaintext only appears under its final name once it has been verified.
    /// </summary>
    public async Task<string> DownloadMessageFileAsync(string messageId, string outDir, string? chatId = null, CancellationToken ct = default)
    {
        var message = await FindMessageAsync(messageId, chatId, ct).ConfigureAwait(false);
        var decrypted = await DecryptAsync(message, ct).ConfigureAwait(false);
        if (decrypted.Error != null) throw new TailchatException($"Message {messageId}: {decrypted.Error}");
        var file = decrypted.File ?? throw new TailchatException($"Message {messageId} has no file");
        Directory.CreateDirectory(outDir);
        var target = UniquePath(outDir, SafeFileName(file.Name, file.Id ?? messageId));
        var tmp = Path.Combine(outDir, $".{Path.GetFileName(target)}.{Guid.NewGuid():N}.part");
        try
        {
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Options = FileOptions.Asynchronous };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using (var fs = new FileStream(tmp, options))
            {
                await DownloadAsync(file, fs, ct).ConfigureAwait(false);
            }
            File.Move(tmp, target, overwrite: false);
            return target;
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    public static string SafeFileName(string? name, string fallback)
    {
        var baseName = Path.GetFileName((name ?? "").Replace('\\', '/'));
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(baseName.Select(c => invalid.Contains(c) || char.IsControl(c) ? '_' : c).ToArray()).Trim();
        if (cleaned.Length == 0 || cleaned == "." || cleaned == ".." || cleaned.All(c => c == '.')) cleaned = fallback;
        if (cleaned.StartsWith('.')) cleaned = "_" + cleaned;
        return cleaned.Length > 200 ? cleaned[..200] : cleaned;
    }

    private static string UniquePath(string dir, string fileName)
    {
        var path = Path.Combine(dir, fileName);
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var ext = Path.GetExtension(fileName);
        for (int i = 1; File.Exists(path) || Directory.Exists(path); i++) path = Path.Combine(dir, $"{stem} ({i}){ext}");
        return path;
    }

    // ---------- realtime ----------

    /// <summary>
    /// Connects to the WebSocket and calls <paramref name="handler"/> for every event, decrypting messages and
    /// posting a delivered receipt for messages from other people. Reconnects with backoff until cancelled.
    /// </summary>
    public async Task ListenAsync(Func<RealtimeEvent, Task> handler, Func<string, Task>? onStatus = null, CancellationToken ct = default)
    {
        var delay = TimeSpan.FromSeconds(1);
        while (!ct.IsCancellationRequested)
        {
            RealtimeConnection? conn = null;
            try
            {
                conn = await RealtimeConnection.ConnectAsync(Api.BaseUri, State.Token, State.DevUser, ct).ConfigureAwait(false);
                delay = TimeSpan.FromSeconds(1);
                if (onStatus != null) await onStatus("connected").ConfigureAwait(false);
                while (true)
                {
                    var evt = await conn.ReceiveAsync(ct).ConfigureAwait(false);
                    if (evt == null) break;
                    var type = evt["type"]?.GetValue<string>() ?? "";
                    DecryptedMessage? decrypted = null;
                    if ((type is "message" or "message-update") && evt["message"] is JsonObject mo)
                    {
                        var message = mo.Deserialize<MessageInfo>(TailchatJson.Api)!;
                        decrypted = await DecryptAsync(message, ct).ConfigureAwait(false);
                        if (type == "message" && message.SenderId != UserId && message.Kind == "msg")
                        {
                            try
                            {
                                await Api.PostReceiptsAsync(message.ChatId, message.Seq, null, ct).ConfigureAwait(false);
                            }
                            catch (ApiException e)
                            {
                                if (onStatus != null) await onStatus($"receipt failed: {e.Message}").ConfigureAwait(false);
                            }
                        }
                    }
                    await handler(new RealtimeEvent(type, evt, decrypted)).ConfigureAwait(false);
                }
                if (conn.CloseStatus is { } status && (int)status == 4003)
                    throw new TailchatException($"The server refused this device: {conn.CloseStatusDescription}");
                if (onStatus != null) await onStatus("disconnected").ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e) when (e is System.Net.WebSockets.WebSocketException or HttpRequestException or IOException)
            {
                if (onStatus != null) await onStatus($"connection failed: {e.Message}").ConfigureAwait(false);
            }
            finally
            {
                if (conn != null) await conn.DisposeAsync().ConfigureAwait(false);
            }
            try
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, TimeSpan.FromSeconds(30).Ticks));
        }
    }

    public void Dispose()
    {
        Ring.Dispose();
        _key.Dispose();
        Api.Dispose();
    }
}

/// <summary>Streams a file through <see cref="FileCrypto.EncryptAsync"/> as an upload body with a known length.</summary>
internal sealed class EncryptingContent : HttpContent
{
    private readonly Stream _input;
    private readonly long _size;
    private bool _used;

    public EncryptedFile? Result { get; private set; }

    public EncryptingContent(Stream input, long size)
    {
        _input = input;
        _size = size;
    }

    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
        SerializeToStreamAsync(stream, context, CancellationToken.None);

    protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken ct)
    {
        // A fresh key every time: never encrypt different data under the same key and IV prefix.
        if (_used) throw new InvalidOperationException("The upload body can only be sent once");
        _used = true;
        Result = await FileCrypto.EncryptAsync(_input, _size, stream, ct: ct).ConfigureAwait(false);
    }

    protected override bool TryComputeLength(out long length)
    {
        length = FileCrypto.EncryptedLength(_size);
        return true;
    }
}
