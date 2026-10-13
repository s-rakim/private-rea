// Package testserver starts a real Tailchat server for tests.
//
// Which server runs is decided in one place, Command:
//
//  1. $TAILCHAT_SERVER_CMD, run with `sh -c` in the tailchat/ directory;
//  2. else the Python server (`python3 -m tailchat_server`) if
//     tailchat/tailchat_server/__main__.py exists;
//  3. else the Node server (`node server/index.js`).
//
// The server gets TAILCHAT_AUTH, TAILCHAT_HOST=127.0.0.1, TAILCHAT_PORT and
// TAILCHAT_DATA (a fresh temporary directory) in its environment.
package testserver

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"
)

// Root returns the tailchat/ directory (the one holding PROTOCOL.md).
func Root() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", ".."))
}

// Command returns the command that starts a Tailchat server, run in Root(),
// and a short description of it. The caller adds the TAILCHAT_* environment.
func Command(ctx context.Context) (*exec.Cmd, string, error) {
	root := Root()
	var cmd *exec.Cmd
	var desc string
	switch {
	case os.Getenv("TAILCHAT_SERVER_CMD") != "":
		line := os.Getenv("TAILCHAT_SERVER_CMD")
		cmd = exec.CommandContext(ctx, "sh", "-c", line)
		desc = "TAILCHAT_SERVER_CMD: " + line
	case fileExists(filepath.Join(root, "tailchat_server", "__main__.py")):
		py, err := exec.LookPath("python3")
		if err != nil {
			return nil, "", fmt.Errorf("tailchat_server needs python3: %w", err)
		}
		cmd = exec.CommandContext(ctx, py, "-m", "tailchat_server")
		desc = "python3 -m tailchat_server"
	case !fileExists(filepath.Join(root, "server", "index.js")):
		return nil, "", fmt.Errorf("no server found in %s (neither tailchat_server/__main__.py nor server/index.js); set TAILCHAT_SERVER_CMD", root)
	default:
		node, err := exec.LookPath("node")
		if err != nil {
			return nil, "", fmt.Errorf("the Node server needs node: %w", err)
		}
		if !fileExists(filepath.Join(root, "node_modules", "ws", "package.json")) {
			return nil, "", fmt.Errorf("run `npm install` in %s first", root)
		}
		cmd = exec.CommandContext(ctx, node, "--no-warnings=ExperimentalWarning", "server/index.js")
		desc = "node server/index.js"
	}
	cmd.Dir = root
	return cmd, desc, nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}

// Server is a running Tailchat server.
type Server struct {
	URL  string // http://127.0.0.1:<port>
	Port int
	Desc string
	cmd  *exec.Cmd
	logs *syncBuffer
	done chan struct{}
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Logs returns the server's output so far.
func (s *Server) Logs() string { return s.logs.String() }

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// Start runs a server in the given auth mode ("dev" or "serve") until the
// test ends. The test is skipped if no server runtime is installed.
func Start(t testing.TB, auth string) *Server {
	t.Helper()
	cmd, desc, err := Command(context.Background())
	if err != nil {
		t.Skipf("cannot start a Tailchat server: %v", err)
	}
	port, err := freePort()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{URL: "http://127.0.0.1:" + strconv.Itoa(port), Port: port, Desc: desc, cmd: cmd, logs: &syncBuffer{}, done: make(chan struct{})}
	cmd.Env = append(os.Environ(),
		"TAILCHAT_AUTH="+auth,
		"TAILCHAT_HOST=127.0.0.1",
		"TAILCHAT_PORT="+strconv.Itoa(port),
		"TAILCHAT_DATA="+t.TempDir(),
	)
	cmd.Stdout = s.logs
	cmd.Stderr = s.logs
	cmd.WaitDelay = 3 * time.Second
	setProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", desc, err)
	}
	go func() {
		cmd.Wait()
		close(s.done)
	}()
	t.Cleanup(func() {
		stopProcess(cmd, s.done)
		if t.Failed() {
			t.Logf("%s output:\n%s", desc, s.Logs())
		}
	})
	if err := s.waitReady(30 * time.Second); err != nil {
		t.Fatalf("%s (auth=%s) did not start: %v\n%s", desc, auth, err, s.Logs())
	}
	return s
}

// waitReady polls until the server answers HTTP at all (an unauthenticated
// /api/me is a 401).
func (s *Server) waitReady(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	hc := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-s.done:
			return fmt.Errorf("server exited: %v", s.cmd.ProcessState)
		default:
		}
		res, err := hc.Get(s.URL + "/api/me")
		if err == nil {
			res.Body.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("no answer on %s after %v", s.URL, timeout)
}

// Node returns the node binary and the URL of public/crypto.js, for interop
// tests against the reference crypto; the test is skipped without them.
func Node(t testing.TB) (node, cryptoURL string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed: skipping interop with public/crypto.js")
	}
	p := filepath.Join(Root(), "public", "crypto.js")
	if !fileExists(p) {
		t.Skipf("%s not found", p)
	}
	return node, "file://" + filepath.ToSlash(p)
}
