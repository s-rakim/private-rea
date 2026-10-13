//! Streaming file encryption (PROTOCOL.md §5). Files are processed one 1 MiB
//! chunk at a time, so memory use stays flat whatever the file size.
//!
//! ```text
//! iv_i  = prefix || uint32_be(i)
//! aad_i = "tailchat/v1|file|" + i + "|" + ("1" if last chunk else "0")
//! blob  = concat_i AES-256-GCM(fileKey, iv_i, chunk_i, aad_i)    // each len+16
//! sha256 = SHA-256(SHA-256(chunk_0) || SHA-256(chunk_1) || ...)
//! ```

use std::io::{self, Read, Write};

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::{b64u, random_bytes, unb64u_n};
use crate::error::{Error, Result};

pub const CHUNK: usize = 1024 * 1024;
pub const TAG: usize = 16;

/// Number of chunks for a plaintext of `size` bytes (an empty file is one empty chunk).
pub fn chunk_count(size: u64) -> u64 {
    size.div_ceil(CHUNK as u64).max(1)
}

/// Size of the uploaded blob: every chunk grows by its 16-byte tag.
pub fn encrypted_size(size: u64) -> u64 {
    size + chunk_count(size) * TAG as u64
}

pub fn chunk_iv(prefix: &[u8; 8], index: u64) -> Result<[u8; 12]> {
    let i = u32::try_from(index).map_err(|_| Error::msg("file has too many chunks"))?;
    let mut iv = [0u8; 12];
    iv[..8].copy_from_slice(prefix);
    iv[8..].copy_from_slice(&i.to_be_bytes());
    Ok(iv)
}

pub fn chunk_aad(index: u64, last: bool) -> String {
    format!("tailchat/v1|file|{index}|{}", if last { 1 } else { 0 })
}

/// The per-file secrets that travel inside the (encrypted) message content.
pub struct FileKey {
    pub key: Zeroizing<[u8; 32]>,
    pub prefix: [u8; 8],
}

impl FileKey {
    pub fn random() -> Self {
        FileKey { key: Zeroizing::new(random_bytes::<32>()), prefix: random_bytes::<8>() }
    }

    pub fn from_b64u(key: &str, prefix: &str) -> Result<Self> {
        Ok(FileKey { key: Zeroizing::new(unb64u_n::<32>(key, "file key")?), prefix: unb64u_n::<8>(prefix, "file prefix")? })
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(self.key.as_ref().into())
    }
}

/// Wraps a plaintext reader of known `size` and reads out the encrypted blob.
/// Hashes the plaintext as it goes; call [`EncryptReader::sha256`] at the end.
pub struct EncryptReader<'a, R: Read> {
    inner: R,
    cipher: Aes256Gcm,
    prefix: [u8; 8],
    size: u64,
    count: u64,
    next: u64,
    buf: Zeroizing<Vec<u8>>,
    pos: usize,
    digests: Sha256,
    done_plain: u64,
    progress: Option<Box<dyn FnMut(u64) + 'a>>,
}

impl<'a, R: Read> EncryptReader<'a, R> {
    pub fn new(inner: R, size: u64, key: &FileKey) -> Self {
        EncryptReader {
            inner,
            cipher: key.cipher(),
            prefix: key.prefix,
            size,
            count: chunk_count(size),
            next: 0,
            buf: Zeroizing::new(Vec::with_capacity(CHUNK + TAG)),
            pos: 0,
            digests: Sha256::new(),
            done_plain: 0,
            progress: None,
        }
    }

    /// Called with the number of plaintext bytes encrypted so far.
    pub fn on_progress(mut self, f: impl FnMut(u64) + 'a) -> Self {
        self.progress = Some(Box::new(f));
        self
    }

    pub fn encrypted_len(&self) -> u64 {
        encrypted_size(self.size)
    }

    fn fill(&mut self) -> io::Result<()> {
        let index = self.next;
        let last = index + 1 == self.count;
        let len = (self.size - index * CHUNK as u64).min(CHUNK as u64) as usize;
        self.buf.clear();
        self.buf.resize(len, 0);
        self.inner.read_exact(&mut self.buf[..len]).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(io::ErrorKind::UnexpectedEof, "the file shrank while it was being sent")
            } else {
                e
            }
        })?;
        if last {
            // A file that grew while we read it would be silently cut short.
            let mut probe = [0u8; 1];
            if self.inner.read(&mut probe)? != 0 {
                return Err(io::Error::other("the file grew while it was being sent"));
            }
        }
        self.digests.update(Sha256::digest(&self.buf[..]));
        let iv = chunk_iv(&self.prefix, index).map_err(|e| io::Error::other(e.to_string()))?;
        let tag = self
            .cipher
            .encrypt_in_place_detached(&Nonce::from(iv), chunk_aad(index, last).as_bytes(), &mut self.buf[..])
            .map_err(|_| io::Error::other("encryption failed"))?;
        self.buf.extend_from_slice(&tag);
        self.pos = 0;
        self.next += 1;
        self.done_plain += len as u64;
        if let Some(p) = self.progress.as_mut() {
            p(self.done_plain);
        }
        Ok(())
    }

    /// `b64u(sha256)` of the chunked digest. Only valid once everything was read.
    pub fn sha256(&self) -> Result<String> {
        if self.next != self.count || self.pos != self.buf.len() {
            return Err(Error::msg("file was not completely encrypted"));
        }
        Ok(b64u(&self.digests.clone().finalize()))
    }
}

