using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Tailchat.Client;

/// <summary>A P-256 public key as a JWK (PROTOCOL.md §2): base64url x and y, 32 bytes each.</summary>
public sealed record PublicJwk(
    [property: JsonPropertyName("kty")] string Kty,
    [property: JsonPropertyName("crv")] string Crv,
    [property: JsonPropertyName("x")] string X,
    [property: JsonPropertyName("y")] string Y);

public sealed record DeviceInfo(
    string Id,
    string UserId,
    string? Name,
    PublicJwk PublicKey,
    long? CreatedAt = null,
    long? LastActive = null,
    long? RevokedAt = null);

public sealed record UserInfo(string Id, string? Name, string? About, bool? Online, long? LastSeen);

public sealed record ChatMember(string UserId, string? Role, bool Left, long DeliveredSeq, long ReadSeq);

public sealed record ChatInfo(
    string Id,
    string Type,
    string? Name,
    string? Description,
    long LastSeq,
    IReadOnlyList<ChatMember> Members,
    int Unread,
    MessageInfo? LastMessage);

public sealed record MessageInfo(
    string Id,
    string ChatId,
    long Seq,
    string SenderId,
    string? SenderDevice,
    string Kind,
    string? Payload,
    IReadOnlyList<string>? Files,
    bool ViewOnce,
    long CreatedAt,
    long? EditedAt,
    long? DeletedAt,
    long? ExpiresAt);

/// <summary>The <c>file</c> object of a <c>media</c> content (PROTOCOL.md §5).</summary>
public sealed record FileRef
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("key")] public required string Key { get; init; }
    [JsonPropertyName("prefix")] public required string Prefix { get; init; }
    [JsonPropertyName("size")] public required long Size { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("mime")] public string? Mime { get; init; }
    [JsonPropertyName("sha256")] public string? Sha256 { get; init; }
}

public static class TailchatJson
{
    /// <summary>Options for API bodies: camelCase, nulls omitted.</summary>
    public static readonly JsonSerializerOptions Api = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Compact output like JavaScript's JSON.stringify: non-ASCII stays as UTF-8 instead of \u escapes.
    /// Only used for data that is encrypted or sent as a JSON body, never embedded in HTML.
    /// </summary>
    public static readonly JsonSerializerOptions Compact = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    public static string Stringify(JsonNode node) => node.ToJsonString(Compact);

    public static T Deserialize<T>(JsonNode? node) =>
        node.Deserialize<T>(Api) ?? throw new TailchatException($"Expected a {typeof(T).Name} in the server response");
}

public class TailchatException : Exception
{
    public TailchatException(string message, Exception? inner = null) : base(message, inner) { }
}

public sealed class ApiException : TailchatException
{
    public int Status { get; }

    public ApiException(int status, string message) : base(message) => Status = status;
}

/// <summary>Raised when a message has no wrapped key for this device (sent before it was linked).</summary>
public sealed class NoKeyException : TailchatException
{
    public NoKeyException() : base("Not encrypted for this device") { }
}
