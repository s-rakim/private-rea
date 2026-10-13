//go:build !unix

package testserver

import (
	"os/exec"
	"time"
)

func setProcessGroup(*exec.Cmd) {}

func stopProcess(cmd *exec.Cmd, done <-chan struct{}) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}
