package main

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testPNG(t testing.TB, w, h int) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = uint8(i)
	}
	img.Set(0, 0, color.Gray{Y: 7})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fastDownloads shrinks the retry and stall timings for the test.
func fastDownloads(t *testing.T) {
	t.Helper()
	base, maxDelay, idle := retryBaseDelay, retryMaxDelay, bodyIdleTimeout
	retryBaseDelay, retryMaxDelay, bodyIdleTimeout = time.Millisecond, 5*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { retryBaseDelay, retryMaxDelay, bodyIdleTimeout = base, maxDelay, idle })
}

type pageServer struct {
	*httptest.Server
	mu    sync.Mutex
	hits  map[string]int
	serve func(w http.ResponseWriter, r *http.Request, attempt int)
}

func newPageServer(t *testing.T, serve func(w http.ResponseWriter, r *http.Request, attempt int)) *pageServer {
	ps := &pageServer{hits: map[string]int{}, serve: serve}
	ps.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ps.mu.Lock()
		ps.hits[r.URL.Path]++
		attempt := ps.hits[r.URL.Path]
		ps.mu.Unlock()
		ps.serve(w, r, attempt)
	}))
	t.Cleanup(ps.Close)
	return ps
}

func (ps *pageServer) attempts(p string) int {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.hits[p]
}

func testConfig(t *testing.T, base string, pages int) DownloadConfig {
	images := make([]string, pages)
	for i := range images {
		images[i] = base + "/g/" + string(rune('1'+i)) + ".png"
	}
	return DownloadConfig{
		Hash:                "h",
		Images:              images,
		DownloadDir:         t.TempDir(),
		Filename:            "out.zip",
		ConcurrentDownloads: 2,
		OnProgress:          func(int, int) {},
		OnPackStart:         func() {},
	}
}

func TestDownloadImagesSkipsGonePages(t *testing.T) {
	fastDownloads(t)
	img := testPNG(t, 4, 4)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		switch r.URL.Path {
		case "/g/2.png":
			w.WriteHeader(http.StatusNotFound)
		case "/g/3.png":
			w.WriteHeader(http.StatusGone)
		default:
			w.Write(img)
		}
	})
	cfg := testConfig(t, ps.URL, 4)
	cfg.MaxMissingPages = 1

	missing, err := downloadImages(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(missing, []int{2, 3}) {
		t.Fatalf("missing = %v", missing)
	}
	if ps.attempts("/g/2.png") != 1 {
		t.Fatalf("404 retried %d times", ps.attempts("/g/2.png"))
	}
}

func TestDownloadImagesRetriesTransientFailures(t *testing.T) {
	fastDownloads(t)
	img := testPNG(t, 4, 4)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, attempt int) {
		switch {
		case r.URL.Path == "/g/1.png" && attempt == 1:
			w.WriteHeader(http.StatusInternalServerError)
		case r.URL.Path == "/g/2.png" && attempt == 1:
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
		case r.URL.Path == "/g/3.png" && attempt == 1:
			// 200 with nothing in it
		case r.URL.Path == "/g/4.png" && attempt < 3:
			w.Write([]byte("<!DOCTYPE html><html><body>Just a moment...</body></html>"))
		default:
			w.Write(img)
		}
	})
	cfg := testConfig(t, ps.URL, 4)

	missing, err := downloadImages(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 {
		t.Fatalf("missing = %v", missing)
	}
	for i := 1; i <= 4; i++ {
		data, err := os.ReadFile(filepath.Join(cfg.DownloadDir, string(rune('0'+i))+".png"))
		if err != nil || !bytes.Equal(data, img) {
			t.Fatalf("page %d not saved intact: %v", i, err)
		}
	}
}

