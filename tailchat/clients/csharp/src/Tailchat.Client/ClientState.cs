using System.Text.Json;
using System.Text.Json.Serialization;

namespace Tailchat.Client;

/// <summary>
/// What a device keeps locally: its private key and token. Saved as JSON with mode 0600 on Unix.
/// Anyone who can read this file can read this device's messages.
/// </summary>
public sealed class ClientState
{
    public int Version { get; set; } = 1;
    public required string Server { get; set; }
    public string? DevUser { get; set; }
    public required string UserId { get; set; }
    public required string DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public required string Token { get; set; }
    public required PrivateJwk PrivateKey { get; set; }

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string DefaultPath(string? devUser)
    {
        var env = Environment.GetEnvironmentVariable("TAILCHAT_STATE");
        if (!string.IsNullOrEmpty(env)) return env;
        var config = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrEmpty(config))
            config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
        var file = devUser == null ? "state.json" : $"state-dev-{devUser}.json";
        return Path.Combine(config, "tailchat-csharp", file);
    }

    public static ClientState? Load(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<ClientState>(File.ReadAllText(path), Options)
                ?? throw new TailchatException($"State file {path} is empty");
        }
        catch (JsonException e)
        {
            throw new TailchatException($"State file {path} is corrupt: {e.Message}", e);
        }
    }

    /// <summary>Writes atomically (temp file + rename), readable only by the current user.</summary>
    public void Save(string path)
    {
        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full)!;
        if (!Directory.Exists(dir))
        {
            if (OperatingSystem.IsWindows()) Directory.CreateDirectory(dir);
            else Directory.CreateDirectory(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        var tmp = full + ".tmp-" + Environment.ProcessId;
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var fs = new FileStream(tmp, options))
        {
            JsonSerializer.Serialize(fs, this, Options);
        }
        File.Move(tmp, full, overwrite: true);
    }
}
