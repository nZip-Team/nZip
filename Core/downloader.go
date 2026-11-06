package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
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

var (
	errEmptyBody      = errors.New("empty response body")
	errBodyStalled    = errors.New("response body stalled")
	errAttemptTimeout = errors.New("attempt took too long")
)

// permanentError marks a failure retrying cannot fix.
type permanentError struct{ err error }

func (e *permanentError) Error() string { return e.err.Error() }
func (e *permanentError) Unwrap() error { return e.err }

func permanent(err error) error { return &permanentError{err: err} }

// notImageError: hosts behind a challenge page answer 200 with HTML.
type notImageError struct {
	ContentType string
	URL         string
}

func (e *notImageError) Error() string {
	return fmt.Sprintf("%s is %s, not an image", e.URL, e.ContentType)
}

// activeRun is one Run; runs of the same hash can overlap, so each is tracked on its own.
type activeRun struct {
	cancel context.CancelFunc
}

// DownloadManager tracks in-flight downloads and can abort them.
type DownloadManager struct {
	mu   sync.Mutex
	runs map[string]map[*activeRun]struct{}
}

// NewDownloadManager creates a ready-to-use DownloadManager.
func NewDownloadManager() *DownloadManager {
	return &DownloadManager{
		runs: make(map[string]map[*activeRun]struct{}),
	}
}

// Run executes the download phase then the pack (archive) phase.
// It streams progress updates via cfg.OnProgress and fires cfg.OnPackStart
// once all images are downloaded.
func (dm *DownloadManager) Run(parent context.Context, cfg DownloadConfig) DownloadResult {
	ctx, cancel := context.WithCancel(parent)
	run := &activeRun{cancel: cancel}
	dm.mu.Lock()
	if dm.runs[cfg.Hash] == nil {
		dm.runs[cfg.Hash] = make(map[*activeRun]struct{})
	}
	dm.runs[cfg.Hash][run] = struct{}{}
	dm.mu.Unlock()

	defer func() {
		cancel()
		dm.mu.Lock()
		delete(dm.runs[cfg.Hash], run)
		if len(dm.runs[cfg.Hash]) == 0 {
			delete(dm.runs, cfg.Hash)
		}
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
	skipped, err := packArchives(ctx, cfg)
	if err != nil {
		logErr("Pack %s: %v", cfg.Hash, err)
		return DownloadResult{ErrorCode: 0x11}
	}

	// A page the packer had to leave out makes the archive partial, same as a failed download.
	missing = append(missing, skipped...)
	slices.Sort(missing)
	return DownloadResult{Success: true, MissingPages: slices.Compact(missing)}
}

// Stop cancels the active downloads for hash (no-op if not active).
func (dm *DownloadManager) Stop(hash string) {
	dm.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(dm.runs[hash]))
	for run := range dm.runs[hash] {
		cancels = append(cancels, run.cancel)
	}
	dm.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// StopAll cancels every active download.
func (dm *DownloadManager) StopAll() {
	dm.mu.Lock()
	var cancels []context.CancelFunc
	for _, runs := range dm.runs {
		for run := range runs {
			cancels = append(cancels, run.cancel)
		}
	}
	dm.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// HasActive reports whether a download is currently running for hash.
func (dm *DownloadManager) HasActive(hash string) bool {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return len(dm.runs[hash]) > 0
}

// tempFileMaxAge: anything younger may belong to a build or download still running, here or on another replica.
const tempFileMaxAge = 15 * time.Minute

// CleanTempFiles removes leftover temporary pack files while preserving the
// downloaded images and completed archives for reuse.
func CleanTempFiles(downloadDir, filename string) {
	entries, err := os.ReadDir(downloadDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".lock") && archiveLockHeld(filepath.Join(downloadDir, e.Name())) {
			return
		}
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		info, err := e.Info()
		if err != nil || time.Since(info.ModTime()) < tempFileMaxAge {
			continue
		}
		_ = os.Remove(filepath.Join(downloadDir, e.Name()))
	}
}

const (
	maxRetries                 = 4
	responseHeaderTimeout      = 10 * time.Second
	defaultConcurrentDownloads = 3
)

// Vars so tests can shorten them.
var (
	retryBaseDelay = 500 * time.Millisecond
	retryMaxDelay  = 30 * time.Second
	maxRetryAfter  = 30 * time.Second
	// bodyIdleTimeout resets on every chunk, so slow hosts can still deliver a large page.
	bodyIdleTimeout = 15 * time.Second
	attemptTimeout  = 5 * time.Minute
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

	// No client Timeout: it would cover the whole body. fetchFile bounds each attempt instead.
	c := &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:          128,
			MaxIdleConnsPerHost:   concurrency,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: responseHeaderTimeout,
			ForceAttemptHTTP2:     true,
		},
	}
	httpClients[concurrency] = c
	return c
}

type downloadItem struct {
	page int // 1-based
	url  string
}

