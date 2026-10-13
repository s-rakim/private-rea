// Command tailchat is a command-line Tailchat client: end-to-end encrypted
// messages and files with the same protocol as the web app (PROTOCOL.md).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/client"
)

const usage = `Usage: tailchat [flags] COMMAND [args]

Commands:
  whoami                         show your tailnet identity and this device
  chats                          list your chats
  send CHAT_OR_USER TEXT...      send an encrypted text message
  send-file [--caption T] [--kind K] CHAT_OR_USER PATH
                                 encrypt and send a file (any size, streamed)
  history [--limit N] CHAT_OR_USER
                                 show recent messages, decrypted
  download [--chat CHAT] MESSAGE_ID OUTDIR
                                 decrypt a message's file into OUTDIR
  listen                         print new messages as they arrive
  code USER                      show USER's security code to compare in person

CHAT_OR_USER is a chat id, a group name, or a user id such as
alice@example.com (their direct chat, started if needed).

The first command registers this device: a new P-256 key pair and a device
token are saved in the state file (mode 0600).

Flags (before or after the command):
`

type app struct {
	server, devUser, statePath, deviceName string
	stdout, stderr                         io.Writer
	httpClient                             *http.Client
	statePathUsed                          string
}

type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

func (a *app) globalFlags(fs *flag.FlagSet) {
	fs.StringVar(&a.server, "server", a.server, "server URL, e.g. https://tailchat.example.ts.net (default $TAILCHAT_SERVER)")
	fs.StringVar(&a.devUser, "dev-user", a.devUser, "send X-Dev-User: NAME (dev-mode servers only, for testing)")
	fs.StringVar(&a.statePath, "state", a.statePath, "device state file (default: per server and dev user, in your config directory)")
	fs.StringVar(&a.deviceName, "device-name", a.deviceName, "name for this device when it registers")
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	host, _ := os.Hostname()
	a := &app{server: os.Getenv("TAILCHAT_SERVER"), deviceName: "Tailchat CLI on " + host, stdout: stdout, stderr: stderr}
	if err := a.main(ctx, args); err != nil {
		var ue usageError
		if errors.As(err, &ue) {
			fmt.Fprintf(stderr, "tailchat: %s\nRun 'tailchat -h' for help.\n", ue.msg)
			return 2
		}
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(stderr, "tailchat: %v\n", err)
		if client.IsStatus(err, 401) && a.statePathUsed != "" {
			fmt.Fprintf(stderr, "If this device was logged out, delete %s to register it again.\n", a.statePathUsed)
		}
		return 1
	}
	return 0
}

func (a *app) main(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("tailchat", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	fs.Usage = func() {
		fmt.Fprint(a.stderr, usage)
		fs.PrintDefaults()
	}
	a.globalFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		fs.Usage()
		return usageError{"no command"}
	}
	cmd, rest := fs.Arg(0), fs.Args()[1:]
	sub := flag.NewFlagSet("tailchat "+cmd, flag.ContinueOnError)
	sub.SetOutput(a.stderr)
	a.globalFlags(sub)
	var (
		caption, kind, name, mimeType, chatArg string
		limit                                  int
	)
	switch cmd {
	case "send-file":
		sub.StringVar(&caption, "caption", "", "caption")
		sub.StringVar(&kind, "kind", "document", "media kind: document, image, video, audio, voice, sticker, gif")
		sub.StringVar(&name, "name", "", "file name to show (default: the file's name)")
		sub.StringVar(&mimeType, "mime", "", "MIME type (default: from the extension)")
	case "history":
		sub.IntVar(&limit, "limit", 30, "number of messages (max 200)")
	case "download":
		sub.StringVar(&chatArg, "chat", "", "only look in this chat (faster)")
	case "whoami", "chats", "send", "listen", "code":
	default:
		return usageError{fmt.Sprintf("unknown command %q", cmd)}
	}
	// Allow flags anywhere: parse, take one positional, repeat.
	var pos []string
	for {
		if err := sub.Parse(rest); err != nil {
			return err
		}
		if sub.NArg() == 0 {
			break
		}
		pos = append(pos, sub.Arg(0))
		rest = sub.Args()[1:]
		if cmd == "send" && len(pos) >= 1 {
			// Everything after the chat is the message text, verbatim.
			pos = append(pos, rest...)
			break
		}
	}
	need := func(n int, what string) error {
		if len(pos) != n {
			return usageError{fmt.Sprintf("usage: tailchat %s %s", cmd, what)}
		}
		return nil
	}
	switch cmd {
	case "whoami":
		if err := need(0, ""); err != nil {
			return err
		}
		return a.whoami(ctx)
	case "chats":
		if err := need(0, ""); err != nil {
			return err
		}
		return a.chats(ctx)
	case "send":
		if len(pos) < 2 {
			return usageError{"usage: tailchat send CHAT_OR_USER TEXT..."}
		}
		return a.send(ctx, pos[0], strings.Join(pos[1:], " "))
	case "send-file":
		if err := need(2, "[--caption TEXT] [--kind KIND] CHAT_OR_USER PATH"); err != nil {
			return err
		}
		return a.sendFile(ctx, pos[0], pos[1], client.FileOptions{Kind: kind, Caption: caption, Name: name, Mime: mimeType})
	case "history":
		if err := need(1, "[--limit N] CHAT_OR_USER"); err != nil {
			return err
		}
		return a.history(ctx, pos[0], limit)
	case "download":
		if err := need(2, "[--chat CHAT] MESSAGE_ID OUTDIR"); err != nil {
			return err
		}
		return a.download(ctx, pos[0], pos[1], chatArg)
	case "listen":
		if err := need(0, ""); err != nil {
			return err
		}
		return a.listen(ctx)
	case "code":
		if err := need(1, "USER"); err != nil {
			return err
		}
		return a.code(ctx, pos[0])
	}
	return nil
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func defaultStatePath(server, devUser string) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", err
		}
		dir = filepath.Join(home, ".config")
	}
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	name := unsafeName.ReplaceAllString(u.Host+u.Path, "_")
	if devUser != "" {
		name += "-dev-" + unsafeName.ReplaceAllString(devUser, "_")
	}
	return filepath.Join(dir, "tailchat", name+".json"), nil
}

