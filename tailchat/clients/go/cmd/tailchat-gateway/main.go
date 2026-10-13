// Command tailchat-gateway puts a Tailchat server on your tailnet without
// installing tailscaled: it joins the tailnet itself (tsnet), serves HTTPS on
// :443 with the node's *.ts.net certificate, and reverse-proxies to the
// Tailchat server on loopback (TAILCHAT_AUTH=serve), adding the same
// Tailscale-User-* identity headers `tailscale serve` would.
//
// It never enables Funnel: Tailchat must only be reachable from the tailnet.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/gateway"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("tailchat-gateway: ")
	cfg, err := parseFlags(os.Args[1:], os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(0)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "tailchat-gateway: %v\n", err)
		os.Exit(2)
	}
	if err := run(cfg); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

type config struct {
	hostname     string
	stateDir     string
	upstream     *url.URL
	redirectHTTP bool
	verbose      bool
}

var errFunnel = errors.New("refusing --funnel: Tailchat must only be reachable from your tailnet, so the gateway never enables Tailscale Funnel")

func parseFlags(args []string, output io.Writer) (*config, error) {
	fs := flag.NewFlagSet("tailchat-gateway", flag.ContinueOnError)
	fs.SetOutput(output)
	cfg := &config{}
	var upstream string
	var funnel bool
	fs.StringVar(&cfg.hostname, "hostname", "tailchat", "machine name on the tailnet (https://NAME.<tailnet>.ts.net)")
	fs.StringVar(&cfg.stateDir, "state-dir", "", "where the node keeps its tailnet state (default: <config dir>/tailchat-gateway/<hostname>)")
	fs.StringVar(&upstream, "upstream", "http://127.0.0.1:8443", "the Tailchat server, running with TAILCHAT_AUTH=serve on loopback")
	fs.BoolVar(&funnel, "funnel", false, "must stay false: Tailchat is tailnet-only and the gateway never enables Funnel")
	fs.BoolVar(&cfg.redirectHTTP, "redirect-http", true, "also listen on :80 (tailnet only) and redirect to https")
	fs.BoolVar(&cfg.verbose, "verbose", false, "log tsnet's internal messages")
	fs.Usage = func() {
		fmt.Fprintf(output, "Usage: tailchat-gateway [flags]\n\nSet TS_AUTHKEY to join the tailnet without an interactive login.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if funnel {
		return nil, errFunnel
	}
	if cfg.hostname == "" {
		return nil, errors.New("--hostname must not be empty")
	}
	u, err := url.Parse(upstream)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("--upstream must be an http(s) URL, got %q", upstream)
	}
	cfg.upstream = u
	return cfg, nil
}

func run(cfg *config) error {
	up := cfg.upstream
	if !isLoopbackHost(up.Hostname()) {
		log.Printf("warning: upstream %s is not on loopback; a serve-mode Tailchat server only accepts loopback connections", up)
	}
	dir := cfg.stateDir
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return fmt.Errorf("pick a --state-dir: %w", err)
		}
		dir = filepath.Join(base, "tailchat-gateway", cfg.hostname)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := gateway.CheckUpstream(ctx, up, nil); err != nil {
		return err
	}

	srv := &tsnet.Server{
		Hostname: cfg.hostname,
		Dir:      dir,
		AuthKey:  os.Getenv("TS_AUTHKEY"),
		UserLogf: log.Printf,
		Logf:     func(string, ...any) {},
	}
	if cfg.verbose {
		srv.Logf = log.Printf
	}
	defer srv.Close()

	log.Printf("joining the tailnet as %q (state in %s)", cfg.hostname, dir)
	if _, err := srv.Up(ctx); err != nil {
		return fmt.Errorf("joining the tailnet: %w", err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}
	domains := srv.CertDomains()
	if len(domains) == 0 {
		return errors.New("this tailnet has no HTTPS certificates: enable MagicDNS and HTTPS in the Tailscale admin console (DNS page)")
	}
	fqdn := domains[0]

	handler, err := gateway.New(gateway.Options{Upstream: up, WhoIs: whoIs(lc), Logf: log.Printf})
	if err != nil {
		return err
	}
	ln, err := srv.ListenTLS("tcp", ":443")
	if err != nil {
		return err
	}
	httpsServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       5 * time.Minute,
		ErrorLog:          log.Default(),
	}
	errc := make(chan error, 2)
	go func() { errc <- httpsServer.Serve(ln) }()

	var httpServer *http.Server
	if cfg.redirectHTTP {
		ln80, err := srv.Listen("tcp", ":80")
		if err != nil {
			return err
		}
		httpServer = &http.Server{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "https://"+fqdn+r.URL.RequestURI(), http.StatusFound)
			}),
			ReadHeaderTimeout: 10 * time.Second,
		}
		go func() { errc <- httpServer.Serve(ln80) }()
	}
	log.Printf("Tailchat is on your tailnet at https://%s/ (proxying to %s)", fqdn, up)

	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	log.Print("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpsServer.Shutdown(sctx)
	if httpServer != nil {
		httpServer.Shutdown(sctx)
	}
	return nil
}

// whoIs adapts the tsnet LocalAPI client to gateway.WhoIsFunc.
func whoIs(lc *local.Client) gateway.WhoIsFunc {
	return func(ctx context.Context, remoteAddr string) (*gateway.Identity, error) {
		res, err := lc.WhoIs(ctx, remoteAddr)
		if err != nil {
			return nil, err
		}
		id := &gateway.Identity{}
		if res.Node != nil && res.Node.IsTagged() {
			id.Tagged = true
		}
		if res.UserProfile != nil {
			id.LoginName = res.UserProfile.LoginName
			id.DisplayName = res.UserProfile.DisplayName
			id.ProfilePicURL = res.UserProfile.ProfilePicURL
		}
		return id, nil
	}
}

func isLoopbackHost(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
