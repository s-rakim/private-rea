using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tailchat.Client;

/// <summary>The result of opening an envelope.</summary>
public sealed record OpenedEnvelope(JsonObject Content, string FromDevice);

/// <summary>
/// Seals and opens message envelopes (PROTOCOL.md §2-3) for one device. Wrap keys are cached because
/// each costs an ECDH operation. Mirrors <c>KeyRing</c> in public/crypto.js.
/// </summary>
public sealed class KeyRing : IDisposable
{
    public const int EnvelopeVersion = 1;
    private static readonly byte[] WrapSalt = Encoding.UTF8.GetBytes("tailchat/v1/wrap");

    private readonly DeviceKey _key;
    private readonly Func<IReadOnlyList<string>, CancellationToken, Task<IReadOnlyList<DeviceInfo>>> _fetchDevices;
    private readonly object _lock = new();
    private readonly Dictionary<string, DeviceInfo> _devices = new();
    private readonly Dictionary<string, ECDiffieHellman> _publicKeys = new();
    private readonly Dictionary<string, byte[]> _wrapKeys = new();

    public string DeviceId { get; }

    /// <param name="deviceId">This device's id.</param>
    /// <param name="key">This device's key pair (not disposed by the ring).</param>
    /// <param name="fetchDevices">Looks up devices by id, e.g. <c>GET /api/keys?ids=</c>.</param>
    public KeyRing(string deviceId, DeviceKey key, Func<IReadOnlyList<string>, CancellationToken, Task<IReadOnlyList<DeviceInfo>>> fetchDevices)
    {
        DeviceId = deviceId;
        _key = key;
        _fetchDevices = fetchDevices;
    }

    /// <summary>HKDF-SHA256(ikm = Z, salt = "tailchat/v1/wrap", info = sender + "|" + recipient, 32 bytes).</summary>
    public static byte[] DeriveWrapKey(byte[] sharedSecret, string senderId, string recipientId) =>
        HKDF.DeriveKey(HashAlgorithmName.SHA256, sharedSecret, 32, WrapSalt, Encoding.UTF8.GetBytes($"{senderId}|{recipientId}"));

    /// <summary>Remembers a device's public key. A device id is bound to one key forever.</summary>
    public void AddDevice(DeviceInfo device)
    {
        lock (_lock)
        {
            if (_devices.TryGetValue(device.Id, out var known))
            {
                if (known.PublicKey.X != device.PublicKey.X || known.PublicKey.Y != device.PublicKey.Y)
                    throw new TailchatException($"The server changed the public key of device {device.Id}");
                _devices[device.Id] = device; // newer metadata (e.g. revokedAt)
                return;
            }
            var ecdh = DeviceKey.ImportPublic(device.PublicKey);
            _publicKeys[device.Id] = ecdh;
            _devices[device.Id] = device;
        }
    }

