package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/client"
	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/e2ee"
)

// clean removes control characters (terminal escape sequences included) from
// text written by other people before it reaches the terminal.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return r
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0):
			return '�'
		case r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069: // bidi overrides
			return '�'
		}
		return r
	}, s)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " …"
	}
	return s
}

func fmtTime(ms int64) string { return time.UnixMilli(ms).Local().Format("2006-01-02 15:04") }

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// body describes a message's content in one or more lines of plain text.
func body(d *client.Decrypted) string {
	m := d.Message
	switch {
	case m.DeletedAt != nil:
		return "(message deleted)"
	case m.Kind == "system":
		return systemText(m.SenderID, d.System)
	case m.Payload == nil:
		return "(view once message, opened)"
	case errors.Is(d.Err, e2ee.ErrNoKey):
		return "(not encrypted for this device: it was sent before this device was linked)"
	case errors.Is(d.Err, client.ErrSenderMismatch):
		return "(WARNING: this message was sealed by a device that does not belong to " + clean(m.SenderID) + "; not shown)"
	case d.Err != nil:
		return "(cannot decrypt: " + clean(d.Err.Error()) + ")"
	}
	c := d.Content
	var s string
	switch c.Type {
	case "text":
		s = c.Text
	case "media":
		s = "[" + c.Kind + "]"
		if c.File != nil {
			s += fmt.Sprintf(" %s (%s)", c.File.Name, humanSize(c.File.Size))
		}
		if c.Caption != "" {
			s += ": " + c.Caption
		}
		if c.File != nil {
			s += fmt.Sprintf("  [tailchat download %s DIR]", m.ID)
		}
	case "location":
		s = "[location]"
		if c.Name != "" {
			s += " " + c.Name
		}
		if c.Lat != nil && c.Lon != nil {
			s += fmt.Sprintf(" %.5f,%.5f", *c.Lat, *c.Lon)
		}
	case "contact":
		s = fmt.Sprintf("[contact] %s <%s>", c.Name, c.UserID)
	case "poll":
		s = fmt.Sprintf("[poll] %s: %s", c.Question, strings.Join(c.Options, " / "))
	case "call":
		kind := "voice"
		if c.Video {
			kind = "video"
		}
		s = fmt.Sprintf("[%s call, %ds]", kind, int(c.Duration))
	default:
		s = "[" + c.Type + "]"
	}
	if c.ReplyTo != nil {
		s = "(reply to: " + firstLine(c.ReplyTo.Preview) + ") " + s
	}
	if c.Forwarded {
		s = "(forwarded) " + s
	}
	if m.ViewOnce {
		s = "(view once) " + s
	}
	return clean(s)
}

func systemText(actor string, raw json.RawMessage) string {
	var ev struct {
		Event string   `json:"event"`
		Name  string   `json:"name"`
		Users []string `json:"users"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Event == "" {
		return "* (system message)"
	}
	s := "* " + actor + " " + ev.Event
	if ev.Name != "" {
		s += fmt.Sprintf(" %q", ev.Name)
	}
	if len(ev.Users) > 0 {
		s += " " + strings.Join(ev.Users, ", ")
	}
	return clean(s)
}

// formatMessage renders one message; chat is shown as a prefix when not empty.
func formatMessage(d *client.Decrypted, chat string) string {
	m := d.Message
	var b strings.Builder
	if chat != "" {
		fmt.Fprintf(&b, "[%s] ", clean(chat))
	}
	fmt.Fprintf(&b, "%s ", fmtTime(m.CreatedAt))
	text := body(d)
	if m.Kind == "system" {
		b.WriteString(text)
		return b.String()
	}
	if m.EditedAt != nil && m.DeletedAt == nil {
		text += " (edited)"
	}
	for _, r := range m.Reactions {
		text += " " + clean(r.Emoji)
	}
	fmt.Fprintf(&b, "%s: %s", clean(m.SenderID), strings.ReplaceAll(text, "\n", "\n    "))
	return b.String()
}
