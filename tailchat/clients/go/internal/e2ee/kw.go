package e2ee

import (
	"crypto/aes"
	"crypto/subtle"
	"encoding/binary"
	"errors"
)

// RFC 3394 AES Key Wrap with the default initial value, as used by WebCrypto's
// "AES-KW" algorithm.

var kwIV = [8]byte{0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6}

// ErrUnwrap means the wrapped key failed its integrity check: the wrong key
// encryption key, or tampered data.
var ErrUnwrap = errors.New("aes-kw: integrity check failed")

// KeyWrap wraps plaintext (a multiple of 8 bytes, at least 16) under kek
// (16, 24 or 32 bytes).
func KeyWrap(kek, plaintext []byte) ([]byte, error) {
	if len(plaintext) < 16 || len(plaintext)%8 != 0 {
		return nil, errors.New("aes-kw: key data must be a multiple of 8 bytes and at least 16")
	}
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	n := len(plaintext) / 8
	out := make([]byte, 8+len(plaintext))
	copy(out, kwIV[:])
	copy(out[8:], plaintext)
	var b [16]byte
	for j := 0; j < 6; j++ {
		for i := 1; i <= n; i++ {
			copy(b[:8], out[:8])
			copy(b[8:], out[i*8:i*8+8])
			block.Encrypt(b[:], b[:])
			t := uint64(n*j + i)
			binary.BigEndian.PutUint64(out[:8], binary.BigEndian.Uint64(b[:8])^t)
			copy(out[i*8:i*8+8], b[8:])
		}
	}
	return out, nil
}

// KeyUnwrap reverses KeyWrap and checks the integrity value.
func KeyUnwrap(kek, wrapped []byte) ([]byte, error) {
	if len(wrapped) < 24 || len(wrapped)%8 != 0 {
		return nil, errors.New("aes-kw: wrapped key must be a multiple of 8 bytes and at least 24")
	}
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	n := len(wrapped)/8 - 1
	var a [8]byte
	copy(a[:], wrapped[:8])
	r := make([]byte, 8*n)
	copy(r, wrapped[8:])
	var b [16]byte
	for j := 5; j >= 0; j-- {
		for i := n; i >= 1; i-- {
			t := uint64(n*j + i)
			binary.BigEndian.PutUint64(b[:8], binary.BigEndian.Uint64(a[:])^t)
			copy(b[8:], r[(i-1)*8:i*8])
			block.Decrypt(b[:], b[:])
			copy(a[:], b[:8])
			copy(r[(i-1)*8:i*8], b[8:])
		}
	}
	if subtle.ConstantTimeCompare(a[:], kwIV[:]) != 1 {
		clear(r)
		return nil, ErrUnwrap
	}
	return r, nil
}
