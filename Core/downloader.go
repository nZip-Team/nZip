package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DownloadConfig is the per-request configuration passed to DownloadManager.Run.
type DownloadConfig struct {
	ReqID               string
	Hash                string
	Images              []string
	DownloadDir         string
	Filename            string
	ConcurrentDownloads int
	Debug               bool
	OnProgress          func(completed, total int)
	OnPackStart         func()
}

// DownloadResult is the final outcome of a Run call.
type DownloadResult struct {
	Success   bool
	ErrorCode int // 0x01 = download error, 0x11 = pack/archive error
}

// DownloadManager tracks in-flight downloads and can abort them.
type DownloadManager struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewDownloadManager creates a ready-to-use DownloadManager.
func NewDownloadManager() *DownloadManager {
	return &DownloadManager{
		cancels: make(map[string]context.CancelFunc),
	}
}

// Run executes the download phase then the pack (archive) phase.
// It streams progress updates via cfg.OnProgress and fires cfg.OnPackStart
// once all images are downloaded.
func (dm *DownloadManager) Run(cfg DownloadConfig) DownloadResult {
	ctx, cancel := context.WithCancel(context.Background())
	dm.mu.Lock()
	dm.cancels[cfg.Hash] = cancel
	dm.mu.Unlock()

	defer func() {
		cancel()
		dm.mu.Lock()
		delete(dm.cancels, cfg.Hash)
		dm.mu.Unlock()
	}()

	// Ensure download directory exists.
	if err := os.MkdirAll(cfg.DownloadDir, 0o755); err != nil {
		logErr("Create directory %s: %v", cfg.DownloadDir, err)
		return DownloadResult{ErrorCode: 0x01}
	}

	// Phase 1: download images.
	if !downloadImages(ctx, cfg) {
		return DownloadResult{ErrorCode: 0x01}
	}

	if ctx.Err() != nil {
		return DownloadResult{ErrorCode: 0x01}
	}

	// Phase 2: pack into zip.
	cfg.OnPackStart()
	if err := packZip(ctx, cfg); err != nil {
		logErr("Pack %s: %v", cfg.Hash, err)
		return DownloadResult{ErrorCode: 0x11}
	}

	return DownloadResult{Success: true}
}

// Stop cancels the active download for hash (no-op if not active).
func (dm *DownloadManager) Stop(hash string) {
	dm.mu.Lock()
	cancel, ok := dm.cancels[hash]
	dm.mu.Unlock()
	if ok {
		cancel()
	}
}

// StopAll cancels every active download.
func (dm *DownloadManager) StopAll() {
	dm.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(dm.cancels))
	for _, c := range dm.cancels {
		cancels = append(cancels, c)
	}
	dm.cancels = make(map[string]context.CancelFunc)
	dm.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// HasActive reports whether a download is currently running for hash.
func (dm *DownloadManager) HasActive(hash string) bool {
	dm.mu.Lock()
	_, ok := dm.cancels[hash]
	dm.mu.Unlock()
	return ok
}

// CleanTempFiles removes all files in downloadDir except filename.
func CleanTempFiles(downloadDir, filename string) {
	entries, err := os.ReadDir(downloadDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.Name() != filename {
			_ = os.Remove(filepath.Join(downloadDir, e.Name()))
		}
	}
}

const (
	maxRetries     = 10
	requestTimeout = 10 * time.Second
	retryBaseDelay = 500 * time.Millisecond
)

// downloadImages fetches all images in cfg.Images concurrently.
// Returns true when all were downloaded (or already present) successfully.
func downloadImages(ctx context.Context, cfg DownloadConfig) bool {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	total := len(cfg.Images)
	if total == 0 {
		return true
	}

	queue := make(chan string, total)
	for _, url := range cfg.Images {
		queue <- url
	}
	close(queue)

	var completed atomic.Int64
	var failed atomic.Bool

	client := &http.Client{Timeout: requestTimeout}

	workers := cfg.ConcurrentDownloads
	if workers <= 0 {
		workers = 3
	}
	if workers > total {
		workers = total
	}

	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for url := range queue {
				if ctx.Err() != nil || failed.Load() {
					return
				}
				if err := downloadFileWithRetry(ctx, client, url, cfg.DownloadDir); err != nil {
					if ctx.Err() == nil {
						logErr("Download %s: %v", url, err)
						failed.Store(true)
						cancel()
					}
					return
				}
				n := int(completed.Add(1))
				cfg.OnProgress(n, total)
			}
		})
	}
	wg.Wait()

	return !failed.Load() && ctx.Err() == nil
}

// downloadFileWithRetry fetches url into downloadDir, retrying on transient errors.
func downloadFileWithRetry(ctx context.Context, client *http.Client, rawURL, dir string) error {
	filename := filepath.Base(rawURL) // e.g. "1.jpg"
	dest := filepath.Join(dir, filename)

	// Skip if already downloaded.
	if st, err := os.Stat(dest); err == nil && st.Size() > 0 {
		return nil
	}

	var lastErr error
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt > 0 {
			delay := retryBaseDelay * (1 << (attempt - 1))
			delay = min(delay, 30*time.Second)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		if err := fetchFile(ctx, client, rawURL, dest); err != nil {
			lastErr = err
			if isTemporaryError(err) {
				continue
			}
			return err
		}
		return nil
	}
	return fmt.Errorf("gave up after %d attempts: %w", maxRetries, lastErr)
}

type httpStatusError struct {
	Code int
	URL  string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("HTTP %d for %s", e.Code, e.URL)
}

func userAgent() string {
	version := strings.TrimSpace(os.Getenv("NZIP_VERSION"))
	if version == "" {
		version = strings.TrimSpace(Version)
	}
	if version == "" {
		version = "dev"
	}
	return fmt.Sprintf("nZip/%s (+https://github.com/nZip-Team/nZip)", version)
}

// isTemporaryError reports whether err is worth retrying.
func isTemporaryError(err error) bool {
	if err == nil {
		return false
	}

	if errors.Is(err, context.Canceled) {
		return false
	}

	if netErr, ok := errors.AsType[net.Error](err); ok {
		if netErr.Timeout() {
			return true
		}
	}

	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}

	if statusErr, ok := errors.AsType[*httpStatusError](err); ok {
		if statusErr.Code == http.StatusRequestTimeout ||
			statusErr.Code == http.StatusTooEarly ||
			statusErr.Code == http.StatusTooManyRequests ||
			statusErr.Code >= http.StatusInternalServerError {
			return true
		}
		return false
	}

	return false
}

// fetchFile downloads rawURL and atomically writes it to dest.
func fetchFile(ctx context.Context, client *http.Client, rawURL, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent())

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &httpStatusError{Code: resp.StatusCode, URL: rawURL}
	}

	// Write to a temp file then rename for atomicity.
	tmp := dest + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}

	_, err = io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}
