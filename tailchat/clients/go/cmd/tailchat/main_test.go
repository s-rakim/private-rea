package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/testserver"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type cli struct {
	t      *testing.T
	server string
	user   string
	state  string
}

func (c cli) run(ctx context.Context, args ...string) (int, string, string) {
	c.t.Helper()
	var out, errb syncBuf
	full := append([]string{"--server", c.server, "--dev-user", c.user, "--state", c.state}, args...)
	code := run(ctx, full, &out, &errb)
	return code, out.String(), errb.String()
}

func (c cli) ok(args ...string) string {
	c.t.Helper()
	code, out, errs := c.run(context.Background(), args...)
	if code != 0 {
		c.t.Fatalf("tailchat %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), code, out, errs)
	}
	return out
}

func TestCLIAgainstDevServer(t *testing.T) {
	srv := testserver.Start(t, "dev")
	dir := t.TempDir()
	alice := cli{t, srv.URL, "alice", filepath.Join(dir, "state", "alice.json")}
	bob := cli{t, srv.URL, "bob", filepath.Join(dir, "state", "bob.json")}

	// First use registers the device and saves its keys with mode 0600.
	code, out, errs := alice.run(context.Background(), "whoami")
	if code != 0 || !strings.Contains(out, "alice@dev") || !strings.Contains(errs, "Registered this device") {
		t.Fatalf("whoami: %d %s %s", code, out, errs)
	}
	info, err := os.Stat(alice.state)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", info.Mode(), err)
	}
	if out2 := alice.ok("whoami"); !strings.Contains(out2, "auth: dev") {
		t.Fatalf("second whoami: %s", out2)
	}
	bob.ok("whoami")

	if out := alice.ok("send", "bob@dev", "hello bob", "--not-a-flag"); !regexp.MustCompile(`^sent \S+ to bob@dev\n$`).MatchString(out) {
		t.Fatalf("send: %q", out)
	}
	if out := bob.ok("chats"); !strings.Contains(out, "alice@dev") || !strings.Contains(out, "hello bob --not-a-flag") || !strings.Contains(out, "(1 unread)") {
		t.Fatalf("chats: %s", out)
	}
	if out := bob.ok("history", "alice@dev"); !strings.Contains(out, "alice@dev: hello bob --not-a-flag") {
		t.Fatalf("history: %s", out)
	}

	// Text from other people can't drive the terminal.
	alice.ok("send", "bob@dev", "\x1b[2Jboom‮")
	if out := bob.ok("history", "--limit", "1", "alice@dev"); strings.ContainsAny(out, "\x1b‮") || !strings.Contains(out, "�[2Jboom") {
		t.Fatalf("escape sequence reached the terminal: %q", out)
	}

	// A file spanning two chunks, streamed up, then down into a directory.
	plain := make([]byte, 1<<20+4096)
	rand.Read(plain)
	src := filepath.Join(dir, "report.pdf")
	os.WriteFile(src, plain, 0o600)
	out = alice.ok("send-file", "--caption", "the report", "bob@dev", src)
	m := regexp.MustCompile(`^sent report\.pdf \(1\.0 MiB\) to bob@dev as (\S+)\n$`).FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("send-file: %q", out)
	}
	fileMsg := m[1]
	if out := bob.ok("history", "alice@dev"); !strings.Contains(out, "[document] report.pdf (1.0 MiB): the report  [tailchat download "+fileMsg+" DIR]") {
		t.Fatalf("history with file: %s", out)
	}
	outDir := filepath.Join(dir, "downloads")
	for _, want := range []string{"report.pdf", "report (1).pdf"} {
		out := bob.ok("download", fileMsg, outDir)
		if !strings.HasPrefix(out, filepath.Join(outDir, want)+" (1.0 MiB, checksum ok)") {
			t.Fatalf("download: %q, want %s", out, want)
		}
		got, _ := os.ReadFile(filepath.Join(outDir, want))
		if !bytes.Equal(got, plain) {
			t.Fatalf("%s differs from what was sent", want)
		}
	}
	// The sender can download its own file too.
	alice.ok("download", "--chat", "bob@dev", fileMsg, filepath.Join(dir, "alice-dl"))

	if out := alice.ok("code", "bob@dev"); !regexp.MustCompile(`(?m)^(\d{5} ){11}\d{5}$`).MatchString(out) {
		t.Fatalf("code: %s", out)
	}

	// listen prints messages as they arrive and stops cleanly.
	ctx, cancel := context.WithCancel(context.Background())
	var lout, lerr syncBuf
	done := make(chan int, 1)
	go func() {
		done <- run(ctx, []string{"--server", srv.URL, "--dev-user", "bob", "--state", bob.state, "listen"}, &lout, &lerr)
	}()
	waitFor(t, func() bool { return strings.Contains(lerr.String(), "Listening as bob@dev") }, "listen to connect: "+lerr.String())
	alice.ok("send", "bob@dev", "live", "message")
	waitFor(t, func() bool {
		return strings.Contains(lout.String(), "[alice@dev] ") && strings.Contains(lout.String(), "alice@dev: live message")
	}, "live message: "+lout.String())
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("listen exit %d: %s", code, lerr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listen did not stop")
	}
}

func TestCLIErrors(t *testing.T) {
	srv := testserver.Start(t, "dev")
	dir := t.TempDir()
	alice := cli{t, srv.URL, "alice", filepath.Join(dir, "alice.json")}
	alice.ok("whoami")
	ctx := context.Background()

	for _, args := range [][]string{{"frobnicate"}, {"send", "bob@dev"}, {"history"}, {"download", "x"}} {
		if code, _, _ := alice.run(ctx, args...); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
	if code, _, errs := (cli{t, srv.URL, "eve", alice.state}).run(ctx, "whoami"); code != 1 || !strings.Contains(errs, "belongs to") {
		t.Errorf("someone else's state file: %d %s", code, errs)
	}
	if code, _, errs := alice.run(ctx, "send", "nobody-here", "hi"); code != 1 || !strings.Contains(errs, "no chat") {
		t.Errorf("unknown chat: %d %s", code, errs)
	}
	if code, _, errs := alice.run(ctx, "download", "AAAAAAAAAAAAAAAAAAAAAA", dir); code != 1 || errs == "" {
		t.Errorf("unknown message: %d %s", code, errs)
	}
	os.Chmod(alice.state, 0o644)
	if code, _, errs := alice.run(ctx, "whoami"); code != 1 || !strings.Contains(errs, "chmod 600") {
		t.Errorf("world-readable state: %d %s", code, errs)
	}
	var out, errb syncBuf
	if code := run(ctx, []string{"whoami"}, &out, &errb); code != 2 && os.Getenv("TAILCHAT_SERVER") == "" {
		t.Errorf("no --server: exit %d", code)
	}
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
