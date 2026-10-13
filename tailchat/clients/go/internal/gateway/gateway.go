// Package gateway is the part of tailchat-gateway that does not need a
// tailnet: it turns "who is this tailnet peer" into the Tailscale-User-*
// headers a Tailchat server in `serve` mode trusts, exactly as
// `tailscale serve` does, and reverse-proxies HTTP and WebSocket traffic to
// the server on loopback.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// Identity is what the tailnet knows about the owner of a connection.
type Identity struct {
	LoginName     string // alice@example.com
	DisplayName   string // Alice Example
	ProfilePicURL string
	// Tagged nodes (servers, CI runners) have no user identity.
	Tagged bool
}

// WhoIsFunc reports who owns the tailnet address remoteAddr ("ip:port", as in
// http.Request.RemoteAddr). It returns an error for addresses that are not a
// known peer. In tailchat-gateway this is tsnet's LocalClient.WhoIs.
type WhoIsFunc func(ctx context.Context, remoteAddr string) (*Identity, error)

// Headers set by `tailscale serve`; any copy sent by a client is removed.
const (
	HeaderLogin       = "Tailscale-User-Login"
	HeaderName        = "Tailscale-User-Name"
	HeaderProfilePic  = "Tailscale-User-Profile-Pic"
	HeaderHeadersInfo = "Tailscale-Headers-Info"
)

// DevCookie and DevHeader select a user on a dev-mode server. They are
// stripped too, so a misconfigured upstream can't be talked into trusting them.
const (
	DevCookie = "tailchat_dev_user"
	DevHeader = "X-Dev-User"
)

// EncodeHeaderValue encodes v the way tailscale serve does: unchanged when it
// is printable ASCII, RFC 2047 Q-encoded UTF-8 otherwise, and empty when it is
// not valid UTF-8.
func EncodeHeaderValue(v string) string {
	if !utf8.ValidString(v) {
		return ""
	}
	return mime.QEncoding.Encode("utf-8", v)
}

// StripIdentityHeaders removes every header a client could use to claim an
// identity: all Tailscale-* headers (any case), X-Dev-User and the dev-mode
// cookie.
func StripIdentityHeaders(h http.Header) {
	for k := range h {
		if strings.HasPrefix(strings.ToLower(k), "tailscale-") || strings.EqualFold(k, DevHeader) {
			delete(h, k)
		}
	}
	cookies := h.Values("Cookie")
	if len(cookies) == 0 {
		return
	}
	var kept []string
	for _, line := range cookies {
		for _, part := range strings.Split(line, ";") {
			name, _, _ := strings.Cut(strings.TrimSpace(part), "=")
			if strings.TrimSpace(part) == "" || strings.EqualFold(strings.TrimSpace(name), DevCookie) {
				continue
			}
			kept = append(kept, strings.TrimSpace(part))
		}
	}
	h.Del("Cookie")
	if len(kept) > 0 {
		h.Set("Cookie", strings.Join(kept, "; "))
	}
}

// CheckIdentity returns an error when id can't use Tailchat: unknown, tagged,
// or without a login name.
func CheckIdentity(id *Identity) error {
	switch {
	case id == nil:
		return errors.New("unknown tailnet peer")
	case id.Tagged || id.LoginName == "tagged-devices":
		return errors.New("tagged devices have no user identity, so they cannot use Tailchat")
	case id.LoginName == "" || !utf8.ValidString(id.LoginName):
		return errors.New("this tailnet peer has no user login")
	}
	return nil
}

// SetIdentityHeaders writes the identity headers as tailscale serve does.
func SetIdentityHeaders(h http.Header, id *Identity) {
	h.Set(HeaderLogin, EncodeHeaderValue(id.LoginName))
	h.Set(HeaderName, EncodeHeaderValue(id.DisplayName))
	if pic := id.ProfilePicURL; validHeaderValue(pic) {
		h.Set(HeaderProfilePic, pic)
	} else {
		h.Del(HeaderProfilePic)
	}
	h.Set(HeaderHeadersInfo, "https://tailscale.com/s/serve-headers")
}

// validHeaderValue accepts printable ASCII (and tabs) only.
func validHeaderValue(v string) bool {
	if v == "" {
		return false
	}
	for i := 0; i < len(v); i++ {
		if b := v[i]; (b < 0x20 && b != '\t') || b >= 0x7f {
			return false
		}
	}
	return true
}

// Options configure the proxy.
type Options struct {
	// Upstream is the Tailchat server in serve mode, e.g. http://127.0.0.1:8443.
	Upstream *url.URL
	// WhoIs identifies the peer behind each request.
	WhoIs WhoIsFunc
	// Transport defaults to a direct (no proxy) clone of http.DefaultTransport.
	Transport http.RoundTripper
	// Logf defaults to discarding.
	Logf func(format string, args ...any)
}

type identityKey struct{}

// New returns the handler: it identifies each request's peer, refuses
// unknown peers and tagged nodes with 403, and proxies everything else
// (WebSocket upgrades included) with the identity headers set.
func New(opts Options) (http.Handler, error) {
	if opts.Upstream == nil || (opts.Upstream.Scheme != "http" && opts.Upstream.Scheme != "https") || opts.Upstream.Host == "" {
		return nil, errors.New("gateway: upstream must be an http(s) URL")
	}
	if opts.WhoIs == nil {
		return nil, errors.New("gateway: WhoIs is required")
	}
	logf := opts.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	transport := opts.Transport
	if transport == nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.Proxy = nil
		transport = tr
	}
	upstream := opts.Upstream
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			// Keep the browser's Host: the server compares it with Origin
			// on WebSocket upgrades. tailscale serve does the same.
			pr.Out.Host = pr.In.Host
			pr.SetXForwarded()
			StripIdentityHeaders(pr.Out.Header)
			if id, ok := pr.In.Context().Value(identityKey{}).(*Identity); ok {
				SetIdentityHeaders(pr.Out.Header, id)
			}
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if !errors.Is(err, context.Canceled) {
				logf("proxy %s %s: %v", r.Method, r.URL.Path, err)
			}
			writeError(w, http.StatusBadGateway, "Tailchat server is not reachable")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		id, err := opts.WhoIs(ctx, r.RemoteAddr)
		cancel()
		if err == nil {
			err = CheckIdentity(id)
		}
		if err != nil {
			logf("refused %s %s from %s: %v", r.Method, r.URL.Path, r.RemoteAddr, err)
			writeError(w, http.StatusForbidden, "Tailchat is only for people on this tailnet: "+err.Error())
			return
		}
		rp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, id)))
	}), nil
}

func writeError(w http.ResponseWriter, status int, msg string) {
	body, _ := json.Marshal(map[string]string{"error": msg})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}

// CheckUpstream refuses an upstream that runs in dev mode, where anyone could
// pick any identity: only dev mode serves /dev/login. Unreachable upstreams
// are not an error (the server may start after the gateway).
func CheckUpstream(ctx context.Context, upstream *url.URL, rt http.RoundTripper) error {
	if rt == nil {
		rt = http.DefaultTransport
	}
	u := upstream.JoinPath("/dev/login")
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return err
	}
	res, err := (&http.Client{Transport: rt, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}).Do(req)
	if err != nil {
		return nil
	}
	res.Body.Close()
	if res.StatusCode == http.StatusOK {
		return fmt.Errorf("the Tailchat server at %s is in dev mode (TAILCHAT_AUTH=dev); the gateway needs TAILCHAT_AUTH=serve", upstream)
	}
	return nil
}
