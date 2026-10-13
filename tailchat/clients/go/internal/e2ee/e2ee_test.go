package e2ee

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"regexp"
	"strings"
	"testing"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// RFC 3394 section 4 test vectors.
func TestKeyWrapRFC3394Vectors(t *testing.T) {
	const kek = "000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F"
	const data = "00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F"
	cases := []struct {
		name          string
		kekLen, dLen  int
		ciphertextHex string
	}{
		{"4.1 128-bit KEK, 128-bit key", 16, 16, "1FA68B0A8112B447 AEF34BD8FB5A7B82 9D3E862371D2CFE5"},
		{"4.2 192-bit KEK, 128-bit key", 24, 16, "96778B25AE6CA435 F92B5B97C050AED2 468AB8A17AD84E5D"},
		{"4.3 256-bit KEK, 128-bit key", 32, 16, "64E8C3F9CE0F5BA2 63E9777905818A2A 93C8191E7D6E8AE7"},
		{"4.4 192-bit KEK, 192-bit key", 24, 24, "031D33264E15D332 68F24EC260743EDC E1C6C7DDEE725A93 6BA814915C6762D2"},
		{"4.5 256-bit KEK, 192-bit key", 32, 24, "A8F9BC1612C68B3F F6E6F4FBE30E71E4 769C8B80A32CB895 8CD5D17D6B254DA1"},
		{"4.6 256-bit KEK, 256-bit key", 32, 32, "28C9F404C4B810F4 CBCCB35CFB87F826 3F5786E2D80ED326 CBC7F0E71A99F43B FB988B9B7A02DD21"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k := unhex(t, kek)[:c.kekLen]
			d := unhex(t, data)[:c.dLen]
			want := unhex(t, c.ciphertextHex)
			got, err := KeyWrap(k, d)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("wrap = %X, want %X", got, want)
			}
			back, err := KeyUnwrap(k, want)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(back, d) {
				t.Fatalf("unwrap = %X, want %X", back, d)
			}
			// Any flipped bit fails the integrity check.
			bad := bytes.Clone(want)
			bad[len(bad)-1] ^= 1
			if _, err := KeyUnwrap(k, bad); !errors.Is(err, ErrUnwrap) {
				t.Fatalf("tampered unwrap err = %v", err)
			}
		})
	}
	if _, err := KeyWrap(make([]byte, 32), make([]byte, 12)); err == nil {
		t.Fatal("wrapping 12 bytes should fail")
	}
	if _, err := KeyUnwrap(make([]byte, 32), make([]byte, 16)); err == nil {
		t.Fatal("unwrapping 16 bytes should fail")
	}
}

func TestSealOpen(t *testing.T) {
	alice, _ := GenerateKey()
	bob, _ := GenerateKey()
	carol, _ := GenerateKey()
	bobPub, err := JWKOf(bob.PublicKey()).PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	aad := ChatAAD("chat1", "msg-0123456789abcdef")
	content := []byte(`{"type":"text","text":"héllo 👋"}`)
	payload, err := Seal("A", alice, content, aad, []Recipient{{ID: "B", Key: bobPub}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "llo") {
		t.Fatal("plaintext leaked into the envelope")
	}
	env, err := ParseEnvelope(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(env.Keys) != 2 || env.From != "A" {
		t.Fatalf("keys = %v from = %q", env.Keys, env.From)
	}
	for _, k := range env.Keys {
		raw, _ := UnB64u(k)
		if len(raw) != 40 {
			t.Fatalf("wrapped key is %d bytes, want 40", len(raw))
		}
	}
	// Bob opens with Alice's public key; Alice can read her own message.
	got, err := env.Open("B", bob, alice.PublicKey(), aad)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("bob open = %q, %v", got, err)
	}
	got, err = env.Open("A", alice, alice.PublicKey(), aad)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("self open = %q, %v", got, err)
	}
	// Moving the message elsewhere breaks it.
	if _, err := env.Open("B", bob, alice.PublicKey(), ChatAAD("chat1", "other-message-id-x")); err == nil {
		t.Fatal("opened with the wrong aad")
	}
	// Carol has no key; claiming to be Bob with Carol's key fails the unwrap.
	if _, err := env.Open("C", carol, alice.PublicKey(), aad); !errors.Is(err, ErrNoKey) {
		t.Fatalf("carol err = %v", err)
	}
	if _, err := env.Open("B", carol, alice.PublicKey(), aad); !errors.Is(err, ErrUnwrap) {
		t.Fatalf("wrong private key err = %v", err)
	}
	// A forged sender id changes the wrap key.
	env.From = "X"
	if _, err := env.Open("B", bob, alice.PublicKey(), aad); err == nil {
		t.Fatal("forged sender id opened")
	}
	if _, err := ParseEnvelope(`{"v":2,"from":"A"}`); err == nil {
		t.Fatal("v2 envelope accepted")
	}
}

