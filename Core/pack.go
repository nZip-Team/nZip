package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Format builds hammer the cache volume, so requests queue instead of piling up.
// gofpdf holds every page of a PDF in memory until it is written, so PDFs get their own, smaller limit.
var (
	packSlots = make(chan struct{}, max(1, runtime.GOMAXPROCS(0)))
	pdfSlots  = make(chan struct{}, 1)
)

// packFormatTimeout bounds one packFormat request, lock wait included.
const packFormatTimeout = 30 * time.Minute

// acquireSlot blocks until a slot of slots is free, or ctx is done.
func acquireSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// packArchives creates the initial fast-path download artifact and returns the pages it had to leave out.
func packArchives(ctx context.Context, cfg DownloadConfig) ([]int, error) {
	filePaths, skipped, err := collectExistingImageFiles(cfg)
	if err != nil {
		return nil, err
	}

	zipPath := filepath.Join(cfg.DownloadDir, cfg.Filename)
	if err := packZipLike(ctx, filePaths, zipPath, nil, nil); err != nil {
		return nil, fmt.Errorf("pack zip: %w", err)
	}

	logInfo("Pack archives: created %s", filepath.Base(zipPath))
	return skipped, nil
}

func packArchiveFormat(ctx context.Context, cfg DownloadConfig, format string) error {
	filePaths, _, err := collectExistingImageFiles(cfg)
	if err != nil {
		return err
	}

	basePath := filepath.Join(cfg.DownloadDir, cfg.Filename)
	switch format {
	case "zip":
		return packZipLike(ctx, filePaths, archivePathWithExt(basePath, ".zip"), packSlots, nil)
	case "cbz":
		return packZipLike(ctx, filePaths, archivePathWithExt(basePath, ".cbz"), packSlots, cbzEntryNamer(filePaths))
	case "pdf":
		return packPDF(ctx, filePaths, archivePathWithExt(basePath, ".pdf"))
	case "epub":
		title := strings.TrimSuffix(filepath.Base(cfg.Filename), filepath.Ext(cfg.Filename))
		return packEPUB(ctx, filePaths, archivePathWithExt(basePath, ".epub"), title, cfg.Hash)
	default:
		return fmt.Errorf("unsupported archive format: %s", format)
	}
}

// collectExistingImageFiles lists the page files to pack, and the 1-based pages left out.
func collectExistingImageFiles(cfg DownloadConfig) ([]string, []int, error) {
	if len(cfg.Images) == 0 {
		filePaths, err := collectExistingImageFilesFromDisk(cfg.DownloadDir, cfg.Hash)
		return filePaths, nil, err
	}

	var (
		filePaths []string
		skipped   []int
	)
	for i, url := range cfg.Images {
		name, err := pageFileName(i+1, url)
		if err != nil {
			logWarn("Pack archives: skipping page %d for %s: %v", i+1, cfg.Hash, err)
			skipped = append(skipped, i+1)
			continue
		}
		p := filepath.Join(cfg.DownloadDir, name)
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			filePaths = append(filePaths, p)
		} else {
			logWarn("Pack archives: skipping missing/empty file %s for %s", name, cfg.Hash)
			skipped = append(skipped, i+1)
		}
	}
	if len(filePaths) == 0 {
		return nil, skipped, fmt.Errorf("no files to pack for %s", cfg.Hash)
	}
	return filePaths, skipped, nil
}

func collectExistingImageFilesFromDisk(downloadDir, hash string) ([]string, error) {
	entries, err := os.ReadDir(downloadDir)
	if err != nil {
		return nil, fmt.Errorf("read download directory for %s: %w", hash, err)
	}

	filePaths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !isDownloadImageFile(entry.Name()) {
			continue
		}

		p := filepath.Join(downloadDir, entry.Name())
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			filePaths = append(filePaths, p)
		} else {
			logWarn("Pack archives: skipping missing/empty file %s for %s", entry.Name(), hash)
		}
	}

	sort.Slice(filePaths, func(i, j int) bool {
		return compareArchiveImageNames(filepath.Base(filePaths[i]), filepath.Base(filePaths[j])) < 0
	})

	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no files to pack for %s", hash)
	}

	return filePaths, nil
}

func isDownloadImageFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		return true
	default:
		return false
	}
}

func compareArchiveImageNames(left, right string) int {
	leftStem := strings.TrimSuffix(left, filepath.Ext(left))
	rightStem := strings.TrimSuffix(right, filepath.Ext(right))

	leftNum, leftErr := strconv.Atoi(leftStem)
	rightNum, rightErr := strconv.Atoi(rightStem)

	if leftErr == nil && rightErr == nil {
		switch {
		case leftNum < rightNum:
			return -1
		case leftNum > rightNum:
			return 1
		default:
			return strings.Compare(left, right)
		}
	}

	return strings.Compare(left, right)
}

func archivePathWithExt(src, ext string) string {
	return strings.TrimSuffix(src, filepath.Ext(src)) + ext
}
