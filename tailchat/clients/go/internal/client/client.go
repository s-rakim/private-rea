// Package client talks to a Tailchat server (PROTOCOL.md): device
// registration, chats, end-to-end encrypted messages and files, and the
// realtime WebSocket.
package client

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/e2ee"
)

// APIError is an error answer from the server.
type APIError struct {
	Status  int
	Message string
	Method  string
	Path    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s %s: %d %s", e.Method, e.Path, e.Status, e.Message)
}

// IsStatus reports whether err is an APIError with that HTTP status.
func IsStatus(err error, status int) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == status
}

// Options configure a Client.
type Options struct {
	// Server is the base URL, e.g. https://tailchat.example.ts.net.
	Server string
	// DevUser is sent as X-Dev-User; only for servers in dev mode.
	DevUser string
	// HTTPClient defaults to a client without a timeout (uploads and
	// downloads can be large); cancel through contexts instead.
	HTTPClient *http.Client
}

// Client is one Tailchat device.
type Client struct {
	base    *url.URL
	devUser string
	http    *http.Client

	token    string
	DeviceID string
	UserID   string
	priv     *ecdh.PrivateKey

	mu      sync.Mutex
	devices map[string]*Device // device id -> device (public key cache)
}

// New makes an unregistered client; call Register or Use next.
func New(opts Options) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(opts.Server, "/"))
	if err != nil {
		return nil, fmt.Errorf("server URL: %w", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("server URL must be http(s)://host[:port], got %q", opts.Server)
	}
	hc := opts.HTTPClient
	if hc == nil {
		hc = DefaultHTTPClient()
	}
	return &Client{base: u, devUser: opts.DevUser, http: hc, devices: map[string]*Device{}}, nil
}

// DefaultHTTPClient connects directly, ignoring HTTP(S)_PROXY: the server is
// on the tailnet, and tailnet traffic should not be handed to a proxy.
func DefaultHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	return &http.Client{Transport: tr}
}

// Server is the normalised server URL.
func (c *Client) Server() string { return c.base.String() }

// Use loads a registered device's credentials.
func (c *Client) Use(st *State) error {
	priv, err := e2ee.ParsePrivateKey(st.PrivateKey)
	if err != nil {
		return err
	}
	if e2ee.JWKOf(priv.PublicKey()) != st.PublicKey {
		return errors.New("state file: private key does not match the public key")
	}
	c.token, c.DeviceID, c.UserID, c.priv = st.Token, st.DeviceID, st.UserID, priv
	return nil
}

// Register creates a key pair, registers this device and returns the state
// to save.
func (c *Client) Register(ctx context.Context, name string) (*State, error) {
	priv, err := e2ee.GenerateKey()
	if err != nil {
		return nil, err
	}
	pub := e2ee.JWKOf(priv.PublicKey())
	var res struct {
		Device Device `json:"device"`
		Token  string `json:"token"`
	}
	body := map[string]any{"name": name, "publicKey": pub}
	if err := c.do(ctx, "POST", "/api/devices", body, &res); err != nil {
		return nil, err
	}
	if res.Device.PublicKey != pub || res.Token == "" || !strings.HasPrefix(res.Token, res.Device.ID+".") {
		return nil, errors.New("server returned an unexpected device registration")
	}
	st := &State{
		Server:     c.base.String(),
		DevUser:    c.devUser,
		UserID:     res.Device.UserID,
		DeviceID:   res.Device.ID,
		DeviceName: res.Device.Name,
		Token:      res.Token,
		PrivateKey: e2ee.EncodePrivateKey(priv),
		PublicKey:  pub,
	}
	return st, c.Use(st)
}

func (c *Client) endpoint(p string) string {
	u := *c.base
	rel, _ := url.Parse(p)
	u.Path = path.Join("/", c.base.Path, rel.Path)
	u.RawQuery = rel.RawQuery
	return u.String()
}

