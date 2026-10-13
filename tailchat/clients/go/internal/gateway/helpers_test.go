package gateway_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/gateway"
)

// fakeTailnet stands in for tsnet's WhoIs: each test client dials through a
// transport that records which identity owns its local address, so the
// gateway sees distinct "peers" by RemoteAddr, as it would on a tailnet.
type fakeTailnet struct {
	mu     sync.Mutex
	byAddr map[string]*gateway.Identity
	calls  int
}

func newFakeTailnet() *fakeTailnet { return &fakeTailnet{byAddr: map[string]*gateway.Identity{}} }

func (f *fakeTailnet) WhoIs(_ context.Context, remoteAddr string) (*gateway.Identity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if id := f.byAddr[remoteAddr]; id != nil {
		return id, nil
	}
	return nil, errors.New("no peer with that address")
}

// client returns an HTTP client whose connections belong to id (nil: an
// address the tailnet does not know).
func (f *fakeTailnet) client(id *gateway.Identity) *http.Client {
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			if id != nil {
				f.mu.Lock()
				f.byAddr[conn.LocalAddr().String()] = id
				f.mu.Unlock()
			}
			return conn, nil
		},
	}
	return &http.Client{Transport: tr}
}

var (
	alice = &gateway.Identity{LoginName: "alice@example.com", DisplayName: "Zoë Ünicode", ProfilePicURL: "https://example.com/alice.png"}
	bob   = &gateway.Identity{LoginName: "bob@example.com", DisplayName: "Bob"}
	robot = &gateway.Identity{LoginName: "tagged-devices", DisplayName: "tagged-devices", Tagged: true}
)
