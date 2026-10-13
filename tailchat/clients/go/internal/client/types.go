package client

import (
	"encoding/json"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/e2ee"
)

// User is a person on the tailnet.
type User struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	About  string `json:"about"`
	Avatar string `json:"avatar"`
}

// Device is a linked device and its public key.
type Device struct {
	ID         string         `json:"id"`
	UserID     string         `json:"userId"`
	Name       string         `json:"name"`
	PublicKey  e2ee.PublicJWK `json:"publicKey"`
	CreatedAt  int64          `json:"createdAt"`
	LastActive int64          `json:"lastActive"`
	RevokedAt  *int64         `json:"revokedAt"`
}

// Me is GET /api/me.
type Me struct {
	User     User    `json:"user"`
	Device   *Device `json:"device"`
	AuthMode string  `json:"authMode"`
}

// Member is a chat member.
type Member struct {
	UserID string `json:"userId"`
	Role   string `json:"role"`
	Left   bool   `json:"left"`
}

// Chat is a chat as one member sees it.
type Chat struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"` // direct or group
	Name        *string  `json:"name"`
	Members     []Member `json:"members"`
	Unread      int      `json:"unread"`
	LastSeq     int64    `json:"lastSeq"`
	LastMessage *Message `json:"lastMessage"`
}

// Title is the group name, or the other person in a direct chat.
func (c *Chat) Title(me string) string {
	if c.Name != nil && *c.Name != "" {
		return *c.Name
	}
	for _, m := range c.Members {
		if m.UserID != me {
			return m.UserID
		}
	}
	return me // a chat with yourself
}

// Reaction is an emoji reaction.
type Reaction struct {
	UserID string `json:"userId"`
	Emoji  string `json:"emoji"`
}

// Message is a chat message; Payload is the encrypted envelope (nil once
// deleted or opened view-once), or plain JSON for kind "system".
type Message struct {
	ID           string          `json:"id"`
	ChatID       string          `json:"chatId"`
	Seq          int64           `json:"seq"`
	SenderID     string          `json:"senderId"`
	SenderDevice *string         `json:"senderDevice"`
	Kind         string          `json:"kind"`
	Payload      *string         `json:"payload"`
	Files        []string        `json:"files"`
	ViewOnce     bool            `json:"viewOnce"`
	Opened       json.RawMessage `json:"opened,omitempty"`
	CreatedAt    int64           `json:"createdAt"`
	EditedAt     *int64          `json:"editedAt"`
	DeletedAt    *int64          `json:"deletedAt"`
	ExpiresAt    *int64          `json:"expiresAt"`
	Reactions    []Reaction      `json:"reactions"`
}

// FileRef is the §5 file object inside media content.
type FileRef struct {
	ID     string `json:"id"`
	Key    string `json:"key"`
	Prefix string `json:"prefix"`
	Size   int64  `json:"size"`
	Name   string `json:"name,omitempty"`
	Mime   string `json:"mime,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

// Keys returns what e2ee needs to decrypt the file.
func (f *FileRef) Keys() e2ee.FileKeys {
	return e2ee.FileKeys{Key: f.Key, Prefix: f.Prefix, Size: f.Size, SHA256: f.SHA256}
}

// ReplyTo quotes another message.
type ReplyTo struct {
	ID       string `json:"id"`
	SenderID string `json:"senderId"`
	Preview  string `json:"preview"`
}

// Content is decrypted message content (§4). Only the fields this client
// shows are typed; Raw keeps the whole object.
type Content struct {
	Type      string   `json:"type"`
	Text      string   `json:"text,omitempty"`
	Kind      string   `json:"kind,omitempty"`
	File      *FileRef `json:"file,omitempty"`
	Caption   string   `json:"caption,omitempty"`
	Lat       *float64 `json:"lat,omitempty"`
	Lon       *float64 `json:"lon,omitempty"`
	Name      string   `json:"name,omitempty"`
	UserID    string   `json:"userId,omitempty"`
	Question  string   `json:"question,omitempty"`
	Options   []string `json:"options,omitempty"`
	Multiple  bool     `json:"multiple,omitempty"`
	Video     bool     `json:"video,omitempty"`
	Duration  float64  `json:"duration,omitempty"`
	ReplyTo   *ReplyTo `json:"replyTo,omitempty"`
	Forwarded bool     `json:"forwarded,omitempty"`

	Raw json.RawMessage `json:"-"`
}

// Decrypted is a message with its content opened.
type Decrypted struct {
	Message *Message
	// Content is nil for system messages and messages that are gone.
	Content *Content
	// System is the plain JSON event of a system message.
	System json.RawMessage
	// Err explains why an encrypted message could not be read.
	Err error
}

// Event is a realtime frame from /ws.
type Event struct {
	Type    string          `json:"type"`
	Message *Message        `json:"message,omitempty"`
	ChatID  string          `json:"chatId,omitempty"`
	ID      string          `json:"id,omitempty"`
	UserID  string          `json:"userId,omitempty"`
	Raw     json.RawMessage `json:"-"`
}
