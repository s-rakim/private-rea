using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tailchat.Client;

/// <summary>Thin typed wrapper over the REST API (PROTOCOL.md §7).</summary>
public sealed class TailchatApi : IDisposable
{
    private readonly HttpClient _http;

    public Uri BaseUri { get; }

    /// <summary>Sent as <c>X-Dev-User</c>; only a server running with TAILCHAT_AUTH=dev honours it.</summary>
    public string? DevUser { get; }

    /// <summary>The device bearer token, <c>&lt;deviceId&gt;.&lt;secret&gt;</c>.</summary>
    public string? Token { get; set; }

    public TailchatApi(string server, string? devUser = null, HttpMessageHandler? handler = null)
    {
        BaseUri = NormalizeServer(server);
        DevUser = devUser;
        _http = handler == null ? new HttpClient() : new HttpClient(handler);
        _http.Timeout = Timeout.InfiniteTimeSpan; // large uploads; callers pass cancellation tokens
    }

    public static Uri NormalizeServer(string server)
    {
        if (!Uri.TryCreate(server.TrimEnd('/') + "/", UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
            throw new TailchatException($"Server must be an http:// or https:// URL, got \"{server}\"");
        return uri;
    }

    public static string Escape(string segment) => Uri.EscapeDataString(segment);

    private HttpRequestMessage NewRequest(HttpMethod method, string path)
    {
        var req = new HttpRequestMessage(method, new Uri(BaseUri, path.TrimStart('/')));
        if (DevUser != null) req.Headers.Add("X-Dev-User", DevUser);
        if (Token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        return req;
    }

    private static async Task<ApiException> ErrorAsync(HttpRequestMessage req, HttpResponseMessage res, CancellationToken ct)
    {
        string message = res.ReasonPhrase ?? "error";
        try
        {
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (JsonNode.Parse(text) is JsonObject o && o["error"] is JsonValue e && e.TryGetValue<string>(out var s)) message = s;
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException)
        {
        }
        return new ApiException((int)res.StatusCode, $"{req.Method} {req.RequestUri?.AbsolutePath} -> {(int)res.StatusCode} {message}");
    }

    public async Task<JsonObject> SendAsync(HttpMethod method, string path, object? body = null, CancellationToken ct = default)
    {
        using var req = NewRequest(method, path);
        if (body != null)
        {
            var json = body is JsonNode node ? TailchatJson.Stringify(node) : JsonSerializer.Serialize(body, TailchatJson.Api);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw await ErrorAsync(req, res, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonNode.Parse(text) as JsonObject ?? throw new TailchatException($"{method} {path}: expected a JSON object");
    }

    public Task<JsonObject> GetAsync(string path, CancellationToken ct = default) => SendAsync(HttpMethod.Get, path, null, ct);

    // ---------- devices and users ----------

    public async Task<(DeviceInfo Device, string Token)> RegisterDeviceAsync(string name, PublicJwk publicKey, CancellationToken ct = default)
    {
        var res = await SendAsync(HttpMethod.Post, "api/devices", new { name, publicKey }, ct).ConfigureAwait(false);
        return (TailchatJson.Deserialize<DeviceInfo>(res["device"]), res["token"]!.GetValue<string>());
    }

    public async Task<(UserInfo User, DeviceInfo? Device)> GetMeAsync(CancellationToken ct = default)
    {
        var res = await GetAsync("api/me", ct).ConfigureAwait(false);
        var device = res["device"] is JsonObject d ? TailchatJson.Deserialize<DeviceInfo>(d) : null;
        return (TailchatJson.Deserialize<UserInfo>(res["user"]), device);
    }

    public async Task<IReadOnlyList<DeviceInfo>> GetKeysAsync(IEnumerable<string> deviceIds, CancellationToken ct = default)
    {
        var ids = string.Join(',', deviceIds.Select(Escape));
        if (ids.Length == 0) return Array.Empty<DeviceInfo>();
        var res = await GetAsync($"api/keys?ids={ids}", ct).ConfigureAwait(false);
        return TailchatJson.Deserialize<List<DeviceInfo>>(res["devices"]);
    }

    public async Task<IReadOnlyList<UserInfo>> GetUsersAsync(CancellationToken ct = default) =>
        TailchatJson.Deserialize<List<UserInfo>>((await GetAsync("api/users", ct).ConfigureAwait(false))["users"]);

    public async Task<IReadOnlyList<DeviceInfo>> GetUserDevicesAsync(string userId, CancellationToken ct = default) =>
        TailchatJson.Deserialize<List<DeviceInfo>>((await GetAsync($"api/users/{Escape(userId)}/devices", ct).ConfigureAwait(false))["devices"]);

    // ---------- chats and messages ----------

    public async Task<IReadOnlyList<ChatInfo>> GetChatsAsync(CancellationToken ct = default) =>
        TailchatJson.Deserialize<List<ChatInfo>>((await GetAsync("api/chats", ct).ConfigureAwait(false))["chats"]);

    public async Task<ChatInfo> GetChatAsync(string chatId, CancellationToken ct = default) =>
        TailchatJson.Deserialize<ChatInfo>((await GetAsync($"api/chats/{Escape(chatId)}", ct).ConfigureAwait(false))["chat"]);

    public async Task<ChatInfo> CreateDirectChatAsync(string userId, CancellationToken ct = default) =>
        TailchatJson.Deserialize<ChatInfo>((await SendAsync(HttpMethod.Post, "api/chats/direct", new { userId }, ct).ConfigureAwait(false))["chat"]);

    /// <summary>Every logged-in device of every current member: the recipients of a new message.</summary>
    public async Task<IReadOnlyList<DeviceInfo>> GetChatDevicesAsync(string chatId, CancellationToken ct = default) =>
        TailchatJson.Deserialize<List<DeviceInfo>>((await GetAsync($"api/chats/{Escape(chatId)}/devices", ct).ConfigureAwait(false))["devices"]);

    /// <summary>History in ascending seq order. <paramref name="before"/>/<paramref name="after"/> are seq numbers.</summary>
    public async Task<(IReadOnlyList<MessageInfo> Messages, bool HasMore)> GetMessagesAsync(string chatId, long? before = null, long? after = null, int? limit = null, CancellationToken ct = default)
    {
        var query = new List<string>();
        if (before is { } b) query.Add($"before={b}");
        if (after is { } a) query.Add($"after={a}");
        if (limit is { } l) query.Add($"limit={l}");
        var path = $"api/chats/{Escape(chatId)}/messages" + (query.Count > 0 ? "?" + string.Join('&', query) : "");
        var res = await GetAsync(path, ct).ConfigureAwait(false);
        return (TailchatJson.Deserialize<List<MessageInfo>>(res["messages"]), res["hasMore"]?.GetValue<bool>() ?? false);
    }

    public async Task<MessageInfo> PostMessageAsync(string chatId, string id, string payload, IReadOnlyList<string>? files = null, bool viewOnce = false, CancellationToken ct = default)
    {
        var body = new JsonObject { ["id"] = id, ["payload"] = payload };
        if (files is { Count: > 0 }) body["files"] = new JsonArray(files.Select(f => (JsonNode)JsonValue.Create(f)!).ToArray());
        if (viewOnce) body["viewOnce"] = true;
        var res = await SendAsync(HttpMethod.Post, $"api/chats/{Escape(chatId)}/messages", body, ct).ConfigureAwait(false);
        return TailchatJson.Deserialize<MessageInfo>(res["message"]);
    }

    public Task PostReceiptsAsync(string chatId, long? delivered, long? read = null, CancellationToken ct = default)
    {
        var body = new JsonObject();
        if (delivered is { } d) body["delivered"] = d;
        if (read is { } r) body["read"] = r;
        return SendAsync(HttpMethod.Post, $"api/chats/{Escape(chatId)}/receipts", body, ct);
    }

    // ---------- files ----------

    /// <summary>Uploads an already encrypted blob. The content must know its length (the server requires Content-Length).</summary>
    public async Task<string> UploadFileAsync(HttpContent content, CancellationToken ct = default)
    {
        using var req = NewRequest(HttpMethod.Post, "api/files");
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        req.Content = content;
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw await ErrorAsync(req, res, ct).ConfigureAwait(false);
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        return json?["id"]?.GetValue<string>() ?? throw new TailchatException("Upload response has no id");
    }

    /// <summary>Opens the encrypted blob as a stream; dispose the response when done.</summary>
    public async Task<HttpResponseMessage> DownloadFileAsync(string fileId, CancellationToken ct = default)
    {
        using var req = NewRequest(HttpMethod.Get, $"api/files/{Escape(fileId)}");
        var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            using (res) throw await ErrorAsync(req, res, ct).ConfigureAwait(false);
        }
        return res;
    }

    public void Dispose() => _http.Dispose();
}