func TestDownloadImagesEmptyAndHTMLBodiesFail(t *testing.T) {
	fastDownloads(t)
	img := testPNG(t, 4, 4)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		switch r.URL.Path {
		case "/g/1.png":
		case "/g/2.png":
			w.Write([]byte("<html><head><title>Attention Required</title></head></html>"))
		default:
			w.Write(img)
		}
	})
	cfg := testConfig(t, ps.URL, 3)
	cfg.MaxMissingPages = 2

	missing, err := downloadImages(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(missing, []int{1, 2}) {
		t.Fatalf("missing = %v", missing)
	}
	if got := ps.attempts("/g/2.png"); got != maxRetries {
		t.Fatalf("html page tried %d times, want %d", got, maxRetries)
	}
	for _, name := range []string{"1.png", "2.png"} {
		if _, err := os.Stat(filepath.Join(cfg.DownloadDir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s was saved: %v", name, err)
		}
	}
	entries, _ := os.ReadDir(cfg.DownloadDir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestDownloadImagesSlowBody(t *testing.T) {
	fastDownloads(t)
	img := testPNG(t, 64, 64)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, attempt int) {
		flusher := w.(http.Flusher)
		switch r.URL.Path {
		case "/g/1.png":
			// Steady trickle: slower overall than the idle timeout, but never idle that long.
			chunk := (len(img) + 7) / 8
			for i := 0; i < len(img); i += chunk {
				w.Write(img[i:min(i+chunk, len(img))])
				flusher.Flush()
				time.Sleep(80 * time.Millisecond)
			}
		case "/g/2.png":
			if attempt == 1 {
				w.Write(img[:600])
				flusher.Flush()
				select {
				case <-r.Context().Done():
				case <-time.After(3 * time.Second):
				}
				return
			}
			w.Write(img)
		}
	})
	cfg := testConfig(t, ps.URL, 2)

	missing, err := downloadImages(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 {
		t.Fatalf("missing = %v", missing)
	}
	if ps.attempts("/g/1.png") != 1 {
		t.Fatalf("trickling page restarted %d times", ps.attempts("/g/1.png"))
	}
	if ps.attempts("/g/2.png") != 2 {
		t.Fatalf("stalled page tried %d times, want 2", ps.attempts("/g/2.png"))
	}
}

func TestDownloadImagesBudgetExceeded(t *testing.T) {
	fastDownloads(t)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.WriteHeader(http.StatusBadGateway)
	})
	cfg := testConfig(t, ps.URL, 6)
	cfg.MaxMissingPages = 2

	if _, err := downloadImages(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "over the limit") {
		t.Fatalf("err = %v", err)
	}
}

func TestDownloadImagesCancel(t *testing.T) {
	fastDownloads(t)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		<-r.Context().Done()
	})
	cfg := testConfig(t, ps.URL, 3)

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	start := time.Now()
	_, err := downloadImages(ctx, cfg)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("cancel took %s", time.Since(start))
	}
}