    public async Task<DeviceInfo> GetDeviceAsync(string deviceId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            if (_devices.TryGetValue(deviceId, out var d)) return d;
        }
        foreach (var d in await _fetchDevices(new[] { deviceId }, ct).ConfigureAwait(false))
        {
            if (d.Id == deviceId) AddDevice(d);
        }
        lock (_lock)
        {
            return _devices.TryGetValue(deviceId, out var d) ? d : throw new TailchatException($"Unknown device {deviceId}");
        }
    }

    /// <summary>The wrap key between sender and recipient; one of them must be this device.</summary>
    public async Task<byte[]> WrapKeyAsync(string senderId, string recipientId, CancellationToken ct = default)
    {
        var cacheKey = $"{senderId}|{recipientId}";
        lock (_lock)
        {
            if (_wrapKeys.TryGetValue(cacheKey, out var cached)) return cached;
        }
        string peer = senderId == DeviceId ? recipientId
            : recipientId == DeviceId ? senderId
            : throw new ArgumentException("Neither side of the wrap key is this device");
        await GetDeviceAsync(peer, ct).ConfigureAwait(false);
        byte[] wrapKey;
        lock (_lock)
        {
            var z = _key.SharedSecret(_publicKeys[peer]);
            try
            {
                wrapKey = DeriveWrapKey(z, senderId, recipientId);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(z);
            }
            _wrapKeys[cacheKey] = wrapKey;
        }
        return wrapKey;
    }

    /// <summary>
    /// Encrypts <paramref name="content"/> for every device in <paramref name="recipients"/> (and this device)
    /// and returns the envelope JSON string to send as the message <c>payload</c>.
    /// </summary>
    public async Task<string> SealAsync(JsonObject content, string aad, IEnumerable<DeviceInfo> recipients, CancellationToken ct = default)
    {
        var plaintext = Encoding.UTF8.GetBytes(TailchatJson.Stringify(content));
        var ids = new List<string>();
        foreach (var d in recipients)
        {
            AddDevice(d);
            if (!ids.Contains(d.Id)) ids.Add(d.Id);
        }
        if (!ids.Contains(DeviceId)) ids.Add(DeviceId);

        var contentKey = RandomNumberGenerator.GetBytes(32);
        try
        {
            var iv = RandomNumberGenerator.GetBytes(12);
            var ct2 = new byte[plaintext.Length + 16];
            using (var gcm = new AesGcm(contentKey, 16))
            {
                gcm.Encrypt(iv, plaintext, ct2.AsSpan(0, plaintext.Length), ct2.AsSpan(plaintext.Length), Encoding.UTF8.GetBytes(aad));
            }
            var keys = new JsonObject();
            foreach (var id in ids)
            {
                var wrapKey = await WrapKeyAsync(DeviceId, id, ct).ConfigureAwait(false);
                keys[id] = Base64Url.Encode(AesKeyWrap.Wrap(wrapKey, contentKey));
            }
            var envelope = new JsonObject
            {
                ["v"] = EnvelopeVersion,
                ["from"] = DeviceId,
                ["iv"] = Base64Url.Encode(iv),
                ["ct"] = Base64Url.Encode(ct2),
                ["keys"] = keys,
            };
            return TailchatJson.Stringify(envelope);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(contentKey);
        }
    }

    /// <summary>Opens an envelope and returns the decrypted content object.</summary>
    /// <exception cref="NoKeyException">No wrapped key for this device.</exception>
    /// <exception cref="CryptographicException">Tampered, misplaced (wrong AAD) or corrupt ciphertext.</exception>
    public async Task<JsonObject> OpenAsync(string payload, string aad, CancellationToken ct = default) =>
        (await OpenEnvelopeAsync(payload, aad, ct).ConfigureAwait(false)).Content;

    public async Task<OpenedEnvelope> OpenEnvelopeAsync(string payload, string aad, CancellationToken ct = default)
    {
        JsonObject env;
        try
        {
            env = JsonNode.Parse(payload) as JsonObject ?? throw new TailchatException("Envelope is not a JSON object");
        }
        catch (JsonException e)
        {
            throw new TailchatException("Envelope is not valid JSON", e);
        }
        if (env["v"] is not JsonValue v || !v.TryGetValue<int>(out var version) || version != EnvelopeVersion)
            throw new TailchatException("Unsupported envelope version");
        var from = GetString(env, "from");
        if (env["keys"] is not JsonObject keys) throw new TailchatException("Envelope has no keys");
        if (keys[DeviceId] is not JsonValue wrappedNode || !wrappedNode.TryGetValue<string>(out var wrapped))
            throw new NoKeyException();
        var iv = Base64Url.Decode(GetString(env, "iv"), 12, "iv");
        var sealedBytes = Base64Url.Decode(GetString(env, "ct"));
        if (sealedBytes.Length < 16) throw new CryptographicException("Ciphertext is too short");

        var wrapKey = await WrapKeyAsync(from, DeviceId, ct).ConfigureAwait(false);
        var contentKey = AesKeyWrap.Unwrap(wrapKey, Base64Url.Decode(wrapped));
        try
        {
            if (contentKey.Length != 32) throw new CryptographicException("Content key must be 32 bytes");
            var n = sealedBytes.Length - 16;
            var plaintext = new byte[n];
            using (var gcm = new AesGcm(contentKey, 16))
            {
                gcm.Decrypt(iv, sealedBytes.AsSpan(0, n), sealedBytes.AsSpan(n), plaintext, Encoding.UTF8.GetBytes(aad));
            }
            var content = JsonNode.Parse(Encoding.UTF8.GetString(plaintext)) as JsonObject
                ?? throw new TailchatException("Decrypted content is not a JSON object");
            return new OpenedEnvelope(content, from);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(contentKey);
        }
    }

    private static string GetString(JsonObject obj, string name) =>
        obj[name] is JsonValue value && value.TryGetValue<string>(out var s) ? s : throw new TailchatException($"Envelope has no {name}");

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var k in _publicKeys.Values) k.Dispose();
            _publicKeys.Clear();
            foreach (var w in _wrapKeys.Values) CryptographicOperations.ZeroMemory(w);
            _wrapKeys.Clear();
        }
    }
}
