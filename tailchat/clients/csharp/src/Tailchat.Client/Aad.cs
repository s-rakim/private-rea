namespace Tailchat.Client;

/// <summary>Additional authenticated data strings (PROTOCOL.md §3 and §5).</summary>
public static class Aad
{
    public static string Chat(string chatId, string messageId) => $"tailchat/v1|chat:{chatId}|msg:{messageId}";

    public static string Status(string userId) => $"tailchat/v1|status:{userId}";

    public static string FileChunk(long index, bool last) => $"tailchat/v1|file|{index}|{(last ? 1 : 0)}";
}
