package client_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/client"
	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/e2ee"
	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/testserver"
)

// peer is the JS side (testdata/interop.mjs using public/crypto.js).
type peer struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string
	stderr *bytes.Buffer
}

func startPeer(t *testing.T, env []string, args ...string) *peer {
	t.Helper()
	node, cryptoURL := testserver.Node(t)
	script, _ := filepath.Abs(filepath.Join("testdata", "interop.mjs"))
	cmd := exec.Command(node, append([]string{script}, args...)...)
	cmd.Env = append(os.Environ(), append(env, "TAILCHAT_CRYPTO_URL="+cryptoURL)...)
	p := &peer{t: t, cmd: cmd, lines: make(chan string, 16), stderr: &bytes.Buffer{}}
	cmd.Stderr = p.stderr
	var err error
	if p.stdin, err = cmd.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 16<<20)
		for sc.Scan() {
			p.lines <- sc.Text()
		}
		close(p.lines)
	}()
	t.Cleanup(func() {
		p.stdin.Close()
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
			<-done
		}
		if t.Failed() && p.stderr.Len() > 0 {
			t.Logf("interop.mjs stderr:\n%s", p.stderr)
		}
	})
	return p
}

func (p *peer) recv(v any) {
	p.t.Helper()
	for {
		select {
		case line, ok := <-p.lines:
			if !ok {
				p.cmd.Wait()
				p.t.Fatalf("interop.mjs exited: %v\n%s", p.cmd.ProcessState, p.stderr)
			}
			if !strings.HasPrefix(line, "{") {
				p.t.Logf("interop.mjs: %s", line)
				continue
			}
			if err := json.Unmarshal([]byte(line), v); err != nil {
				p.t.Fatalf("bad line from interop.mjs: %v: %s", err, line)
			}
			return
		case <-time.After(60 * time.Second):
			p.t.Fatalf("timed out waiting for interop.mjs\n%s", p.stderr)
		}
	}
}

func (p *peer) send(v any) {
	p.t.Helper()
	line, ok := v.(string)
	if !ok {
		b, _ := json.Marshal(v)
		line = string(b)
	}
	if _, err := io.WriteString(p.stdin, line+"\n"); err != nil {
		p.t.Fatal(err)
	}
}

func sha256hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// Files encrypted in Go decrypt with crypto.js and vice versa, at every chunk
// boundary (no server involved).
func TestFileInteropWithCryptoJS(t *testing.T) {
	sizes := []int{0, 1, e2ee.ChunkSize - 1, e2ee.ChunkSize, e2ee.ChunkSize + 1, 2*e2ee.ChunkSize + 777}
	dir := t.TempDir()
	type goBlob struct {
		Path string `json:"path"`
		File struct {
			Key    string `json:"key"`
			Prefix string `json:"prefix"`
			Size   int64  `json:"size"`
			SHA256 string `json:"sha256"`
		} `json:"file"`
	}
	var manifest struct {
		GoBlobs []goBlob `json:"goBlobs"`
		JSSizes []int    `json:"jsSizes"`
		OutDir  string   `json:"outDir"`
	}
	var plains [][]byte
	for i, size := range sizes {
		plain := make([]byte, size)
		rand.Read(plain)
		plains = append(plains, plain)
		er, err := e2ee.NewEncryptReader(bytes.NewReader(plain), int64(size))
		if err != nil {
			t.Fatal(err)
		}
		blob, err := io.ReadAll(er)
		if err != nil {
			t.Fatal(err)
		}
		k, _ := er.Keys()
		g := goBlob{Path: filepath.Join(dir, "go-"+string(rune('a'+i))+".bin")}
		g.File.Key, g.File.Prefix, g.File.Size, g.File.SHA256 = k.Key, k.Prefix, k.Size, k.SHA256
		if err := os.WriteFile(g.Path, blob, 0o600); err != nil {
			t.Fatal(err)
		}
		manifest.GoBlobs = append(manifest.GoBlobs, g)
	}
	manifest.JSSizes, manifest.OutDir = sizes, dir
	mp := filepath.Join(dir, "manifest.json")
	data, _ := json.Marshal(manifest)
	os.WriteFile(mp, data, 0o600)

	p := startPeer(t, nil, "files", mp)
	var res struct {
		Decrypted []struct {
			Size   int    `json:"size"`
			SHA256 string `json:"sha256"`
		} `json:"decrypted"`
		Encrypted []struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
			File   struct {
				Key    string `json:"key"`
				Prefix string `json:"prefix"`
				Size   int64  `json:"size"`
				SHA256 string `json:"sha256"`
			} `json:"file"`
		} `json:"encrypted"`
	}
	p.recv(&res)
	for i, size := range sizes {
		if d := res.Decrypted[i]; d.Size != size || d.SHA256 != sha256hex(plains[i]) {
			t.Errorf("Go->JS size %d: JS got %d bytes, sha %s", size, d.Size, d.SHA256)
		}
		e := res.Encrypted[i]
		blob, err := os.ReadFile(e.Path)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		k := e2ee.FileKeys{Key: e.File.Key, Prefix: e.File.Prefix, Size: e.File.Size, SHA256: e.File.SHA256}
		if err := e2ee.DecryptStream(&out, bytes.NewReader(blob), k); err != nil {
			t.Errorf("JS->Go size %d: %v", size, err)
			continue
		}
		if out.Len() != size || sha256hex(out.Bytes()) != e.SHA256 {
			t.Errorf("JS->Go size %d: got %d bytes", size, out.Len())
		}
	}
}