func TestIsTemporaryError(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{&httpStatusError{Code: 500}, true},
		{&httpStatusError{Code: 503}, true},
		{&httpStatusError{Code: 429}, true},
		{&httpStatusError{Code: 408}, true},
		{&httpStatusError{Code: 403}, false},
		{&httpStatusError{Code: 400}, false},
		{errors.New("read: connection reset by peer"), true},
		{errEmptyBody, true},
		{&notImageError{}, true},
		{permanent(errors.New("too big")), false},
		{context.Canceled, false},
	}
	for _, c := range cases {
		if got := isTemporaryError(c.err); got != c.want {
			t.Errorf("isTemporaryError(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}

func TestParseRetryAfter(t *testing.T) {
	if got := parseRetryAfter("7"); got != 7*time.Second {
		t.Fatalf("seconds: %s", got)
	}
	if got := parseRetryAfter(time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)); got < 59*time.Minute {
		t.Fatalf("date: %s", got)
	}
	if got := retryDelay(1, &httpStatusError{Code: 429, RetryAfter: time.Hour}); got > maxRetryAfter*3/2+time.Second {
		t.Fatalf("Retry-After not capped: %s", got)
	}
}

func TestPageFileName(t *testing.T) {
	cases := map[string]string{
		"https://i.example/galleries/1/7.jpg":          "3.jpg",
		"https://i.example/galleries/1/x.WEBP?sig=a.b": "3.webp",
		"https://i.example/galleries/1/../../evil.png": "3.png",
	}
	for in, want := range cases {
		got, err := pageFileName(3, in)
		if err != nil || got != want {
			t.Errorf("pageFileName(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"https://i.example/a/1.html", "https://i.example/a/1", "https://i.example/a/1.jpg/"} {
		if got, err := pageFileName(1, bad); err == nil {
			t.Errorf("pageFileName(%q) = %q, want error", bad, got)
		}
	}
}

func TestDownloadManagerOverlappingRuns(t *testing.T) {
	dm := NewDownloadManager()
	releaseA := make(chan struct{})
	var started atomic.Int32
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		started.Add(1)
		if strings.HasPrefix(r.URL.Path, "/a/") {
			<-releaseA
		} else {
			<-r.Context().Done()
		}
		w.WriteHeader(http.StatusNotFound)
	})

	cfgA, cfgB := testConfig(t, ps.URL, 1), testConfig(t, ps.URL, 1)
	cfgA.Images[0] = ps.URL + "/a/1.png"
	cfgB.Images[0] = ps.URL + "/b/1.png"
	doneA, doneB := make(chan DownloadResult, 1), make(chan DownloadResult, 1)
	go func() { doneA <- dm.Run(context.Background(), cfgA) }()
	go func() { doneB <- dm.Run(context.Background(), cfgB) }()
	for started.Load() < 2 {
		time.Sleep(5 * time.Millisecond)
	}

	// The first run finishing must not unregister the second one.
	close(releaseA)
	<-doneA
	if !dm.HasActive("h") {
		t.Fatal("second run lost when the first finished")
	}

	dm.Stop("h")
	select {
	case <-doneB:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not reach the second run")
	}
	if dm.HasActive("h") {
		t.Fatal("run still listed after both finished")
	}
}

func TestRunReportsPagesThePackerSkipped(t *testing.T) {
	fastDownloads(t)
	img := testPNG(t, 4, 4)
	ps := newPageServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Write(img)
	})
	cfg := testConfig(t, ps.URL, 3)
	// Page 2 was already "downloaded" by a broken earlier run; the downloader keeps nothing that is not an image.
	if err := os.WriteFile(filepath.Join(cfg.DownloadDir, "2.png"), []byte("<html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg.Images[2] = ps.URL + "/g/3.bin"

	res := NewDownloadManager().Run(context.Background(), cfg)
	if !res.Success {
		t.Fatalf("run failed: %+v", res)
	}
	if !slices.Equal(res.MissingPages, []int{3}) {
		t.Fatalf("missing = %v", res.MissingPages)
	}
	if data, _ := os.ReadFile(filepath.Join(cfg.DownloadDir, "2.png")); !bytes.Equal(data, img) {
		t.Fatal("non-image leftover was not replaced")
	}
}

func TestCleanTempFilesKeepsFreshAndLockedBuilds(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, ".zip.1.tmp")
	fresh := filepath.Join(dir, ".pdf.2.tmp")
	for _, p := range []string{old, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-time.Hour)
	os.Chtimes(old, past, past)

	release, err := tryArchiveLock(archiveLockPath(filepath.Join(dir, "a.epub")))
	if err != nil || release == nil {
		t.Fatalf("lock: %v", err)
	}
	CleanTempFiles(dir, "a.zip")
	if _, err := os.Stat(old); err != nil {
		t.Fatal("removed a temp file while a build holds a lock")
	}
	release()

	CleanTempFiles(dir, "a.zip")
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old temp file kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh temp file removed")
	}
}
