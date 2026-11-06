//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package main

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// Without flock the lock is an exclusive-create file whose mtime the holder keeps fresh;
// one left untouched for archiveLockStaleAfter belongs to a dead process.
const (
	archiveLockStaleAfter   = 15 * time.Minute
	archiveLockRefreshEvery = time.Minute
)

func tryArchiveLock(lockPath string) (func(), error) {
	for range 2 {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = fmt.Fprintf(f, "%d\n%d\n", os.Getpid(), time.Now().Unix())
			_ = f.Close()

			stop := make(chan struct{})
			go func() {
				ticker := time.NewTicker(archiveLockRefreshEvery)
				defer ticker.Stop()
				for {
					select {
					case <-stop:
						return
					case now := <-ticker.C:
						_ = os.Chtimes(lockPath, now, now)
					}
				}
			}()
			return func() {
				close(stop)
				_ = os.Remove(lockPath)
			}, nil
		}

		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if !isStaleArchiveLock(lockPath) {
			return nil, nil
		}
		_ = os.Remove(lockPath)
	}
	return nil, nil
}

func archiveLockHeld(lockPath string) bool {
	_, err := os.Stat(lockPath)
	return err == nil && !isStaleArchiveLock(lockPath)
}

func isStaleArchiveLock(lockPath string) bool {
	st, err := os.Stat(lockPath)
	if err != nil {
		return false
	}
	return time.Since(st.ModTime()) > archiveLockStaleAfter
}
