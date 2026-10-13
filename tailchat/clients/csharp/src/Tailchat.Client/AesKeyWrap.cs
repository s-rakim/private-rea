using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Tailchat.Client;

/// <summary>
/// RFC 3394 AES Key Wrap with the default IV 0xA6A6A6A6A6A6A6A6, built on raw AES-ECB
/// (the same algorithm as WebCrypto's "AES-KW").
/// </summary>
public static class AesKeyWrap
{
    private const ulong DefaultIv = 0xA6A6A6A6A6A6A6A6UL;

    public static byte[] Wrap(ReadOnlySpan<byte> kek, ReadOnlySpan<byte> keyData)
    {
        CheckKek(kek);
        if (keyData.Length < 16 || keyData.Length % 8 != 0)
            throw new ArgumentException("Key data must be a multiple of 8 bytes and at least 16 bytes", nameof(keyData));
        int n = keyData.Length / 8;
        var r = keyData.ToArray();
        ulong a = DefaultIv;
        var block = new byte[16];
        var output = new byte[16];
        using var aes = Aes.Create();
        aes.Key = kek.ToArray();
        for (int j = 0; j <= 5; j++)
        {
            for (int i = 1; i <= n; i++)
            {
                BinaryPrimitives.WriteUInt64BigEndian(block, a);
                r.AsSpan((i - 1) * 8, 8).CopyTo(block.AsSpan(8));
                aes.EncryptEcb(block, output, PaddingMode.None);
                a = BinaryPrimitives.ReadUInt64BigEndian(output) ^ (ulong)(n * j + i);
                output.AsSpan(8, 8).CopyTo(r.AsSpan((i - 1) * 8));
            }
        }
        var result = new byte[keyData.Length + 8];
        BinaryPrimitives.WriteUInt64BigEndian(result, a);
        r.CopyTo(result, 8);
        CryptographicOperations.ZeroMemory(r);
        CryptographicOperations.ZeroMemory(block);
        CryptographicOperations.ZeroMemory(output);
        return result;
    }

    /// <exception cref="CryptographicException">The integrity check failed (wrong key or tampered data).</exception>
    public static byte[] Unwrap(ReadOnlySpan<byte> kek, ReadOnlySpan<byte> wrapped)
    {
        CheckKek(kek);
        if (wrapped.Length < 24 || wrapped.Length % 8 != 0)
            throw new CryptographicException("Wrapped key must be a multiple of 8 bytes and at least 24 bytes");
        int n = wrapped.Length / 8 - 1;
        ulong a = BinaryPrimitives.ReadUInt64BigEndian(wrapped);
        var r = wrapped[8..].ToArray();
        var block = new byte[16];
        var output = new byte[16];
        using var aes = Aes.Create();
        aes.Key = kek.ToArray();
        for (int j = 5; j >= 0; j--)
        {
            for (int i = n; i >= 1; i--)
            {
                BinaryPrimitives.WriteUInt64BigEndian(block, a ^ (ulong)(n * j + i));
                r.AsSpan((i - 1) * 8, 8).CopyTo(block.AsSpan(8));
                aes.DecryptEcb(block, output, PaddingMode.None);
                a = BinaryPrimitives.ReadUInt64BigEndian(output);
                output.AsSpan(8, 8).CopyTo(r.AsSpan((i - 1) * 8));
            }
        }
        CryptographicOperations.ZeroMemory(block);
        CryptographicOperations.ZeroMemory(output);
        Span<byte> got = stackalloc byte[8];
        Span<byte> want = stackalloc byte[8];
        BinaryPrimitives.WriteUInt64BigEndian(got, a);
        BinaryPrimitives.WriteUInt64BigEndian(want, DefaultIv);
        if (!CryptographicOperations.FixedTimeEquals(got, want))
        {
            CryptographicOperations.ZeroMemory(r);
            throw new CryptographicException("AES key unwrap failed: integrity check mismatch");
        }
        return r;
    }

    private static void CheckKek(ReadOnlySpan<byte> kek)
    {
        if (kek.Length is not (16 or 24 or 32))
            throw new ArgumentException("KEK must be 16, 24 or 32 bytes", nameof(kek));
    }
}
