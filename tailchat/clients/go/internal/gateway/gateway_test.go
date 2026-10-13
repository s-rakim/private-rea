package gateway_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/gateway"
)

func TestEncodeHeaderValue(t *testing.T) {
	for in, want := range map[string]string{
		"Alice Example": "Alice Example",
		"Zoë Ünicode":   "=?utf-8?q?Zo=C3=AB_=C3=9Cnicode?=",
		"日本":            "=?utf-8?q?=E6=97=A5=E6=9C=AC?=",
		"bad \xff utf8": "",
		"":              "",
	} {
		if got := gateway.EncodeHeaderValue(in); got != want {
			t.Errorf("EncodeHeaderValue(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStripIdentityHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Tailscale-User-Login", "mallory@example.com")
	h["tailscale-user-name"] = []string{"Mallory"} // not canonicalised
	h["TAILSCALE-USER-PROFILE-PIC"] = []string{"x"}
	h.Set("Tailscale-Funnel-Request", "?1")
	h.Set("X-Dev-User", "mallory")
	h.Add("Cookie", "a=1; tailchat_dev_user=mallory; b=2")
	h.Add("Cookie", "TAILCHAT_DEV_USER=eve")
	h.Set("Authorization", "Bearer keep")
	h.Set("X-Tailscale-Thing", "keep") // only the Tailscale- prefix is reserved
	gateway.StripIdentityHeaders(h)
	want := http.Header{
		"Cookie":            {"a=1; b=2"},
		"Authorization":     {"Bearer keep"},
		"X-Tailscale-Thing": {"keep"},
	}
	if len(h) != len(want) {
		t.Fatalf("headers left: %v", h)
	}
	for k, v := range want {
		if strings.Join(h[k], "|") != strings.Join(v, "|") {
			t.Fatalf("%s = %v, want %v (all: %v)", k, h[k], v, h)
		}
	}
	only := http.Header{"Cookie": {"tailchat_dev_user=x"}}
	gateway.StripIdentityHeaders(only)
	if len(only) != 0 {
		t.Fatalf("cookie header should be gone: %v", only)
	}
}

func TestCheckIdentity(t *testing.T) {
	for _, c := range []struct {
		id *gateway.Identity
		ok bool
	}{
		{nil, false},
		{alice, true},
		{robot, false},
		{&gateway.Identity{LoginName: "carol@example.com", Tagged: true}, false},
		{&gateway.Identity{LoginName: ""}, false},
	} {
		if err := gateway.CheckIdentity(c.id); (err == nil) != c.ok {
			t.Errorf("CheckIdentity(%+v) = %v", c.id, err)
		}
	}
}

// seen is what the fake upstream reports back.
type seen struct {
	Method, Path, Query, Host, Body string
	Header                          http.Header
}

func fakeUpstream(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/ws" {
			login := r.Header.Get(gateway.HeaderLogin)
			forged := r.Header.Get("X-Dev-User")
			c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			defer c.CloseNow()
			ctx := r.Context()
			c.Write(ctx, websocket.MessageText, []byte("hello "+login+" forged="+forged))
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					return
				}
				c.Write(ctx, websocket.MessageText, append([]byte("echo: "), data...))
			}
		}
		body, _ := io.ReadAll(r.Body)
		json.NewEncoder(w).Encode(seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Host, string(body), r.Header})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newGateway(t *testing.T, upstream string, tn *fakeTailnet) *httptest.Server {
	t.Helper()
	u, _ := url.Parse(upstream)
	h, err := gateway.New(gateway.Options{Upstream: u, WhoIs: tn.WhoIs, Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	gw := httptest.NewServer(h)
	t.Cleanup(gw.Close)
	return gw
}

func TestProxySetsIdentityAndStripsForgeries(t *testing.T) {
	var hits atomic.Int32
	up := fakeUpstream(t, &hits)
	tn := newFakeTailnet()
	gw := newGateway(t, up.URL, tn)

	req, _ := http.NewRequest("POST", gw.URL+"/api/chats/x/messages?limit=5&after=2", strings.NewReader(`{"payload":"p"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Tailscale-User-Login", "mallory@example.com")
	req.Header.Set("Tailscale-User-Name", "Mallory")
	req.Header.Set("Tailscale-User-Profile-Pic", "https://evil.example/m.png")
	req.Header.Set("X-Dev-User", "mallory")
	req.Header.Set("Cookie", "tailchat_dev_user=mallory; theme=dark")
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	req.Header.Set("Authorization", "Bearer token")
	res, err := tn.client(alice).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got seen
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	gwHost := strings.TrimPrefix(gw.URL, "http://")
	checks := map[string][2]string{
		"method":            {got.Method, "POST"},
		"path":              {got.Path, "/api/chats/x/messages"},
		"query":             {got.Query, "limit=5&after=2"},
		"host (preserved)":  {got.Host, gwHost},
		"body":              {got.Body, `{"payload":"p"}`},
		"login":             {got.Header.Get(gateway.HeaderLogin), "alice@example.com"},
		"name (RFC 2047)":   {got.Header.Get(gateway.HeaderName), "=?utf-8?q?Zo=C3=AB_=C3=9Cnicode?="},
		"profile pic":       {got.Header.Get(gateway.HeaderProfilePic), "https://example.com/alice.png"},
		"dev header":        {got.Header.Get("X-Dev-User"), ""},
		"cookie":            {got.Header.Get("Cookie"), "theme=dark"},
		"authorization":     {got.Header.Get("Authorization"), "Bearer token"},
		"x-forwarded-for":   {got.Header.Get("X-Forwarded-For"), "127.0.0.1"},
		"x-forwarded-proto": {got.Header.Get("X-Forwarded-Proto"), "http"},
	}
	for name, c := range checks {
		if c[0] != c[1] {
			t.Errorf("%s = %q, want %q", name, c[0], c[1])
		}
	}
	if v := got.Header.Values(gateway.HeaderLogin); len(v) != 1 {
		t.Errorf("login header values %v", v)
	}

	// A user without a profile picture gets no picture header, even a forged one.
	req, _ = http.NewRequest("GET", gw.URL+"/", nil)
	req.Header.Set("Tailscale-User-Profile-Pic", "https://evil.example/m.png")
	res, err = tn.client(bob).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got = seen{}
	json.NewDecoder(res.Body).Decode(&got)
	res.Body.Close()
	if got.Header.Get(gateway.HeaderLogin) != "bob@example.com" || got.Header.Get(gateway.HeaderName) != "Bob" {
		t.Errorf("bob headers %v", got.Header)
	}
	if _, ok := got.Header[gateway.HeaderProfilePic]; ok {
		t.Errorf("forged profile pic passed through: %v", got.Header)
	}
}

func TestProxyRefusesTaggedAndUnknownPeers(t *testing.T) {
	var hits atomic.Int32
	up := fakeUpstream(t, &hits)
	tn := newFakeTailnet()
	gw := newGateway(t, up.URL, tn)
	for name, id := range map[string]*gateway.Identity{"tagged": robot, "unknown": nil} {
		req, _ := http.NewRequest("GET", gw.URL+"/api/me", nil)
		req.Header.Set("Tailscale-User-Login", "alice@example.com")
		res, err := tn.client(id).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden || !strings.Contains(string(body), `"error"`) {
			t.Errorf("%s: status %d %s", name, res.StatusCode, body)
		}
	}
	// A WebSocket upgrade from a tagged node is refused too.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(gw.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: tn.client(robot)})
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Errorf("tagged websocket: %v %v", err, res)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("upstream was reached %d times", n)
	}
}

func TestProxyWebSocketPassthrough(t *testing.T) {
	var hits atomic.Int32
	up := fakeUpstream(t, &hits)
	tn := newFakeTailnet()
	gw := newGateway(t, up.URL, tn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := http.Header{}
	h.Set("Tailscale-User-Login", "mallory@example.com")
	h.Set("X-Dev-User", "mallory")
	c, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(gw.URL, "http")+"/ws", &websocket.DialOptions{HTTPClient: tn.client(alice), HTTPHeader: h})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d", res.StatusCode)
	}
	_, hello, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(hello) != "hello alice@example.com forged=" {
		t.Fatalf("upstream saw %q", hello)
	}
	for _, msg := range []string{"one", strings.Repeat("x", 20000)} {
		if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
		_, echo, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if string(echo) != "echo: "+msg {
			t.Fatalf("echo = %.40q", echo)
		}
	}
	c.Close(websocket.StatusNormalClosure, "")
}

func TestProxyUpstreamDown(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	tn := newFakeTailnet()
	gw := newGateway(t, "http://"+addr, tn)
	res, err := tn.client(alice).Get(gw.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestNewValidates(t *testing.T) {
	tn := newFakeTailnet()
	for _, u := range []string{"", "ftp://x", "http://"} {
		pu, _ := url.Parse(u)
		if _, err := gateway.New(gateway.Options{Upstream: pu, WhoIs: tn.WhoIs}); err == nil {
			t.Errorf("upstream %q accepted", u)
		}
	}
	u, _ := url.Parse("http://127.0.0.1:1")
	if _, err := gateway.New(gateway.Options{Upstream: u}); err == nil {
		t.Error("missing WhoIs accepted")
	}
}

func TestCheckUpstream(t *testing.T) {
	ctx := context.Background()
	dev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dev/login" {
			w.Write([]byte("<h1>dev login</h1>"))
			return
		}
		http.NotFound(w, r)
	}))
	defer dev.Close()
	serve := httptest.NewServer(http.NotFoundHandler())
	defer serve.Close()
	du, _ := url.Parse(dev.URL)
	su, _ := url.Parse(serve.URL)
	if err := gateway.CheckUpstream(ctx, du, nil); err == nil {
		t.Error("dev-mode upstream accepted")
	}
	if err := gateway.CheckUpstream(ctx, su, nil); err != nil {
		t.Errorf("serve-mode upstream refused: %v", err)
	}
	down, _ := url.Parse("http://127.0.0.1:1")
	if err := gateway.CheckUpstream(ctx, down, nil); err != nil {
		t.Errorf("unreachable upstream should only be a warning: %v", err)
	}
}
