// Package e2ee implements Tailchat's end-to-end encryption (PROTOCOL.md §2-5):
// P-256 device keys, per-message envelopes with AES-KW wrapped content keys,
// chunked AES-256-GCM file encryption and contact security codes. It is
// interoperable with public/crypto.js.
package e2ee

import (
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// B64u encodes bytes as base64url without padding.
func B64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// UnB64u decodes base64url, with or without padding.
func UnB64u(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// PublicJWK is a device public key as the server stores it.
type PublicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// GenerateKey makes a new device key pair.
func GenerateKey() (*ecdh.PrivateKey, error) { return ecdh.P256().GenerateKey(rand.Reader) }

// ParsePrivateKey loads a b64u-encoded P-256 scalar.
func ParsePrivateKey(d string) (*ecdh.PrivateKey, error) {
	raw, err := UnB64u(d)
	if err != nil {
		return nil, fmt.Errorf("private key: %w", err)
	}
	return ecdh.P256().NewPrivateKey(raw)
}

// EncodePrivateKey is the inverse of ParsePrivateKey.
func EncodePrivateKey(k *ecdh.PrivateKey) string { return B64u(k.Bytes()) }

// JWKOf returns the JWK of a P-256 public key.
func JWKOf(pub *ecdh.PublicKey) PublicJWK {
	raw := pub.Bytes() // 0x04 || X || Y
	return PublicJWK{Kty: "EC", Crv: "P-256", X: B64u(raw[1:33]), Y: B64u(raw[33:65])}
}

// rawXY returns the 32-byte coordinates of a JWK.
func (j PublicJWK) rawXY() (x, y []byte, err error) {
	if j.Kty != "EC" || j.Crv != "P-256" {
		return nil, nil, errors.New("public key is not a P-256 EC key")
	}
	if x, err = UnB64u(j.X); err != nil {
		return nil, nil, fmt.Errorf("public key x: %w", err)
	}
	if y, err = UnB64u(j.Y); err != nil {
		return nil, nil, fmt.Errorf("public key y: %w", err)
	}
	if len(x) != 32 || len(y) != 32 {
		return nil, nil, errors.New("public key coordinates must be 32 bytes")
	}
	return x, y, nil
}

// PublicKey parses and validates (on-curve check) the JWK.
func (j PublicJWK) PublicKey() (*ecdh.PublicKey, error) {
	x, y, err := j.rawXY()
	if err != nil {
		return nil, err
	}
	raw := make([]byte, 0, 65)
	raw = append(raw, 4)
	raw = append(raw, x...)
	raw = append(raw, y...)
	return ecdh.P256().NewPublicKey(raw)
}

// WrapKey derives the AES-KW key between a sender and a recipient device
// (PROTOCOL.md §2). self is this device's private key and peer the other
// device's public key; senderID|recipientID always names the sender first so
// both ends derive the same key.
func WrapKey(self *ecdh.PrivateKey, peer *ecdh.PublicKey, senderID, recipientID string) ([]byte, error) {
	z, err := self.ECDH(peer)
	if err != nil {
		return nil, err
	}
	return hkdf.Key(sha256.New, z, []byte("tailchat/v1/wrap"), senderID+"|"+recipientID, 32)
}