impl<R: Read> Read for EncryptReader<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.pos == self.buf.len() {
            if self.next == self.count {
                return Ok(0);
            }
            self.fill()?;
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Decrypt an encrypted blob from `input` into `output`, chunk by chunk,
/// checking every tag, the chunk count (no truncation, no trailing bytes)
/// and, if given, the chunked sha256. `output` may hold unverified plaintext
/// when this fails, so write to a temporary file and only keep it on success.
pub fn decrypt_stream<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    key: &FileKey,
    size: u64,
    expected_sha256: Option<&str>,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let cipher = key.cipher();
    let count = chunk_count(size);
    let mut digests = Sha256::new();
    let mut buf = Zeroizing::new(vec![0u8; CHUNK + TAG]);
    let mut done = 0u64;
    for index in 0..count {
        let last = index + 1 == count;
        let len = (size - index * CHUNK as u64).min(CHUNK as u64) as usize;
        input.read_exact(&mut buf[..len + TAG]).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                Error::msg("the encrypted file is truncated")
            } else {
                Error::msg(format!("download failed: {e}"))
            }
        })?;
        let (data, tag) = buf[..len + TAG].split_at_mut(len);
        let tag = Tag::from(<[u8; TAG]>::try_from(&*tag).expect("16-byte tag"));
        let iv = chunk_iv(&key.prefix, index)?;
        cipher
            .decrypt_in_place_detached(&Nonce::from(iv), chunk_aad(index, last).as_bytes(), data, &tag)
            .map_err(|_| Error::msg(format!("chunk {index} failed authentication (corrupted or tampered file)")))?;
        digests.update(Sha256::digest(&*data));
        output.write_all(data)?;
        done += len as u64;
        progress(done);
    }
    let mut probe = [0u8; 1];
    if input.read(&mut probe).map_err(|e| Error::msg(format!("download failed: {e}")))? != 0 {
        return Err(Error::msg("the encrypted file is longer than expected"));
    }
    if let Some(expected) = expected_sha256 {
        if b64u(&digests.finalize()) != expected {
            return Err(Error::msg("file checksum mismatch"));
        }
    }
    output.flush()?;
    Ok(())
}