func devClient(t *testing.T, base, user string) *client.Client {
	t.Helper()
	c, err := client.New(client.Options{Server: base, DevUser: user})
	if err != nil {
		t.Fatal(err)
	}
	st, err := c.Register(context.Background(), "Go test device")
	if err != nil {
		t.Fatal(err)
	}
	if st.UserID != user+"@dev" {
		t.Fatalf("registered as %q", st.UserID)
	}
	return c
}

// A Go device and a crypto.js device chat through a real server in dev mode:
// text and a multi-chunk file each way, the realtime socket, and security codes.
func TestChatInteropWithCryptoJS(t *testing.T) {
	testserver.Node(t) // skip early without node
	srv := testserver.Start(t, "dev")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	gc := devClient(t, srv.URL, "gopher")

	p := startPeer(t, []string{"TAILCHAT_BASE=" + srv.URL, "GO_USER=gopher@dev", "JS_USER=jsuser"}, "chat")
	var reg struct {
		ChatID   string `json:"chatId"`
		DeviceID string `json:"deviceId"`
		UserID   string `json:"userId"`
	}
	p.recv(&reg)
	if reg.UserID != "jsuser@dev" {
		t.Fatalf("JS user %q", reg.UserID)
	}

	// Listen before the JS side sends, to see its message arrive live.
	events := make(chan *client.Event, 256)
	ready := make(chan struct{})
	lctx, lcancel := context.WithCancel(ctx)
	listenErr := make(chan error, 1)
	go func() {
		listenErr <- gc.Listen(lctx, func() { close(ready) }, func(ev *client.Event) error {
			events <- ev
			return nil
		})
	}()
	select {
	case <-ready:
	case err := <-listenErr:
		t.Fatalf("listen: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("websocket never became ready")
	}

	p.send("send")
	var sent struct {
		TextID        string `json:"textId"`
		FileMessageID string `json:"fileMessageId"`
		Text          string `json:"text"`
		FileSHA256    string `json:"fileSha256"`
		FileSize      int64  `json:"fileSize"`
		FileName      string `json:"fileName"`
		CodeGo        string `json:"codeGo"`
		CodeJS        string `json:"codeJs"`
	}
	p.recv(&sent)

	// JS -> Go, live over the WebSocket.
	var live *client.Event
	deadline := time.After(10 * time.Second)
	for live == nil {
		select {
		case ev := <-events:
			if ev.Type == "message" && ev.Message != nil && ev.Message.ID == sent.TextID {
				live = ev
			}
		case <-deadline:
			t.Fatal("JS text message never arrived over the WebSocket")
		}
	}
	d := gc.Decrypt(ctx, live.Message)
	if d.Err != nil || d.Content == nil || d.Content.Type != "text" || d.Content.Text != sent.Text {
		t.Fatalf("JS text decrypted in Go = %+v, %v", d.Content, d.Err)
	}
	if live.Message.SenderID != "jsuser@dev" || live.Message.ChatID != reg.ChatID {
		t.Fatalf("message metadata %+v", live.Message)
	}

	// JS -> Go file, found by id through history and streamed to disk.
	m, err := gc.FindMessage(ctx, sent.FileMessageID, "")
	if err != nil {
		t.Fatal(err)
	}
	fd := gc.Decrypt(ctx, m)
	if fd.Err != nil || fd.Content.File == nil || fd.Content.Kind != "document" || fd.Content.Caption != "js file" {
		t.Fatalf("JS file message = %+v, %v", fd.Content, fd.Err)
	}
	outDir := t.TempDir()
	dest, err := gc.DownloadTo(ctx, fd.Content.File, outDir, "fallback")
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(got)) != sent.FileSize || sha256hex(got) != sent.FileSHA256 || filepath.Base(dest) != sent.FileName {
		t.Fatalf("JS file in Go: %s, %d bytes (want %d, %s)", dest, len(got), sent.FileSize, sent.FileName)
	}
	if sent.FileSize <= e2ee.ChunkSize {
		t.Fatal("the JS file should span more than one chunk")
	}

	// Security codes agree.
	for user, want := range map[string]string{"gopher@dev": sent.CodeGo, "jsuser@dev": sent.CodeJS} {
		code, _, err := gc.SecurityCode(ctx, user)
		if err != nil || code != want {
			t.Errorf("security code for %s: Go %q, JS %q (%v)", user, code, want, err)
		}
	}

	// Go -> JS: text and a 2.5 MiB file with a ragged last chunk.
	goText := "héllo from Go 👋 <&> \"q\"  \nline two"
	tm, err := gc.SendText(ctx, reg.ChatID, goText)
	if err != nil {
		t.Fatal(err)
	}
	plain := make([]byte, 5*e2ee.ChunkSize/2+7)
	rand.Read(plain)
	src := filepath.Join(t.TempDir(), "from go.dat")
	if err := os.WriteFile(src, plain, 0o600); err != nil {
		t.Fatal(err)
	}
	fm, err := gc.SendFile(ctx, reg.ChatID, src, client.FileOptions{Caption: "go file", Mime: "application/x-test"})
	if err != nil {
		t.Fatal(err)
	}
	p.send(map[string]string{"textId": tm.ID, "fileMessageId": fm.ID})
	var opened struct {
		Text       string  `json:"text"`
		TextSender string  `json:"textSender"`
		FileSHA256 string  `json:"fileSha256"`
		FileSize   int     `json:"fileSize"`
		FileName   string  `json:"fileName"`
		FileMime   string  `json:"fileMime"`
		Kind       string  `json:"kind"`
		Caption    *string `json:"caption"`
	}
	p.recv(&opened)
	if opened.Text != goText || opened.TextSender != "gopher@dev" {
		t.Errorf("JS read Go text %q from %s", opened.Text, opened.TextSender)
	}
	if opened.FileSize != len(plain) || opened.FileSHA256 != sha256hex(plain) {
		t.Errorf("JS decrypted Go file: %d bytes, sha %s", opened.FileSize, opened.FileSHA256)
	}
	if opened.FileName != "from go.dat" || opened.FileMime != "application/x-test" || opened.Kind != "document" || opened.Caption == nil || *opened.Caption != "go file" {
		t.Errorf("JS saw file metadata %+v", opened)
	}

	// The Go device can read its own messages too (it wraps for itself).
	own, err := gc.FindMessage(ctx, tm.ID, reg.ChatID)
	if err != nil {
		t.Fatal(err)
	}
	if d := gc.Decrypt(ctx, own); d.Err != nil || d.Content.Text != goText {
		t.Fatalf("own message: %+v %v", d.Content, d.Err)
	}

	lcancel()
	select {
	case err := <-listenErr:
		if err != nil {
			t.Fatalf("listen returned %v after cancel", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listen did not stop")
	}
}
