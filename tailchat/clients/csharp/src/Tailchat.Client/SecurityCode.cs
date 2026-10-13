using System.Security.Cryptography;
using System.Text;

namespace Tailchat.Client;

/// <summary>The 60-digit security code people compare in person (PROTOCOL.md §3).</summary>
public static class SecurityCode
{
    public static string Compute(IEnumerable<PublicJwk> keys)
    {
        var digests = new List<string>();
        foreach (var k in keys)
        {
            var raw = new byte[64];
            Base64Url.Decode(k.X, 32, "x").CopyTo(raw, 0);
            Base64Url.Decode(k.Y, 32, "y").CopyTo(raw, 32);
            digests.Add(Base64Url.Encode(SHA256.HashData(raw)));
        }
        // JS Array.prototype.sort compares UTF-16 code units; base64url is ASCII so ordinal matches.
        digests.Sort(StringComparer.Ordinal);
        var h = SHA256.HashData(Encoding.UTF8.GetBytes(string.Concat(digests)));
        var groups = new string[12];
        for (int i = 0; i < 12; i++)
        {
            int n = ((h[2 * i] << 16) | (h[2 * i + 1] << 8) | h[24 + i % 8]) % 100000;
            groups[i] = n.ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
        }
        return string.Join(' ', groups);
    }

    public static string Compute(IEnumerable<DeviceInfo> devices) => Compute(devices.Select(d => d.PublicKey));
}