/// The chunked sha256 of a plaintext stream (used to recognise files that
/// were already downloaded).
pub fn chunked_sha256<R: Read>(mut input: R) -> io::Result<(u64, String)> {
    let mut digests = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut size = 0u64;
    loop {
        let mut filled = 0;
        while filled < CHUNK {
            let n = input.read(&mut buf[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        // An empty file is one empty chunk; otherwise stop at the end.
        if filled > 0 || size == 0 {
            digests.update(Sha256::digest(&buf[..filled]));
        }
        size += filled as u64;
        if filled < CHUNK {
            break;
        }
    }
    Ok((size, b64u(&digests.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::sha256;

    fn pattern(len: usize) -> Vec<u8> {
        let mut x: u32 = 0x1234_5678;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    fn encrypt(data: &[u8], key: &FileKey) -> (Vec<u8>, String) {
        let mut r = EncryptReader::new(data, data.len() as u64, key);
        let mut out = Vec::new();
        // Small reads exercise the buffering across chunk boundaries.
        let mut small = [0u8; 4093];
        loop {
            let n = r.read(&mut small).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&small[..n]);
        }
        (out, r.sha256().unwrap())
    }

    #[test]
    fn framing_constants() {
        assert_eq!(chunk_count(0), 1);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(CHUNK as u64), 1);
        assert_eq!(chunk_count(CHUNK as u64 + 1), 2);
        assert_eq!(encrypted_size(0), 16);
        assert_eq!(encrypted_size(5), 21);
        assert_eq!(encrypted_size(2 * CHUNK as u64 + 5), 2 * CHUNK as u64 + 5 + 48);
        let prefix = [1, 2, 3, 4, 5, 6, 7, 8];
        assert_eq!(chunk_iv(&prefix, 0).unwrap(), [1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]);
        assert_eq!(chunk_iv(&prefix, 0x0102_0304).unwrap(), [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4]);
        assert!(chunk_iv(&prefix, 1 << 32).is_err());
        assert_eq!(chunk_aad(0, false), "tailchat/v1|file|0|0");
        assert_eq!(chunk_aad(12, true), "tailchat/v1|file|12|1");
    }

    #[test]
    fn chunk_layout_matches_the_protocol() {
        // Encrypt each chunk independently with plain AES-GCM and compare.
        use aes_gcm::aead::{Aead, Payload};
        let key = FileKey { key: Zeroizing::new([9u8; 32]), prefix: [7u8; 8] };
        let data = pattern(CHUNK + 100);
        let (blob, sha) = encrypt(&data, &key);
        let cipher = Aes256Gcm::new((&[9u8; 32]).into());
        let c0 = cipher
            .encrypt(&Nonce::from(chunk_iv(&[7u8; 8], 0).unwrap()), Payload { msg: &data[..CHUNK], aad: b"tailchat/v1|file|0|0" })
            .unwrap();
        let c1 = cipher
            .encrypt(&Nonce::from(chunk_iv(&[7u8; 8], 1).unwrap()), Payload { msg: &data[CHUNK..], aad: b"tailchat/v1|file|1|1" })
            .unwrap();
        assert_eq!(blob, [c0, c1].concat());
        let mut both = sha256(&data[..CHUNK]).to_vec();
        both.extend_from_slice(&sha256(&data[CHUNK..]));
        assert_eq!(sha, b64u(&sha256(&both)));
        assert_eq!(chunked_sha256(&data[..]).unwrap(), (data.len() as u64, sha));
    }

    #[test]
    fn empty_file_is_one_empty_chunk() {
        let key = FileKey::random();
        let (blob, sha) = encrypt(b"", &key);
        assert_eq!(blob.len(), 16);
        assert_eq!(sha, b64u(&sha256(&sha256(b""))));
        assert_eq!(chunked_sha256(&b""[..]).unwrap(), (0, sha.clone()));
        let mut out = Vec::new();
        decrypt_stream(&blob[..], &mut out, &key, 0, Some(&sha), |_| {}).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn roundtrip_at_chunk_boundaries() {
        for len in [1, 100, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 12345] {
            let key = FileKey::random();
            let data = pattern(len);
            let (blob, sha) = encrypt(&data, &key);
            assert_eq!(blob.len() as u64, encrypted_size(len as u64), "len {len}");
            assert_eq!(chunked_sha256(&data[..]).unwrap().1, sha);
            let mut out = Vec::new();
            let mut seen = 0;
            decrypt_stream(&blob[..], &mut out, &key, len as u64, Some(&sha), |n| seen = n).unwrap();
            assert_eq!(out, data, "len {len}");
            assert_eq!(seen, len as u64);
        }
    }

    #[test]
    fn tampering_is_detected() {
        let key = FileKey::random();
        let data = pattern(2 * CHUNK + 10);
        let (blob, sha) = encrypt(&data, &key);
        let size = data.len() as u64;
        let fails =
            |blob: &[u8], size: u64, sha: Option<&str>| decrypt_stream(blob, Vec::new(), &key, size, sha, |_| {}).is_err();

        assert!(fails(&blob[..blob.len() - 1], size, None), "truncated");
        assert!(fails(&[&blob[..], b"x"].concat(), size, None), "trailing bytes");
        let mut flipped = blob.clone();
        flipped[CHUNK + 20] ^= 0x80;
        assert!(fails(&flipped, size, None), "bit flip");
        // Dropping the last chunk and claiming a shorter file: chunk 1 was not sealed as "last".
        assert!(fails(&blob[..2 * (CHUNK + TAG)], 2 * CHUNK as u64, None), "dropped last chunk");
        // Swapping chunks breaks the per-chunk IV.
        let mut swapped = blob[CHUNK + TAG..2 * (CHUNK + TAG)].to_vec();
        swapped.extend_from_slice(&blob[..CHUNK + TAG]);
        swapped.extend_from_slice(&blob[2 * (CHUNK + TAG)..]);
        assert!(fails(&swapped, size, None), "reordered chunks");
        assert!(fails(&blob, size, Some("AAAA")), "checksum");
        assert!(!fails(&blob, size, Some(&sha)));
    }

    #[test]
    fn file_that_changes_while_reading_is_refused() {
        let key = FileKey::random();
        let data = pattern(1000);
        let mut grew = EncryptReader::new(&data[..], 999, &key);
        assert!(io::copy(&mut grew, &mut io::sink()).is_err());
        let mut shrank = EncryptReader::new(&data[..], 1001, &key);
        assert!(io::copy(&mut shrank, &mut io::sink()).is_err());
    }
}