func TestJWK(t *testing.T) {
	k, _ := GenerateKey()
	j := JWKOf(k.PublicKey())
	pub, err := j.PublicKey()
	if err != nil || !pub.Equal(k.PublicKey()) {
		t.Fatalf("round trip: %v", err)
	}
	d, err := ParsePrivateKey(EncodePrivateKey(k))
	if err != nil || !d.Equal(k) {
		t.Fatalf("private round trip: %v", err)
	}
	bad := j
	bad.Y = j.X // almost certainly not on the curve
	if _, err := bad.PublicKey(); err == nil {
		t.Fatal("off-curve point accepted")
	}
	bad = j
	bad.Crv = "P-384"
	if _, err := bad.PublicKey(); err == nil {
		t.Fatal("wrong curve accepted")
	}
}

func encrypt(t *testing.T, plain []byte) ([]byte, FileKeys) {
	t.Helper()
	er, err := NewEncryptReader(bytes.NewReader(plain), int64(len(plain)))
	if err != nil {
		t.Fatal(err)
	}
	blob, err := io.ReadAll(er)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(blob)) != er.Size() || er.Size() != EncryptedSize(int64(len(plain))) {
		t.Fatalf("blob is %d bytes, Size() %d", len(blob), er.Size())
	}
	k, err := er.Keys()
	if err != nil {
		t.Fatal(err)
	}
	return blob, k
}

func chunkedSHA(plain []byte) string {
	outer := sha256.New()
	for i := 0; i == 0 || i < len(plain); i += ChunkSize {
		d := sha256.Sum256(plain[i:min(i+ChunkSize, len(plain))])
		outer.Write(d[:])
	}
	return B64u(outer.Sum(nil))
}

func TestFileRoundTrip(t *testing.T) {
	for _, size := range []int{0, 1, 1000, ChunkSize - 1, ChunkSize, ChunkSize + 1, 2 * ChunkSize, 2*ChunkSize + 12345} {
		plain := make([]byte, size)
		rand.Read(plain)
		blob, k := encrypt(t, plain)
		if k.Size != int64(size) || k.SHA256 != chunkedSHA(plain) {
			t.Fatalf("size %d: keys %+v", size, k)
		}
		if want := int64(size) + ChunkCount(int64(size))*16; int64(len(blob)) != want {
			t.Fatalf("size %d: blob %d want %d", size, len(blob), want)
		}
		var out bytes.Buffer
		if err := DecryptStream(&out, bytes.NewReader(blob), k); err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		if !bytes.Equal(out.Bytes(), plain) {
			t.Fatalf("size %d: plaintext mismatch", size)
		}
	}
}

func TestFileTampering(t *testing.T) {
	plain := make([]byte, 2*ChunkSize+500)
	rand.Read(plain)
	blob, k := encrypt(t, plain)
	check := func(name string, data []byte, keys FileKeys) {
		t.Helper()
		if err := DecryptStream(io.Discard, bytes.NewReader(data), keys); err == nil {
			t.Fatalf("%s: decrypted", name)
		}
	}
	check("truncated", blob[:len(blob)-10], k)
	// Dropping the whole last chunk leaves chunk 1 without its "last" flag.
	short := k
	short.Size = 2 * ChunkSize
	check("dropped last chunk", blob[:2*(ChunkSize+16)], short)
	check("extended", append(bytes.Clone(blob), 0), k)
	flipped := bytes.Clone(blob)
	flipped[ChunkSize+20] ^= 0x80
	check("flipped", flipped, k)
	swapped := bytes.Clone(blob)
	copy(swapped[:ChunkSize+16], blob[ChunkSize+16:2*(ChunkSize+16)])
	copy(swapped[ChunkSize+16:], blob[:ChunkSize+16])
	check("reordered", swapped, k)
	wrongSum := k
	wrongSum.SHA256 = chunkedSHA([]byte("other"))
	if err := DecryptStream(io.Discard, bytes.NewReader(blob), wrongSum); !errors.Is(err, ErrChecksum) {
		t.Fatalf("checksum err = %v", err)
	}
	// A file that shrinks while it is read is an error, not a short upload.
	er, _ := NewEncryptReader(bytes.NewReader(plain[:100]), 200)
	if _, err := io.ReadAll(er); err == nil {
		t.Fatal("short source accepted")
	}
}

func TestSecurityCode(t *testing.T) {
	var keys []PublicJWK
	for range 3 {
		k, _ := GenerateKey()
		keys = append(keys, JWKOf(k.PublicKey()))
	}
	one, err := SecurityCode(keys)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^(\d{5} ){11}\d{5}$`).MatchString(one) {
		t.Fatalf("bad format %q", one)
	}
	rev := []PublicJWK{keys[2], keys[0], keys[1]}
	if two, _ := SecurityCode(rev); two != one {
		t.Fatalf("order dependent: %q vs %q", one, two)
	}
	if three, _ := SecurityCode(keys[:2]); three == one {
		t.Fatal("different key sets gave the same code")
	}
}
