using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Tailchat.Client;

/// <summary>Key material and checksum of an encrypted file, before it has a server id.</summary>
public sealed record EncryptedFile(byte[] Key, byte[] Prefix, long Size, byte[] Sha256)
{
    public FileRef ToFileRef(string id, string? name, string? mime) => new()
    {
        Id = id,
        Key = Base64Url.Encode(Key),
        Prefix = Base64Url.Encode(Prefix),
        Size = Size,
        Name = name,
        Mime = mime,
        Sha256 = Base64Url.Encode(Sha256),
    };
}

/// <summary>Chunked AES-256-GCM file encryption (PROTOCOL.md §5). Mirrors encryptFile/decryptFile in public/crypto.js.</summary>
public static class FileCrypto
{
    public const int ChunkSize = 1024 * 1024;
    public const int TagSize = 16;

    /// <summary>Number of chunks; an empty file is one empty chunk.</summary>
    public static long ChunkCount(long size) => Math.Max(1, (size + ChunkSize - 1) / ChunkSize);

    public static long EncryptedLength(long size) => size + ChunkCount(size) * TagSize;

    /// <summary>iv_i = prefix || uint32_be(i).</summary>
    public static byte[] ChunkIv(ReadOnlySpan<byte> prefix, long index)
    {
        if (prefix.Length != 8) throw new ArgumentException("prefix must be 8 bytes", nameof(prefix));
        if (index is < 0 or > uint.MaxValue) throw new ArgumentOutOfRangeException(nameof(index));
        var iv = new byte[12];
        prefix.CopyTo(iv);
        BinaryPrimitives.WriteUInt32BigEndian(iv.AsSpan(8), (uint)index);
        return iv;
    }

    public static byte[] ChunkAad(long index, bool last) => Encoding.UTF8.GetBytes(Aad.FileChunk(index, last));

    /// <summary>
    /// Encrypts exactly <paramref name="size"/> bytes of <paramref name="input"/> into <paramref name="output"/>
    /// (<see cref="EncryptedLength"/> bytes). <paramref name="key"/> and <paramref name="prefix"/> are random when null.
    /// </summary>
    public static async Task<EncryptedFile> EncryptAsync(Stream input, long size, Stream output,
        byte[]? key = null, byte[]? prefix = null, CancellationToken ct = default)
    {
        if (size < 0) throw new ArgumentOutOfRangeException(nameof(size));
        key ??= RandomNumberGenerator.GetBytes(32);
        prefix ??= RandomNumberGenerator.GetBytes(8);
        if (key.Length != 32) throw new ArgumentException("key must be 32 bytes", nameof(key));
        long count = ChunkCount(size);
        var plain = new byte[(int)Math.Min(ChunkSize, Math.Max(size, 0))];
        var sealedChunk = new byte[plain.Length + TagSize];
        using var gcm = new AesGcm(key, TagSize);
        using var digests = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var chunkDigest = new byte[32];
        for (long i = 0; i < count; i++)
        {
            int len = (int)Math.Min(ChunkSize, size - i * ChunkSize);
            int read = await input.ReadAtLeastAsync(plain.AsMemory(0, len), len, throwOnEndOfStream: false, ct).ConfigureAwait(false);
            if (read != len) throw new TailchatException("The file got shorter while it was being encrypted");
            SHA256.HashData(plain.AsSpan(0, len), chunkDigest);
            digests.AppendData(chunkDigest);
            bool last = i == count - 1;
            gcm.Encrypt(ChunkIv(prefix, i), plain.AsSpan(0, len), sealedChunk.AsSpan(0, len), sealedChunk.AsSpan(len, TagSize), ChunkAad(i, last));
            await output.WriteAsync(sealedChunk.AsMemory(0, len + TagSize), ct).ConfigureAwait(false);
        }
        CryptographicOperations.ZeroMemory(plain);
        return new EncryptedFile(key, prefix, size, digests.GetHashAndReset());
    }

