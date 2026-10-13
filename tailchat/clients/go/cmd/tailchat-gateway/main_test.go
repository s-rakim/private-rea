package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/gateway"
)

func TestParseFlags(t *testing.T) {
	cfg, err := parseFlags(nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.hostname != "tailchat" || cfg.upstream.String() != "http://127.0.0.1:8443" || !cfg.redirectHTTP {
		t.Fatalf("defaults: %+v", cfg)
	}
	if _, err := parseFlags([]string{"--funnel=false", "--hostname", "chat", "--upstream", "http://127.0.0.1:9000"}, io.Discard); err != nil {
		t.Fatalf("--funnel=false refused: %v", err)
	}
	for _, args := range [][]string{{"--funnel"}, {"--funnel=true"}, {"-funnel=1"}} {
		if _, err := parseFlags(args, io.Discard); !errors.Is(err, errFunnel) {
			t.Errorf("%v: err = %v, want the Funnel refusal", args, err)
		}
	}
	for _, args := range [][]string{{"--upstream", "ftp://x"}, {"--upstream", "127.0.0.1:8443"}, {"extra"}, {"--hostname", ""}} {
		if _, err := parseFlags(args, io.Discard); err == nil {
			t.Errorf("%v accepted", args)
		}
	}
}

// fakeLocalAPI answers /localapi/v0/whois like tailscaled/tsnet would.
type fakeLocalAPI map[string]*apitype.WhoIsResponse

func (f fakeLocalAPI) RoundTrip(r *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	if r.URL.Path != "/localapi/v0/whois" {
		http.NotFound(rec, r)
	} else if res, ok := f[r.URL.Query().Get("addr")]; ok {
		json.NewEncoder(rec).Encode(res)
	} else {
		http.Error(rec, "no match for IP:port", http.StatusNotFound)
	}
	return rec.Result(), nil
}

func TestWhoIsAdapter(t *testing.T) {
	lc := &local.Client{Transport: fakeLocalAPI{
		"100.64.0.1:40000": {
			Node:        &tailcfg.Node{Name: "laptop.example.ts.net."},
			UserProfile: &tailcfg.UserProfile{LoginName: "alice@example.com", DisplayName: "Zoë", ProfilePicURL: "https://example.com/a.png"},
		},
		"100.64.0.2:40000": {
			Node:        &tailcfg.Node{Name: "ci.example.ts.net.", Tags: []string{"tag:ci"}},
			UserProfile: &tailcfg.UserProfile{LoginName: "tagged-devices", DisplayName: "tagged-devices"},
		},
	}, OmitAuth: true}
	whois := whoIs(lc)
	ctx := context.Background()

	id, err := whois(ctx, "100.64.0.1:40000")
	if err != nil {
		t.Fatal(err)
	}
	want := gateway.Identity{LoginName: "alice@example.com", DisplayName: "Zoë", ProfilePicURL: "https://example.com/a.png"}
	if *id != want || gateway.CheckIdentity(id) != nil {
		t.Fatalf("user node: %+v", id)
	}
	id, err = whois(ctx, "100.64.0.2:40000")
	if err != nil || !id.Tagged || gateway.CheckIdentity(id) == nil {
		t.Fatalf("tagged node: %+v %v", id, err)
	}
	if _, err := whois(ctx, "100.64.0.9:1"); !errors.Is(err, local.ErrPeerNotFound) {
		t.Fatalf("unknown peer: %v", err)
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for h, want := range map[string]bool{"127.0.0.1": true, "::1": true, "localhost": true, "100.64.0.1": false, "example.com": false} {
		if got := isLoopbackHost(h); got != want {
			t.Errorf("isLoopbackHost(%q) = %v", h, got)
		}
	}
	if !strings.Contains(errFunnel.Error(), "tailnet") {
		t.Fatal("funnel refusal should explain why")
	}
}
