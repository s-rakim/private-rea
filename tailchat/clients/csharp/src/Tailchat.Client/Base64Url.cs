namespace Tailchat.Client;

/// <summary>base64url without padding (PROTOCOL.md §2 "b64u").</summary>
public static class Base64Url
{
    public static string Encode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] Decode(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length % 4 == 1) throw new FormatException("Invalid base64url length");
        foreach (var c in text)
        {
            if (!(c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_'))
                throw new FormatException($"Invalid base64url character '{c}'");
        }
        var s = text.Replace('-', '+').Replace('_', '/');
        s += (s.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        return Convert.FromBase64String(s);
    }

    /// <summary>Decodes and checks the decoded length.</summary>
    public static byte[] Decode(string text, int expectedLength, string what)
    {
        var bytes = Decode(text);
        if (bytes.Length != expectedLength)
            throw new FormatException($"{what} must be {expectedLength} bytes, got {bytes.Length}");
        return bytes;
    }
}
