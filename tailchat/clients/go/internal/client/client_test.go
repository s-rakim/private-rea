package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/e2ee"
)

func TestSafeFileName(t *testing.T) {
	for in, want := range map[string]string{
		"report.pdf":            "report.pdf",
		"../../etc/passwd":      "passwd",
		`..\..\Windows\win.ini`: "win.ini",
		"/abs/path/x.txt":       "x.txt",
		"..":                    "fallback",
		"":                      "fallback",
		".bashrc":               "bashrc",
		"a\x1b[31mb\nc.txt":     "a_[31mb_c.txt",
		"what?.txt":             "what_.txt",
		"dir/":                  "dir",
	} {
		if got := SafeFileName(in, "fallback"); got != want {
			t.Errorf("SafeFileName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStateFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "state.json")
	k, _ := e2ee.GenerateKey()
	st := &State{Server: "http://x", UserID: "a@b", DeviceID: "d", Token: "d.s", PrivateKey: e2ee.EncodePrivateKey(k), PublicKey: e2ee.JWKOf(k.PublicKey())}
	if err := st.Save(p); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(p)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	back, err := LoadState(p)
	if err != nil || *back != *st {
		t.Fatalf("load: %+v %v", back, err)
	}
	if _, err := LoadState(filepath.Join(t.TempDir(), "missing.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	// A state whose public key doesn't match the private key is refused.
	other, _ := e2ee.GenerateKey()
	st.PublicKey = e2ee.JWKOf(other.PublicKey())
	c, _ := New(Options{Server: "http://x"})
	if err := c.Use(st); err == nil {
		t.Fatal("mismatched key pair accepted")
	}
}

// A server that attributes a message to the wrong user is caught: the
// envelope's sealing device must belong to the message's senderId.
func TestDecryptChecksSender(t *testing.T) {
	mallory, _ := e2ee.GenerateKey()
	me, _ := e2ee.GenerateKey()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"devices": []Device{{ID: "mdev", UserID: "mallory@example.com", PublicKey: e2ee.JWKOf(mallory.PublicKey())}}})
	}))
	defer srv.Close()
	c, _ := New(Options{Server: srv.URL})
	if err := c.Use(&State{DeviceID: "medev", Token: "medev.x", PrivateKey: e2ee.EncodePrivateKey(me), PublicKey: e2ee.JWKOf(me.PublicKey())}); err != nil {
		t.Fatal(err)
	}
	payload, err := e2ee.Seal("mdev", mallory, []byte(`{"type":"text","text":"hi"}`), e2ee.ChatAAD("c1", "m1"), []e2ee.Recipient{{ID: "medev", Key: me.PublicKey()}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	m := &Message{ID: "m1", ChatID: "c1", Kind: "msg", SenderID: "mallory@example.com", Payload: &payload}
	if d := c.Decrypt(ctx, m); d.Err != nil || d.Content.Text != "hi" {
		t.Fatalf("honest message: %+v %v", d.Content, d.Err)
	}
	m.SenderID = "alice@example.com"
	if d := c.Decrypt(ctx, m); !errors.Is(d.Err, ErrSenderMismatch) || d.Content != nil {
		t.Fatalf("misattributed message: %+v %v", d.Content, d.Err)
	}
	m.SenderID, m.ID = "mallory@example.com", "m2"
	if d := c.Decrypt(ctx, m); d.Err == nil {
		t.Fatal("moved message decrypted")
	}
	// Files without a checksum are refused before anything is fetched.
	if err := c.Download(ctx, &FileRef{ID: "f", Key: "k", Prefix: "p", Size: 1}, nil); err == nil {
		t.Fatal("file without sha256 accepted")
	}
}
