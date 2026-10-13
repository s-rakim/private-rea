using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Tailchat.Client;

/// <summary>A device's ECDH P-256 key pair (PROTOCOL.md §2).</summary>
public sealed class DeviceKey : IDisposable
{
    public ECDiffieHellman Ecdh { get; }

    public PublicJwk PublicJwk { get; }

    private DeviceKey(ECDiffieHellman ecdh)
    {
        Ecdh = ecdh;
        var p = ecdh.ExportParameters(false);
        PublicJwk = new PublicJwk("EC", "P-256", Base64Url.Encode(p.Q.X), Base64Url.Encode(p.Q.Y));
    }

    public static DeviceKey Generate() => new(ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256));

    /// <summary>Loads a private JWK (with <c>d</c>), as written by <see cref="ExportPrivateJwk"/>.</summary>
    public static DeviceKey FromPrivateJwk(PrivateJwk jwk)
    {
        if (jwk.Kty != "EC" || jwk.Crv != "P-256") throw new TailchatException("Device key must be an EC P-256 JWK");
        var parameters = new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint
            {
                X = Base64Url.Decode(jwk.X, 32, "x"),
                Y = Base64Url.Decode(jwk.Y, 32, "y"),
            },
            D = Base64Url.Decode(jwk.D, 32, "d"),
        };
        parameters.Validate();
        return new DeviceKey(ECDiffieHellman.Create(parameters));
    }

    public PrivateJwk ExportPrivateJwk()
    {
        var p = Ecdh.ExportParameters(true);
        return new PrivateJwk("EC", "P-256", Base64Url.Encode(p.Q.X), Base64Url.Encode(p.Q.Y), Base64Url.Encode(p.D));
    }

    /// <summary>Imports a peer's public JWK, checking it is a valid point on P-256. The caller disposes it.</summary>
    public static ECDiffieHellman ImportPublic(PublicJwk jwk)
    {
        if (jwk.Kty != "EC" || jwk.Crv != "P-256") throw new TailchatException("Public key must be an EC P-256 JWK");
        var parameters = new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = Base64Url.Decode(jwk.X, 32, "x"), Y = Base64Url.Decode(jwk.Y, 32, "y") },
        };
        // ECDiffieHellman.Create validates that the point is on the curve.
        return ECDiffieHellman.Create(parameters);
    }

    /// <summary>Z = the 32-byte shared x coordinate (same as WebCrypto deriveBits(…, 256)).</summary>
    public byte[] SharedSecret(ECDiffieHellman peer)
    {
        using var publicKey = peer.PublicKey;
        return Ecdh.DeriveRawSecretAgreement(publicKey);
    }

    public void Dispose() => Ecdh.Dispose();
}

public sealed record PrivateJwk(
    [property: JsonPropertyName("kty")] string Kty,
    [property: JsonPropertyName("crv")] string Crv,
    [property: JsonPropertyName("x")] string X,
    [property: JsonPropertyName("y")] string Y,
    [property: JsonPropertyName("d")] string D);
