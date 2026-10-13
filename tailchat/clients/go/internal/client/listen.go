package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/coder/websocket"
)

// ErrAuthRejected means the server closed the socket because the device token
// was refused; reconnecting will not help.
var ErrAuthRejected = errors.New("realtime: device token refused")

// Listen connects to /ws, authenticates and calls handle for every event
// until ctx is cancelled (returns nil), the connection drops, or handle
// returns an error. ready, if not nil, is called once the server has accepted
// the device.
func (c *Client) Listen(ctx context.Context, ready func(), handle func(*Event) error) error {
	if err := c.requireDevice(); err != nil {
		return err
	}
	u := *c.base
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = c.base.Path + "/ws"
	u.RawQuery = ""
	h := http.Header{}
	if c.devUser != "" {
		h.Set("X-Dev-User", c.devUser)
	}
	conn, res, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: h, HTTPClient: c.http})
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		if res != nil && res.StatusCode >= 400 {
			return &APIError{Status: res.StatusCode, Message: "WebSocket upgrade refused", Method: "GET", Path: u.Path}
		}
		return err
	}
	defer conn.CloseNow()
	// Events carry whole messages (envelopes up to 512 KiB) and chat views.
	conn.SetReadLimit(8 << 20)

	auth, _ := json.Marshal(map[string]string{"type": "auth", "token": c.token})
	if err := conn.Write(ctx, websocket.MessageText, auth); err != nil {
		return err
	}
	authed := false
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				conn.Close(websocket.StatusNormalClosure, "bye")
				return nil
			}
			if code := websocket.CloseStatus(err); code == 4001 || code == 4003 {
				return fmt.Errorf("%w (%v)", ErrAuthRejected, err)
			}
			return err
		}
		ev := &Event{}
		if err := json.Unmarshal(data, ev); err != nil {
			continue
		}
		ev.Raw = data
		if !authed {
			if ev.Type == "ready" {
				authed = true
				if ready != nil {
					ready()
				}
			}
			continue
		}
		if err := handle(ev); err != nil {
			conn.Close(websocket.StatusNormalClosure, "bye")
			return err
		}
	}
}
