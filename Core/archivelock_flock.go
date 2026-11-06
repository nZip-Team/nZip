//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// tryArchiveLock takes an flock on lockPath without blocking; nil release means another holder has it.
// The kernel drops the lock when its holder dies, so a crash leaves no stale lock behind, and it
// holds across containers sharing a local volume.
func tryArchiveLock(lockPath string) (func(), error) {
	for range 8 {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			return nil, err
		}

		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			_ = f.Close()
			if errors.Is(err, syscall.EWOULDBLOCK) {
				return nil, nil
			}
			return nil, err
		}

		// The previous holder unlinks the file on release; a lock on that orphaned inode guards nothing.
		held, statErr := f.Stat()
		current, pathErr := os.Stat(lockPath)
		if statErr != nil || pathErr != nil || !os.SameFile(held, current) {
			_ = f.Close()
			continue
		}

		_ = f.Truncate(0)
		_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
		return func() {
			_ = os.Remove(lockPath)
			_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
			_ = f.Close()
		}, nil
	}
	return nil, nil
}

// archiveLockHeld reports whether a live process holds the lock at lockPath.
func archiveLockHeld(lockPath string) bool {
	f, err := os.Open(lockPath)
	if err != nil {
		return false
	}
	defer f.Close()

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.Is(err, syscall.EWOULDBLOCK)
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}
