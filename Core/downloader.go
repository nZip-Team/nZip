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
	"slices"
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
	MaxMissingPages     int // pages that may fail for other reasons than 404/410; 0 = max(2, 2% of the gallery)
	Debug               bool
	OnProgress          func(completed, total int)
	OnPackStart         func()
}

// DownloadResult is the final outcome of a Run call.
type DownloadResult struct {
	Success      bool
	ErrorCode    int   // 0x01 = download error, 0x03 = no page available, 0x11 = pack/archive error
	MissingPages []int // 1-based page numbers left out of the archives
}

// errPageMissing: galleries can lose images, so a 404/410 page is skipped without limit.
var errPageMissing = errors.New("page not available")

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
	missing, err := downloadImages(ctx, cfg)
	if err != nil {
		logErr("Download %s: %v", cfg.Hash, err)
		return DownloadResult{ErrorCode: 0x01}
	}

	if len(missing) > 0 && len(missing) >= len(cfg.Images) {
		logWarn("Download %s: none of the %d page(s) are available", cfg.Hash, len(missing))
		return DownloadResult{ErrorCode: 0x03, MissingPages: missing}
	}

	// Phase 2: pack into the downloadable archives.
	cfg.OnPackStart()
	if err := packArchives(ctx, cfg); err != nil {
		logErr("Pack %s: %v", cfg.Hash, err)
		return DownloadResult{ErrorCode: 0x11}
	}

	return DownloadResult{Success: true, MissingPages: missing}
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

// CleanTempFiles removes leftover temporary pack files while preserving the
// downloaded images and completed archives for reuse.
func CleanTempFiles(downloadDir, filename string) {
	entries, err := os.ReadDir(downloadDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			_ = os.Remove(filepath.Join(downloadDir, e.Name()))
		}
	}
}

const (
	maxRetries                 = 4
	requestTimeout             = 10 * time.Second
	retryBaseDelay             = 500 * time.Millisecond
	defaultConcurrentDownloads = 3
)

// Cached per worker count so idle connections survive between galleries.
var (
	httpClientMu sync.Mutex
	httpClients  = map[int]*http.Client{}
)

func downloadHTTPClient(concurrency int) *http.Client {
	if concurrency <= 0 {
		concurrency = defaultConcurrentDownloads
	}

	httpClientMu.Lock()
	defer httpClientMu.Unlock()

	if c, ok := httpClients[concurrency]; ok {
		return c
	}

	c := &http.Client{
		Timeout: requestTimeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			MaxIdleConns:        128,
			MaxIdleConnsPerHost: concurrency,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
			ForceAttemptHTTP2:   true,
		},
	}
	httpClients[concurrency] = c
	return c
}

type downloadItem struct {
	page int // 1-based
	url  string
}

// missingPageBudget is how many pages may fail (other than 404/410) before the run fails.
func missingPageBudget(cfg DownloadConfig, total int) int {
	if cfg.MaxMissingPages > 0 {
		return cfg.MaxMissingPages
	}
	return max(2, total*2/100)
}

// downloadImages returns the 1-based numbers of the pages left out. It errors on abort, or when
// more pages failed than the budget allows; pages the host does not have (404/410) don't count.
func downloadImages(ctx context.Context, cfg DownloadConfig) ([]int, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	total := len(cfg.Images)
	if total == 0 {
		return nil, nil
	}

	queue := make(chan downloadItem, total)
	for i, url := range cfg.Images {
		queue <- downloadItem{page: i + 1, url: url}
	}
	close(queue)

	client := downloadHTTPClient(cfg.ConcurrentDownloads)

	workers := cfg.ConcurrentDownloads
	if workers <= 0 {
		workers = defaultConcurrentDownloads
	}
	if workers > total {
		workers = total
	}

	budget := missingPageBudget(cfg, total)

	var (
		completed atomic.Int64
		mu        sync.Mutex
		missing   []int
		failed    int
		exceeded  bool
	)

	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for item := range queue {
				if ctx.Err() != nil {
					return
				}
				if err := downloadFileWithRetry(ctx, client, item.url, cfg.DownloadDir); err != nil {
					if ctx.Err() != nil {
						return
					}

					gone := errors.Is(err, errPageMissing)
					if !gone {
						logErr("Download page %d (%s): %v", item.page, item.url, err)
					}

					mu.Lock()
					missing = append(missing, item.page)
					if !gone {
						failed++
					}
					over := failed > budget
					exceeded = exceeded || over
					mu.Unlock()

					if over {
						cancel()
						return
					}
				}
				cfg.OnProgress(int(completed.Add(1)), total)
			}
		})
	}
	wg.Wait()

	if exceeded {
		return nil, fmt.Errorf("%d of %d pages failed, over the limit of %d", failed, total, budget)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	slices.Sort(missing)
	if len(missing) > 0 && len(missing) < total {
		logWarn("Download %s: continuing without %d of %d page(s): %v", cfg.Hash, len(missing), total, missing)
	}
	return missing, nil
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
			if statusErr, ok := errors.AsType[*httpStatusError](err); ok && (statusErr.Code == http.StatusNotFound || statusErr.Code == http.StatusGone) {
				return fmt.Errorf("%s: %w", filename, errPageMissing)
			}
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

// maxImageBytes caps what a third-party image host can write to the cache volume.
const maxImageBytes = 64 << 20

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

	if resp.ContentLength > maxImageBytes {
		return fmt.Errorf("image %s is %d bytes, over the %d byte limit", rawURL, resp.ContentLength, maxImageBytes)
	}

	// Write to a temp file then rename for atomicity.
	tmp := dest + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}

	// One byte past the limit, so oversized bodies are detected, not truncated
	written, err := io.Copy(f, io.LimitReader(resp.Body, maxImageBytes+1))
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}

	if written > maxImageBytes {
		os.Remove(tmp)
		return fmt.Errorf("image %s exceeds the %d byte limit", rawURL, maxImageBytes)
	}

	return os.Rename(tmp, dest)
}
