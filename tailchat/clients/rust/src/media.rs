//! MIME types, media kinds and safe file names.

use std::path::{Path, PathBuf};

const TYPES: &[(&str, &str)] = &[
    // images
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("heic", "image/heic"),
    ("heif", "image/heif"),
    ("bmp", "image/bmp"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
    // video
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("mov", "video/quicktime"),
    ("webm", "video/webm"),
    ("mkv", "video/x-matroska"),
    ("avi", "video/x-msvideo"),
    ("3gp", "video/3gpp"),
    // audio
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("wav", "audio/wav"),
    ("flac", "audio/flac"),
    // documents
    ("pdf", "application/pdf"),
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("csv", "text/csv"),
    ("json", "application/json"),
    ("xml", "application/xml"),
    ("html", "text/html"),
    ("htm", "text/html"),
    ("zip", "application/zip"),
    ("gz", "application/gzip"),
    ("tgz", "application/gzip"),
    ("tar", "application/x-tar"),
    ("7z", "application/x-7z-compressed"),
    ("rar", "application/vnd.rar"),
    ("doc", "application/msword"),
    ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("xls", "application/vnd.ms-excel"),
    ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("ppt", "application/vnd.ms-powerpoint"),
    ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ("odt", "application/vnd.oasis.opendocument.text"),
    ("ods", "application/vnd.oasis.opendocument.spreadsheet"),
    ("odp", "application/vnd.oasis.opendocument.presentation"),
    ("epub", "application/epub+zip"),
    ("apk", "application/vnd.android.package-archive"),
];

pub fn guess_mime(name: &str) -> &'static str {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    ext.and_then(|ext| TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)).unwrap_or("application/octet-stream")
}

/// The message `kind` for a MIME type. SVG (scriptable) and odd image
/// formats browsers can't show go as documents.
pub fn kind_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif" => "image",
        m if m.starts_with("video/") => "video",
        m if m.starts_with("audio/") => "audio",
        _ => "document",
    }
}

pub fn extension_for(mime: &str) -> &'static str {
    TYPES.iter().find(|(_, m)| *m == mime).map(|(e, _)| *e).unwrap_or("bin")
}

/// Turn a name chosen by a remote sender into a safe local file name: no
/// directories, no hidden files, no control characters, bounded length.
pub fn safe_file_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::new();
    for c in trimmed.chars() {
        if out.len() + c.len_utf8() > 200 {
            break;
        }
        out.push(c);
    }
    Some(out)
}

/// `name`, then `stem (2).ext`, `stem (3).ext`, ... in `dir`.
pub fn candidate_names(dir: &Path, name: &str) -> impl Iterator<Item = PathBuf> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    };
    let dir = dir.to_path_buf();
    let first = dir.join(name);
    std::iter::once(first).chain((2..).map(move |n| dir.join(format!("{stem} ({n}){ext}"))))
}

/// A path in `dir` for `name` that does not exist yet.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    candidate_names(dir, name).find(|p| !p.exists()).expect("an unbounded iterator finds a free name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_and_kind() {
        assert_eq!(guess_mime("Holiday.JPG"), "image/jpeg");
        assert_eq!(kind_for(guess_mime("a.png")), "image");
        assert_eq!(kind_for(guess_mime("clip.mov")), "video");
        assert_eq!(kind_for(guess_mime("song.mp3")), "audio");
        assert_eq!(kind_for(guess_mime("drawing.svg")), "document");
        assert_eq!(kind_for(guess_mime("report.pdf")), "document");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
        assert_eq!(guess_mime(".bashrc"), "application/octet-stream");
        assert_eq!(extension_for("image/png"), "png");
    }

    #[test]
    fn remote_names_are_made_safe() {
        assert_eq!(safe_file_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_file_name("C:\\Users\\x\\evil.exe").as_deref(), Some("evil.exe"));
        assert_eq!(safe_file_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(safe_file_name("..").as_deref(), None);
        assert_eq!(safe_file_name("a\nb\u{0}.txt").as_deref(), Some("a_b_.txt"));
        assert_eq!(safe_file_name("   ").as_deref(), None);
        assert!(safe_file_name(&"é".repeat(500)).unwrap().len() <= 200);
    }

    #[test]
    fn numbered_candidates() {
        let names: Vec<String> = candidate_names(Path::new("/d"), "photo.jpg")
            .take(3)
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["photo.jpg", "photo (2).jpg", "photo (3).jpg"]);
        let plain: Vec<String> =
            candidate_names(Path::new("/d"), "README").take(2).map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(plain, ["README", "README (2)"]);
    }
}
