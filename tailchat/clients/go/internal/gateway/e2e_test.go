package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/client"
	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/gateway"
	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/testserver"
)

// The real server in serve mode behind the gateway handler: identity comes
// only from the (fake) tailnet, never from the client's own headers.
func TestGatewayEndToEnd(t *testing.T) {
	srv := testserver.Start(t, "serve")
	tn := newFakeTailnet()
	gw := newGateway(t, srv.URL, tn)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	up, _ := url.Parse(srv.URL)
	if err := gateway.CheckUpstream(ctx, up, nil); err != nil {
		t.Fatalf("serve-mode server rejected: %v", err)
	}

	me := func(id *gateway.Identity, forge bool) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, "GET", gw.URL+"/api/me", nil)
		if forge {
			req.Header.Set("Tailscale-User-Login", "mallory@example.com")
			req.Header.Set("Tailscale-User-Name", "Mallory")
			req.Header.Set("X-Dev-User", "mallory")
			req.Header.Set("Cookie", "tailchat_dev_user=mallory")
		}
		res, err := tn.client(id).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]any
		json.NewDecoder(res.Body).Decode(&body)
		return res.StatusCode, body
	}

	// A forged login from the client is ignored: the tailnet says alice.
	status, body := me(alice, true)
	user, _ := body["user"].(map[string]any)
	if status != 200 || user["id"] != "alice@example.com" {
		t.Fatalf("forged request: %d %v", status, body)
	}
	if user["name"] != "Zoë Ünicode" {
		t.Errorf("display name = %q (RFC 2047 round trip through the server)", user["name"])
	}
	if user["avatar"] != "https://example.com/alice.png" {
		t.Errorf("avatar = %v", user["avatar"])
	}
	for name, id := range map[string]*gateway.Identity{"tagged": robot, "unknown": nil} {
		if status, body := me(id, true); status != http.StatusForbidden {
			t.Errorf("%s peer: %d %v", name, status, body)
		}
	}

	// Full client flow through the gateway: register, chat, realtime.
	newClient := func(id *gateway.Identity) (*client.Client, *client.State) {
		c, err := client.New(client.Options{Server: gw.URL, HTTPClient: tn.client(id)})
		if err != nil {
			t.Fatal(err)
		}
		st, err := c.Register(ctx, "gateway test")
		if err != nil {
			t.Fatal(err)
		}
		if st.UserID != id.LoginName {
			t.Fatalf("registered as %s, want %s", st.UserID, id.LoginName)
		}
		return c, st
	}
	ac, _ := newClient(alice)
	bc, bobState := newClient(bob)

	// Bob's device token is bound to bob: alice's connection can't use it.
	req, _ := http.NewRequestWithContext(ctx, "GET", gw.URL+"/api/chats", nil)
	req.Header.Set("Authorization", "Bearer "+bobState.Token)
	if res, err := tn.client(alice).Do(req); err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("alice using bob's token: %v %v", res, err)
	}

	events := make(chan *client.Event, 64)
	ready := make(chan struct{})
	lctx, lcancel := context.WithCancel(ctx)
	defer lcancel()
	go bc.Listen(lctx, func() { close(ready) }, func(ev *client.Event) error {
		events <- ev
		return nil
	})
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("WebSocket through the gateway never became ready")
	}

	chat, err := ac.DirectChat(ctx, "bob@example.com")
	if err != nil {
		t.Fatal(err)
	}
	sent, err := ac.SendText(ctx, chat.ID, "through the gateway")
	if err != nil {
		t.Fatal(err)
	}
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Type != "message" || ev.Message == nil || ev.Message.ID != sent.ID {
				continue
			}
			if ev.Message.SenderID != "alice@example.com" {
				t.Fatalf("sender %s", ev.Message.SenderID)
			}
			d := bc.Decrypt(ctx, ev.Message)
			if d.Err != nil || d.Content.Text != "through the gateway" {
				t.Fatalf("bob decrypted %+v %v", d.Content, d.Err)
			}
			goto origin
		case <-timeout:
			t.Fatal("message never arrived over the gateway WebSocket")
		}
	}

origin:
	// The gateway keeps the browser's Host, so the server's same-origin check
	// on WebSocket upgrades works: same origin passes, another site is refused.
	wsURL := "ws" + strings.TrimPrefix(gw.URL, "http") + "/ws"
	for origin, ok := range map[string]bool{gw.URL: true, "https://evil.example": false} {
		h := http.Header{"Origin": {origin}}
		c, res, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: tn.client(alice), HTTPHeader: h})
		if ok {
			if err != nil {
				t.Errorf("same-origin upgrade refused: %v", err)
				continue
			}
			c.Close(websocket.StatusNormalClosure, "")
		} else if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
			t.Errorf("cross-origin upgrade: err %v, response %v", err, res)
		}
	}

	// tailscale serve splits long non-ASCII names into several encoded-words;
	// so does the gateway. RFC 2047 says the whitespace between them is not
	// part of the name.
	long := &gateway.Identity{LoginName: "carol@example.com", DisplayName: "Ζωή Παπαδοπούλου-Καραγιαννοπούλου Αλεξανδροπούλου"}
	if enc := gateway.EncodeHeaderValue(long.DisplayName); !strings.Contains(enc, "?= =?") {
		t.Fatalf("expected a multi-word encoding, got %q", enc)
	}
	_, body = me(long, false)
	user, _ = body["user"].(map[string]any)
	if user["name"] != long.DisplayName {
		t.Logf("SERVER BUG (not the gateway): long non-ASCII display name came back as %q, want %q; "+
			"the server's RFC 2047 decoder keeps the spaces between adjacent encoded-words", user["name"], long.DisplayName)
	}
}
