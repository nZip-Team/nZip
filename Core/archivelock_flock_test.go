//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package main

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestArchiveLockLeftoverFileIsFree(t *testing.T) {
	out := filepath.Join(t.TempDir(), "gallery.zip")
	// What a crashed holder leaves: the file, but no lock on it.
	if err := os.WriteFile(archiveLockPath(out), []byte("12345\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := buildArchiveFile(ctx, out, nil, func(f *os.File) error {
		_, err := f.WriteString("ok")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if !archiveExists(out) {
		t.Fatal("archive not built")
	}
}

func TestArchiveLockReleasedWhenHolderFdCloses(t *testing.T) {
	out := filepath.Join(t.TempDir(), "gallery.epub")
	holder, err := os.OpenFile(archiveLockPath(out), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(holder.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	if !archiveLockHeld(archiveLockPath(out)) {
		t.Fatal("held lock not reported")
	}

	// The kernel drops an flock with its last fd, as it does when the holder process dies.
	time.AfterFunc(300*time.Millisecond, func() { holder.Close() })

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := buildArchiveFile(ctx, out, nil, func(f *os.File) error {
		_, err := f.WriteString("ok")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatal("built while the lock was held")
	}
	if _, err := os.Stat(archiveLockPath(out)); !os.IsNotExist(err) {
		t.Fatal("lock file left behind")
	}
}
