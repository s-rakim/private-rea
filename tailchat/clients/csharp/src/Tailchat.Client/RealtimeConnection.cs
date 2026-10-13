using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tailchat.Client;

/// <summary>The realtime WebSocket (PROTOCOL.md §6): authenticate with the device token, then read events.</summary>
public sealed class RealtimeConnection : IAsyncDisposable
{
    private readonly ClientWebSocket _ws;
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private RealtimeConnection(ClientWebSocket ws) => _ws = ws;

    public static Uri WebSocketUri(Uri baseUri)
    {
        var b = new UriBuilder(new Uri(baseUri, "ws")) { Scheme = baseUri.Scheme == "https" ? "wss" : "ws" };
        return b.Uri;
    }

    /// <summary>Connects, sends <c>{"type":"auth","token"}</c> and waits for <c>{"type":"ready"}</c>.</summary>
    public static async Task<RealtimeConnection> ConnectAsync(Uri baseUri, string token, string? devUser, CancellationToken ct = default)
    {
        var ws = new ClientWebSocket();
        if (devUser != null) ws.Options.SetRequestHeader("X-Dev-User", devUser);
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        var conn = new RealtimeConnection(ws);
        try
        {
            await ws.ConnectAsync(WebSocketUri(baseUri), ct).ConfigureAwait(false);
            await conn.SendAsync(new JsonObject { ["type"] = "auth", ["token"] = token }, ct).ConfigureAwait(false);
            var first = await conn.ReceiveAsync(ct).ConfigureAwait(false);
            if (first == null)
                throw new TailchatException($"WebSocket closed during auth: {ws.CloseStatus} {ws.CloseStatusDescription}");
            if (first["type"]?.GetValue<string>() != "ready")
                throw new TailchatException($"Expected a ready frame, got {first.ToJsonString()}");
            return conn;
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task SendAsync(JsonObject frame, CancellationToken ct = default)
    {
        var bytes = Encoding.UTF8.GetBytes(TailchatJson.Stringify(frame));
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>The next event object, or null once the server closes the socket.</summary>
    public async Task<JsonObject?> ReceiveAsync(CancellationToken ct = default)
    {
        var buffer = new ArrayBufferWriter<byte>();
        while (true)
        {
            buffer.Clear();
            ValueWebSocketReceiveResult result;
            do
            {
                var memory = buffer.GetMemory(16 * 1024);
                try
                {
                    result = await _ws.ReceiveAsync(memory, ct).ConfigureAwait(false);
                }
                catch (WebSocketException)
                {
                    return null;
                }
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    if (_ws.State == WebSocketState.CloseReceived)
                    {
                        try
                        {
                            await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, ct).ConfigureAwait(false);
                        }
                        catch (WebSocketException)
                        {
                        }
                    }
                    return null;
                }
                buffer.Advance(result.Count);
                if (buffer.WrittenCount > 4 * 1024 * 1024) throw new TailchatException("WebSocket frame too large");
            } while (!result.EndOfMessage);
            if (result.MessageType != WebSocketMessageType.Text) continue;
            try
            {
                if (JsonNode.Parse(buffer.WrittenSpan) is JsonObject obj) return obj;
            }
            catch (JsonException)
            {
                // ignore malformed frames
            }
        }
    }

    public WebSocketCloseStatus? CloseStatus => _ws.CloseStatus;

    public string? CloseStatusDescription => _ws.CloseStatusDescription;

    public async ValueTask DisposeAsync()
    {
        if (_ws.State == WebSocketState.Open)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, cts.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException)
            {
            }
        }
        _ws.Dispose();
        _sendLock.Dispose();
    }
}