// open returns a client for a registered device, registering it first if
// there is no state file yet.
func (a *app) open(ctx context.Context) (*client.Client, error) {
	if a.server == "" {
		return nil, usageError{"--server is required (or set TAILCHAT_SERVER)"}
	}
	c, err := client.New(client.Options{Server: a.server, DevUser: a.devUser, HTTPClient: a.httpClient})
	if err != nil {
		return nil, err
	}
	path := a.statePath
	if path == "" {
		if path, err = defaultStatePath(c.Server(), a.devUser); err != nil {
			return nil, err
		}
	}
	a.statePathUsed = path
	st, err := client.LoadState(path)
	if errors.Is(err, os.ErrNotExist) {
		st, err = c.Register(ctx, a.deviceName)
		if err != nil {
			return nil, fmt.Errorf("registering this device: %w", err)
		}
		if err := st.Save(path); err != nil {
			return nil, fmt.Errorf("saving device keys: %w", err)
		}
		fmt.Fprintf(a.stderr, "Registered this device for %s (device %s); keys saved in %s\n", st.UserID, st.DeviceID, path)
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if st.Server != c.Server() || st.DevUser != a.devUser {
		return nil, fmt.Errorf("%s belongs to %s (dev user %q), not %s (dev user %q); pass --state for another device", path, st.Server, st.DevUser, c.Server(), a.devUser)
	}
	return c, c.Use(st)
}

func (a *app) whoami(ctx context.Context) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	me, err := c.Me(ctx)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "user:    %s (%s)\n", clean(me.User.ID), clean(me.User.Name))
	if me.Device != nil {
		fmt.Fprintf(a.stdout, "device:  %s (%s)\n", me.Device.ID, clean(me.Device.Name))
	}
	fmt.Fprintf(a.stdout, "server:  %s (auth: %s)\n", c.Server(), clean(me.AuthMode))
	fmt.Fprintf(a.stdout, "state:   %s\n", a.statePathUsed)
	return nil
}

func (a *app) chats(ctx context.Context) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	chats, err := c.Chats(ctx)
	if err != nil {
		return err
	}
	if len(chats) == 0 {
		fmt.Fprintln(a.stdout, "No chats yet. Start one with: tailchat send USER@DOMAIN TEXT")
		return nil
	}
	for _, ch := range chats {
		unread := ""
		if ch.Unread > 0 {
			unread = fmt.Sprintf("  (%d unread)", ch.Unread)
		}
		last := ""
		if ch.LastMessage != nil {
			d := c.Decrypt(ctx, ch.LastMessage)
			last = "\n    " + fmtTime(ch.LastMessage.CreatedAt) + " " + clean(ch.LastMessage.SenderID) + ": " + firstLine(body(d))
		}
		fmt.Fprintf(a.stdout, "%s  %-6s %s%s%s\n", ch.ID, ch.Type, clean(ch.Title(c.UserID)), unread, last)
	}
	return nil
}

