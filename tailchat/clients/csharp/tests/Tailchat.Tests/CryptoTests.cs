using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Tailchat.Client;
using Xunit;

namespace Tailchat.Tests;

public class AesKeyWrapTests
{
    // RFC 3394 §4.1-4.6
    [Theory]
    [InlineData("000102030405060708090A0B0C0D0E0F", "00112233445566778899AABBCCDDEEFF",
        "1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5")]
    [InlineData("000102030405060708090A0B0C0D0E0F1011121314151617", "00112233445566778899AABBCCDDEEFF",
        "96778B25AE6CA435F92B5B97C050AED2468AB8A17AD84E5D")]
    [InlineData("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "00112233445566778899AABBCCDDEEFF",
        "64E8C3F9CE0F5BA263E9777905818A2A93C8191E7D6E8AE7")]
    [InlineData("000102030405060708090A0B0C0D0E0F1011121314151617", "00112233445566778899AABBCCDDEEFF0001020304050607",
        "031D33264E15D33268F24EC260743EDCE1C6C7DDEE725A936BA814915C6762D2")]
    [InlineData("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "00112233445566778899AABBCCDDEEFF0001020304050607",
        "A8F9BC1612C68B3FF6E6F4FBE30E71E4769C8B80A32CB8958CD5D17D6B254DA1")]
    [InlineData("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F",
        "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21")]
    public void Rfc3394Vectors(string kek, string key, string wrapped)
    {
        var k = Convert.FromHexString(kek);
        Assert.Equal(wrapped, Convert.ToHexString(AesKeyWrap.Wrap(k, Convert.FromHexString(key))));
        Assert.Equal(key, Convert.ToHexString(AesKeyWrap.Unwrap(k, Convert.FromHexString(wrapped))));
    }

    [Fact]
    public void UnwrapRejectsWrongKeyAndTampering()
    {
        var kek = RandomNumberGenerator.GetBytes(32);
        var wrapped = AesKeyWrap.Wrap(kek, RandomNumberGenerator.GetBytes(32));
        Assert.Equal(40, wrapped.Length);
        Assert.Throws<CryptographicException>(() => AesKeyWrap.Unwrap(RandomNumberGenerator.GetBytes(32), wrapped));
        wrapped[20] ^= 1;
        Assert.Throws<CryptographicException>(() => AesKeyWrap.Unwrap(kek, wrapped));
        Assert.Throws<CryptographicException>(() => AesKeyWrap.Unwrap(kek, wrapped.AsSpan(0, 39)));
    }
}

public class Base64UrlTests
{
    [Fact]
    public void NoPaddingAndUrlAlphabet()
    {
        Assert.Equal("", Base64Url.Encode(Array.Empty<byte>()));
        Assert.Equal("_-8", Base64Url.Encode(new byte[] { 0xff, 0xef }));
        Assert.Equal("AA", Base64Url.Encode(new byte[] { 0 }));
        Assert.Equal(new byte[] { 0xff, 0xef }, Base64Url.Decode("_-8"));
        for (int n = 0; n < 40; n++)
        {
            var bytes = RandomNumberGenerator.GetBytes(n);
            var s = Base64Url.Encode(bytes);
            Assert.DoesNotContain('=', s);
            Assert.Equal(bytes, Base64Url.Decode(s));
        }
    }

    [Theory]
    [InlineData("AA==")]
    [InlineData("a+b/")]
    [InlineData("A")]
    public void RejectsNonBase64Url(string text) => Assert.Throws<FormatException>(() => Base64Url.Decode(text));
}

public class FileCryptoTests
{
    public static byte[] Pattern(int size)
    {
        var bytes = new byte[size];
        for (int i = 0; i < size; i++) bytes[i] = (byte)(i * 7 + (i >> 12));
        return bytes;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(FileCrypto.ChunkSize - 1)]
    [InlineData(FileCrypto.ChunkSize)]
    [InlineData(FileCrypto.ChunkSize + 1)]
    [InlineData(5 * FileCrypto.ChunkSize / 2)]
    public void RoundTrip(int size)
    {
        var plain = Pattern(size);
        var info = FileCrypto.Encrypt(plain, out var encrypted);
        Assert.Equal(FileCrypto.EncryptedLength(size), encrypted.Length);
        Assert.Equal(size + 16 * Math.Max(1, (size + FileCrypto.ChunkSize - 1) / FileCrypto.ChunkSize), encrypted.Length);
        var file = info.ToFileRef("id", "x.bin", "application/octet-stream");
        Assert.Equal(FileCrypto.ChunkedSha256(plain), file.Sha256);
        Assert.Equal(plain, FileCrypto.Decrypt(encrypted, file));
    }

