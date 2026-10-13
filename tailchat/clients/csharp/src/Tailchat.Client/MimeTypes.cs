namespace Tailchat.Client;

/// <summary>A small extension → MIME table, and the media <c>kind</c> for a MIME type (PROTOCOL.md §4).</summary>
public static class MimeTypes
{
    private static readonly Dictionary<string, string> ByExtension = new(StringComparer.OrdinalIgnoreCase)
    {
        [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".png"] = "image/png", [".gif"] = "image/gif",
        [".webp"] = "image/webp", [".heic"] = "image/heic", [".svg"] = "image/svg+xml",
        [".mp4"] = "video/mp4", [".mov"] = "video/quicktime", [".webm"] = "video/webm", [".mkv"] = "video/x-matroska",
        [".mp3"] = "audio/mpeg", [".m4a"] = "audio/mp4", [".ogg"] = "audio/ogg", [".opus"] = "audio/opus", [".wav"] = "audio/wav",
        [".pdf"] = "application/pdf", [".txt"] = "text/plain", [".md"] = "text/markdown", [".csv"] = "text/csv",
        [".json"] = "application/json", [".zip"] = "application/zip", [".gz"] = "application/gzip",
        [".doc"] = "application/msword",
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };

    public static string FromFileName(string name) =>
        ByExtension.TryGetValue(Path.GetExtension(name), out var mime) ? mime : "application/octet-stream";

    public static string KindFor(string mime) =>
        mime.StartsWith("image/", StringComparison.Ordinal) && mime != "image/svg+xml" ? "image"
        : mime.StartsWith("video/", StringComparison.Ordinal) ? "video"
        : mime.StartsWith("audio/", StringComparison.Ordinal) ? "audio"
        : "document";
}