// pageFileName names a page after its number, keeping only a known image extension from the URL.
func pageFileName(page int, rawURL string) (string, error) {
	p := rawURL
	if u, err := url.Parse(rawURL); err == nil {
		p = u.Path
	}
	ext := strings.ToLower(path.Ext(p))
	if !isDownloadImageFile(ext) {
		return "", fmt.Errorf("page %d: unsupported image extension %q", page, ext)
	}
	return strconv.Itoa(page) + ext, nil
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
				name, err := pageFileName(item.page, item.url)
				if err == nil {
					err = downloadFileWithRetry(ctx, client, item.url, filepath.Join(cfg.DownloadDir, name))
				}
				if err != nil {
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

// downloadFileWithRetry fetches url into dest, retrying on transient errors.
func downloadFileWithRetry(ctx context.Context, client *http.Client, rawURL, dest string) error {
	// Skip if already downloaded; an older build may have saved a challenge page here.
	if isImageFile(dest) {
		return nil
	}

	var lastErr error
	for attempt := range maxRetries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(retryDelay(attempt, lastErr)):
			}
		}
		err := fetchFile(ctx, client, rawURL, dest)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if statusErr, ok := errors.AsType[*httpStatusError](err); ok && (statusErr.Code == http.StatusNotFound || statusErr.Code == http.StatusGone) {
			return fmt.Errorf("%s: %w", filepath.Base(dest), errPageMissing)
		}
		lastErr = err
		if !isTemporaryError(err) {
			return err
		}
	}
	return fmt.Errorf("gave up after %d attempts: %w", maxRetries, lastErr)
}

// retryDelay is exponential backoff with jitter, stretched to a server's Retry-After.
func retryDelay(attempt int, lastErr error) time.Duration {
	delay := min(retryBaseDelay*(1<<(attempt-1)), retryMaxDelay)
	if statusErr, ok := errors.AsType[*httpStatusError](lastErr); ok && statusErr.RetryAfter > delay {
		delay = min(statusErr.RetryAfter, maxRetryAfter)
	}
	return delay + rand.N(delay/2+1)
}

type httpStatusError struct {
	Code       int
	URL        string
	RetryAfter time.Duration
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("HTTP %d for %s", e.Code, e.URL)
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return max(0, time.Duration(secs)*time.Second)
	}
	if t, err := http.ParseTime(v); err == nil {
		return max(0, time.Until(t))
	}
	return 0
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

// isTemporaryError reports whether err is worth retrying: anything but an abort,
// a 4xx other than 408/425/429, or a failure marked permanent.
func isTemporaryError(err error) bool {
	if err == nil {
		return false
	}

	if netErr, ok := errors.AsType[net.Error](err); ok && netErr.Timeout() {
		return true
	}

	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	if _, ok := errors.AsType[*permanentError](err); ok {
		return false
	}

	if statusErr, ok := errors.AsType[*httpStatusError](err); ok && statusErr.Code >= 400 && statusErr.Code < 500 {
		return statusErr.Code == http.StatusRequestTimeout ||
			statusErr.Code == http.StatusTooEarly ||
			statusErr.Code == http.StatusTooManyRequests
	}

	return true
}

// maxImageBytes caps what a third-party image host can write to the cache volume.
var maxImageBytes int64 = 64 << 20

const sniffLen = 512

func isImageContent(head []byte) bool {
	return len(head) > 0 && strings.HasPrefix(http.DetectContentType(head), "image/")
}

// isImageFile reports whether p exists and starts like an image.
func isImageFile(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, sniffLen)
	n, _ := io.ReadFull(f, head)
	return isImageContent(head[:n])
}

// progressReader calls onRead whenever bytes arrive.
type progressReader struct {
	r      io.Reader
	onRead func()
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.onRead()
	}
	return n, err
}

// fetchFile runs one download attempt, aborted if the body stalls or the attempt drags on.
func fetchFile(ctx context.Context, client *http.Client, rawURL, dest string) error {
	timeoutCtx, cancelTimeout := context.WithTimeoutCause(ctx, attemptTimeout, errAttemptTimeout)
	defer cancelTimeout()
	attemptCtx, cancel := context.WithCancelCause(timeoutCtx)
	defer cancel(nil)

	stall := time.AfterFunc(bodyIdleTimeout, func() { cancel(errBodyStalled) })
	defer stall.Stop()

	err := fetchFileAttempt(attemptCtx, client, rawURL, dest, func() { stall.Reset(bodyIdleTimeout) })
	if err != nil && ctx.Err() == nil && attemptCtx.Err() != nil {
		return fmt.Errorf("%s: %w", rawURL, context.Cause(attemptCtx))
	}
	return err
}

// fetchFileAttempt downloads rawURL and atomically writes it to dest.
func fetchFileAttempt(ctx context.Context, client *http.Client, rawURL, dest string, onRead func()) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return permanent(err)
	}
	req.Header.Set("User-Agent", userAgent())

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		statusErr := &httpStatusError{Code: resp.StatusCode, URL: rawURL}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
			statusErr.RetryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
		}
		return statusErr
	}

	if resp.ContentLength > maxImageBytes {
		return permanent(fmt.Errorf("image %s is %d bytes, over the %d byte limit", rawURL, resp.ContentLength, maxImageBytes))
	}

	// One byte past the limit, so oversized bodies are detected, not truncated
	body := &progressReader{r: io.LimitReader(resp.Body, maxImageBytes+1), onRead: onRead}

	head := make([]byte, sniffLen)
	n, err := io.ReadFull(body, head)
	switch {
	case errors.Is(err, io.EOF):
		return fmt.Errorf("%s: %w", rawURL, errEmptyBody)
	case err != nil && !errors.Is(err, io.ErrUnexpectedEOF):
		return err
	}
	head = head[:n]
	if !isImageContent(head) {
		return &notImageError{ContentType: http.DetectContentType(head), URL: rawURL}
	}

	f, err := createTemp(filepath.Dir(dest), "."+filepath.Base(dest)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	committed := false
	defer func() {
		if !committed {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()

	if _, err := f.Write(head); err != nil {
		return err
	}
	written, err := io.Copy(f, body)
	if err != nil {
		return err
	}
	if int64(n)+written > maxImageBytes {
		return permanent(fmt.Errorf("image %s exceeds the %d byte limit", rawURL, maxImageBytes))
	}

	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	committed = true
	return nil
}