    public static EncryptedFile Encrypt(byte[] plaintext, out byte[] encrypted)
    {
        using var output = new MemoryStream((int)EncryptedLength(plaintext.Length));
        var info = EncryptAsync(new MemoryStream(plaintext, writable: false), plaintext.Length, output).GetAwaiter().GetResult();
        encrypted = output.ToArray();
        return info;
    }

    /// <summary>
    /// Decrypts a downloaded blob into <paramref name="output"/>, checking the size, every chunk's tag (which also
    /// detects truncation and reordering) and the chunked SHA-256. On failure, part of the plaintext may already
    /// have been written: write to a temporary file and only keep it when this returns.
    /// </summary>
    public static async Task DecryptAsync(Stream encrypted, FileRef file, Stream output, CancellationToken ct = default)
    {
        var key = Base64Url.Decode(file.Key, 32, "file key");
        var prefix = Base64Url.Decode(file.Prefix, 8, "file prefix");
        if (file.Size < 0) throw new TailchatException("File size is negative");
        long count = ChunkCount(file.Size);
        if (count - 1 > uint.MaxValue) throw new TailchatException("File is too large");
        var sealedChunk = new byte[(int)Math.Min(ChunkSize, file.Size) + TagSize];
        var plain = new byte[sealedChunk.Length - TagSize];
        using var gcm = new AesGcm(key, TagSize);
        using var digests = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var chunkDigest = new byte[32];
        try
        {
            for (long i = 0; i < count; i++)
            {
                int len = (int)Math.Min(ChunkSize, file.Size - i * ChunkSize);
                int want = len + TagSize;
                int read = await encrypted.ReadAtLeastAsync(sealedChunk.AsMemory(0, want), want, throwOnEndOfStream: false, ct).ConfigureAwait(false);
                if (read != want) throw new TailchatException("Encrypted file has the wrong size");
                bool last = i == count - 1;
                try
                {
                    gcm.Decrypt(ChunkIv(prefix, i), sealedChunk.AsSpan(0, len), sealedChunk.AsSpan(len, TagSize), plain.AsSpan(0, len), ChunkAad(i, last));
                }
                catch (CryptographicException e)
                {
                    throw new TailchatException($"File chunk {i} failed to decrypt (tampered or truncated)", e);
                }
                SHA256.HashData(plain.AsSpan(0, len), chunkDigest);
                digests.AppendData(chunkDigest);
                await output.WriteAsync(plain.AsMemory(0, len), ct).ConfigureAwait(false);
            }
            var extra = new byte[1];
            if (await encrypted.ReadAsync(extra, ct).ConfigureAwait(false) != 0)
                throw new TailchatException("Encrypted file has the wrong size");
            var digest = digests.GetHashAndReset();
            if (file.Sha256 != null && !CryptographicOperations.FixedTimeEquals(digest, Base64Url.Decode(file.Sha256)))
                throw new TailchatException("File checksum mismatch");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public static byte[] Decrypt(byte[] encrypted, FileRef file)
    {
        using var output = new MemoryStream();
        DecryptAsync(new MemoryStream(encrypted, writable: false), file, output).GetAwaiter().GetResult();
        return output.ToArray();
    }

    /// <summary>The chunked digest: SHA-256(SHA-256(chunk_0) || SHA-256(chunk_1) || …), base64url.</summary>
    public static string ChunkedSha256(ReadOnlySpan<byte> plaintext)
    {
        using var digests = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long count = ChunkCount(plaintext.Length);
        for (long i = 0; i < count; i++)
        {
            int start = (int)(i * ChunkSize);
            int len = (int)Math.Min(ChunkSize, plaintext.Length - start);
            digests.AppendData(SHA256.HashData(plaintext.Slice(start, len)));
        }
        return Base64Url.Encode(digests.GetHashAndReset());
    }
}
