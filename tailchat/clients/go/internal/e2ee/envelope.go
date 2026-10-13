package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
)

// ChatAAD binds a chat message's ciphertext to its chat and message id.
func ChatAAD(chatID, messageID string) string {
	return "tailchat/v1|chat:" + chatID + "|msg:" + messageID
}

// StatusAAD binds a status update to its author.
func StatusAAD(userID string) string { return "tailchat/v1|status:" + userID }

// NewMessageID returns a fresh client-chosen message id (22 base64url chars).
func NewMessageID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return B64u(b)
}

// Envelope is a message payload (PROTOCOL.md §3).
type Envelope struct {
	V    int               `json:"v"`
	From string            `json:"from"`
	IV   string            `json:"iv"`
	CT   string            `json:"ct"`
	Keys map[string]string `json:"keys"`
}

// ErrNoKey means the envelope has no wrapped key for this device, e.g. it was
// sent before the device was linked.
var ErrNoKey = errors.New("message is not encrypted for this device")

// Recipient is a device a message is encrypted for.
type Recipient struct {
	ID  string
	Key *ecdh.PublicKey
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("AES-256-GCM key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal encrypts plaintext (the UTF-8 JSON content) for every recipient and for
// the sending device itself, and returns the serialised envelope.
func Seal(selfID string, self *ecdh.PrivateKey, plaintext []byte, aad string, recipients []Recipient) (string, error) {
	contentKey := make([]byte, 32)
	iv := make([]byte, 12)
	if _, err := rand.Read(contentKey); err != nil {
		return "", err
	}
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	defer clear(contentKey)
	gcm, err := newGCM(contentKey)
	if err != nil {
		return "", err
	}
	ct := gcm.Seal(nil, iv, plaintext, []byte(aad))

	env := Envelope{V: 1, From: selfID, IV: B64u(iv), CT: B64u(ct), Keys: map[string]string{}}
	all := append([]Recipient{{ID: selfID, Key: self.PublicKey()}}, recipients...)
	for _, r := range all {
		if _, done := env.Keys[r.ID]; done {
			continue
		}
		if r.ID == "" || r.Key == nil {
			return "", errors.New("recipient without id or key")
		}
		kek, err := WrapKey(self, r.Key, selfID, r.ID)
		if err != nil {
			return "", fmt.Errorf("wrap key for %s: %w", r.ID, err)
		}
		wrapped, err := KeyWrap(kek, contentKey)
		clear(kek)
		if err != nil {
			return "", err
		}
		env.Keys[r.ID] = B64u(wrapped)
	}
	out, err := json.Marshal(env)
	return string(out), err
}

// ParseEnvelope decodes a payload string.
func ParseEnvelope(payload string) (*Envelope, error) {
	var env Envelope
	if err := json.Unmarshal([]byte(payload), &env); err != nil {
		return nil, fmt.Errorf("malformed envelope: %w", err)
	}
	if env.V != 1 {
		return nil, fmt.Errorf("unsupported envelope version %d", env.V)
	}
	if env.From == "" {
		return nil, errors.New("envelope has no sender device")
	}
	return &env, nil
}

// Open decrypts the envelope for this device. senderKey is the public key of
// device env.From.
func (env *Envelope) Open(selfID string, self *ecdh.PrivateKey, senderKey *ecdh.PublicKey, aad string) ([]byte, error) {
	wrappedB64, ok := env.Keys[selfID]
	if !ok {
		return nil, ErrNoKey
	}
	wrapped, err := UnB64u(wrappedB64)
	if err != nil {
		return nil, fmt.Errorf("wrapped key: %w", err)
	}
	kek, err := WrapKey(self, senderKey, env.From, selfID)
	if err != nil {
		return nil, err
	}
	contentKey, err := KeyUnwrap(kek, wrapped)
	clear(kek)
	if err != nil {
		return nil, err
	}
	defer clear(contentKey)
	if len(contentKey) != 32 {
		return nil, errors.New("content key must be 32 bytes")
	}
	iv, err := UnB64u(env.IV)
	if err != nil || len(iv) != 12 {
		return nil, errors.New("envelope iv must be 12 bytes")
	}
	ct, err := UnB64u(env.CT)
	if err != nil {
		return nil, fmt.Errorf("envelope ct: %w", err)
	}
	gcm, err := newGCM(contentKey)
	if err != nil {
		return nil, err
	}
	pt, err := gcm.Open(nil, iv, ct, []byte(aad))
	if err != nil {
		return nil, errors.New("message failed to decrypt (wrong chat, message id or tampered ciphertext)")
	}
	return pt, nil
}