func (a *app) send(ctx context.Context, target, text string) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	ch, err := c.ResolveChat(ctx, target)
	if err != nil {
		return err
	}
	m, err := c.SendText(ctx, ch.ID, text)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "sent %s to %s\n", m.ID, clean(ch.Title(c.UserID)))
	return nil
}

func (a *app) sendFile(ctx context.Context, target, path string, opt client.FileOptions) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	ch, err := c.ResolveChat(ctx, target)
	if err != nil {
		return err
	}
	m, err := c.SendFile(ctx, ch.ID, path, opt)
	if err != nil {
		return err
	}
	info, _ := os.Stat(path)
	size := int64(0)
	if info != nil {
		size = info.Size()
	}
	fmt.Fprintf(a.stdout, "sent %s (%s) to %s as %s\n", clean(filepath.Base(path)), humanSize(size), clean(ch.Title(c.UserID)), m.ID)
	return nil
}

func (a *app) history(ctx context.Context, target string, limit int) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	ch, err := c.ResolveChat(ctx, target)
	if err != nil {
		return err
	}
	msgs, more, err := c.Messages(ctx, ch.ID, 0, limit)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "-- %s (%s) --\n", clean(ch.Title(c.UserID)), ch.ID)
	if more {
		fmt.Fprintln(a.stdout, "   (older messages not shown; use --limit)")
	}
	for i := range msgs {
		fmt.Fprintln(a.stdout, formatMessage(c.Decrypt(ctx, &msgs[i]), ""))
	}
	return nil
}

func (a *app) download(ctx context.Context, messageID, outDir, chatArg string) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	chatID := ""
	if chatArg != "" {
		ch, err := c.ResolveChat(ctx, chatArg)
		if err != nil {
			return err
		}
		chatID = ch.ID
	}
	m, err := c.FindMessage(ctx, messageID, chatID)
	if err != nil {
		return err
	}
	d := c.Decrypt(ctx, m)
	if d.Err != nil {
		return fmt.Errorf("cannot decrypt message %s: %w", messageID, d.Err)
	}
	if d.Content == nil || d.Content.File == nil {
		return fmt.Errorf("message %s has no file", messageID)
	}
	dest, err := c.DownloadTo(ctx, d.Content.File, outDir, "tailchat-"+messageID)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "%s (%s, checksum ok)\n", dest, humanSize(d.Content.File.Size))
	return nil
}

func (a *app) code(ctx context.Context, user string) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	code, devices, err := c.SecurityCode(ctx, user)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "Security code for %s (%d device(s)):\n%s\n", clean(user), len(devices), code)
	return nil
}

func (a *app) listen(ctx context.Context) error {
	c, err := a.open(ctx)
	if err != nil {
		return err
	}
	titles := map[string]string{}
	title := func(chatID string) string {
		if t, ok := titles[chatID]; ok {
			return t
		}
		t := chatID
		if ch, err := c.Chat(ctx, chatID); err == nil {
			t = ch.Title(c.UserID)
		}
		titles[chatID] = t
		return t
	}
	seen := map[string]string{} // message id -> last printed state
	handle := func(ev *client.Event) error {
		switch ev.Type {
		case "message", "message-update":
			m := ev.Message
			if m == nil {
				return nil
			}
			state := "new"
			if m.DeletedAt != nil {
				state = "deleted"
			} else if m.EditedAt != nil {
				state = fmt.Sprint("edited", *m.EditedAt)
			}
			prev, ok := seen[m.ID]
			if !ok && ev.Type == "message-update" {
				prev, ok = "new", true // an older message we have not printed
			}
			if ok && prev == state {
				return nil // reactions, votes, stars: nothing new to show
			}
			seen[m.ID] = state
			fmt.Fprintln(a.stdout, formatMessage(c.Decrypt(ctx, m), title(m.ChatID)))
		case "message-gone":
			fmt.Fprintf(a.stdout, "[%s] message %s disappeared\n", clean(title(ev.ChatID)), clean(ev.ID))
		case "chat":
			if ev.Chat != nil {
				titles[ev.Chat.ID] = ev.Chat.Title(c.UserID)
			}
		}
		return nil
	}
	backoff := time.Second
	for {
		err := c.Listen(ctx, func() {
			backoff = time.Second
			fmt.Fprintf(a.stderr, "Listening as %s on %s (Ctrl-C to stop)\n", c.UserID, c.Server())
		}, handle)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, client.ErrAuthRejected) || client.IsStatus(err, 401) || client.IsStatus(err, 403) {
			return err
		}
		fmt.Fprintf(a.stderr, "connection lost (%v); reconnecting in %s\n", err, backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}