func (c *Client) newRequest(ctx context.Context, method, p string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(p), body)
	if err != nil {
		return nil, err
	}
	c.authorize(req.Header)
	return req, nil
}

func (c *Client) authorize(h http.Header) {
	if c.devUser != "" {
		h.Set("X-Dev-User", c.devUser)
	}
	if c.token != "" {
		h.Set("Authorization", "Bearer "+c.token)
	}
}

func (c *Client) send(req *http.Request) (*http.Response, error) {
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		return nil, &APIError{Status: res.StatusCode, Message: msg, Method: req.Method, Path: req.URL.Path}
	}
	return res, nil
}

// do sends a JSON request and decodes a JSON answer into out (if not nil).
func (c *Client) do(ctx context.Context, method, p string, body, out any) error {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	req, err := c.newRequest(ctx, method, p, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.send(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out == nil {
		_, err = io.Copy(io.Discard, res.Body)
		return err
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// Me returns the signed-in user and this device.
func (c *Client) Me(ctx context.Context) (*Me, error) {
	var me Me
	return &me, c.do(ctx, "GET", "/api/me", nil, &me)
}

// Chats lists this user's chats.
func (c *Client) Chats(ctx context.Context) ([]Chat, error) {
	var res struct {
		Chats []Chat `json:"chats"`
	}
	return res.Chats, c.do(ctx, "GET", "/api/chats", nil, &res)
}

// Chat returns one chat.
func (c *Client) Chat(ctx context.Context, id string) (*Chat, error) {
	var res struct {
		Chat Chat `json:"chat"`
	}
	return &res.Chat, c.do(ctx, "GET", "/api/chats/"+url.PathEscape(id), nil, &res)
}

// DirectChat finds or starts the direct chat with a user.
func (c *Client) DirectChat(ctx context.Context, userID string) (*Chat, error) {
	var res struct {
		Chat Chat `json:"chat"`
	}
	return &res.Chat, c.do(ctx, "POST", "/api/chats/direct", map[string]string{"userId": userID}, &res)
}

// ResolveChat accepts a chat id, a user id (anything with an @: their direct
// chat, started if needed) or a group name.
func (c *Client) ResolveChat(ctx context.Context, arg string) (*Chat, error) {
	if strings.Contains(arg, "@") {
		chats, err := c.Chats(ctx)
		if err != nil {
			return nil, err
		}
		for i := range chats {
			ch := &chats[i]
			if ch.Type == "direct" && ch.Title(c.UserID) == arg {
				return ch, nil
			}
		}
		return c.DirectChat(ctx, arg)
	}
	ch, err := c.Chat(ctx, arg)
	if err == nil {
		return ch, nil
	}
	if !IsStatus(err, 404) && !IsStatus(err, 403) {
		return nil, err
	}
	chats, lerr := c.Chats(ctx)
	if lerr != nil {
		return nil, lerr
	}
	var found *Chat
	for i := range chats {
		if chats[i].Name != nil && strings.EqualFold(*chats[i].Name, arg) {
			if found != nil {
				return nil, fmt.Errorf("more than one chat is called %q: use its id (tailchat chats)", arg)
			}
			found = &chats[i]
		}
	}
	if found == nil {
		return nil, fmt.Errorf("no chat %q (give a chat id, a group name or a user id like alice@example.com)", arg)
	}
	return found, nil
}

// ChatDevices lists every logged-in device of every current member.
func (c *Client) ChatDevices(ctx context.Context, chatID string) ([]Device, error) {
	var res struct {
		Devices []Device `json:"devices"`
	}
	return res.Devices, c.do(ctx, "GET", "/api/chats/"+url.PathEscape(chatID)+"/devices", nil, &res)
}

// UserDevices lists a user's logged-in devices.
func (c *Client) UserDevices(ctx context.Context, userID string) ([]Device, error) {
	var res struct {
		Devices []Device `json:"devices"`
	}
	return res.Devices, c.do(ctx, "GET", "/api/users/"+url.PathEscape(userID)+"/devices", nil, &res)
}

// device returns a device's public key record, from cache or /api/keys.
func (c *Client) device(ctx context.Context, id string) (*Device, error) {
	c.mu.Lock()
	d := c.devices[id]
	c.mu.Unlock()
	if d != nil {
		return d, nil
	}
	var res struct {
		Devices []Device `json:"devices"`
	}
	if err := c.do(ctx, "GET", "/api/keys?ids="+url.QueryEscape(id), nil, &res); err != nil {
		return nil, err
	}
	for i := range res.Devices {
		if res.Devices[i].ID == id {
			d = &res.Devices[i]
		}
	}
	if d == nil {
		return nil, fmt.Errorf("unknown device %s", id)
	}
	c.mu.Lock()
	c.devices[id] = d
	c.mu.Unlock()
	return d, nil
}

// Messages returns up to limit messages before seq `before` (0: the latest),
// oldest first, and whether there are more.
func (c *Client) Messages(ctx context.Context, chatID string, before int64, limit int) ([]Message, bool, error) {
	q := url.Values{}
	if before > 0 {
		q.Set("before", strconv.FormatInt(before, 10))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var res struct {
		Messages []Message `json:"messages"`
		HasMore  bool      `json:"hasMore"`
	}
	p := "/api/chats/" + url.PathEscape(chatID) + "/messages"
	if len(q) > 0 {
		p += "?" + q.Encode()
	}
	return res.Messages, res.HasMore, c.do(ctx, "GET", p, nil, &res)
}

// GetMessage fetches one message by id.
func (c *Client) GetMessage(ctx context.Context, id string) (*Message, error) {
	var res struct {
		Message Message `json:"message"`
	}
	return &res.Message, c.do(ctx, "GET", "/api/messages/"+url.PathEscape(id), nil, &res)
}

// FindMessage fetches a message by id. Servers without GET /api/messages/:id
// (it answers 405 there) are searched chat by chat; chatID narrows that
// search when not empty.
func (c *Client) FindMessage(ctx context.Context, messageID, chatID string) (*Message, error) {
	m, err := c.GetMessage(ctx, messageID)
	if err == nil {
		if chatID != "" && m.ChatID != chatID {
			return nil, fmt.Errorf("message %s is not in chat %s", messageID, chatID)
		}
		return m, nil
	}
	if !IsStatus(err, 405) {
		return nil, err
	}
	var ids []string
	if chatID != "" {
		ids = []string{chatID}
	} else {
		chats, err := c.Chats(ctx)
		if err != nil {
			return nil, err
		}
		for _, ch := range chats {
			ids = append(ids, ch.ID)
		}
	}
	for _, id := range ids {
		var before int64
		for {
			msgs, more, err := c.Messages(ctx, id, before, 200)
			if err != nil {
				return nil, err
			}
			for i := range msgs {
				if msgs[i].ID == messageID {
					return &msgs[i], nil
				}
			}
			if !more || len(msgs) == 0 {
				break
			}
			before = msgs[0].Seq
		}
	}
	return nil, fmt.Errorf("no message %s in your chats", messageID)
}

func (c *Client) requireDevice() error {
	if c.priv == nil || c.token == "" {
		return ErrNoState
	}
	return nil
}

// Seal encrypts content for every device in the chat (and this one).
func (c *Client) Seal(ctx context.Context, chatID, messageID string, content any) (string, error) {
	if err := c.requireDevice(); err != nil {
		return "", err
	}
	devices, err := c.ChatDevices(ctx, chatID)
	if err != nil {
		return "", err
	}
	recipients := make([]e2ee.Recipient, 0, len(devices))
	for _, d := range devices {
		pub, err := d.PublicKey.PublicKey()
		if err != nil {
			return "", fmt.Errorf("device %s of %s has a bad key: %w", d.ID, d.UserID, err)
		}
		recipients = append(recipients, e2ee.Recipient{ID: d.ID, Key: pub})
		dd := d
		c.mu.Lock()
		c.devices[d.ID] = &dd
		c.mu.Unlock()
	}
	plain, err := json.Marshal(content)
	if err != nil {
		return "", err
	}
	return e2ee.Seal(c.DeviceID, c.priv, plain, e2ee.ChatAAD(chatID, messageID), recipients)
}

// SendContent encrypts and posts a message. files lists attached file ids.
func (c *Client) SendContent(ctx context.Context, chatID string, content any, files []string) (*Message, error) {
	id := e2ee.NewMessageID()
	payload, err := c.Seal(ctx, chatID, id, content)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"id": id, "payload": payload}
	if len(files) > 0 {
		body["files"] = files
	}
	var res struct {
		Message Message `json:"message"`
	}
	if err := c.do(ctx, "POST", "/api/chats/"+url.PathEscape(chatID)+"/messages", body, &res); err != nil {
		return nil, err
	}
	return &res.Message, nil
}

// SendText sends a text message.
func (c *Client) SendText(ctx context.Context, chatID, text string) (*Message, error) {
	return c.SendContent(ctx, chatID, Content{Type: "text", Text: text}, nil)
}

// Upload encrypts size bytes from r while streaming them to POST /api/files
// and returns the file object for the message content (without name/mime).
func (c *Client) Upload(ctx context.Context, r io.Reader, size int64) (*FileRef, error) {
	enc, err := e2ee.NewEncryptReader(r, size)
	if err != nil {
		return nil, err
	}
	req, err := c.newRequest(ctx, "POST", "/api/files", enc)
	if err != nil {
		return nil, err
	}
	req.ContentLength = enc.Size()
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.send(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var up struct {
		ID   string `json:"id"`
		Size int64  `json:"size"`
	}
	if err := json.NewDecoder(res.Body).Decode(&up); err != nil {
		return nil, err
	}
	keys, err := enc.Keys()
	if err != nil {
		return nil, err
	}
	if up.ID == "" || up.Size != enc.Size() {
		return nil, fmt.Errorf("upload: server stored %d bytes, sent %d", up.Size, enc.Size())
	}
	return &FileRef{ID: up.ID, Key: keys.Key, Prefix: keys.Prefix, Size: keys.Size, SHA256: keys.SHA256}, nil
}

// FileOptions describe a file message.
type FileOptions struct {
	Kind    string // image, video, audio, voice, document, sticker, gif; default document
	Caption string
	Name    string // defaults to the file's base name
	Mime    string // defaults to a guess from the extension
}

// SendFile encrypts, uploads and sends a file from disk.
func (c *Client) SendFile(ctx context.Context, chatID, filePath string, opt FileOptions) (*Message, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filePath)
	}
	ref, err := c.Upload(ctx, f, info.Size())
	if err != nil {
		return nil, err
	}
	ref.Name = opt.Name
	if ref.Name == "" {
		ref.Name = filepath.Base(filePath)
	}
	ref.Mime = opt.Mime
	if ref.Mime == "" {
		ref.Mime = mime.TypeByExtension(strings.ToLower(filepath.Ext(filePath)))
	}
	if ref.Mime == "" {
		ref.Mime = "application/octet-stream"
	}
	kind := opt.Kind
	if kind == "" {
		kind = "document"
	}
	content := Content{Type: "media", Kind: kind, File: ref, Caption: opt.Caption}
	return c.SendContent(ctx, chatID, content, []string{ref.ID})
}

// ErrSenderMismatch means the envelope was sealed by a device that does not
// belong to the user the server says sent the message.
var ErrSenderMismatch = errors.New("sender device does not belong to the message's sender")

// Decrypt opens a message. Failures are reported in Decrypted.Err.
func (c *Client) Decrypt(ctx context.Context, m *Message) *Decrypted {
	out := &Decrypted{Message: m}
	if m.Payload == nil {
		return out
	}
	if m.Kind == "system" {
		out.System = json.RawMessage(*m.Payload)
		return out
	}
	if err := c.requireDevice(); err != nil {
		out.Err = err
		return out
	}
	env, err := e2ee.ParseEnvelope(*m.Payload)
	if err != nil {
		out.Err = err
		return out
	}
	if _, ok := env.Keys[c.DeviceID]; !ok {
		out.Err = e2ee.ErrNoKey
		return out
	}
	sender, err := c.device(ctx, env.From)
	if err != nil {
		out.Err = err
		return out
	}
	// The wrapped key authenticates env.From; the server's senderId must be
	// that device's owner, or the server is misattributing the message.
	if sender.UserID != m.SenderID {
		out.Err = ErrSenderMismatch
		return out
	}
	pub, err := sender.PublicKey.PublicKey()
	if err != nil {
		out.Err = err
		return out
	}
	plain, err := env.Open(c.DeviceID, c.priv, pub, e2ee.ChatAAD(m.ChatID, m.ID))
	if err != nil {
		out.Err = err
		return out
	}
	var content Content
	if err := json.Unmarshal(plain, &content); err != nil {
		out.Err = fmt.Errorf("decrypted content is not JSON: %w", err)
		return out
	}
	content.Raw = plain
	out.Content = &content
	return out
}

// Download fetches and decrypts a file into w, verifying every chunk and the
// checksum.
func (c *Client) Download(ctx context.Context, f *FileRef, w io.Writer) error {
	if f == nil || f.ID == "" {
		return errors.New("message has no file")
	}
	if f.SHA256 == "" {
		return errors.New("file has no sha256 checksum, refusing it (PROTOCOL.md §5)")
	}
	req, err := c.newRequest(ctx, "GET", "/api/files/"+url.PathEscape(f.ID), nil)
	if err != nil {
		return err
	}
	res, err := c.send(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.ContentLength >= 0 && res.ContentLength != e2ee.EncryptedSize(f.Size) {
		return fmt.Errorf("encrypted file has the wrong size (%d bytes, want %d)", res.ContentLength, e2ee.EncryptedSize(f.Size))
	}
	return e2ee.DecryptStream(w, res.Body, f.Keys())
}

// SafeFileName turns a sender-chosen name into a plain file name.
func SafeFileName(name, fallback string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimSpace(strings.Trim(name, ". "))
	if name == "" || name == "/" {
		return fallback
	}
	if len(name) > 200 {
		ext := filepath.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		name = strings.ToValidUTF8(name[:200-len(ext)], "") + ext
	}
	return name
}

// DownloadTo decrypts a file into dir, under its (sanitised) name, without
// overwriting anything. The plaintext only appears under its final name once
// it is fully verified.
func (c *Client) DownloadTo(ctx context.Context, f *FileRef, dir, fallbackName string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".tailchat-download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := c.Download(ctx, f, tmp); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	name := SafeFileName(f.Name, fallbackName)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		dest := filepath.Join(dir, candidate)
		// Reserve the name so a concurrent download can't take it, then
		// replace the placeholder with the verified file.
		ph, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		ph.Close()
		if err := os.Rename(tmp.Name(), dest); err != nil {
			os.Remove(dest)
			return "", err
		}
		return dest, nil
	}
	return "", fmt.Errorf("too many files called %s in %s", name, dir)
}

// SecurityCode computes the code for a user's devices (§3).
func (c *Client) SecurityCode(ctx context.Context, userID string) (string, []Device, error) {
	devices, err := c.UserDevices(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	if len(devices) == 0 {
		return "", nil, fmt.Errorf("%s has no logged-in devices", userID)
	}
	keys := make([]e2ee.PublicJWK, len(devices))
	for i, d := range devices {
		keys[i] = d.PublicKey
	}
	code, err := e2ee.SecurityCode(keys)
	return code, devices, err
}
