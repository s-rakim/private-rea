//go:build unix

package testserver

import (
	"os/exec"
	"syscall"
	"time"
)

// The server runs in its own process group so `sh -c` wrappers and any
// children are stopped with it.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func stopProcess(cmd *exec.Cmd, done <-chan struct{}) {
	if cmd.Process == nil {
		return
	}
	pgid := -cmd.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(pgid, syscall.SIGKILL)
		<-done
	}
	// Reap anything left in the group (e.g. a child of sh -c).
	_ = syscall.Kill(pgid, syscall.SIGKILL)
}
