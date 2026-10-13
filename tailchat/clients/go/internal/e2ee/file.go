package e2ee

import (
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"strconv"
)

// ChunkSize is the plaintext size of every file chunk but the last (§5).
const ChunkSize = 1 << 20

const tagSize = 16

// FileKeys are the §5 fields a recipient needs to decrypt a file.
type FileKeys struct {
	Key    string // b64u 32-byte AES key
	Prefix string // b64u 8-byte IV prefix
	Size   int64  // plaintext bytes
	SHA256 string // b64u chunked digest
}

// ChunkCount is the number of chunks a file of size bytes has (an empty file
// is one empty chunk).
func ChunkCount(size int64) int64 {
	if size <= 0 {
		return 1
	}
	return (size + ChunkSize - 1) / ChunkSize
}

// EncryptedSize is the size of the uploaded blob for a file of size bytes.
func EncryptedSize(size int64) int64 { return size + ChunkCount(size)*tagSize }

func chunkIV(prefix []byte, i int64) []byte {
	iv := make([]byte, 12)
	copy(iv, prefix)
	binary.BigEndian.PutUint32(iv[8:], uint32(i))
	return iv
}

func chunkAAD(i int64, last bool) []byte {
	flag := "0"
	if last {
		flag = "1"
	}
	return []byte("tailchat/v1|file|" + strconv.FormatInt(i, 10) + "|" + flag)
}

func plainLen(size, i, count int64) int64 {
	if i < count-1 {
		return ChunkSize
	}
	return size - (count-1)*ChunkSize
}

// EncryptReader streams the encrypted blob of a plaintext of known size,
// reading one chunk at a time, so files of any size use ~2 MiB of memory.
type EncryptReader struct {
	src     io.Reader
	size    int64
	count   int64
	next    int64
	key     []byte
	prefix  []byte
	gcm     cipher.AEAD
	plain   []byte
	out     []byte
	pos     int
	digests hash.Hash
	err     error
}

// NewEncryptReader encrypts size bytes read from src with a fresh random key.
func NewEncryptReader(src io.Reader, size int64) (*EncryptReader, error) {
	if size < 0 {
		return nil, errors.New("negative file size")
	}
	count := ChunkCount(size)
	if count > 1<<32 {
		return nil, errors.New("file too large")
	}
	key := make([]byte, 32)
	prefix := make([]byte, 8)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if _, err := rand.Read(prefix); err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	return &EncryptReader{
		src: src, size: size, count: count, key: key, prefix: prefix, gcm: gcm,
		plain: make([]byte, min(size, ChunkSize)), digests: sha256.New(),
	}, nil
}

// Size is the total number of bytes Read will produce.
func (e *EncryptReader) Size() int64 { return EncryptedSize(e.size) }

func (e *EncryptReader) Read(p []byte) (int, error) {
	if e.err != nil {
		return 0, e.err
	}
	if e.pos == len(e.out) {
		if e.next == e.count {
			e.err = io.EOF
			return 0, io.EOF
		}
		i := e.next
		n := plainLen(e.size, i, e.count)
		chunk := e.plain[:n]
		if _, err := io.ReadFull(e.src, chunk); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				err = fmt.Errorf("file is shorter than %d bytes (did it change while sending?)", e.size)
			}
			e.err = err
			return 0, err
		}
		d := sha256.Sum256(chunk)
		e.digests.Write(d[:])
		e.out = e.gcm.Seal(e.out[:0], chunkIV(e.prefix, i), chunk, chunkAAD(i, i == e.count-1))
		e.pos = 0
		e.next++
	}
	n := copy(p, e.out[e.pos:])
	e.pos += n
	return n, nil
}

// Keys returns the fields for the message's file object. It is only valid
// once Read has returned io.EOF.
func (e *EncryptReader) Keys() (FileKeys, error) {
	if e.next != e.count || e.pos != len(e.out) {
		return FileKeys{}, errors.New("file not fully encrypted yet")
	}
	return FileKeys{Key: B64u(e.key), Prefix: B64u(e.prefix), Size: e.size, SHA256: B64u(e.digests.Sum(nil))}, nil
}

// ErrChecksum means the decrypted file does not match the message's sha256.
var ErrChecksum = errors.New("file checksum mismatch")

// DecryptStream reads an encrypted blob from src and writes the plaintext to
// dst chunk by chunk. Every chunk is authenticated before it is written; a
// truncated, extended, reordered or tampered blob is an error, as is a
// checksum mismatch (checked after the last chunk, when k.SHA256 is set).
// On error, dst may hold a prefix of the plaintext: callers should write to a
// temporary file and discard it.
func DecryptStream(dst io.Writer, src io.Reader, k FileKeys) error {
	key, err := UnB64u(k.Key)
	if err != nil || len(key) != 32 {
		return errors.New("file key must be 32 bytes")
	}
	prefix, err := UnB64u(k.Prefix)
	if err != nil || len(prefix) != 8 {
		return errors.New("file iv prefix must be 8 bytes")
	}
	if k.Size < 0 {
		return errors.New("negative file size")
	}
	count := ChunkCount(k.Size)
	if count > 1<<32 {
		return errors.New("file too large")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return err
	}
	digests := sha256.New()
	buf := make([]byte, min(k.Size, ChunkSize)+tagSize)
	var plain []byte
	for i := int64(0); i < count; i++ {
		ct := buf[:plainLen(k.Size, i, count)+tagSize]
		if _, err := io.ReadFull(src, ct); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return errors.New("encrypted file is truncated")
			}
			return err
		}
		plain, err = gcm.Open(plain[:0], chunkIV(prefix, i), ct, chunkAAD(i, i == count-1))
		if err != nil {
			return fmt.Errorf("file chunk %d failed to decrypt", i)
		}
		d := sha256.Sum256(plain)
		digests.Write(d[:])
		if _, err := dst.Write(plain); err != nil {
			return err
		}
	}
	var extra [1]byte
	if n, _ := io.ReadFull(src, extra[:]); n > 0 {
		return errors.New("encrypted file is longer than expected")
	}
	if k.SHA256 != "" && B64u(digests.Sum(nil)) != k.SHA256 {
		return ErrChecksum
	}
	return nil
}
