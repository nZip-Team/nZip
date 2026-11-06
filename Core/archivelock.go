package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const archiveLockPollInterval = 200 * time.Millisecond

// buildArchiveFile writes outputPath once across processes and replicas sharing the volume:
// it takes the build lock, then a slot of slots (nil for none), and renames a synced temp file in.
func buildArchiveFile(ctx context.Context, outputPath string, slots chan struct{}, build func(f *os.File) error) error {
	if archiveExists(outputPath) {
		return nil
	}

	release, err := acquireArchiveBuildLock(ctx, outputPath)
	if err != nil {
		return err
	}
	if release == nil {
		return nil
	}
	defer release()

	if archiveExists(outputPath) {
		return nil
	}

	// After the lock, so waiting on another replica's build does not hold a slot.
	if slots != nil {
		releaseSlot, err := acquireSlot(ctx, slots)
		if err != nil {
			return err
		}
		defer releaseSlot()
	}

	tmpFile, err := createTemp(filepath.Dir(outputPath), archiveSiblingName(outputPath)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	committed := false
	defer func() {
		if !committed {
			_ = tmpFile.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	if err := build(tmpFile); err != nil {
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		return fmt.Errorf("sync archive: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close archive: %w", err)
	}

	if archiveExists(outputPath) {
		return nil
	}

	if err := os.Rename(tmpPath, outputPath); err != nil {
		if archiveExists(outputPath) {
			return nil
		}
		return fmt.Errorf("rename archive: %w", err)
	}
	committed = true

	return nil
}

func archiveExists(outputPath string) bool {
	st, err := os.Stat(outputPath)
	return err == nil && st.Size() > 0
}

// archiveSiblingName names the lock and temp files kept next to an archive
// after its format (".zip", ".epub", ...) instead of after the archive. The
// archive's name carries the gallery title and can sit right at the 255-byte
// filename limit, so anything appended to it fails with "file name too long".
// Every gallery packs into its own directory, so the format is enough to keep
// these apart; two builds of one format there only share a lock.
func archiveSiblingName(outputPath string) string {
	return "." + strings.TrimPrefix(strings.ToLower(filepath.Ext(outputPath)), ".")
}

func archiveLockPath(outputPath string) string {
	return filepath.Join(filepath.Dir(outputPath), archiveSiblingName(outputPath)+".lock")
}

// acquireArchiveBuildLock waits for the build lock of outputPath. It returns a nil release
// when another holder finished the archive meanwhile.
func acquireArchiveBuildLock(ctx context.Context, outputPath string) (func(), error) {
	lockPath := archiveLockPath(outputPath)

	for {
		release, err := tryArchiveLock(lockPath)
		if err != nil {
			return nil, fmt.Errorf("acquire archive lock: %w", err)
		}
		if release != nil {
			return release, nil
		}

		if archiveExists(outputPath) {
			return nil, nil
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(archiveLockPollInterval):
		}
	}
}