    [Fact]
    public void ChunkIvAndAadLayout()
    {
        var prefix = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 };
        Assert.Equal("0102030405060708000000FF", Convert.ToHexString(FileCrypto.ChunkIv(prefix, 255)));
        Assert.Equal("01020304050607080001_0000".Replace("_", ""), Convert.ToHexString(FileCrypto.ChunkIv(prefix, 65536)));
        Assert.Equal("tailchat/v1|file|3|1", Aad.FileChunk(3, true));
        Assert.Equal("tailchat/v1|file|0|0", Aad.FileChunk(0, false));
    }

    [Fact]
    public void ChunkedDigestOfEmptyFileIsHashOfHashOfNothing()
    {
        var expected = Base64Url.Encode(SHA256.HashData(SHA256.HashData(Array.Empty<byte>())));
        Assert.Equal(expected, FileCrypto.ChunkedSha256(Array.Empty<byte>()));
    }

    [Fact]
    public void DetectsTruncationReorderingExtraBytesAndChecksum()
    {
        var plain = Pattern(2 * FileCrypto.ChunkSize + 100);
        var info = FileCrypto.Encrypt(plain, out var encrypted);
        var file = info.ToFileRef("id", null, null);

        // Dropping the whole last chunk: the new last chunk was sealed with last=0.
        var cut = encrypted.AsSpan(0, 2 * (FileCrypto.ChunkSize + 16)).ToArray();
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(cut, file));
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(cut, file with { Size = 2 * FileCrypto.ChunkSize }));
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(encrypted[..^10], file));
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(encrypted.Concat(new byte[] { 0 }).ToArray(), file));

        var swapped = (byte[])encrypted.Clone();
        Array.Copy(encrypted, FileCrypto.ChunkSize + 16, swapped, 0, FileCrypto.ChunkSize + 16);
        Array.Copy(encrypted, 0, swapped, FileCrypto.ChunkSize + 16, FileCrypto.ChunkSize + 16);
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(swapped, file));

        var flipped = (byte[])encrypted.Clone();
        flipped[12345] ^= 0x80;
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(flipped, file));

        var wrongSum = file with { Sha256 = Base64Url.Encode(new byte[32]) };
        Assert.Throws<TailchatException>(() => FileCrypto.Decrypt(encrypted, wrongSum));
    }
}

public class KeyRingTests
{
    private static (KeyRing Ring, DeviceInfo Info, DeviceKey Key) Device(string id, string user, Dictionary<string, DeviceInfo> directory)
    {
        var key = DeviceKey.Generate();
        var info = new DeviceInfo(id, user, id, key.PublicJwk);
        directory[id] = info;
        var ring = new KeyRing(id, key, (ids, _) => Task.FromResult<IReadOnlyList<DeviceInfo>>(ids.Where(directory.ContainsKey).Select(i => directory[i]).ToList()));
        return (ring, info, key);
    }

    [Fact]
    public async Task SealOpenBetweenDevices()
    {
        var dir = new Dictionary<string, DeviceInfo>();
        var a = Device("devA", "alice", dir);
        var b = Device("devB", "bob", dir);
        var c = Device("devC", "carol", dir);
        var text = "héllo 👋 \"q\" " + (char)0x2028 + " <b>";
        var content = new JsonObject { ["type"] = "text", ["text"] = text };
        var aad = Aad.Chat("chat1", "msg1234567890abcd");
        var payload = await a.Ring.SealAsync(content, aad, new[] { b.Info });

        var env = JsonNode.Parse(payload)!.AsObject();
        Assert.Equal(new[] { "v", "from", "iv", "ct", "keys" }, env.Select(p => p.Key));
        Assert.Equal(1, env["v"]!.GetValue<int>());
        Assert.Equal("devA", env["from"]!.GetValue<string>());
        Assert.Equal(12, Base64Url.Decode(env["iv"]!.GetValue<string>()).Length);
        Assert.Equal(new[] { "devB", "devA" }, env["keys"]!.AsObject().Select(p => p.Key));
        Assert.All(env["keys"]!.AsObject(), p => Assert.Equal(40, Base64Url.Decode(p.Value!.GetValue<string>()).Length));

        Assert.Equal(content.ToJsonString(), (await b.Ring.OpenAsync(payload, aad)).ToJsonString());
        Assert.Equal(text, (await a.Ring.OpenAsync(payload, aad))["text"]!.GetValue<string>());
        await Assert.ThrowsAnyAsync<CryptographicException>(() => b.Ring.OpenAsync(payload, Aad.Chat("chat1", "otherMessageId00")));
        await Assert.ThrowsAsync<NoKeyException>(() => c.Ring.OpenAsync(payload, aad));
    }

    [Fact]
    public void WrapKeyIsSymmetric()
    {
        using var a = DeviceKey.Generate();
        using var b = DeviceKey.Generate();
        using var aPub = DeviceKey.ImportPublic(a.PublicJwk);
        using var bPub = DeviceKey.ImportPublic(b.PublicJwk);
        var z1 = a.SharedSecret(bPub);
        var z2 = b.SharedSecret(aPub);
        Assert.Equal(32, z1.Length);
        Assert.Equal(z1, z2);
        Assert.Equal(KeyRing.DeriveWrapKey(z1, "S", "R"), KeyRing.DeriveWrapKey(z2, "S", "R"));
        Assert.NotEqual(KeyRing.DeriveWrapKey(z1, "S", "R"), KeyRing.DeriveWrapKey(z1, "R", "S"));
    }

    [Fact]
    public void PrivateJwkRoundTrips()
    {
        using var a = DeviceKey.Generate();
        using var copy = DeviceKey.FromPrivateJwk(a.ExportPrivateJwk());
        Assert.Equal(a.PublicJwk, copy.PublicJwk);
        using var b = DeviceKey.Generate();
        using var bPub = DeviceKey.ImportPublic(b.PublicJwk);
        Assert.Equal(a.SharedSecret(bPub), copy.SharedSecret(bPub));
    }

    [Fact]
    public void RejectsPointsOffTheCurve()
    {
        using var a = DeviceKey.Generate();
        var bad = a.PublicJwk with { Y = Base64Url.Encode(new byte[32]) };
        Assert.ThrowsAny<CryptographicException>(() => DeviceKey.ImportPublic(bad).Dispose());
    }

    [Fact]
    public void SecurityCodeShape()
    {
        using var a = DeviceKey.Generate();
        using var b = DeviceKey.Generate();
        var code = SecurityCode.Compute(new[] { a.PublicJwk, b.PublicJwk });
        Assert.Matches(@"^(\d{5} ){11}\d{5}$", code);
        Assert.Equal(code, SecurityCode.Compute(new[] { b.PublicJwk, a.PublicJwk }));
    }
}
