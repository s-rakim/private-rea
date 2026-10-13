package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/s-rakim/private-rea/tailchat/clients/go/internal/e2ee"
)

// State is what a registered device keeps on disk: its private key and bearer
// token. The file is written with mode 0600.
type State struct {
	Server     string         `json:"server"`
	DevUser    string         `json:"devUser,omitempty"`
	UserID     string         `json:"userId"`
	DeviceID   string         `json:"deviceId"`
	DeviceName string         `json:"deviceName"`
	Token      string         `json:"token"`
	PrivateKey string         `json:"privateKey"` // b64u P-256 scalar
	PublicKey  e2ee.PublicJWK `json:"publicKey"`
}

// LoadState reads a state file. A missing file returns an error matching
// os.ErrNotExist. Files readable by other users are refused, like ssh keys.
func LoadState(path string) (*State, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if runtime.GOOS != "windows" {
		info, err := f.Stat()
		if err != nil {
			return nil, err
		}
		if info.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("%s holds a private key but is accessible by other users (mode %o): run chmod 600 %s", path, info.Mode().Perm(), path)
		}
	}
	var st State
	if err := json.NewDecoder(f).Decode(&st); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if st.DeviceID == "" || st.Token == "" || st.PrivateKey == "" {
		return nil, fmt.Errorf("%s is incomplete", path)
	}
	return &st, nil
}

// Save writes the state atomically with mode 0600 (directory 0700).
func (st *State) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tailchat-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ErrNoState is returned by Open when no device is registered yet.
var ErrNoState = errors.New("this device is not registered yet")
